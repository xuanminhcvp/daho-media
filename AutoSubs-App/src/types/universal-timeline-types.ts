// universal-timeline-types.ts
// Kiểu dữ liệu "Bản nháp trung lập" — đầu ra Core Pipeline
// Adapter (DaVinci, CapCut, MoviePy...) nhận kiểu này làm đầu vào
// → Sửa adapter A không ảnh hưởng adapter B

// ======================== CLIP ĐƠN LẺ ========================

/** 1 đoạn media trung lập (ảnh/video/audio) — đơn vị giây */
export interface UniversalClip {
    /** Đường dẫn tuyệt đối tới file trên ổ cứng */
    filePath: string
    /** Vị trí bắt đầu trên timeline (giây) */
    startTime: number
    /** Vị trí kết thúc trên timeline (giây) */
    endTime: number
    /** Vị trí bắt đầu trong file nguồn — mặc định 0 (giây) */
    sourceStart?: number
    /** Trim start/end cho footage (giây) */
    trimStart?: number
    trimEnd?: number
}

/** 1 dòng phụ đề trung lập */
export interface UniversalSubtitle {
    /** Nội dung text hiển thị */
    text: string
    /** Thời điểm bắt đầu hiển thị (giây) */
    startTime: number
    /** Thời điểm kết thúc hiển thị (giây) */
    endTime: number
}

// ======================== TIMELINE TỔNG HỢP ========================

/**
 * Dữ liệu timeline trung lập — "Chân lý thời gian"
 * Core Pipeline trả ra object này, adapter sẽ dịch sang format phần mềm tương ứng
 *
 * Quy ước:
 * - Tất cả thời gian đều tính bằng GIÂY (float)
 * - Các mảng đã được sort theo startTime tăng dần
 * - voiceDuration là source-of-truth cho tổng thời lượng timeline
 */
export interface UniversalTimeline {
    /** Tổng thời lượng timeline dựa trên Voice Over (giây) — source-of-truth */
    voiceDuration: number

    /** Clips ảnh/video AI — layer nền tảng (V1) */
    imageClips: UniversalClip[]
    /** Clips footage B-roll (V2) */
    footageClips: UniversalClip[]
    /** File Voice Over — thường chỉ 1 clip duy nhất (A1) */
    voiceoverClips: UniversalClip[]
    /** Clips nhạc nền BGM (A2) */
    bgmClips: UniversalClip[]
    /** Clips hiệu ứng âm thanh SFX (A3) */
    sfxClips: UniversalClip[]
    /** Danh sách phụ đề */
    subtitles: UniversalSubtitle[]

    /** Dữ liệu bổ sung từ AI Match — adapter có thể cần dùng */
    matchedSentences: MatchedSentenceRef[]
}

/** Tham chiếu rút gọn tới kết quả AI match — chỉ giữ gì adapter cần */
export interface MatchedSentenceRef {
    /** Số thứ tự câu trong script */
    num: number
    /** Nội dung câu */
    text: string
    /** Thời điểm bắt đầu (giây) */
    start: number
    /** Thời điểm kết thúc (giây) */
    end: number
    /** Chất lượng match: high/medium/low */
    quality: string
    /** Tỉ lệ match (nếu có) */
    matchRate?: string
    /** Whisper text tương ứng (nếu có) */
    matchedWhisper?: string
}
