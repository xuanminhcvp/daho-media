use whisper_rs::{WhisperVadContext, WhisperVadContextParams, WhisperVadParams};
use crate::types::{SpeechSegment, LabeledProgressFn, ProgressType};
use eyre::Result;
use std::time::Instant;

/// Kích thước mỗi chunk: 5 phút (300 giây) audio
/// Chia nhỏ để tránh treo khi audio quá dài
const CHUNK_SECONDS: usize = 300;
const SAMPLE_RATE: usize = 16_000;
const CHUNK_SAMPLES: usize = SAMPLE_RATE * CHUNK_SECONDS;

/// Detect speech segments with Silero VAD via whisper-rs.
/// Audio được chia thành chunks nhỏ (mỗi chunk 5 phút) để:
/// - Tránh treo khi audio dài (>30 phút)
/// - Emit progress theo từng chunk
/// - Giảm memory pressure
///
/// Input `int_samples` phải là mono i16 ở 16_000 Hz.
pub fn get_segments(
    vad_model: &str,
    int_samples: &[i16],
    progress_callback: Option<&LabeledProgressFn>,
) -> Result<Vec<SpeechSegment>> {
    let t_total = Instant::now();
    let total_samples = int_samples.len();
    let audio_secs = total_samples as f64 / SAMPLE_RATE as f64;
    println!("[VAD] 🟢 Bắt đầu, {} samples ({:.1}s audio)", total_samples, audio_secs);

    // === Bước 1: Tạo VAD context (load model 1 lần) ===
    let t_ctx = Instant::now();
    println!("[VAD] 1️⃣ WhisperVadContext::new()...");
    if let Some(cb) = progress_callback {
        cb(0, ProgressType::Transcribe, "🔍 VAD: loading model...");
    }
    let ctx = WhisperVadContextParams::new();
    let mut vad = WhisperVadContext::new(vad_model, ctx)?;
    println!("[VAD] ✅ VAD context OK sau {:.2}s", t_ctx.elapsed().as_secs_f64());

    // === Bước 2: Chia audio thành chunks và xử lý từng chunk ===
    let total_chunks = (total_samples + CHUNK_SAMPLES - 1) / CHUNK_SAMPLES; // ceil division
    println!("[VAD] 2️⃣ Chia thành {} chunks (mỗi chunk {}s)", total_chunks, CHUNK_SECONDS);
    if let Some(cb) = progress_callback {
        cb(0, ProgressType::Transcribe, &format!("🔍 VAD: {} chunks × {}s", total_chunks, CHUNK_SECONDS));
    }

    let mut all_segments: Vec<SpeechSegment> = Vec::new();

    let mut chunk_start: usize = 0;
    let mut chunk_idx: usize = 0;

    while chunk_start < total_samples {
        // Xác định vùng samples cho chunk này
        let chunk_end = (chunk_start + CHUNK_SAMPLES).min(total_samples);
        let chunk_i16 = &int_samples[chunk_start..chunk_end];
        let chunk_secs = chunk_i16.len() as f64 / SAMPLE_RATE as f64;

        // Offset thời gian của chunk này (tính bằng giây)
        let time_offset = chunk_start as f64 / SAMPLE_RATE as f64;

        println!("[VAD] 📦 Chunk {}/{}: {:.0}s - {:.0}s ({:.1}s, {} samples)",
            chunk_idx + 1, total_chunks,
            time_offset, time_offset + chunk_secs,
            chunk_secs, chunk_i16.len()
        );
        if let Some(cb) = progress_callback {
            let pct = ((chunk_idx as f64 / total_chunks as f64) * 100.0) as i32;
            cb(pct, ProgressType::Transcribe,
                &format!("🔍 VAD chunk {}/{} ({:.0}s-{:.0}s)...",
                    chunk_idx + 1, total_chunks, time_offset, time_offset + chunk_secs));
        }

        let t_chunk = Instant::now();

        // Convert i16 → f32 cho chunk này
        let mut chunk_f32 = vec![0.0f32; chunk_i16.len()];
        whisper_rs::convert_integer_to_float_audio(chunk_i16, &mut chunk_f32)?;

        // Chạy VAD trên chunk này
        let mut vadp = WhisperVadParams::new();
        vadp.set_min_silence_duration(200);
        let segs = vad.segments_from_samples(vadp, &chunk_f32)?;

        // Map segments: chuyển centiseconds → seconds + thêm offset
        let n = chunk_i16.len();
        let n_f32 = n as f32;
        let sr = SAMPLE_RATE as f32;

        let chunk_segments: Vec<SpeechSegment> = segs
            .map(|s| {
                // VAD trả về centiseconds (1/100 giây) tương đối trong chunk
                let start_sec = (s.start as f64) / 100.0 + time_offset;
                let end_sec = (s.end as f64) / 100.0 + time_offset;
                (start_sec, end_sec)
            })
            .filter(|(st, en)| en > st)
            .map(|(start_sec, end_sec)| {
                // Tính index trong buffer GỐC (int_samples), không phải chunk
                let abs_start_idx = ((start_sec * SAMPLE_RATE as f64).round() as usize).min(total_samples);
                let abs_end_idx = ((end_sec * SAMPLE_RATE as f64).round() as usize).min(total_samples);

                let seg_samples: Vec<i16> = if abs_end_idx > abs_start_idx {
                    int_samples[abs_start_idx..abs_end_idx].to_vec()
                } else {
                    Vec::new()
                };

                SpeechSegment {
                    start: start_sec,
                    end: end_sec,
                    samples: seg_samples,
                    speaker_id: None,
                }
            })
            .filter(|seg| seg.end > seg.start && !seg.samples.is_empty())
            .collect();

        println!("[VAD] ✅ Chunk {}/{}: {} segments, {:.2}s",
            chunk_idx + 1, total_chunks,
            chunk_segments.len(), t_chunk.elapsed().as_secs_f64()
        );

        all_segments.extend(chunk_segments);
        chunk_start = chunk_end;
        chunk_idx += 1;
    }

    println!("[VAD] 🎉 Hoàn tất: {} segments total, {:.2}s",
        all_segments.len(), t_total.elapsed().as_secs_f64()
    );
    if let Some(cb) = progress_callback {
        cb(100, ProgressType::Transcribe,
            &format!("✅ VAD: {} segments ({:.1}s)", all_segments.len(), t_total.elapsed().as_secs_f64()));
    }

    Ok(all_segments)
}
