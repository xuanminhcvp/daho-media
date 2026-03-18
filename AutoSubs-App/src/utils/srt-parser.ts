// srt-parser.ts
// ═══════════════════════════════════════════════════════════════
// Parse file SRT (Whisper output) → lấy timing chính xác từng đoạn
// Dùng để cắt audio theo thời điểm THỰC trong file WAV/MP3
// ═══════════════════════════════════════════════════════════════

import { readTextFile } from "@tauri-apps/plugin-fs"
import type { ScriptSentence } from "@/utils/media-matcher"

// ======================== TYPES ========================

/** Một entry trong file SRT (Whisper output) */
export interface SRTEntry {
    index: number    // Số thứ tự SRT (1-based)
    start: number    // Thời điểm bắt đầu (giây, float)
    end: number      // Thời điểm kết thúc (giây, float)
    text: string     // Nội dung transcript (đã lowercase)
}

// ======================== PARSER ========================

/**
 * Parse file SRT thành mảng SRTEntry
 * Format SRT chuẩn:
 *   1
 *   00:00:00,033 --> 00:00:03,033
 *   some text here
 */
export function parseSRT(content: string): SRTEntry[] {
    const entries: SRTEntry[] = []

    // Tách ra từng block (phân cách bằng dòng trắng)
    const blocks = content.trim().split(/\n\s*\n/)

    for (const block of blocks) {
        const lines = block.trim().split("\n").map(l => l.trim()).filter(Boolean)
        if (lines.length < 3) continue

        // Dòng 1: số thứ tự
        const index = parseInt(lines[0], 10)
        if (isNaN(index)) continue

        // Dòng 2: timing "HH:MM:SS,mmm --> HH:MM:SS,mmm"
        const timingMatch = lines[1].match(
            /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/
        )
        if (!timingMatch) continue

        const start = parseTimestamp(
            timingMatch[1], timingMatch[2], timingMatch[3], timingMatch[4]
        )
        const end = parseTimestamp(
            timingMatch[5], timingMatch[6], timingMatch[7], timingMatch[8]
        )

        // Dòng 3+: text (có thể nhiều dòng)
        const text = lines.slice(2).join(" ").toLowerCase().trim()

        entries.push({ index, start, end, text })
    }

    return entries
}

/** Convert HH:MM:SS,mmm → giây (float) */
function parseTimestamp(h: string, m: string, s: string, ms: string): number {
    return (
        parseInt(h, 10) * 3600 +
        parseInt(m, 10) * 60 +
        parseInt(s, 10) +
        parseInt(ms, 10) / 1000
    )
}

// ======================== LOAD SRT ========================

/**
 * Đọc và parse file SRT từ đường dẫn
 */
export async function loadSRTFile(srtPath: string): Promise<SRTEntry[]> {
    const content = await readTextFile(srtPath)
    const entries = parseSRT(content)
    console.log(`[SRT Parser] Loaded ${entries.length} entries from ${srtPath}`)
    return entries
}

// ======================== MATCHING: SRT → SCRIPT ========================

/**
 * Normalize text: lowercase, bỏ dấu câu, nhiều khoảng trắng → 1 space
 * Dùng để so khớp text mờ giữa SRT và matching.json
 */
function normalizeText(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")  // bỏ dấu câu
        .replace(/\s+/g, " ")
        .trim()
}

/**
 * Tính độ tương đồng n-gram giữa 2 chuỗi (0–1)
 * Dùng để tìm SRT segments phù hợp nhất với script sentence
 */
function ngramSimilarity(a: string, b: string, n = 3): number {
    const ngrams = (s: string) => {
        const tokens = s.split(" ")
        const result = new Set<string>()
        for (let i = 0; i <= tokens.length - n; i++) {
            result.add(tokens.slice(i, i + n).join(" "))
        }
        return result
    }
    const aNgrams = ngrams(a)
    const bNgrams = ngrams(b)
    if (aNgrams.size === 0 || bNgrams.size === 0) return 0
    let intersection = 0
    for (const g of aNgrams) {
        if (bNgrams.has(g)) intersection++
    }
    return intersection / Math.max(aNgrams.size, bNgrams.size)
}

/**
 * Ánh xạ từng ScriptSentence sang SRT entries chính xác nhất
 * 
 * Chiến lược:
 * 1. Script sentence có matchedWhisper (text Whisper tương ứng) → so khớp text đó
 * 2. Tìm chuỗi SRT entries liên tiếp bao phủ matchedWhisper tốt nhất
 * 3. Lấy start của entry đầu tiên, end của entry cuối cùng → timing chính xác
 * 
 * @param sentences - Danh sách câu từ matching.json (có matchedWhisper)
 * @param srtEntries - Danh sách SRT entries (từ parseSRT)
 * @returns sentences với start/end được cập nhật theo SRT timing
 */
