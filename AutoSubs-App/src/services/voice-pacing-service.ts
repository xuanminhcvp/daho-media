// voice-pacing-service.ts
// ═══════════════════════════════════════════════════════════════
// Service xử lý Voice Pacing: gọi AI phân tích + FFmpeg cắt audio
// ═══════════════════════════════════════════════════════════════
// Quy trình:
// 1. Đọc matching data (start/end/text mỗi câu)
// 2. Phân tích nhịp (rule-based hoặc AI)
// 3. Gọi FFmpeg cắt audio gốc → chèn silence → ghép lại
// 4. Xuất file audio mới + matching data mới (timing đã dịch)
// ═══════════════════════════════════════════════════════════════

import { writeTextFile } from "@tauri-apps/plugin-fs"
import { join } from "@tauri-apps/api/path"
import { Command } from "@tauri-apps/plugin-shell"
import {
    addDebugLog,
    updateDebugLog,
    generateLogId,
} from "@/services/debug-logger"
import {
    PACING_RULES,
    PACING_CONFIG,
    SENTENCE_TYPE_RULES,
    buildVoicePacingPrompt,
} from "@/prompts/voice-pacing-prompt"
import type { ScriptSentence } from "@/utils/media-matcher"

// ======================== TYPES ========================

// Kết quả phân tích pause cho 1 câu
export interface PauseResult {
    num: number       // Số thứ tự câu
    pause: number     // Khoảng nghỉ (giây) sau câu
    reason: string    // Lý do
    original: number  // Giá trị gốc (để reset)
}

// Progress callback
export interface PacingProgress {
    message: string
    step: number
    total: number
}

// ======================== CONFIG AI (dùng chung với ai-matcher) ========================

const AI_CONFIG = {
    baseUrl: "https://ezaiapi.com/v1",
    apiKey: "sk-570848c49fda787c748cd58f3a21a1d95f00afd87a5cba6e",
    model: "claude-sonnet-4-6",   // Claude Sonnet local
    timeoutMs: 120000,             // 2 phút timeout (Sonnet nhanh hơn Opus)
    maxTokens: 8000,
}

// ======================== HELPER: PHÁT HIỆN LOẠI CÂU ========================

/**
 * Phát hiện loại câu dựa trên keywords
 * Trả về: "timestamp" | "action" | "twist" | "quote" | "stats" | "list" | null
 */
function detectSentenceType(text: string): keyof typeof SENTENCE_TYPE_RULES | null {
    const trimmed = text.trim()

    // 1. Timestamp — bắt đầu bằng tháng hoặc có pattern ngày tháng
    for (const kw of SENTENCE_TYPE_RULES.timestamp.keywords) {
        if (trimmed.startsWith(kw)) return "timestamp"
    }

    // 2. Plot Twist — bắt đầu bằng "But " hoặc "However,"
    for (const kw of SENTENCE_TYPE_RULES.twist.keywords) {
        if (trimmed.startsWith(kw)) return "twist"
    }

    // 3. Direct Quote — có pattern "he says", "she tells", etc.
    const textLower = trimmed.toLowerCase()
    for (const kw of SENTENCE_TYPE_RULES.quote.keywords) {
        if (textLower.includes(kw.toLowerCase())) return "quote"
    }

    // 4. Stats/Numbers — có con số + đơn vị
    for (const kw of SENTENCE_TYPE_RULES.stats.keywords) {
        if (textLower.includes(kw.toLowerCase())) return "stats"
    }

    // 5. Action — có động từ hành động mạnh
    for (const kw of SENTENCE_TYPE_RULES.action.keywords) {
        if (textLower.includes(kw.toLowerCase())) return "action"
    }

    // 6. List — có pattern liệt kê
    for (const kw of SENTENCE_TYPE_RULES.list.keywords) {
        if (textLower.includes(kw.toLowerCase())) return "list"
    }

    // 7. Description — câu dài (>= N từ)
    const wordCount = trimmed.split(/\s+/).length
    if (wordCount >= (SENTENCE_TYPE_RULES.description.minWords ?? 20)) return "description"

    return null
}

