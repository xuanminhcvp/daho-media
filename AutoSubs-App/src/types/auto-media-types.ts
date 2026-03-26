// auto-media-types.ts
// Types cho tính năng Auto Media — tự động hoá toàn bộ hậu kỳ với 1 nút bấm
// Pipeline: Transcribe → AI Match → 5 bước song song → Effects cuối

// ======================== BƯỚC PIPELINE ========================

/** 7 bước trong Auto Media pipeline */
export type AutoMediaStep =
    | 'transcribe'   // Bước 1: Whisper transcribe
    | 'aiMatch'      // Bước 2: AI so chiếu script ↔ voice timing
    | 'image'        // Bước 3a: Import ảnh lên V1
    | 'subtitle'     // Bước 3b: Phụ đề lên V3
    | 'music'        // Bước 3c: Nhạc nền lên A3
    | 'sfx'          // Bước 3d: SFX lên A1
    | 'footage'      // Bước 3e: Footage lên V2
    | 'effects'      // Bước 4: Ken Burns / Shake (sau khi ảnh trên timeline)

/** Trạng thái mỗi bước */
export type StepStatus =
    | 'idle'         // Chưa bắt đầu
    | 'waiting'      // Đang chờ bước trước xong
    | 'running'      // Đang chạy
    | 'paused'       // Dừng chờ user nhấn "Tiếp tục" (debug mode)
    | 'done'         // Hoàn tất ✅
    | 'error'        // Lỗi ❌
    | 'skipped'      // Bỏ qua (thiếu điều kiện: folder chưa chọn, scan chưa đủ...)

// ======================== TRẠNG THÁI 1 BƯỚC ========================

/** State chi tiết của 1 bước trong pipeline */
export interface StepState {
    /** Trạng thái hiện tại */
    status: StepStatus
    /** Thông điệp hiển thị cho user: "AI matching batch 3/5...", "Đang convert ảnh 12/25..." */
    message: string
    /** Thông báo lỗi chi tiết (nếu status === 'error') */
    error?: string
    /** Thời điểm bắt đầu (ms) */
    startedAt?: number
    /** Thời điểm hoàn tất (ms) */
    finishedAt?: number
    /** Debug details — thông tin chi tiết cho developer debug */
    debugDetails?: string
}

// ======================== CẤU HÌNH PIPELINE ========================

/** Config bật/tắt từng bước — user toggle trên UI popup */
export interface AutoMediaConfig {
    /** Bật/tắt từng bước (mặc định bật hết) */
    enableImage: boolean
    enableSubtitle: boolean
    enableMusic: boolean
    enableSfx: boolean
    enableFootage: boolean
    enableEffects: boolean

    /** Cài đặt Effects (lấy từ defaults hoặc user chọn) */
    effectType: 'kenburns' | 'shake' | 'both'
    effectIntensity: 'subtle' | 'medium' | 'strong'

    /** Debug mode: chạy tuần tự + dừng sau mỗi bước chờ nhấn Tiếp tục */
    debugMode: boolean
}

/** Config mặc định — bật hết trừ subtitle (nặng RAM), debug mode tắt */
export const DEFAULT_AUTO_MEDIA_CONFIG: AutoMediaConfig = {
    enableImage: true,
    enableSubtitle: false, // ★ Mặc định TẮT — Fusion Text+ ngốn RAM DaVinci
    enableMusic: true,
    enableSfx: true,
    enableFootage: true,
    enableEffects: true,
    effectType: 'kenburns',
    effectIntensity: 'subtle',
    debugMode: false, // ★ Mặc định TẮT — chạy tự động song song
}

// ======================== TRẠNG THÁI TỔNG THỂ ========================

/** State chung toàn pipeline */
export interface AutoMediaState {
    /** Pipeline đang chạy hay không */
    isRunning: boolean
    /** Trạng thái từng bước */
    steps: Record<AutoMediaStep, StepState>
    /** Thời điểm bắt đầu pipeline (ms) */
    startedAt?: number
    /** Thời điểm pipeline kết thúc (ms) */
    finishedAt?: number
}

/** Giá trị khởi tạo cho StepState */
const INITIAL_STEP: StepState = {
    status: 'idle',
    message: '',
}

/** Giá trị khởi tạo cho toàn pipeline */
export const INITIAL_AUTO_MEDIA_STATE: AutoMediaState = {
    isRunning: false,
    steps: {
        transcribe: { ...INITIAL_STEP },
        aiMatch: { ...INITIAL_STEP },
        image: { ...INITIAL_STEP },
        subtitle: { ...INITIAL_STEP },
        music: { ...INITIAL_STEP },
        sfx: { ...INITIAL_STEP },
        footage: { ...INITIAL_STEP },
        effects: { ...INITIAL_STEP },
    },
}

// ======================== TRACK CỐ ĐỊNH (7V + 5A) ========================

