// title-types.ts
// Types chung cho tính năng Text On Screen (Title Cards)
// Tách riêng ra để tránh circular dependency:
//   template-assignment-service.ts → (dynamic import) → title-assignment-prompt.ts → TextTemplate
// Nếu TextTemplate nằm trong template-assignment-service.ts sẽ tạo vòng tròn import

// ======================== TEMPLATE TYPE ========================

/**
 * Định nghĩa 1 Template hiệu ứng chữ (Text On Screen)
 * Người dùng cấu hình tối đa 8 template với tên + mô tả + quy tắc sử dụng
 */
export interface TextTemplate {
    /** ID duy nhất: "template_1" đến "template_8" */
    id: string;
    /** Tên hiển thị (do user đặt): "Title 1 Glow", "Typewriter", v.v. */
    displayName: string;
    /** Mô tả ngắn cho AI hiểu template này trông như thế nào */
    description: string;
    /** Quy tắc sử dụng: khi nào nên dùng template này */
    usageRule: string;
    /** Có bật/sử dụng template này không */
    enabled: boolean;
    /** Màu nhận diện trên giao diện (hex color) */
    badgeColor: string;
    /** Tên template THỰC TẾ trong DaVinci Resolve Media Pool
     *  User chọn từ dropdown — đây là tên mà Lua sẽ tìm trong Media Pool
     *  Nếu rỗng → fallback về "Default Template" */
    resolveTemplateName: string;
    /** Tên SFX đi kèm template (tìm trong Media Pool)
     *  VD: "Cinematic Hit 3.mp3" cho đập xuống, "Click.mp3" cho xuất hiện */
    sfxName?: string;
}

// ======================== TITLE CUE TYPE ========================

/**
 * 1 Title Cue được lấy trực tiếp từ Whisper Words (không cần matching.json)
 * AI đọc word timestamps → trả về start/end chính xác ngay
 */
export interface TitleCue {
    /** ID template: "template_1" ... "template_8" */
    templateId: string;
    /** Text hiển thị trên màn hình: "FEBRUARY 22, 2026" */
    displayText: string;
    /** Giây bắt đầu hiển thị — lấy từ timestamp từ đầu tiên */
    start: number;
    /** Giây kết thúc hiển thị — lấy từ timestamp từ cuối + 0.5s */
    end: number;
    /** Lý do AI chọn */
    reason: string;
}

/** Kết quả tổng thể từ phân tích Whisper Words */
export interface AITitleCueResult {
    cues: TitleCue[];
    analyzedAt: string;
}