// ======================== PHÂN TÍCH NHỊP: QUY TẮC ========================

/**
 * Phân tích nhịp dựa trên 3 tầng quy tắc:
 *   Tầng 1: Loại câu nâng cao (8 loại từ SENTENCE_TYPE_RULES)
 *   Tầng 2: Dấu câu cuối (PACING_RULES)
 *   Tầng 3: Breathing Rule + nhóm câu ngắn
 */
export function analyzeByRules(sentences: ScriptSentence[]): PauseResult[] {
    const results: PauseResult[] = []
    let timeSinceBreath = 0  // Thời gian tích lũy cho Breathing Rule (giây)

    for (let i = 0; i < sentences.length; i++) {
        const s = sentences[i]
        const text = s.text.trim()
        const wordCount = text.split(/\s+/).length

        let pause = PACING_RULES.period.defaultPause
        let reason = "Kết thúc ý"

        // ═══ TẦNG 1: Phát hiện loại câu nâng cao ═══
        const sentType = detectSentenceType(text)
        let addPauseBefore = 0  // Pause thêm TRƯỚC câu (sẽ cộng vào câu trước)

        if (sentType) {
            const rule = SENTENCE_TYPE_RULES[sentType]
            pause = rule.pauseAfter ?? pause
            reason = rule.label + " — " + rule.description

            // Nếu loại câu có pauseBefore (timestamp, twist, quote)
            if ("pauseBefore" in rule && rule.pauseBefore && i > 0) {
                addPauseBefore = rule.pauseBefore as number
            }
        }

        // ═══ TẦNG 2: Dấu câu cuối (nếu chưa detect loại nâng cao) ═══
        if (!sentType) {
            // Câu ngắn / liệt kê
            if (wordCount <= PACING_RULES.shortSentence.maxWords) {
                pause = PACING_RULES.shortSentence.defaultPause
                reason = `Câu ngắn (${wordCount} từ)`
            }
            // Ba chấm (...)
            else if (text.endsWith("...")) {
                pause = PACING_RULES.ellipsis.defaultPause
                reason = "Bỏ lửng / suspense"
            }
            // Dấu hỏi (?)
            else if (text.endsWith("?")) {
                pause = PACING_RULES.question.defaultPause
                reason = "Câu hỏi tu từ"
            }
            // Dấu chấm than (!)
            else if (text.endsWith("!")) {
                pause = PACING_RULES.exclamation.defaultPause
                reason = "Câu cảm thán"
            }
            // Dấu chấm (.) — mặc định
            else if (text.endsWith(".")) {
                pause = PACING_RULES.period.defaultPause
                reason = "Kết thúc ý"
            }
        }

        // ═══ TẦNG 3a: Nhóm câu ngắn liên tiếp → pause = 0 (montage) ═══
        if (PACING_CONFIG.groupShortSentences && wordCount <= PACING_RULES.shortSentence.maxWords && !sentType) {
            const prevShort = i > 0 && sentences[i - 1].text.trim().split(/\s+/).length <= PACING_RULES.shortSentence.maxWords
            const nextShort = i < sentences.length - 1 && sentences[i + 1].text.trim().split(/\s+/).length <= PACING_RULES.shortSentence.maxWords
            if (prevShort || nextShort) {
                pause = 0.0
                reason = "Liệt kê dồn dập (staccato)"
            }
        }

        // ═══ TẦNG 3b: Breathing Rule ═══
        // Tích lũy thời gian, nếu vượt ngưỡng → boost pause
        const segDuration = (s.end - s.start) || 3  // Ước lượng 3s nếu không có timing
        timeSinceBreath += segDuration

        if (timeSinceBreath >= PACING_CONFIG.breathingIntervalSeconds) {
            // Đã quá lâu chưa có nhịp thở → boost pause câu này
            if (pause < 0.8) {
                pause += PACING_CONFIG.breathingPauseBoost
                reason += " + 🫁 nhịp thở"
            }
            timeSinceBreath = 0  // Reset
        }

        // Nếu câu có pause dài (>= 1s) → reset breathing counter
        if (pause >= 1.0) {
            timeSinceBreath = 0
        }

        // ═══ Cộng pauseBefore vào câu TRƯỚC ═══
        if (addPauseBefore > 0 && results.length > 0) {
            const prev = results[results.length - 1]
            // Chỉ boost nếu pause hiện tại của câu trước nhỏ hơn pauseBefore
            if (prev.pause < addPauseBefore) {
                prev.pause = parseFloat(addPauseBefore.toFixed(1))
                prev.reason += ` → +${addPauseBefore}s trước ${sentType}`
                prev.original = prev.pause
            }
        }

        // ═══ Câu cuối cùng → pause = 0 ═══
        if (PACING_CONFIG.zeroPauseLastSentence && i === sentences.length - 1) {
            pause = 0.0
            reason = "Câu cuối"
        }

        // Giới hạn min/max toàn cục
        pause = Math.max(PACING_CONFIG.globalMinPause, Math.min(PACING_CONFIG.globalMaxPause, pause))
        pause = parseFloat(pause.toFixed(1))

        results.push({ num: s.num, pause, reason, original: pause })
    }

    return results
}

