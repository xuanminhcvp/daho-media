// audio-types.ts
// Định nghĩa tất cả types/interfaces cho hệ thống Hậu Kỳ Âm Thanh (Post-Production Audio)
// Bao gồm: Thư viện nhạc/SFX, AI metadata, Scene mapping, và cấu hình Ducking

// ======================== THƯ VIỆN ÂM THANH ========================

/** Từng phân đoạn thời gian của bản nhạc (diễn biến cảm xúc) */
export interface AudioTimelineSegment {
    /** Giây bắt đầu */
    startSec: number;
    /** Giây kết thúc */
    endSec: number;
    /** Cảm xúc chính của phân đoạn này */
    emotion: string;
    /** Mô tả chi tiết (ví dụ: "Nhạc build-up, tiếng trống dồn dập") */
    description: string;
}

/** 1 nhịp/hit/đập quan trọng trong file audio (beat timing) */
export interface AudioBeat {
    /** Giây chính xác của nhịp này */
    timeSec: number;
    /** Loại nhịp: "start" | "hit" | "impact" | "transition" | "drop" | "swell" | "end" */
    type: string;
    /** Mô tả ngắn: "Bass drum hit", "Cymbal crash", "Climax impact" */
    description: string;
}

/** Gợi ý cắt gọt 1 đoạn hay từ file audio (để FFmpeg trim) */
export interface AudioTrimSuggestion {
    /** Giây bắt đầu đoạn cắt */
    startSec: number;
    /** Giây kết thúc đoạn cắt */
    endSec: number;
    /** Tên ngắn gọn: "Chỉ lấy impact mở đầu" */
    label: string;
    /** Lý do: "Phù hợp làm SFX ngắn cho plot twist" */
    reason: string;
}

/** Metadata AI tạo ra cho 1 file nhạc/SFX (chỉ tạo 1 lần khi quét) */
export interface AudioAIMetadata {
    /** Danh sách cảm xúc chính: ["Buồn", "Thư giãn", "Suy tư"] */
    emotion: string[];
    /** Cường độ tổng thể: "Cao" | "Trung bình" | "Thấp" */
    intensity: "Cao" | "Trung bình" | "Thấp";
    /** Mô tả ngắn gọn do AI viết, ví dụ: "Piano chậm rãi, phù hợp cho cảnh buồn..." */
    description: string;
    /** Từ khóa để tìm kiếm nhanh: ["piano", "sad", "nostalgic"] */
    tags: string[];
    /** Tình huống phim phù hợp nhất: ["Cảnh xung đột", "Trước plot twist"] */
    bestFor?: string[];
    /** Nhạc có đoạn im lặng/cắt đột ngột — dùng cho plot twist */
    hasDrop?: boolean;
    /** Nhạc có đoạn tăng dần cường độ — dùng cho dồn dập trước cao trào */
    hasBuildUp?: boolean;
    /** Tổng độ dài file (giây) do AI ước lượng */
    totalDurationSec?: number;
    /** Phân tích chi tiết chuyển biến cảm xúc theo thời gian */
    timeline: AudioTimelineSegment[];
    /** Danh sách nhịp/hit quan trọng (beat timing) — giúp cắt gọt chính xác */
    beats?: AudioBeat[];
    /** Gợi ý đoạn cắt hay nhất — FFmpeg trim trước khi dùng */
    trimSuggestions?: AudioTrimSuggestion[];
}

/** 1 bản nhạc/SFX trong thư viện (đã được AI phân tích) */
export interface AudioLibraryItem {
    /** Đường dẫn đầy đủ tới file trên máy */
    filePath: string;
    /** Tên file (không có path): "nhac_buon.mp3" */
    fileName: string;
    /** Hash MD5 của file — dùng để phát hiện trùng lặp, tránh AI quét lại */
    fileHash: string;
    /** Độ dài file tính bằng giây */
    durationSec: number;
    /** Loại file: "music" (nhạc nền) hoặc "sfx" (hiệu ứng) */
    type: "music" | "sfx";
    /** Metadata do AI tạo — NULL nếu chưa quét AI */
    aiMetadata: AudioAIMetadata | null;
    /** Ngày quét AI gần nhất */
    scannedAt: string | null;
}

// ======================== DATABASE CỤC BỘ ========================

