//! Parakeet (NeMo) speech recognition backend.
//!
//! This module wraps the transcribe-rs Parakeet engine to provide
//! NVIDIA NeMo Parakeet speech-to-text capabilities.

use crate::types::{SpeechSegment, Segment, WordTimestamp, TranscribeOptions, LabeledProgressFn, NewSegmentFn, ProgressType};
use eyre::{Result, eyre};
use std::path::Path;
use std::time::Instant;
use transcribe_rs::{
    TranscriptionEngine,
    engines::parakeet::{ParakeetEngine, ParakeetModelParams, ParakeetInferenceParams, TimestampGranularity},
};

/// Transcribe audio segments using the Parakeet engine.
///
/// This function handles the conversion between internal types and transcribe-rs types,
/// and processes speech segments through the Parakeet model.
///
/// # Arguments
/// * `model_path` - Path to the Parakeet model directory
/// * `speech_segments` - Pre-processed speech segments from VAD/diarization
/// * `options` - Transcription options (note: Parakeet is English-only, language options are ignored)
/// * `progress_callback` - Optional callback for progress updates
/// * `new_segment_callback` - Optional callback for new segment notifications
/// * `_abort_callback` - Optional callback to check for cancellation (not yet implemented for Parakeet)
///
/// # Returns
/// A tuple of (segments, detected_language) where detected_language is always Some("en") for Parakeet.
pub async fn transcribe_parakeet(
    model_path: &Path,
    speech_segments: Vec<SpeechSegment>,
    options: &TranscribeOptions,
    progress_callback: Option<&LabeledProgressFn>,
    new_segment_callback: Option<&NewSegmentFn>,
    _abort_callback: Option<Box<dyn Fn() -> bool + Send + Sync>>,
) -> Result<(Vec<Segment>, Option<String>)> {
    tracing::debug!("Parakeet transcribe called with model: {:?}", model_path);

    // === LOG: Tạo Parakeet engine ===
    let t_total = Instant::now();
    println!("[PARAKEET] 🛠️  Tạo ParakeetEngine...");
    // Gửi log về frontend qua progress callback
    if let Some(cb) = progress_callback {
        cb(0, ProgressType::Transcribe, "🛠️ Tạo Parakeet engine...");
    }
    let t_new = Instant::now();
    let mut engine = ParakeetEngine::new();
    println!("[PARAKEET] ✅ Engine đã tạo sau {:.2}s", t_new.elapsed().as_secs_f64());

    // === LOG: Load model ===
    println!("[PARAKEET] 📦 Load model: {:?} (int8)", model_path);
    if let Some(cb) = progress_callback {
        cb(5, ProgressType::Transcribe, "📦 Loading Parakeet model (int8)...");
    }
    let model_params = ParakeetModelParams::int8();
    let t_load = Instant::now();
    engine.load_model_with_params(model_path, model_params)
        .map_err(|e| eyre!("Failed to load Parakeet model: {}", e))?;
    let load_secs = t_load.elapsed().as_secs_f64();
    println!("[PARAKEET] ✅ Model loaded OK sau {:.2}s", load_secs);
    if let Some(cb) = progress_callback {
        cb(10, ProgressType::Transcribe, &format!("✅ Model loaded ({:.1}s)", load_secs));
    }

    // Configure inference for word-level timestamps
    let inference_params = ParakeetInferenceParams {
        timestamp_granularity: TimestampGranularity::Word,
    };
    println!("[PARAKEET] 🎯 Inference mode: Word-level timestamps");

    // Apply user offset
    let user_offset = options.offset.unwrap_or(0.0);

    let mut segments: Vec<Segment> = Vec::new();
    let total_segments = speech_segments.len();

    for (i, speech_segment) in speech_segments.iter().enumerate() {
        // === LOG: Bắt đầu inference segment ===
        let seg_duration = speech_segment.end - speech_segment.start;
        println!("[PARAKEET] 🎤 Segment {}/{}: {:.2}s - {:.2}s ({:.1}s, {} samples)",
            i + 1, total_segments,
            speech_segment.start, speech_segment.end,
            seg_duration, speech_segment.samples.len()
        );
        // Gửi tiến độ về frontend
        if let Some(cb) = progress_callback {
            let pct = 10 + ((i as f64 / total_segments as f64) * 85.0) as i32;
            cb(pct, ProgressType::Transcribe,
                &format!("🎤 Transcribing segment {}/{} ({:.1}s)", i + 1, total_segments, seg_duration));
        }
        let t_seg = Instant::now();

        // Convert i16 samples to f32 for Parakeet
        let samples: Vec<f32> = speech_segment.samples
            .iter()
            .map(|&s| s as f32 / 32768.0)
            .collect();
        println!("[PARAKEET]   🔄 Converted {} samples to f32, gọi transcribe_samples()...", samples.len());

        // Transcribe this segment
        let t_infer = Instant::now();
        let result = engine.transcribe_samples(samples, Some(inference_params.clone()))
            .map_err(|e| eyre!("Parakeet transcription failed: {}", e))?;
        let infer_secs = t_infer.elapsed().as_secs_f64();
        println!("[PARAKEET]   ✅ Inference xong sau {:.2}s (segment total: {:.2}s)",
            infer_secs,
            t_seg.elapsed().as_secs_f64()
        );
        // Gửi kết quả về frontend
        if let Some(cb) = progress_callback {
            let pct = 10 + (((i + 1) as f64 / total_segments as f64) * 85.0) as i32;
            cb(pct, ProgressType::Transcribe,
                &format!("✅ Segment {}/{} xong ({:.1}s)", i + 1, total_segments, infer_secs));
        }

        // Base offset for this chunk
        let base_offset = speech_segment.start + user_offset;

        // Convert transcribe-rs output to our internal format.
        // We emit one Segment per input speech segment, and populate word timestamps
        // from the word-level segments returned by transcribe-rs.
        let text = result.text.trim().to_string();
        if !text.is_empty() {
            let mut words: Vec<WordTimestamp> = Vec::new();

            if let Some(transcribe_segments) = result.segments {
                let mut is_first_word = true;
                for w in transcribe_segments {
                    // Preserve leading whitespace so the formatter can correctly re-insert spaces
                    // between words (it inspects `WordTimestamp.text` for leading space/newline).
                    // Only trim trailing whitespace/terminators.
                    let mut w_text = w
                        .text
                        .trim_end_matches(|c: char| c.is_whitespace() || c == '\0')
                        .to_string();
                    if w_text.trim().is_empty() {
                        continue;
                    }

                    // Parakeet word pieces often do not include leading space markers.
                    // Our formatter uses leading spaces/newlines to decide inter-word spacing
                    // and to avoid merging continuation pieces, so synthesize them.
                    if !is_first_word && !w_text.starts_with(' ') && !w_text.starts_with('\n') {
                        w_text.insert(0, ' ');
                    }

                    words.push(WordTimestamp {
                        text: w_text,
                        start: base_offset + w.start as f64,
                        end: base_offset + w.end as f64,
                        probability: None,
                    });

                    is_first_word = false;
                }
            }

            let (seg_start, seg_end) = if let (Some(first), Some(last)) = (words.first(), words.last()) {
                (first.start, last.end)
            } else {
                (
                    base_offset,
                    base_offset + (speech_segment.end - speech_segment.start),
                )
            };

            // Prevent overlaps with previous segment
            if let Some(last) = segments.last_mut() {
                if last.end > seg_start {
                    last.end = seg_start;
                }
                if let Some(last_words) = &mut last.words {
                    if let Some(last_word) = last_words.last_mut() {
                        if last_word.end > last.end {
                            last_word.end = last.end;
                        }
                    }
                }
            }

            let segment = Segment {
                speaker_id: speech_segment.speaker_id.clone(),
                start: seg_start,
                end: seg_end,
                text,
                words: (!words.is_empty()).then_some(words),
            };

            if let Some(cb) = new_segment_callback {
                cb(&segment);
            }

            segments.push(segment);
        }

        // Emit progress update
        if let Some(progress_callback) = progress_callback {
            let progress = ((i + 1) as f64 / total_segments as f64 * 100.0) as i32;
            progress_callback(progress, ProgressType::Transcribe, "Transcribing audio (Parakeet)");
        }
    }

    tracing::debug!("Parakeet transcription complete: {} segments", segments.len());
    println!("[PARAKEET] 🎉 Hoàn tất: {} segments, total {:.2}s",
        segments.len(),
        t_total.elapsed().as_secs_f64()
    );

    Ok((segments, None))
}

/// Check if a model name refers to a Parakeet model.
pub fn is_parakeet_model(model_name: &str) -> bool {
    model_name.to_lowercase().starts_with("parakeet")
}