// ======================== PHÂN TÍCH NHỊP: AI (BATCH SONG SONG) ========================

// Cấu hình batching
const BATCH_CONFIG = {
    batchSize: 40,      // Số câu mỗi batch (core, không tính overlap)
    overlapSize: 5,     // Số câu overlap context ở mỗi đầu
}

/**
 * Gọi AI phân tích ngữ cảnh script → gợi ý pause thông minh hơn
 * 
 * Chiến lược BATCHING:
 * - Chia script thành các batch ~40 câu
 * - Mỗi batch có 5 câu overlap ở 2 đầu để AI hiểu ngữ cảnh
 * - Prompt đánh dấu rõ: [CONTEXT BEFORE] / [ANALYZE THESE] / [CONTEXT AFTER]
 * - AI chỉ trả kết quả cho phần [ANALYZE THESE]
 * - Tất cả batch chạy SONG SONG → nhanh
 * - Ghép kết quả theo thứ tự num
 */
export async function analyzeByAI(
    sentences: ScriptSentence[],
    onProgress?: (progress: PacingProgress) => void,
): Promise<PauseResult[]> {
    // Nếu ít câu → gửi 1 lần (không cần chia batch)
    if (sentences.length <= BATCH_CONFIG.batchSize + BATCH_CONFIG.overlapSize * 2) {
        return analyzeByAISingle(sentences, 1, 1, onProgress)
    }

    // ═══ Chia batch ═══
    const batches: { core: ScriptSentence[]; contextBefore: ScriptSentence[]; contextAfter: ScriptSentence[] }[] = []
    const { batchSize, overlapSize } = BATCH_CONFIG

    for (let start = 0; start < sentences.length; start += batchSize) {
        const coreEnd = Math.min(start + batchSize, sentences.length)
        const core = sentences.slice(start, coreEnd)

        // Context trước: 5 câu overlap từ batch trước
        const ctxBeforeStart = Math.max(0, start - overlapSize)
        const contextBefore = start > 0 ? sentences.slice(ctxBeforeStart, start) : []

        // Context sau: 5 câu overlap sang batch sau
        const ctxAfterEnd = Math.min(sentences.length, coreEnd + overlapSize)
        const contextAfter = coreEnd < sentences.length ? sentences.slice(coreEnd, ctxAfterEnd) : []

        batches.push({ core, contextBefore, contextAfter })
    }

    const totalBatches = batches.length
    console.log(`[Voice Pacing] Chia ${sentences.length} câu → ${totalBatches} batch (${batchSize} câu/batch, ${overlapSize} overlap)`)

    onProgress?.({
        message: `Chia ${totalBatches} batch, đang gửi song song...`,
        step: 0,
        total: totalBatches + 1,
    })

    // ═══ Gửi tất cả batch SONG SONG ═══
    const batchPromises = batches.map(async (batch, idx) => {
        const batchNum = idx + 1
        try {
            const results = await analyzeByAIBatch(
                batch.core,
                batch.contextBefore,
                batch.contextAfter,
                batchNum,
                totalBatches,
            )
            console.log(`[Voice Pacing] Batch ${batchNum}/${totalBatches}: ${results.length} câu ✅`)
            return { batchNum, results }
        } catch (error) {
            console.error(`[Voice Pacing] Batch ${batchNum} LỖI:`, error)
            // Fallback: dùng rule-based cho batch lỗi
            const fallback = analyzeByRules(batch.core)
            return { batchNum, results: fallback }
        }
    })

    const batchResults = await Promise.all(batchPromises)

    // ═══ Ghép kết quả theo thứ tự batch ═══
    const mergedMap = new Map<number, PauseResult>()
    for (const { results } of batchResults.sort((a, b) => a.batchNum - b.batchNum)) {
        for (const r of results) {
            // Ưu tiên kết quả đầu tiên (batch trước, vì overlap context tốt hơn)
            if (!mergedMap.has(r.num)) {
                mergedMap.set(r.num, r)
            }
        }
    }

    // Sắp xếp theo thứ tự câu gốc
    const allResults: PauseResult[] = sentences.map((s, i) => {
        const r = mergedMap.get(s.num)
        if (r) {
            // Câu cuối → pause = 0
            if (PACING_CONFIG.zeroPauseLastSentence && i === sentences.length - 1) {
                return { ...r, pause: 0, reason: "Câu cuối", original: 0 }
            }
            return r
        }
        // Fallback: mặc định
        return { num: s.num, pause: PACING_RULES.period.defaultPause, reason: "Mặc định", original: PACING_RULES.period.defaultPause }
    })

    onProgress?.({
        message: `✅ Hoàn tất! ${allResults.length} câu, ${totalBatches} batch`,
        step: totalBatches + 1,
        total: totalBatches + 1,
    })

    return allResults
}