/** Cấu trúc file JSON Database lưu trên máy người dùng */
export interface AudioDatabase {
    /** Phiên bản schema — để upgrade sau này */
    version: string;
    /** Lần quét gần nhất */
    lastScanned: string;
    /** Danh sách tất cả nhạc nền (key = filePath) */
    musicLibrary: Record<string, AudioLibraryItem>;
    /** Danh sách tất cả SFX (key = filePath) */
    sfxLibrary: Record<string, AudioLibraryItem>;
}

// ======================== SCENE & AI ĐẠO DIỄN ========================

/** 1 "Cảnh" (Scene) do AI phân tích từ kịch bản */
export interface AudioScene {
    /** ID cảnh: 1, 2, 3... */
    sceneId: number;
    /** Giây bắt đầu cảnh (lấy từ câu đầu tiên trong cảnh) */
    startTime: number;
    /** Giây kết thúc cảnh (lấy từ câu cuối cùng trong cảnh) */
    endTime: number;
    /** Cảm xúc chính của cảnh: "Vui vẻ", "Kịch tính", "Buồn bã"... */
    emotion: string;
    /** Lý do AI chọn cảm xúc này */
    emotionReason: string;
    /** Bài nhạc nền được gán cho cảnh — NULL nếu chưa gán (hoặc không tìm thấy) */
    assignedMusic: AudioLibraryItem | null;
    /** Khoảng thời gian (giây) BẮT ĐẦU trích xuất từ file nhạc nền. (Mặc định 0: lấy từ đầu bài) */
    assignedMusicStartTime?: number;
    /** Danh sách từ khoá AI gợi ý để user tự đi tìm nhạc (ví dụ: ["epic", "orchestral", "battle"]) */
    searchKeywords: string[];
    /** Danh sách số câu thuộc cảnh này: [1, 2, 3] */
    sentenceNums: number[];
}

/** 1 SFX được gán cho 1 câu cụ thể */
export interface AssignedSFX {
    /** Số câu (num trong matching.json) */
    sentenceNum: number;
    /** Giây chính xác để chèn SFX */
    atTime: number;
    /** File SFX được gán */
    sfxItem: AudioLibraryItem;
    /** Lý do AI chọn SFX này (hoặc user tự gán) */
    reason: string;
}

/** Kết quả trả về từ AI Đạo Diễn sau khi phân tích kịch bản */
export interface AIDirectorResult {
    /** Danh sách Scene + nhạc nền được gán */
    scenes: AudioScene[];
    /** Danh sách SFX được gán cho từng câu */
    sfxAssignments: AssignedSFX[];
    /** Ngày phân tích */
    analyzedAt: string;
}

// ======================== CẤU HÌNH DUCKING ========================

/** Cài đặt Auto Ducking (nhạc lùi khi có giọng nói) */
export interface DuckingConfig {
    /** Volume nhạc nền khi có giọng nói (0.0 → 1.0, mặc định 0.2 = 20%) */
    duckVolume: number;
    /** Thời gian fade-out trước khi câu bắt đầu (giây, mặc định 0.5) */
    fadeOutDuration: number;
    /** Thời gian fade-in sau khi câu kết thúc (giây, mặc định 0.5) */
    fadeInDuration: number;
    /** Crossfade giữa 2 bài nhạc khi chuyển Scene (giây, mặc định 2.0) */
    crossfadeDuration: number;
}

// ======================== TRẠNG THÁI UI ========================

/** Trạng thái tổng thể của panel Post-Production */
export type PostProdStatus =
    | "idle"           // Chưa làm gì
    | "scanning"       // Đang quét thư viện bằng AI
    | "analyzing"      // AI đang phân tích kịch bản
    | "rendering"      // FFmpeg đang render
    | "importing"      // Đang import vào DaVinci
    | "done"           // Hoàn tất
    | "error";         // Lỗi

// ======================== PHỤ ĐỀ (SUBTITLE) ========================

/** 1 dòng phụ đề sau khi AI đã tách câu dài và gán timing */
export interface SubtitleLine {
    /** Nội dung phụ đề (đã tách ngắn gọn, ≤ ~45 ký tự) */
    text: string;
    /** Giây bắt đầu hiển thị (từ Whisper word timing) */
    start: number;
    /** Giây kết thúc hiển thị */
    end: number;
}

/** Sub-tab đang active trong Post-Production Panel */
export type PostProdTab = "music" | "sfx" | "highlight" | "templates" | "subtitles" | "effects" | "footage" | "ducking";
