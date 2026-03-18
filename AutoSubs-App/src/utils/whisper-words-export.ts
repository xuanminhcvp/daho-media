// whisper-words-export.ts
// ═══════════════════════════════════════════════════════════════
// Util: Trích xuất word-level timestamps từ Whisper transcript
// và lưu thành file autosubs_whisper_words.txt (format text gọn)
// Format: [start] word [start] word ... (giống ai-matcher dùng)
// ═══════════════════════════════════════════════════════════════

import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { Subtitle } from "@/types/interfaces";

/**
 * Cấu trúc 1 word đã format
 * Dùng nội bộ để xử lý trước khi xuất text
 */
interface FormattedWord {
    /** Thời điểm bắt đầu nói từ này (giây) */
    start: number;
    /** Nội dung từ */
    text: string;
    /** Chuỗi đã format: "[0.13] February" */
    formatted: string;
}

/**
 * Trích xuất TOÀN BỘ word-level timestamps từ originalSegments
 * Trả về mảng words đã format dạng [time] word
 *
 * @param originalSegments - Mảng segment gốc từ Whisper (chứa words[])
 * @returns Mảng FormattedWord đã sort theo thời gian
 */
function extractAndFormatWords(originalSegments: Subtitle[]): FormattedWord[] {
    const allWords: FormattedWord[] = [];

    for (const segment of originalSegments) {
        // Mỗi segment có mảng words[] chứa timing từng từ
        if (segment.words && segment.words.length > 0) {
            for (const word of segment.words) {
                const wordText = (word.word || "").trim();
                if (!wordText) continue;

                // Parse start — có thể là string hoặc number
                const start = typeof word.start === "string" ? parseFloat(word.start) : word.start;

                // Chỉ lấy word có timing hợp lệ
                if (!isNaN(start)) {
                    allWords.push({
                        start: Math.round(start * 100) / 100,
                        text: wordText,
                        // Format giống ai-matcher: [0.13] February
                        formatted: `[${start.toFixed(2)}] ${wordText}`,
                    });
                }
            }
        }
    }

    // Sort theo thời gian bắt đầu (đảm bảo thứ tự)
    allWords.sort((a, b) => a.start - b.start);

    return allWords;
}

/**
 * Tạo nội dung file text từ originalSegments
 * Format: [0.13] February [0.77] twenty [1.01] second, ...
 * Gọn gàng, dễ đọc, nhẹ hơn JSON ~60%
 *
 * @param originalSegments - Mảng segment gốc từ Whisper
 * @returns Chuỗi text sẵn sàng để lưu file
 */
export function buildWhisperWordsText(originalSegments: Subtitle[]): {
    text: string;
    totalWords: number;
    totalDuration: number;
} {
    const words = extractAndFormatWords(originalSegments);

    // Tính tổng thời lượng từ word cuối cùng
    const totalDuration = words.length > 0 ? words[words.length - 1].start : 0;

    // Nối tất cả words thành 1 chuỗi text dài
    const text = words.map((w) => w.formatted).join(" ");

    return {
        text,
        totalWords: words.length,
        totalDuration: Math.round(totalDuration * 100) / 100,
    };
}

/**
 * Hiển thị dialog Save As → cho user chọn folder → lưu file .txt
 * Format output: [0.13] February [0.77] twenty [1.01] second, ...
 *
 * @param originalSegments - Mảng segment gốc từ Whisper (chứa words[])
 * @returns true nếu lưu thành công, false nếu user cancel
 */
export async function exportWhisperWordsFile(originalSegments: Subtitle[]): Promise<boolean> {
    try {
        // Kiểm tra có word-level data không
        const hasWords = originalSegments.some(
            (seg) => seg.words && seg.words.length > 0
        );

        if (!hasWords) {
            console.error("[WhisperWords] Không có word-level timestamps trong transcript!");
            console.error("[WhisperWords] Hãy bật 'Word Timestamps (DTW)' khi Generate Subtitles.");
            return false;
        }

        // Build nội dung file text
        const { text, totalWords, totalDuration } = buildWhisperWordsText(originalSegments);

        console.log(
            `[WhisperWords] Chuẩn bị export: ${totalWords} words, ${totalDuration.toFixed(0)}s`
        );

        // Hiển thị dialog Save As — mặc định file .txt
        const filePath = await save({
            defaultPath: "autosubs_whisper_words.txt",
            filters: [{ name: "Text Files", extensions: ["txt"] }],
        });

        // User cancel dialog → không lưu
        if (!filePath) {
            console.log("[WhisperWords] User đã cancel dialog Save As");
            return false;
        }

        // Lưu file text (gọn gàng, nhẹ hơn JSON ~60%)
        await writeTextFile(filePath, text);

        console.log(`[WhisperWords] ✅ Đã lưu ${totalWords} words vào: ${filePath}`);
        return true;
    } catch (error) {
        console.error("[WhisperWords] ❌ Lỗi khi export:", error);
        return false;
    }
}
