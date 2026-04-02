export interface FormatConfig {
    /** Số lần chia kịch bản để gọi AI chọn nhạc nền */
    MUSIC_BATCH_COUNT: number;
    /** Số lần chia kịch bản để gọi AI chọn viền SFX/Sound Effects */
    SFX_BATCH_COUNT: number;
    /** Số hiệu ứng âm thanh tối đa cho MỖI BATCH SFX */
    MAX_SFX_CUES_PER_BATCH: number;
    /** (Tùy chọn) Timeline Resolution khi gọi Setup Track trong DaVinci */
    RESOLUTION?: {
        width: number;
        height: number;
        useVertical: boolean;
    };
}

export const formatConfig: FormatConfig = {
    MUSIC_BATCH_COUNT: 1,
    SFX_BATCH_COUNT: 1,
    MAX_SFX_CUES_PER_BATCH: 10,
    
    RESOLUTION: {
        width: 1080,
        height: 1920,
        useVertical: true
    }
};
