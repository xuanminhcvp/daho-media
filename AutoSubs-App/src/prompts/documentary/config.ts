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
    // Documentary dài 20-30 phút: 1 batch nhạc để giữ mạch cảm xúc xuyên suốt
    MUSIC_BATCH_COUNT: 1,
    // SFX cũng quy trình 1 batch để không làm quá tải
    SFX_BATCH_COUNT: 1,
    MAX_SFX_CUES_PER_BATCH: 10,
    
    RESOLUTION: {
        width: 1920,
        height: 1080,
        useVertical: false
    }
};
