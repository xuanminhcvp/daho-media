// voice-pipeline-service.ts
// ═══════════════════════════════════════════════════════════════
// Service điều phối toàn bộ quy trình cho file Voice MỚI:
//   1. Lắng nghe events tiến độ Whisper (labeled-progress)
//   2. Gọi backend Whisper → lấy Transcript + timing chính xác
//   3. Parse kịch bản đánh số
//   4. Gọi AI Matcher → map từng câu → lưu autosubs_matching.json
// ═══════════════════════════════════════════════════════════════

import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { dirname } from "@tauri-apps/api/path"
import { aiMatchScriptToTimeline } from "./ai-matcher"
import { parseScript } from "@/utils/media-matcher"
import type { TranscriptionOptions } from "@/types/interfaces"
import type { ScriptSentence } from "@/utils/media-matcher"
import { logTranscribePhaseTimingToDebug } from "@/services/transcribe-phase-debug-service"
import { startTranscribePhaseDebugLog } from "@/services/transcribe-phase-debug-service"

// ======================== TYPES ========================

export interface PipelineProgress {
    step: 1 | 2 | 3 | 4
    message: string
}

// ======================== HÀM CHÍNH ========================

/**
 * Chạy toàn trình cho file Voice mới tinh:
 * WAV/MP3 + Kịch bản đánh số → autosubs_matching.json có timing chính xác
 *
 * @param audioPath  Đường dẫn file WAV/MP3 mới
 * @param scriptText Kịch bản đánh số (vd: "1. Câu đầu\n2. Câu tiếp")
 * @param onProgress Callback nhận progress message để hiện lên UI
 * @param modelValue Tên model Whisper (từ ModelsContext)
 * @param language   Ngôn ngữ cho Whisper (vd: "en", "auto")
 */
export async function runVoicePacingPipeline(
    audioPath: string,
    scriptText: string,
    onProgress: (progress: PipelineProgress) => void,
    modelValue: string,
    language: string
): Promise<{
    success: boolean
    folderPath: string
    matchedSentences: ScriptSentence[]
}> {
    // Lấy folder chứa file WAV để lưu matching.json cùng chỗ
    const folderPath = await dirname(audioPath)

    // ─── Bước 1: Lắng nghe event progress của Whisper backend ───
    // Backend Tauri emit "labeled-progress" với { progress: 0-100, type: "Transcribe" }
    // → Relay % này lên UI để user thấy Whisper đang tiến triển, không phải treo
    let whisperUnlisten: (() => void) | null = null

    const unlistenFn = await listen<{ progress: number; type?: string; label?: string }>(
        "labeled-progress",
        (event) => {
            const { progress, type, label } = event.payload
            if (type === "Transcribe") {
                const pct = Math.round(progress)
                // Nếu backend trả label (vd: cache hit), ưu tiên hiển thị đúng trạng thái thật.
                const labelText = typeof label === "string" && label.trim().length > 0
                    ? label.trim()
                    : null
                onProgress({
                    step: 1,
                    message: labelText
                        ? `🎙️ ${labelText} (${pct}%)`
                        : `🎙️ Whisper đang xử lý: ${pct}% (vui lòng chờ, file dài mất nhiều phút)`,
                })
            }
        }
    )
    whisperUnlisten = unlistenFn

    onProgress({
        step: 1,
        message: "Đang khởi động Whisper Transcribe... (file 30 phút ≈ mất ~5-15 phút)",
    })

    try {
        // ─── Bước 2: Gọi Tauri backend Whisper ───
        // invoke() block cho đến khi Whisper hoàn tất, trong thời gian đó
        // listener bên trên sẽ liên tục nhận events và cập nhật UI
        const transcribeOptions = {
            audioPath,
            offset: 0,
            model: modelValue,
            lang: language,
            translate: false,
            targetLanguage: "en",
            enableDtw: true,   // Word-level timestamps — QUAN TRỌNG để timing chuẩn
            enableGpu: true,
            enableDiarize: false,
            maxSpeakers: null,
            density: "standard",
        } satisfies TranscriptionOptions
        // Tạo log pending ngay khi bắt đầu transcribe để tab API thấy trạng thái đang chạy.
        const transcribeDebugLogId = startTranscribePhaseDebugLog({
            label: "Voice Pacing Pipeline",
            options: transcribeOptions,
        })
        const rawTranscriptData = await invoke<any>("transcribe_audio", {
            options: transcribeOptions,
        })
        // Ghi timing chi tiết các pha vào DEBUG Panel.
        logTranscribePhaseTimingToDebug({
            logId: transcribeDebugLogId,
            label: "Voice Pacing Pipeline",
            options: transcribeOptions,
            transcript: rawTranscriptData,
        })

        // Fix Whisper hallucination đầu file (text sai ở 2-5 giây đầu)
        const { removeHallucinatedSegments } = await import('@/utils/whisper-hallucination-fix')
        const transcriptData = removeHallucinatedSegments(rawTranscriptData as any, language || 'en')

        // Whisper xong → dọn dẹp listener
        whisperUnlisten?.()
        whisperUnlisten = null

        onProgress({ step: 2, message: "✅ Transcribe hoàn tất! Đang chuẩn bị AI Match..." })

        // ─── Bước 3: Parse kịch bản đánh số ───
        const sentences = parseScript(scriptText)
        if (sentences.length === 0) {
            throw new Error(
                "Không tìm thấy câu nào trong kịch bản.\n" +
                "Format cần: '1. Câu đầu tiên', '2. Câu tiếp theo'..."
            )
        }
        console.log(`[Pipeline] ${sentences.length} câu từ kịch bản → bắt đầu AI Match`)

        // ─── Bước 4: AI Match kịch bản → timing Whisper ───
        // Hàm này sẽ tự lưu autosubs_matching.json vào folderPath
        const matched = await aiMatchScriptToTimeline(
            sentences,
            transcriptData,
            (progressMsg) => {
                onProgress({ step: 3, message: progressMsg.message })
            },
            folderPath
        )

        onProgress({
            step: 4,
            message: `✅ Hoàn tất! ${matched.length} câu có timing chính xác từ Whisper.`,
        })

        return { success: true, folderPath, matchedSentences: matched }

    } catch (error) {
        // Dọn dẹp listener dù có lỗi
        whisperUnlisten?.()
        console.error("[Pipeline] Lỗi:", error)
        throw new Error(String(error))
    }
}

