/**
 * reference-image-types.ts
 * Types cho tính năng Reference Images — ảnh thực tế minh hoạ Documentary
 * AI gợi ý 6-10 ảnh/video, editor tự tìm + import lên Track V4
 */

// ======================== LOẠI ẢNH ========================

/** Phân loại ảnh minh hoạ */
export type RefImageType =
    | 'portrait'    // 👤 Chân dung, mugshot nhân vật
    | 'location'    // 📍 Địa điểm, hiện trường
    | 'map'         // 🗺️ Bản đồ
    | 'event'       // ⚡ Sự kiện, phiên toà, đột kích
    | 'document'    // 📄 Giấy tờ, hồ sơ
    | 'headline'    // 📰 Screenshot báo chí, tiêu đề tin
    | 'evidence'    // 🔧 Bằng chứng, ảnh khái niệm, vật chứng

/** Nguồn tìm ảnh gợi ý */
export type RefImageSource = 'google' | 'pinterest' | 'wikipedia'

/** Độ ưu tiên — AI đánh giá mức quan trọng */
export type RefImagePriority = 'high' | 'medium' | 'low'

// ======================== 1 GỢI Ý ẢNH TỪ AI ========================

/** 1 ảnh minh hoạ AI đề xuất */
export interface RefImageSuggestion {
    /** ID duy nhất (auto-gen) */
    id: string

    /** Câu số mấy trong kịch bản */
    sentenceNum: number

    /** Nội dung câu (để hiển thị UI) */
    sentenceText: string

    /** Mô tả ảnh cần tìm */
    description: string

    /** Từ khoá tìm kiếm (nhiều variants) */
    searchKeywords: string[]

    /** Loại ảnh */
    type: RefImageType

    /** Thời điểm bắt đầu hiển thị (giây) — AI tính từ whisper words */
    startTime: number

    /** Thời điểm kết thúc hiển thị (giây) */
    endTime: number

    /** Nguồn gợi ý tìm */
    source: RefImageSource

    /** Độ ưu tiên */
    priority: RefImagePriority

    /** Lý do cần ảnh này */
    reason: string

    // ===== Gán bởi editor (sau khi tìm được ảnh) =====

    /** Đường dẫn file ảnh đã tải về (editor gán) */
    assignedImagePath?: string

    /** Tên file ảnh */
    assignedImageName?: string
}

// ======================== KẾT QUẢ AI ========================

/** Kết quả AI phân tích kịch bản → danh sách ảnh cần tìm */
export interface AIRefImageResult {
    /** Danh sách gợi ý (6-10 ảnh/video) */
    suggestions: RefImageSuggestion[]

    /** Ngày phân tích */
    analyzedAt: string
}

// ======================== CACHE FILE ========================

/** Cấu trúc file cache lưu trong folder ref_images */
export interface RefImageCacheFile {
    version: number
    savedAt: string
    aiResult: AIRefImageResult
}
