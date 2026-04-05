/**
 * whisper-hallucination-fix.ts
 * 
 * Sửa lỗi Whisper "cold start hallucination" — hiện tượng Whisper
 * output text sai (thường là tiếng nước ngoài: Cyrillic, CJK, Arabic...)
 * ở vài segment đầu tiên do model chưa "warm up".
 * 
 * Cách hoạt động:
 * 1. Quét 5 segment đầu tiên, phát hiện ký tự non-Latin
 * 2. Nếu phát hiện → cắt đoạn audio bị hallucinate
 * 3. Thêm 1 giây silence trước → re-transcribe bằng Whisper local
 * 4. Thay thế segment rác bằng segment mới, giữ nguyên phần sau
 * 
 * Không dùng AI API, chạy hoàn toàn local, thêm ~1-2 giây xử lý.
 */

import { invoke } from '@tauri-apps/api/core'

// ======================== TYPES ========================

/** Segment từ Whisper — chứa text + thời gian */
interface WhisperSegment {
    start: number   // giây
    end: number     // giây
    text: string
    speaker_id?: string
    words?: Array<{ word: string; start: number; end: number; probability?: number }>
}

/** Kết quả transcript từ Whisper backend */
interface WhisperTranscript {
    processing_time_sec: number
    segments: WhisperSegment[]
    speakers: any[]
}

// ======================== DETECT HALLUCINATION ========================

/**
 * Regex phát hiện ký tự non-Latin (Cyrillic, CJK, Arabic, Thai, Devanagari...)
 * Whisper thường hallucinate ra các ngôn ngữ này khi chưa warm up
 */
const NON_LATIN_REGEX = /[\u0400-\u04FF\u0500-\u052F\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\u0600-\u06FF\u0E00-\u0E7F\u0900-\u097F\uAC00-\uD7AF]/

/**
 * Kiểm tra 1 segment có phải hallucination không
 * - Ký tự non-Latin chiếm > 30% text
 * - Hoặc text quá ngắn + toàn ký tự lạ
 */
