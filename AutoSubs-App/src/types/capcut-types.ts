// capcut-types.ts
// TypeScript types cho CapCut Draft Export
// Dùng trong service capcut-draft-service.ts để inject data vào CapCut project

// ======================== ĐƠN VỊ THỜI GIAN ========================
// CapCut dùng MICROSECOND (µs) cho toàn bộ timeline
// 1 giây = 1,000,000 µs

/** Khoảng thời gian trên CapCut timeline (microsecond) */
export interface CapCutTimerange {
    start: number   // Vị trí bắt đầu trên timeline (µs)
    duration: number // Thời lượng (µs)
}

// ======================== MATERIAL TYPES ========================

/** Material video/footage trong CapCut draft */
export interface CapCutVideoMaterial {
    id: string
    local_material_id: string   // Phải giống id — key liên kết với segment
    path: string                // Đường dẫn tuyệt đối đến file (VD: /Users/may1/Downloads/clip.mp4)
    type: string                // "photo" | "video"
    duration: number            // Thời lượng gốc file (µs)
    width: number
    height: number
    category_name: string       // Luôn "local"
    material_name: string       // Tên file hiển thị
}

/** Material audio (nhạc nền / SFX) trong CapCut draft */
export interface CapCutAudioMaterial {
    id: string
    local_material_id: string
    path: string
    name: string                // Tên file hiển thị
    type: string                // "extract_music" | "music"
    duration: number            // Thời lượng gốc file (µs)
    category_name: string       // Luôn "local"
}

/** Material text/subtitle trong CapCut draft */
export interface CapCutTextMaterial {
    id: string
    type: string                // "text"
    content: string             // JSON string chứa { text, styles[] }
    font_size: number
    alignment: number           // 1 = center
}

// ======================== SEGMENT & TRACK ========================

/** 1 segment (clip) trên 1 track */
export interface CapCutSegment {
    id: string
    material_id: string         // ID trỏ tới material tương ứng
    target_timerange: CapCutTimerange  // Vị trí trên timeline
    source_timerange: CapCutTimerange  // Đoạn nào trong file gốc
    speed: number               // Tốc độ phát (1.0 = bình thường)
    volume: number              // Âm lượng (1.0 = 100%)
    render_index: number        // Thứ tự render layer
}

/** 1 track (lớp) trên timeline */
export interface CapCutTrack {
    id: string
    type: string                // "video" | "audio" | "text"
    attribute: number           // 0 = bình thường
    flag: number                // 0 = bình thường
    segments: CapCutSegment[]
}

// ======================== SPEED MATERIAL ========================

/** CapCut yêu cầu mỗi segment video phải có entry speed tương ứng */
export interface CapCutSpeedMaterial {
    id: string
    mode: number    // 0 = normal
    speed: number   // 1.0 = bình thường
    type: string    // "speed"
}

// ======================== INPUT CHO SERVICE ========================

/** Kết quả 1 clip từ pipeline — service sẽ convert sang CapCut format */
export interface CapCutClipInput {
    filePath: string
    startTime: number    // Giây (float) — vị trí bắt đầu trên timeline
    endTime: number      // Giây (float)  — vị trí kết thúc trên timeline
    sourceStart?: number // Giây — bắt đầu từ đâu trong file gốc (default: 0)
    type?: 'video' | 'audio' | 'image'
}

/** Kết quả 1 dòng subtitle từ pipeline */
export interface CapCutSubtitleInput {
    text: string
    startTime: number    // Giây (float)
    endTime: number      // Giây (float)
}

/** Config cho CapCut Draft Generator */
export interface CapCutDraftConfig {
    /** Tên project sẽ hiển thị trong CapCut (VD: "AutoMedia_tutorial_20260403") */
    projectName: string
    /**
     * Đường dẫn draft CapCut nguồn cần ghi đè trực tiếp.
     * Nếu có giá trị:
     * - Service sẽ cập nhật thẳng vào draft này.
     * - Không tạo draft CapCut mới.
     */
    targetDraftPath?: string
    /** Kích thước canvas */
    width: number
    height: number
    /** FPS (mặc định 30 — CapCut default) */
    fps: number
}

/** Input tổng hợp từ pipeline vào CapCut Draft Service */
export interface CapCutDraftInput {
    config: CapCutDraftConfig
    /** Danh sách clips ảnh/video AI — track V1 */
    imageClips?: CapCutClipInput[]
    /** Danh sách clips footage B-roll — track V2 */
    footageClips?: CapCutClipInput[]
    /** Voice over (giọng đọc) — track A1, user chọn file .wav/.mp3 */
    voiceoverClips?: CapCutClipInput[]
    /** Nhạc nền BGM — track A2 */
    bgmClips?: CapCutClipInput[]
    /** SFX hiệu ứng — track A3 */
    sfxClips?: CapCutClipInput[]
    /** Subtitle phụ đề — track T1 */
    subtitles?: CapCutSubtitleInput[]
    /** Effects settings (transition, video effect, text template, zoom, mute) */
    effectsSettings?: {
        transitionEffectId?: string
        transitionCachePath?: string
        transitionDuration?: number
        videoEffectId?: string
        videoEffectCachePath?: string
        videoEffectName?: string
        textTemplateEffectId?: string
        textTemplateCachePath?: string
        textTemplateName?: string
        textTemplateRawJson?: any
        /** Text material gốc đi kèm text template đã chọn */
        textTemplateTextMaterialRawJson?: any
        /** Các material animations gốc mà text template tham chiếu */
        textTemplateLinkedMaterialAnimationsRawJson?: any[]
        /** Các effects gốc mà text template tham chiếu qua extra_material_refs */
        textTemplateLinkedEffectsRawJson?: any[]
        textAnimationEffectId?: string
        textAnimationCachePath?: string
        textAnimationName?: string
        zoomEnabled?: boolean
        zoomLevel?: number
        muteVideo?: boolean
    }
    /** Branding theo kênh: chèn logo kênh tự động lên toàn timeline */
    channelBranding?: {
        channelId: string
        channelName: string
        logoPath: string
        position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
        x?: number
        y?: number
        scale?: number
    }
}

// ======================== EXPORT TARGET ========================

/** Chọn xuất sang đâu — chỉ dùng trong Auto Media mode */
export type ExportTarget = 'davinci' | 'capcut' | 'moviepy'