// ════════════════════════════════════════════════
// Helper: Gửi 1 batch cho AI (có context overlap)
// ════════════════════════════════════════════════

async function analyzeByAIBatch(
    coreSentences: ScriptSentence[],
    contextBefore: ScriptSentence[],
    contextAfter: ScriptSentence[],
    batchNum: number,
    totalBatches: number,
): Promise<PauseResult[]> {
    const { callAIMultiProvider } = await import("@/utils/ai-provider")

    // Build script text với đánh dấu context rõ ràng
    let scriptText = ""

    if (contextBefore.length > 0) {
        scriptText += "--- CONTEXT BEFORE (for reference only, DO NOT include in output) ---\n"
        scriptText += contextBefore.map(s => `${s.num}. ${s.text}`).join("\n")
        scriptText += "\n\n"
    }

    scriptText += "--- ANALYZE THESE SENTENCES (return pause for these ONLY) ---\n"
    scriptText += coreSentences.map(s => `${s.num}. ${s.text}`).join("\n")

    if (contextAfter.length > 0) {
        scriptText += "\n\n--- CONTEXT AFTER (for reference only, DO NOT include in output) ---\n"
        scriptText += contextAfter.map(s => `${s.num}. ${s.text}`).join("\n")
    }

    // Build prompt
    const prompt = buildVoicePacingPrompt(scriptText)

    // Round-robin Claude/Gemini
    const aiContent = await callAIMultiProvider(
        prompt,
        `Voice Pacing Batch ${batchNum}/${totalBatches} (${coreSentences.length} câu)`,
        "auto",
        AI_CONFIG.timeoutMs
    )

    const parsed = parseAIPacingResponse(aiContent)

    // Chỉ lấy kết quả cho core sentences (loại bỏ context nếu AI trả về)
    const coreNums = new Set(coreSentences.map(s => s.num))
    const coreResults = parsed.filter(p => coreNums.has(p.num))

    // Map vào PauseResult
    return coreSentences.map(s => {
        const aiResult = coreResults.find(p => p.num === s.num)
        const pause = aiResult
            ? Math.max(PACING_CONFIG.globalMinPause, Math.min(PACING_CONFIG.globalMaxPause, aiResult.pause))
            : PACING_RULES.period.defaultPause
        const reason = aiResult?.reason || "Mặc định"
        const rounded = parseFloat(pause.toFixed(1))
        return { num: s.num, pause: rounded, reason, original: rounded }
    })
}