export function mapSentencesToSRT(
    sentences: ScriptSentence[],
    srtEntries: SRTEntry[],
): ScriptSentence[] {
    const mapped: ScriptSentence[] = []
    let srtSearchStart = 0  // Tìm từ vị trí này trở đi (tránh tìm lại đầu file)

    for (const sentence of sentences) {
        // Lấy Whisper text đã match (từ matching.json), hoặc dùng text gốc
        const targetRaw = (sentence as any).matchedWhisper || sentence.text
        // Loại bỏ nếu AI không match được
        if (targetRaw === "(AI không trả về)") {
            // Giữ nguyên timing matching.json cho câu bị miss
            mapped.push(sentence)
            continue
        }
        const target = normalizeText(targetRaw)

        // Tìm window SRT entries tốt nhất trong phạm vi ±20 entry từ vị trí hiện tại
        const windowStart = Math.max(0, srtSearchStart - 3)
        const windowEnd = Math.min(srtEntries.length, srtSearchStart + 30)
        const window = srtEntries.slice(windowStart, windowEnd)

        // Thử gộp 1-5 entries liên tiếp, tìm tổ hợp có similarity cao nhất
        let bestScore = 0
        let bestStart = sentence.start  // Fallback: giữ timing cũ
        let bestEnd = sentence.end
        let bestSRTIdx = srtSearchStart

        for (let i = 0; i < window.length; i++) {
            let combinedText = ""
            for (let j = i; j < Math.min(i + 7, window.length); j++) {
                combinedText = (combinedText + " " + window[j].text).trim()
                const score = ngramSimilarity(target, combinedText)
                if (score > bestScore) {
                    bestScore = score
                    bestStart = window[i].start
                    bestEnd = window[j].end
                    bestSRTIdx = windowStart + i
                }
                // Nếu đã có điểm cao thì không cần thêm entry nữa
                if (score > 0.85) break
            }
            if (bestScore > 0.85) break
        }

        // Cập nhật vị trí tìm kiếm cho câu tiếp theo
        if (bestScore > 0.3) {
            srtSearchStart = bestSRTIdx + 1
        }

        const updated: ScriptSentence = {
            ...sentence,
            start: parseFloat(bestStart.toFixed(3)),
            end: parseFloat(bestEnd.toFixed(3)),
        }

        // Log nếu không tìm được (score thấp)
        if (bestScore < 0.3) {
            console.warn(
                `[SRT Map] Câu #${sentence.num} score=${bestScore.toFixed(2)} — giữ timing cũ`,
                sentence.text.slice(0, 50)
            )
        }

        mapped.push(updated)
    }

    console.log(`[SRT Map] Đã map ${mapped.length} câu sang SRT timing`)
    return mapped
}

// ======================== SRT → TRANSCRIPT (cho AI Matcher) ========================

/**
 * Convert SRT entries → cấu trúc "transcript" giả lập mà aiMatchScriptToTimeline hiểu
 *
 * aiMatchScriptToTimeline đọc transcript.segments[].words[] để lấy timing.
 * Vì SRT không có word-level timing, ta coi mỗi SRT entry là 1 "word" segment.
 * AI Matcher vẫn hoạt động tốt vì cần start/end của từng đoạn, không cần từng từ.
 *
 * Dùng khi người dùng đã có SRT từ tab Subtitles → bỏ qua bước Whisper hoàn toàn.
 */
export function srtToTranscript(srtEntries: SRTEntry[]): any {
    // Mỗi SRT entry → 1 segment có 1 "word" (text đầy đủ của segment đó)
    const segments = srtEntries.map((entry) => ({
        start: entry.start,
        end: entry.end,
        text: entry.text,  // text đã lowercase từ parseSRT
        // Tạo words array giả: mỗi từ trong entry có timing tuyến tính
        words: splitEntryToWords(entry),
    }))

    return {
        // Cấu trúc tương thích với extractWhisperWords() trong media-matcher.ts
        originalSegments: segments,
        segments,
    }
}

/**
 * Chia text của 1 SRT entry thành array "words" với timing tuyến tính
 * Không có word-level timing thực → chia đều thời gian cho từng từ
 */
function splitEntryToWords(entry: SRTEntry): { word: string; start: number; end: number }[] {
    const words = entry.text.split(/\s+/).filter(Boolean)
    if (words.length === 0) return []

    const duration = entry.end - entry.start
    const perWord = duration / words.length  // Thời gian mỗi từ (chia đều)

    return words.map((word, i) => ({
        word,
        start: parseFloat((entry.start + i * perWord).toFixed(3)),
        end: parseFloat((entry.start + (i + 1) * perWord).toFixed(3)),
    }))
}
