// whisper-words-matcher.ts
// ═══════════════════════════════════════════════════════════════
// Util: Khớp displayText (từ AI rút gọn) với whisper word-level timestamps
// để tìm chính xác start/end thời gian hiển thị text on screen
//
// Logic tương tự Media Import: normalize text → fuzzy match → lấy start/end
// ═══════════════════════════════════════════════════════════════

import { readTextFile } from "@tauri-apps/plugin-fs";

// ======================== TYPES ========================

/**
 * 1 word từ file autosubs_whisper_words.json
 * t = start time (giây), w = word text, e = end time (giây)
 */
export interface WhisperWord {
    t: number;
    w: string;
    e: number;
}

/**
 * File autosubs_whisper_words.json structure
 */
export interface WhisperWordsFile {
    version: number;
    exportedAt: string;
    totalWords: number;
    totalDuration: number;
    words: WhisperWord[];
}

/**
 * Kết quả matching: start/end chính xác từ whisper words
 */
export interface WordMatchResult {
    /** Thời điểm bắt đầu hiển thị (giây) — start của từ đầu tiên match */
    start: number;
    /** Thời điểm kết thúc hiển thị (giây) — end của từ cuối cùng match */
    end: number;
    /** Các từ whisper đã match (để debug) */
    matchedWords: string[];
    /** Có match thành công không */
    success: boolean;
    /** Lý do nếu thất bại */
    error?: string;
}

// ======================== LOAD FILE ========================

/**
 * Đọc file autosubs_whisper_words.json từ đường dẫn
 * @param filePath - Đường dẫn đầy đủ đến file .json
 * @returns WhisperWordsFile hoặc null nếu lỗi
 */
export async function loadWhisperWordsJsonFile(filePath: string): Promise<WhisperWordsFile | null> {
    try {
        const content = await readTextFile(filePath);
        const parsed = JSON.parse(content);

        // Validate cấu trúc file
        if (!parsed.words || !Array.isArray(parsed.words)) {
            console.error("[WhisperWordsMatcher] File JSON không có mảng 'words'");
            return null;
        }

        console.log(`[WhisperWordsMatcher] Loaded ${parsed.words.length} words từ JSON`);
        return parsed as WhisperWordsFile;
    } catch (error) {
        console.error("[WhisperWordsMatcher] Lỗi đọc file JSON:", error);
        return null;
    }
}

/**
 * Đọc file autosubs_whisper_words.txt (format gọn: [0.13] February [0.77] twenty ...)
 * Parse từng cặp [time] word, tính end = start của word kế tiếp
 * @param filePath - Đường dẫn đầy đủ đến file .txt
 * @returns WhisperWordsFile hoặc null nếu lỗi
 */