// ════════════════════════════════════════════════
// Helper: Gửi 1 lần riêng cho script ngắn (≤ batchSize + overlap)
// ════════════════════════════════════════════════

async function analyzeByAISingle(
    sentences: ScriptSentence[],
    batchNum: number,
    totalBatches: number,
    onProgress?: (progress: PacingProgress) => void,
): Promise<PauseResult[]> {
    onProgress?.({ message: "Script ngắn — gửi 1 lần...", step: 1, total: 3 })

    try {
        const results = await analyzeByAIBatch(sentences, [], [], batchNum, totalBatches)

        // Câu cuối → pause = 0
        const final = results.map((r, i) => {
            if (PACING_CONFIG.zeroPauseLastSentence && i === results.length - 1) {
                return { ...r, pause: 0, reason: "Câu cuối", original: 0 }
            }
            return r
        })

        onProgress?.({ message: `✅ Hoàn tất! ${final.length} câu`, step: 3, total: 3 })
        return final
    } catch (err) {
        throw err
    }
}

/**
 * Parse JSON từ AI response cho voice pacing
 * AI trả về: [{ "num": 1, "pause": 0.8, "reason": "..." }]
 */
function parseAIPacingResponse(aiResponse: string): { num: number; pause: number; reason: string }[] {
    // Bỏ thinking tags
    let cleaned = aiResponse.replace(/<thinking>[\s\S]*?<\/thinking>/g, "")

    // Bỏ markdown code block  
    const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (codeBlock) cleaned = codeBlock[1]

    // Tìm JSON array
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
        console.error("[Voice Pacing] AI response không có JSON:", cleaned.slice(0, 500))
        throw new Error("AI response không chứa JSON array")
    }

    const parsed = JSON.parse(jsonMatch[0])
    if (!Array.isArray(parsed)) throw new Error("Không phải array")

    return parsed
        .filter((r: any) =>
            typeof r.num === "number" &&
            typeof r.pause === "number"
        )
        .map((r: any) => ({
            num: r.num,
            pause: Math.max(0, r.pause),
            reason: typeof r.reason === "string" ? r.reason : "",
        }))
}

// ======================== HELPER: DETECT CODEC THEO EXTENSION ========================

/**
 * Tự động chọn codec FFmpeg dựa vào extension của file
 * WAV → pcm_s16le (lossless, DaVinci ưa thích)
 * MP3 → libmp3lame
 * M4A/AAC/MP4 → aac
 * @returns { codec, bitrate, extraArgs } — args truyền vào FFmpeg
 */
function detectAudioCodec(filePath: string): { codec: string; bitrateArg: string[] } {
    const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
    switch (ext) {
        case "wav":
            // PCM 16-bit lossless — DaVinci Resolve import chuẩn nhất
            return { codec: "pcm_s16le", bitrateArg: [] }
        case "mp3":
            return { codec: "libmp3lame", bitrateArg: ["-b:a", "192k"] }
        case "flac":
            return { codec: "flac", bitrateArg: [] }
        case "m4a":
        case "aac":
        case "mp4":
            return { codec: "aac", bitrateArg: ["-b:a", "192k"] }
        default:
            // Mặc định AAC tương thích cao
            return { codec: "aac", bitrateArg: ["-b:a", "192k"] }
    }
}

// ======================== FFMPEG: CẮT + CHÈN SILENCE ========================

/**
 * Dùng FFmpeg cắt audio gốc theo matching data, chèn silence giữa các câu
 * 
 * Quy trình:
 * 1. Tạo FFmpeg filter phức hợp:
 *    - Cắt từng đoạn câu (atrim)
 *    - Tạo silence với duration tùy ý (anullsrc)
 *    - Nối tất cả lại (concat)
 * 2. Xuất ra file audio mới
 * 
 * @param audioPath - Đường dẫn file audio gốc
 * @param sentences - Danh sách câu (có start/end timing)
 * @param pauses - Khoảng nghỉ sau mỗi câu
 * @param outputPath - Đường dẫn file output
 * @param onProgress - Callback progress
 */
