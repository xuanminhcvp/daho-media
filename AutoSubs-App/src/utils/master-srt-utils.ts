// master-srt-utils.ts
// Utility functions cho Master SRT — dùng chung giữa các tab
// Master SRT là nguồn dữ liệu chuẩn (word + timing chính xác từ kịch bản)

import type { MasterWord } from '@/services/master-srt-service';

// ======================== INTERFACES ========================

/** Format transcript giả lập từ Master SRT — tương thích với extractWhisperWords() */
export interface FakeTranscriptFromMaster {
    originalSegments: Array<{
        start: string;
        end: string;
        text: string;
        words: Array<{
            word: string;
            start: string;
            end: string;
        }>;
    }>;
}

// ======================== CONVERT FUNCTIONS ========================

/**
 * Chuyển Master SRT → transcript object tương thích với hàm AI matching
 * 
 * Mục đích: Các service (subtitle-matcher, ai-matcher, template-assignment)
 * cần transcript dạng { segments: [{ words: [...] }] }
 * Master SRT đã có word-level timing chuẩn → chuyển đổi format là đủ
 * 
 * @param masterSrt - Mảng MasterWord từ ProjectContext
 * @returns Transcript object tương thích extractWhisperWords() / formatWhisperWords()
 */
export function masterSrtToTranscript(masterSrt: MasterWord[]): FakeTranscriptFromMaster {
    if (!masterSrt || masterSrt.length === 0) {
        return { originalSegments: [] };
    }

    // Nhóm words thành các "segments" ~50 words/segment (giả lập Whisper segments)
    // Để formatWhisperWords() có thể xử lý giống transcript thật
    const WORDS_PER_SEGMENT = 50;
    const segments: FakeTranscriptFromMaster['originalSegments'] = [];

    for (let i = 0; i < masterSrt.length; i += WORDS_PER_SEGMENT) {
        const chunk = masterSrt.slice(i, i + WORDS_PER_SEGMENT);
        const firstWord = chunk[0];
        const lastWord = chunk[chunk.length - 1];

        segments.push({
            start: String(firstWord.start),
            end: String(lastWord.end),
            text: chunk.map(w => w.word).join(' '),
            words: chunk.map(w => ({
                word: w.word,
                start: String(w.start),
                end: String(w.end),
            })),
        });
    }

    return { originalSegments: segments };
}

/**
 * Chuyển Master SRT → text format "[timestamp] word" cho AI phân tích
 * Dùng cho Template Assignment và các tab cần Whisper words text
 * 
 * @param masterSrt - Mảng MasterWord từ ProjectContext
 * @returns Chuỗi text format: "[0.16] February [0.44] twenty [0.80] second..."
 */
export function masterSrtToWordsText(masterSrt: MasterWord[]): string {
    if (!masterSrt || masterSrt.length === 0) return '';
    return masterSrt.map(w => `[${w.start.toFixed(2)}] ${w.word}`).join(' ');
}

// ======================== VALIDATION ========================

/**
 * Kiểm tra project có Master SRT hợp lệ chưa
 * Dùng ở các tab bắt buộc Master SRT để gatekeep
 * 
 * @param masterSrt - Dữ liệu Master SRT từ project
 * @returns true nếu đã có Master SRT hợp lệ (≥1 word)
 */
export function hasMasterSrt(masterSrt: MasterWord[] | undefined | null): boolean {
    return !!(masterSrt && masterSrt.length > 0);
}

/** Thông báo lỗi chuẩn khi chưa có Master SRT */
export const MASTER_SRT_REQUIRED_MESSAGE =
    '⚠️ Bắt buộc phải có Master SRT!\n\n' +
    'Vui lòng vào tab "Master SRT" để tạo trước.\n' +
    'Master SRT chứa text chuẩn (khớp kịch bản) + timing chính xác từ Whisper.';