export async function loadWhisperWordsTxtFile(filePath: string): Promise<WhisperWordsFile | null> {
    try {
        const content = await readTextFile(filePath);

        // Parse format: [0.13] February [0.77] twenty [1.01] second,
        // Regex: bắt cặp [time] word
        const regex = /\[(\d+\.\d+)\]\s+([^\[]+)/g;
        const words: WhisperWord[] = [];
        let match;

        while ((match = regex.exec(content)) !== null) {
            const startTime = parseFloat(match[1]);
            const wordText = match[2].trim();
            if (!isNaN(startTime) && wordText.length > 0) {
                words.push({
                    t: startTime,
                    w: wordText,
                    e: 0, // Sẽ tính sau
                });
            }
        }

        // Tính end time = start của word kế tiếp (word cuối: end = start + 0.3s)
        for (let i = 0; i < words.length; i++) {
            if (i < words.length - 1) {
                words[i].e = words[i + 1].t;
            } else {
                words[i].e = words[i].t + 0.3;
            }
        }

        if (words.length === 0) {
            console.error("[WhisperWordsMatcher] File TXT không parse được word nào");
            return null;
        }

        const totalDuration = words[words.length - 1].e;
        console.log(`[WhisperWordsMatcher] Loaded ${words.length} words từ TXT (${totalDuration.toFixed(0)}s)`);

        return {
            version: 1,
            exportedAt: "",
            totalWords: words.length,
            totalDuration,
            words,
        };
    } catch (error) {
        console.error("[WhisperWordsMatcher] Lỗi đọc file TXT:", error);
        return null;
    }
}

/**
 * Auto-detect format dựa trên extension (.txt hoặc .json)
 * @param filePath - Đường dẫn file
 * @returns WhisperWordsFile hoặc null
 */
export async function loadWhisperWordsFile(filePath: string): Promise<WhisperWordsFile | null> {
    const ext = filePath.toLowerCase().split(".").pop();
    if (ext === "txt") {
        return loadWhisperWordsTxtFile(filePath);
    } else {
        return loadWhisperWordsJsonFile(filePath);
    }
}

// ======================== NORMALIZE ========================

/**
 * Normalize text để so sánh: lowercase, bỏ dấu câu, trim
 * Ví dụ: "Fifty billion dollars." → "fifty billion dollars"
 */
function normalizeWord(word: string): string {
    return word
        .toLowerCase()
        .replace(/[.,!?;:'"()\[\]{}\-—–…]/g, "")  // Bỏ dấu câu
        .replace(/\s+/g, " ")                       // Gộp khoảng trắng
        .trim();
}

/**
 * Tách chuỗi matchWords thành mảng từ đã normalize
 * Ví dụ: "fifty billion dollars" → ["fifty", "billion", "dollars"]
 */
function tokenize(text: string): string[] {
    return normalizeWord(text)
        .split(" ")
        .filter((w) => w.length > 0);
}

// ======================== MATCHING ========================

/**
 * Tìm chuỗi từ liên tiếp trong whisper words (trong phạm vi câu)
 * 
 * Thuật toán:
 * 1. Lọc whisper words trong phạm vi [sentenceStart - margin, sentenceEnd + margin]
 * 2. Tìm từ đầu tiên của matchWords trong danh sách đã lọc
 * 3. Kiểm tra các từ tiếp theo có match liên tiếp không
 * 4. Trả về start của từ đầu, end của từ cuối
 *
 * @param matchWordsRaw - Chuỗi từ gốc narrator nói (AI trả về), VD: "fifty billion dollars"
 * @param whisperWords - Toàn bộ mảng whisper words
 * @param sentenceStart - Start time của câu (giây) — để giới hạn phạm vi tìm
 * @param sentenceEnd - End time của câu (giây)
 * @returns WordMatchResult với start/end chính xác
 */
export function matchWordsToTimestamps(
    matchWordsRaw: string,
    whisperWords: WhisperWord[],
    sentenceStart: number,
    sentenceEnd: number
): WordMatchResult {
    // Tokenize matchWords
    const tokens = tokenize(matchWordsRaw);
    if (tokens.length === 0) {
        return { start: sentenceStart, end: sentenceEnd, matchedWords: [], success: false, error: "matchWords rỗng" };
    }

    // Margin: mở rộng phạm vi tìm thêm 2 giây mỗi bên (do timing Whisper có thể lệch nhẹ)
    const MARGIN = 2.0;
    const searchStart = sentenceStart - MARGIN;
    const searchEnd = sentenceEnd + MARGIN;

    // Lọc whisper words trong phạm vi câu
    const candidateWords = whisperWords.filter(
        (w) => w.t >= searchStart && w.t <= searchEnd
    );

    if (candidateWords.length === 0) {
        return { start: sentenceStart, end: sentenceEnd, matchedWords: [], success: false, error: "Không tìm thấy whisper words trong phạm vi câu" };
    }

    // Tìm chuỗi match liên tiếp
    // Duyệt từng vị trí bắt đầu có thể
    for (let i = 0; i <= candidateWords.length - tokens.length; i++) {
        let allMatch = true;
        const matchedWordsDebug: string[] = [];

        for (let j = 0; j < tokens.length; j++) {
            const whisperNorm = normalizeWord(candidateWords[i + j].w);
            const tokenNorm = tokens[j];

            // Fuzzy match: kiểm tra whisperWord có CHỨA token không
            // Vì whisper có thể gộp 2 từ (ví dụ: "of Tapalpa," là 1 word)
            if (whisperNorm === tokenNorm || whisperNorm.includes(tokenNorm) || tokenNorm.includes(whisperNorm)) {
                matchedWordsDebug.push(candidateWords[i + j].w);
            } else {
                allMatch = false;
                break;
            }
        }

        if (allMatch) {
            const firstWord = candidateWords[i];
            const lastWord = candidateWords[i + tokens.length - 1];

            return {
                start: firstWord.t,
                end: lastWord.e,
                matchedWords: matchedWordsDebug,
                success: true,
            };
        }
    }

    // Fallback: nếu không match liên tiếp được, thử tìm từng từ riêng lẻ
    // Lấy start của từ đầu tiên match, end của từ cuối cùng match
    const firstToken = tokens[0];
    const lastToken = tokens[tokens.length - 1];

    let firstMatch: WhisperWord | null = null;
    let lastMatch: WhisperWord | null = null;
    const partialMatched: string[] = [];

    for (const w of candidateWords) {
        const wNorm = normalizeWord(w.w);

        // Tìm từ đầu tiên
        if (!firstMatch && (wNorm === firstToken || wNorm.includes(firstToken) || firstToken.includes(wNorm))) {
            firstMatch = w;
            partialMatched.push(w.w);
        }

        // Tìm từ cuối cùng (lấy lần cuối match)
        if (wNorm === lastToken || wNorm.includes(lastToken) || lastToken.includes(wNorm)) {
            lastMatch = w;
            if (!partialMatched.includes(w.w)) {
                partialMatched.push(w.w);
            }
        }
    }

    if (firstMatch && lastMatch) {
        return {
            start: firstMatch.t,
            end: lastMatch.e,
            matchedWords: partialMatched,
            success: true,
        };
    }

    // Không match được gì → fallback về sentence timing
    return {
        start: sentenceStart,
        end: sentenceEnd,
        matchedWords: [],
        success: false,
        error: `Không tìm thấy "${matchWordsRaw}" trong whisper words`,
    };
}

// ======================== BATCH MATCHING ========================

/**
 * Interface cho 1 assignment cần matching
 */
export interface AssignmentToMatch {
    sentenceNum: number;
    matchWords: string;
    sentenceStart: number;
    sentenceEnd: number;
}

/**
 * Batch match: khớp nhiều assignments cùng lúc
 * @param assignments - Danh sách assignments cần match
 * @param whisperWords - Toàn bộ whisper words
 * @returns Map<sentenceNum, WordMatchResult>
 */
export function batchMatchWordsToTimestamps(
    assignments: AssignmentToMatch[],
    whisperWords: WhisperWord[]
): Map<number, WordMatchResult> {
    const results = new Map<number, WordMatchResult>();

    for (const a of assignments) {
        const result = matchWordsToTimestamps(
            a.matchWords,
            whisperWords,
            a.sentenceStart,
            a.sentenceEnd
        );
        results.set(a.sentenceNum, result);

        // Debug log
        if (result.success) {
            console.log(
                `[WhisperWordsMatcher] Câu ${a.sentenceNum}: ✅ "${a.matchWords}" → ${result.start.toFixed(2)}s - ${result.end.toFixed(2)}s [${result.matchedWords.join(", ")}]`
            );
        } else {
            console.log(
                `[WhisperWordsMatcher] Câu ${a.sentenceNum}: ⚠️ Fallback — ${result.error}`
            );
        }
    }

    const successCount = Array.from(results.values()).filter((r) => r.success).length;
    console.log(
        `[WhisperWordsMatcher] Batch done: ${successCount}/${assignments.length} matched successfully`
    );

    return results;
}
