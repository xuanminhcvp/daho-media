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

// ======================== TRACK CỐ ĐỊNH ========================

/** 
 * Layout track cố định trên DaVinci timeline
 * Video: V1=Media, V2=Footage, V3=Phụ đề
 * Audio: A1=SFX, A2=Voice (giọng đọc gốc), A3=Nhạc nền
 * Timeline mặc định 24fps
 */
export const TRACK_LAYOUT = {
    // Video tracks
    IMAGE_TRACK: '1',      // V1 — ảnh/media 3D
    FOOTAGE_TRACK: '2',    // V2 — footage minh hoạ (B-roll)
    SUBTITLE_TRACK: '3',   // V3 — phụ đề / text onscreen
    REF_IMAGE_TRACK: '4',  // V4 — ảnh tham khảo thực tế (overlay)

    // Audio tracks (note: DaVinci xử lý audio track riêng)
    SFX_TRACK: '1',        // A1 — SFX
    VOICE_TRACK: '2',      // A2 — Voice (giọng đọc gốc)
    MUSIC_TRACK: '3',      // A3 — Nhạc nền

    // FPS mặc định
    DEFAULT_FPS: 24,
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
