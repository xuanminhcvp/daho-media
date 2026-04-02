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
    // TikTok/Shorts ngắn (1-2 phút): nhạc thay đổi nhanh, cần cắt nhiều batch để đổi mode liên tục
    MUSIC_BATCH_COUNT: 3,
    // SFX cho TikTok cần dồn dập, giật gân, nhiều batch
    SFX_BATCH_COUNT: 5,
    MAX_SFX_CUES_PER_BATCH: 5,
    
    RESOLUTION: {
        width: 1080,
        height: 1920,
        useVertical: true
    }
};
