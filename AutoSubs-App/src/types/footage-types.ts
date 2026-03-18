/**
 * footage-types.ts
 *
 * Types cho tính năng Footage Library — video clip minh hoạ
 * Tải từ Envato, AI scan + match với script
 */

// ======================== FOOTAGE ITEM ========================

/** Metadata của 1 file footage trong thư viện */
export interface FootageItem {
    /** Đường dẫn tuyệt đối đến file video */
    filePath: string;

    /** Tên file: "city_night.mp4" */
    fileName: string;

    /** Hash đơn giản từ tên file — phát hiện file mới */
    fileHash: string;

    /** Độ dài footage tính bằng giây (max 20) */
    durationSec: number;

    /** Width x Height (nếu lấy được từ ffprobe) */
    resolution?: string;

    // ===== AI Vision Metadata (FFmpeg trích frame → AI mô tả) =====

    /** Mô tả ngắn từ AI: "Aerial shot of city at night with lights" */
    aiDescription: string | null;

    /** Tags từ AI: ["city", "night", "aerial", "urban"] */
    aiTags: string[] | null;

    /** Mood/cảm xúc: "Cinematic", "Calm", "Dramatic" */
    aiMood: string | null;

    /** Ngày quét AI (ISO string) — null = chưa quét */
    scannedAt: string | null;
}

// ======================== AI MATCHING ========================

/** 1 gợi ý footage cho 1 đoạn trong script */
export interface FootageSuggestion {
    /** Câu số mấy trong script (sentence index) */
    sentenceIndex: number;

    /** Nội dung câu (để hiển thị UI) */
    sentenceText: string;

    /** Thời điểm bắt đầu chèn footage (giây, từ whisper timing) */
    startTime: number;

    /** Thời điểm kết thúc footage */
    endTime: number;

    /** Tên file footage được AI chọn */
    footageFile: string;

    /** Đường dẫn đầy đủ đến file footage */
    footagePath: string;

    /** Trim footage: lấy từ giây nào */
    trimStart: number;

    /** Trim footage: đến giây nào (max 20s) */
    trimEnd: number;

    /** Lý do AI chọn footage này */
    reason: string;
}

// ======================== METADATA FILE ========================

/** Cấu trúc file JSON metadata lưu trong folder footage */
export interface FootageMetadataFile {
    /** Version format */
    version: string;

    /** Ngày quét gần nhất */
    lastScanned: string;

    /** Tổng số items */
    itemCount: number;

    /** Danh sách footage items */
    items: FootageItem[];
}

// ======================== SCAN PROGRESS ========================

/** Callback progress khi quét footage */
export interface FootageScanProgress {
    current: number;
    total: number;
    fileName: string;
    message: string;
}