function isHallucinatedSegment(text: string, expectedLang: string): boolean {
    // Chỉ check cho ngôn ngữ Latin-based (en, es, fr, de, pt, vi...)
    const latinLangs = ['en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'vi', 'id', 'ms', 'tl', 'ro', 'pl', 'cs', 'hu', 'sv', 'da', 'no', 'fi']
    if (!latinLangs.includes(expectedLang)) return false

    const cleaned = text.replace(/\s+/g, '')
    if (cleaned.length === 0) return false

    // Đếm ký tự non-Latin
    const nonLatinChars = cleaned.match(NON_LATIN_REGEX) || []
    const ratio = nonLatinChars.length / cleaned.length

    // > 30% ký tự non-Latin → hallucination
    return ratio > 0.3
}

// ======================== MAIN FIX FUNCTION ========================

/**
 * Fix Whisper hallucination ở đầu transcript
 * 
 * @param transcript - Kết quả Whisper gốc
 * @param audioPath - Đường dẫn file audio
 * @param lang - Ngôn ngữ đang transcribe (vd: 'en')
 * @param whisperOptions - Options Whisper gốc (model, settings...)
 * @returns Transcript đã sửa (hoặc giữ nguyên nếu không có hallucination)
 */
export async function fixWhisperHallucination(
    transcript: WhisperTranscript,
    audioPath: string,
    lang: string,
    whisperOptions: Record<string, any>
): Promise<WhisperTranscript> {
    if (!transcript.segments || transcript.segments.length === 0) {
        return transcript
    }

    // ---- Bước 1: Quét tối đa 5 segment đầu để tìm hallucination ----
    const MAX_CHECK = Math.min(5, transcript.segments.length)
    let lastHallucinatedIdx = -1

    for (let i = 0; i < MAX_CHECK; i++) {
        if (isHallucinatedSegment(transcript.segments[i].text, lang)) {
            lastHallucinatedIdx = i
        } else {
            // Gặp segment sạch đầu tiên → dừng quét
            break
        }
    }

    // Không có hallucination → trả nguyên transcript
    if (lastHallucinatedIdx === -1) {
        console.log('[HallucinationFix] ✅ Không phát hiện hallucination đầu file')
        return transcript
    }

    // ---- Bước 2: Xác định đoạn cần re-transcribe ----
    // Lấy end time của segment hallucinate cuối cùng + thêm 2 giây buffer
    const hallucinatedEndTime = transcript.segments[lastHallucinatedIdx].end
    const retranscribeEndSec = Math.min(hallucinatedEndTime + 2, 10) // Tối đa 10 giây

    console.log(`[HallucinationFix] ⚠️ Phát hiện ${lastHallucinatedIdx + 1} segment hallucinated (0s → ${hallucinatedEndTime.toFixed(1)}s)`)
    console.log(`[HallucinationFix] 🔄 Re-transcribe đoạn 0s → ${retranscribeEndSec.toFixed(1)}s...`)

    // Log text hallucinated (để debug)
    for (let i = 0; i <= lastHallucinatedIdx; i++) {
        console.log(`[HallucinationFix] ❌ Segment ${i}: "${transcript.segments[i].text.substring(0, 80)}"`)
    }

    // ---- Bước 3: Re-transcribe đoạn đầu bằng Whisper (có silence đệm) ----
    try {
        const reResult = await invoke<WhisperTranscript>('transcribe_audio', {
            options: {
                ...whisperOptions,
                audioPath: audioPath,
                // Thêm 1 giây silence trước bằng FFmpeg padding (Whisper backend xử lý)
                prependSilenceSec: 1.0,
                // Chỉ transcribe đoạn đầu
                maxDurationSec: retranscribeEndSec + 1, // +1 vì thêm silence
            }
        })

        if (!reResult.segments || reResult.segments.length === 0) {
            console.warn('[HallucinationFix] ⚠️ Re-transcribe trả về rỗng, giữ nguyên transcript gốc')
            return transcript
        }

        // ---- Bước 4: Lọc kết quả re-transcribe ----
        // Offset trừ 1 giây silence đệm, chỉ lấy segment nằm trong đoạn cần thay
        const fixedSegments: WhisperSegment[] = []
        for (const seg of reResult.segments) {
            const adjustedStart = seg.start - 1.0  // trừ offset silence
            const adjustedEnd = seg.end - 1.0

            // Bỏ segment nằm trong vùng silence (< 0) hoặc ngoài vùng retranscribe
            if (adjustedEnd <= 0 || adjustedStart >= retranscribeEndSec) continue

            // Kiểm tra segment mới có sạch không
            if (isHallucinatedSegment(seg.text, lang)) continue

            fixedSegments.push({
                ...seg,
                start: Math.max(0, adjustedStart),
                end: adjustedEnd,
                // Adjust word timestamps nếu có
                words: seg.words?.map(w => ({
                    ...w,
                    start: Math.max(0, w.start - 1.0),
                    end: w.end - 1.0,
                })).filter(w => w.end > 0)
            })
        }

        if (fixedSegments.length === 0) {
            console.warn('[HallucinationFix] ⚠️ Re-transcribe không sạch hơn, giữ nguyên transcript gốc')
            return transcript
        }

        // ---- Bước 5: Ghép lại ----
        // Lấy tất cả segment gốc SAU vùng hallucination
        const keptOriginalSegments = transcript.segments.filter(
            seg => seg.start >= retranscribeEndSec
        )

        const mergedSegments = [...fixedSegments, ...keptOriginalSegments]
        // Sort theo start time đảm bảo thứ tự
        mergedSegments.sort((a, b) => a.start - b.start)

        console.log(`[HallucinationFix] ✅ Đã sửa: ${fixedSegments.length} segment mới + ${keptOriginalSegments.length} segment gốc giữ lại = ${mergedSegments.length} tổng`)
        for (const seg of fixedSegments) {
            console.log(`[HallucinationFix] ✅ Fixed: ${seg.start.toFixed(1)}s → "${seg.text.substring(0, 80)}"`)
        }

        return {
            ...transcript,
            segments: mergedSegments,
        }
    } catch (err) {
        // Re-transcribe thất bại → giữ nguyên transcript gốc, không crash pipeline
        console.error('[HallucinationFix] ❌ Re-transcribe lỗi, giữ nguyên transcript gốc:', err)
        return transcript
    }
}

/**
 * Phiên bản nhẹ: Chỉ xoá segment hallucinated mà KHÔNG re-transcribe
 * Dùng khi không muốn tốn thêm thời gian re-transcribe
 * Phần bị xoá sẽ không có sub (nhưng thường chỉ 1-3 giây đầu)
 */
export function removeHallucinatedSegments(
    transcript: WhisperTranscript,
    lang: string
): WhisperTranscript {
    if (!transcript.segments || transcript.segments.length === 0) return transcript

    const MAX_CHECK = Math.min(5, transcript.segments.length)
    let removeCount = 0

    for (let i = 0; i < MAX_CHECK; i++) {
        if (isHallucinatedSegment(transcript.segments[i].text, lang)) {
            removeCount++
        } else {
            break
        }
    }

    if (removeCount === 0) {
        console.log('[HallucinationFix] ✅ Không có hallucination — giữ nguyên')
        return transcript
    }

    console.log(`[HallucinationFix] 🗑️ Xoá ${removeCount} segment hallucinated đầu file`)
    return {
        ...transcript,
        segments: transcript.segments.slice(removeCount),
    }
}