/** 
 * Layout track cố định trên DaVinci timeline — 7 Video + 5 Audio
 * 
 * VIDEO (track số lớn = hiện trên cùng trong DaVinci):
 *   V1 = Video AI (nền tảng)
 *   V2 = Ảnh Thực Tế / Ref Images (overlay lên video AI)
 *   V3 = Adjustment Layer (đi kèm V4 Text)
 *   V4 = Text Onscreen (phụ đề stories — Fusion Text+)
 *   V5 = Số Chương (VD: "Chương 3")
 *   V6 = Tên Chương (VD: "Bí ẩn vũ trụ")
 *   V7 = Footage B-roll
 * 
 * AUDIO:
 *   A1 = SFX Video AI (import cùng V1)
 *   A2 = VO / Voice Over (giọng đọc)
 *   A3 = SFX Text xuất hiện
 *   A4 = SFX Ảnh Ref xuất hiện
 *   A5 = Nhạc Nền (BGM)
 * 
 * ⚠️ User cần tạo đủ 7 Video + 5 Audio tracks trong DaVinci trước khi chạy pipeline
 * Timeline mặc định 24fps
 */
export const TRACK_LAYOUT = {
    // ===== Video tracks =====
    VIDEO_AI_TRACK: '1',       // V1 — Video AI (nền tảng, layer cốt lõi)
    REF_IMAGE_TRACK: '2',      // V2 — Ảnh thực tế minh hoạ (overlay)
    ADJUSTMENT_TRACK: '3',     // V3 — Adjustment Layer (đi kèm V4)
    TEXT_ONSCREEN_TRACK: '4',  // V4 — Text Onscreen (phụ đề stories)
    CHAPTER_NUM_TRACK: '5',    // V5 — Số chương
    CHAPTER_NAME_TRACK: '6',   // V6 — Tên chương
    FOOTAGE_TRACK: '7',        // V7 — Footage B-roll

    // ===== Audio tracks =====
    SFX_VIDEO_TRACK: '1',      // A1 — SFX Video AI (đi cùng V1)
    VOICE_TRACK: '2',          // A2 — VO / Voice Over (giọng đọc)
    SFX_TEXT_TRACK: '3',       // A3 — SFX Text xuất hiện
    SFX_REF_TRACK: '4',        // A4 — SFX Ảnh Ref xuất hiện
    MUSIC_TRACK: '5',          // A5 — Nhạc Nền (BGM)

    // ===== Cấu hình =====
    DEFAULT_FPS: 24,

    // ===== Tổng số tracks cần tạo =====
    TOTAL_VIDEO_TRACKS: 7,
    TOTAL_AUDIO_TRACKS: 5,
} as const

/** 
 * Label hiển thị cho từng track — dùng trong UI TrackGuide
 * Mỗi track có icon + tên + màu riêng để dễ phân biệt
 */
export const TRACK_LABELS = {
    // Video tracks
    video: [
        { track: 'V1', icon: '📹', name: 'Video AI', color: '#3b82f6', desc: 'Nền tảng — video AI tạo ra' },
        { track: 'V2', icon: '🖼️', name: 'Ảnh Thực Tế', color: '#8b5cf6', desc: 'Ref images overlay' },
        { track: 'V3', icon: '🎚️', name: 'Adjustment Layer', color: '#6b7280', desc: 'Hiệu ứng đi kèm V4' },
        { track: 'V4', icon: '💬', name: 'Text Onscreen', color: '#eab308', desc: 'Phụ đề stories' },
        { track: 'V5', icon: '#️⃣', name: 'Số Chương', color: '#f97316', desc: 'VD: Chương 3' },
        { track: 'V6', icon: '🔤', name: 'Tên Chương', color: '#ef4444', desc: 'VD: Bí ẩn vũ trụ' },
        { track: 'V7', icon: '🎬', name: 'Footage B-roll', color: '#14b8a6', desc: 'Video minh hoạ' },
    ],
    // Audio tracks
    audio: [
        { track: 'A1', icon: '🔊', name: 'SFX Video AI', color: '#3b82f6', desc: 'Đi cùng V1' },
        { track: 'A2', icon: '🎙️', name: 'VO (Voice)', color: '#22c55e', desc: 'Giọng đọc chính' },
        { track: 'A3', icon: '🔔', name: 'SFX Text', color: '#eab308', desc: 'Âm thanh text hiện' },
        { track: 'A4', icon: '📸', name: 'SFX Ảnh Ref', color: '#8b5cf6', desc: 'Âm thanh ảnh hiện' },
        { track: 'A5', icon: '🎵', name: 'Nhạc Nền', color: '#ec4899', desc: 'BGM' },
    ],
} as const

// ======================== KIỂM TRA ĐIỀU KIỆN ========================

/** Số file scan AI tối thiểu mỗi thư viện để bước đó chạy */
export const MIN_SCANNED_FILES = 5

/** Kết quả kiểm tra điều kiện tiên quyết */
export interface PrerequisiteCheck {
    /** Tên bước */
    step: AutoMediaStep
    /** Đủ điều kiện chạy? */
    ready: boolean
    /** Lý do nếu chưa đủ: "Folder nhạc: chỉ có 2/5 file đã scan" */
    reason?: string
}

// ======================== CALLBACK ========================

/** Callback để service thông báo tiến trình cho UI */
export type OnStepUpdate = (
    step: AutoMediaStep,
    status: StepStatus,
    message: string,
    error?: string,
    /** Debug details — hiện chữ nhỏ bên dưới message */
    debugDetails?: string
) => void
