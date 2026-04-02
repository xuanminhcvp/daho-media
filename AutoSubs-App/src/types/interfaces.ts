import { SupportedUiLanguage } from '@/i18n';

// Error message interface
export interface ErrorMsg {
    title: string;
    desc: string;
}

// Resolve Interfaces
export interface AudioInfo {
    path: string;
    markIn: number;
    markOut: number;
    offset: number;
}

export interface Template {
    value: string;
    label: string;
}
export interface Track {
    value: string;
    label: string;
}

export interface TimelineInfo {
    name: string;
    timelineId: string;
    /** Tên project DaVinci Resolve đang kết nối */
    projectName?: string;
    templates: Template[];
    inputTracks: Track[];
    outputTracks: Track[];
}

// Subtitle Interfaces
export interface Word {
    word: string;
    start: number;
    end: number;
    line_number: number;
    probability?: number;
}
export interface Subtitle {
    id: number;
    start: number;
    end: number;
    text: string;
    words: Array<Word>;
    speaker_id?: string;
}

// Speaker Interfaces
export interface ColorModifier {
    enabled: boolean;
    color: string;
}
export interface Sample {
    start: number;
    end: number;
}
export interface Speaker {
    name: string;
    fill: ColorModifier;
    outline: ColorModifier;
    border: ColorModifier;
    sample: Sample;
    track?: string;
}

// Model Interface
export interface Model {
    value: string
    label: string
    description: string
    size: string
    ram: string
    image: string
    details: string
    badge: string
    languageSupport:
    | { kind: "multilingual" }
    | { kind: "single_language"; language: string }
    | { kind: "restricted"; languages: string[] }
    accuracy: 1 | 2 | 3 // 1 = Poor, 2 = Standard, 3 = Excellent
    weight: 1 | 2 | 3 // 1 = Heavy, 2 = Standard, 3 = Lightweight
    isDownloaded: boolean
}

// Settings Interface
export interface Settings {
    // Mode
    isStandaloneMode: boolean,
    activeProfile: string,

    // UI settings
    uiLanguage: SupportedUiLanguage;
    uiLanguagePromptCompleted: boolean;
    showEnglishOnlyModels: boolean;

    // Survey notification settings
    timesDismissedSurvey: number;
    lastSurveyDate: string;

    // Processing settings
    model: number; // index of model in models array
    language: string,
    translate: boolean,
    targetLanguage: string,
    enableDiarize: boolean,
    maxSpeakers: number | null,
    enableDTW: boolean,
    enableGpu: boolean,

    // Text settings
    textDensity: "less" | "standard" | "more",
    maxLinesPerSubtitle: number,
    splitOnPunctuation: boolean,
    textCase: "none" | "uppercase" | "lowercase" | "titlecase";
    removePunctuation: boolean,
    enableCensor: boolean,
    censoredWords: Array<string>,

    // Davinci Resolve settings
    selectedInputTracks: string[];
    selectedOutputTrack: string;
    selectedTemplate: Template;

    // Animation settings
    animationType: "none" | "pop-in" | "fade-in" | "slide-in" | "typewriter";
    highlightType: "none" | "outline" | "fill" | "bubble";
    highlightColor: string;

    // ===== AI Performance Settings (Cấu hình Hiệu Năng AI) =====
    /** Số đợt chia để phân tích Âm thanh (Audio Director) */
    aiAudioBatches: number;
    /** Số đợt chia để phân tích SFX (Âm thanh hiệu ứng) */
    aiSfxBatches: number;
    /** Số đợt chia để gắn Footage (Footage Matcher) */
    aiFootageBatches: number;
    /** Số đợt chia để tìm chú thích Text On Screen */
    aiTextOnScreenBatches: number;
    /** Số đợt chia để vẽ Ref Image (Ảnh tham chiếu Midjourney) */
    aiRefImageBatches: number;
    /** Số batch chia khi tạo Phụ đề (Subtitle Match) */
    aiSubtitleBatches: number;
    /** Số batch chia Whisper transcript khi tạo Master SRT (mặc định: 4) */
    aiMasterSrtBatches: number;
    /** Số batch chia transcript khi match trong Video Import (mặc định: 4) */
    aiMediaImportBatches: number;
    /** Số batch chia transcript khi match trong Image Import (mặc định: 4) */
    aiImageImportBatches: number;
    /** Số luồng API chạy song song tối đa (mặc định: 3) — dùng chung cho tất cả tính năng */
    aiMaxConcurrency: number;
    /** Tỷ lệ % overlap (chồng lấn) văn bản/âm thanh giữa các batch để AI không bị trượt bối cảnh ở biên (mặc định: 0.15) */
    aiBatchOverlapRatio: number;
    /** Độ sáng tạo AI — 0.0 (chặt chẽ) → 1.0 (bay bổng) (mặc định: 0.7) */
    aiTemperature: number;
    /** Thời gian cấm chèn B-Roll ở đầu video (giây, mặc định: 60) */
    bRollStartTime: number;
    /** Số lần thử lại tối đa khi API gặp lỗi (mặc định: 3) */
    aiMaxRetries: number;
    /** Tổng số SFX tối đa cho toàn video (mặc định: 20) */
    aiTotalSfxCues: number;
    /** Tổng số Footage tối đa cho toàn video (mặc định: 15) */
    aiTotalFootageClips: number;
}

export interface TranscriptionOptions {
    audioPath: string,
    offset: number,
    model: string,
    lang: string,
    translate: boolean,
    targetLanguage: string,
    enableDtw: boolean,
    enableGpu: boolean,
    enableDiarize: boolean,
    maxSpeakers: number | null,
    density: "less" | "standard" | "more",
}

// Formatting options for reformatting subtitles without re-transcribing
export interface FormattingOptions {
    maxLines?: number,
    textDensity?: "less" | "standard" | "more",
    language?: string,
}

// Segment format expected by the backend reformat command
export interface BackendSegment {
    start: number,
    end: number,
    text: string,
    speaker_id?: string,
    words?: Array<{
        word: string,
        start: number,
        end: number,
        probability?: number,
    }>,
}