export async function processAudioWithFFmpeg(
    audioPath: string,
    sentences: ScriptSentence[],
    pauses: PauseResult[],
    outputPath: string,
    onProgress?: (progress: PacingProgress) => void,
): Promise<{
    success: boolean
    outputPath: string
    newSentences: ScriptSentence[]  // Matching data mới (timing đã dịch)
    totalAdded: number              // Tổng thời gian thêm vào (giây)
    error?: string
}> {
    const logId = generateLogId()
    const startTime = Date.now()

    onProgress?.({ message: "Đang chuẩn bị FFmpeg filter...", step: 1, total: 4 })

    // Phát hiện codec từ extension output (chất lượng FFmpeg encode)
    const { codec, bitrateArg } = detectAudioCodec(outputPath)
    console.log(`[Voice Pacing] Output: ${outputPath} → codec: ${codec}`)

    try {
        // Sắp xếp theo thứ tự start time
        const sorted = [...sentences].sort((a, b) => a.start - b.start)

        // Tạo map pause: num → pause
        const pauseMap = new Map(pauses.map(p => [p.num, p.pause]))

        // ════════════════════════════════════════════════
        // Xây dựng FFmpeg filter_complex
        // ════════════════════════════════════════════════
        // Strategy: dùng atrim để cắt từng đoạn, anullsrc để tạo silence,
        // rồi concat nối tất cả lại

        const filterParts: string[] = []
        const concatInputs: string[] = []
        let filterIdx = 0

        for (let i = 0; i < sorted.length; i++) {
            const s = sorted[i]
            const pause = pauseMap.get(s.num) ?? 0

            // Cắt đoạn audio cho câu này
            filterParts.push(
                `[0:a]atrim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},asetpts=PTS-STARTPTS[seg${filterIdx}]`
            )
            concatInputs.push(`[seg${filterIdx}]`)
            filterIdx++

            // Nếu có pause > 0 → tạo silence
            if (pause > 0 && i < sorted.length - 1) {
                // anullsrc tạo đoạn im lặng, FFmpeg tự convert sample_fmt khi encode
                // KHÔNG dùng sample_fmt trong anullsrc — option không tồn tại
                filterParts.push(
                    `anullsrc=r=44100:cl=stereo,atrim=duration=${pause.toFixed(3)},asetpts=PTS-STARTPTS[sil${filterIdx}]`
                )
                concatInputs.push(`[sil${filterIdx}]`)
                filterIdx++
            }
        }

        // Concat tất cả segments + silences
        const concatCount = concatInputs.length
        const filterComplex = filterParts.join(";") +
            ";" +
            concatInputs.join("") +
            `concat=n=${concatCount}:v=0:a=1[out]`

        // Log vào Debug panel
        addDebugLog({
            id: logId,
            timestamp: new Date(),
            method: "CLI",
            url: "FFmpeg",
            requestHeaders: {},
            requestBody: `ffmpeg -i "${audioPath}" -filter_complex "..." -map [out] "${outputPath}"`,
            status: null,
            responseHeaders: {},
            responseBody: "(đang chạy...)",
            duration: 0,
            error: null,
            label: `Voice Pacing FFmpeg (${sorted.length} segments)`,
        })

        onProgress?.({ message: `Đang xử lý ${sorted.length} đoạn audio...`, step: 2, total: 4 })

        // ════════════════════════════════════════════════
        // Gọi FFmpeg qua Tauri shell
        // ════════════════════════════════════════════════
        // Thử sidecar trước, nếu không có thì dùng system ffmpeg

        let exitCode: number
        let stdout: string
        let stderr: string

        // Build FFmpeg args chung (dùng cho sidecar và system)
        const ffmpegArgs = [
            "-y",                           // Ghi đè output nếu có
            "-i", audioPath,                // Input file
            "-filter_complex", filterComplex,
            "-map", "[out]",                // Map output stream
            "-c:a", codec,                  // Codec tự detect theo extension
            ...bitrateArg,                  // Bitrate nếu cần (WAV không cần)
            outputPath,                     // Output file
        ]

        try {
            // Thử sidecar bundled ffmpeg trước
            const cmd = Command.sidecar("binaries/ffmpeg", ffmpegArgs)
            const output = await cmd.execute()
            exitCode = output.code ?? -1
            stdout = output.stdout
            stderr = output.stderr
        } catch {
            // Fallback: dùng system ffmpeg
            console.log("[Voice Pacing] Sidecar không khả dụng, dùng system FFmpeg...")
            const cmd = Command.create("ffmpeg", ffmpegArgs)
            const output = await cmd.execute()
            exitCode = output.code ?? -1
            stdout = output.stdout
            stderr = output.stderr
        }

        const duration = Date.now() - startTime

        if (exitCode !== 0) {
            updateDebugLog(logId, {
                status: 500,
                responseBody: stderr || stdout,
                duration,
                error: `FFmpeg exit code: ${exitCode}`,
            })
            return {
                success: false,
                outputPath: "",
                newSentences: [],
                totalAdded: 0,
                error: `FFmpeg lỗi (code ${exitCode}): ${stderr.slice(0, 500)}`,
            }
        }

        onProgress?.({ message: "Đang tính timing mới...", step: 3, total: 4 })

        // ════════════════════════════════════════════════
        // Tính matching data mới (timing đã dịch chuyển)
        // ════════════════════════════════════════════════
        let cumulativeShift = 0 // Tổng thời gian đã thêm vào
        const newSentences: ScriptSentence[] = []

        for (let i = 0; i < sorted.length; i++) {
            const s = sorted[i]
            const pause = pauseMap.get(s.num) ?? 0
            const segDuration = s.end - s.start

            // Vị trí mới = vị trí gốc + tổng pause đã thêm trước đó
            // Nhưng vì ta cắt từng đoạn, vị trí mới = tính từ đầu file mới
            const newStart = (i === 0) ? 0 : newSentences[newSentences.length - 1].end + (pauseMap.get(sorted[i - 1].num) ?? 0)
            const newEnd = newStart + segDuration

            newSentences.push({
                ...s,
                start: parseFloat(newStart.toFixed(3)),
                end: parseFloat(newEnd.toFixed(3)),
            })

            cumulativeShift += pause
        }

        // Log thành công
        updateDebugLog(logId, {
            status: 200,
            responseBody: JSON.stringify({
                segments: sorted.length,
                totalAdded: cumulativeShift.toFixed(1) + "s",
                outputPath,
                duration: duration + "ms",
            }, null, 2),
            duration,
            error: null,
        })

        onProgress?.({ message: `✅ Hoàn tất! +${cumulativeShift.toFixed(1)}s`, step: 4, total: 4 })

        return {
            success: true,
            outputPath,
            newSentences,
            totalAdded: cumulativeShift,
        }
    } catch (error) {
        const duration = Date.now() - startTime
        updateDebugLog(logId, {
            duration,
            error: String(error),
            responseBody: `(Lỗi: ${String(error)})`,
        })
        return {
            success: false,
            outputPath: "",
            newSentences: [],
            totalAdded: 0,
            error: String(error),
        }
    }
}

// ======================== LƯU MATCHING DATA MỚI ========================

/**
 * Lưu matching data mới (timing đã cập nhật sau khi chèn silence)
 * Vào file autosubs_matching_paced.json cùng folder
 */
export async function savePacedMatchingData(
    outputFolder: string,
    sentences: ScriptSentence[],
): Promise<string> {
    const fileName = "autosubs_matching_paced.json"
    const filePath = await join(outputFolder, fileName)
    const data = {
        version: 2,
        type: "paced",
        savedAt: new Date().toISOString(),
        totalSentences: sentences.length,
        results: sentences,
    }
    await writeTextFile(filePath, JSON.stringify(data, null, 2))
    console.log(`[Voice Pacing] ✅ Lưu matching data mới: ${filePath}`)
    return filePath
}