// ======================== PIPELINE TỪ SRT CÓ SẴN ========================

/**
 * Pipeline nhanh khi đã có SRT từ tab Subtitles — bỏ qua Whisper hoàn toàn:
 * 1. Đọc SRT → convert sang cấu trúc transcript giả lập
 * 2. AI Match kịch bản đánh số → timing từ SRT
 * 3. Lưu autosubs_matching.json vào cùng folder WAV
 *
 * @param audioPath    Đường dẫn file WAV
 * @param srtPath      Đường dẫn file SRT đã có (từ tab Subtitles)
 * @param scriptText   Kịch bản đánh số
 * @param onProgress   Callback progress lên UI
 */
export async function runVoicePacingPipelineFromSRT(
    audioPath: string,
    srtPath: string,
    scriptText: string,
    onProgress: (progress: PipelineProgress) => void,
): Promise<{
    success: boolean
    folderPath: string
    matchedSentences: ScriptSentence[]
}> {
    // Import lazy để tránh circular
    const { loadSRTFile, srtToTranscript } = await import("@/utils/srt-parser")

    const folderPath = await dirname(audioPath)

    onProgress({ step: 1, message: "⏳ Đang đọc file SRT..." })

    // 1. Parse SRT → transcript giả lập
    const srtEntries = await loadSRTFile(srtPath)
    if (srtEntries.length === 0) {
        throw new Error("File SRT trống hoặc không đúng format!")
    }

    const transcriptData = srtToTranscript(srtEntries)
    console.log(`[Pipeline SRT] ${srtEntries.length} SRT entries → transcript giả lập`)

    onProgress({ step: 2, message: `✅ SRT đã load (${srtEntries.length} segments). Bắt đầu AI Match...` })

    // 2. Parse kịch bản đánh số
    const sentences = parseScript(scriptText)
    if (sentences.length === 0) {
        throw new Error("Không tìm thấy câu nào trong kịch bản. Format: '1. Câu đầu tiên'")
    }
    console.log(`[Pipeline SRT] ${sentences.length} câu → AI Match`)

    // 3. AI Match kịch bản → timing từ SRT
    const matched = await aiMatchScriptToTimeline(
        sentences,
        transcriptData,
        (progressMsg) => {
            onProgress({ step: 3, message: progressMsg.message })
        },
        folderPath
    )

    onProgress({ step: 4, message: `✅ Hoàn tất! ${matched.length} câu có timing từ SRT.` })

    return { success: true, folderPath, matchedSentences: matched }
}
