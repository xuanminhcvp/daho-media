// highlight-text-prompt.ts
// Prompt cho AI Video Editor: phân tích kịch bản → tìm cụm từ cần Highlight Text
// Xác định từ khoá đắt giá cần hiện to lên màn hình để nhấn mạnh

import type { MatchingSentence } from "@/services/audio-director-service";

/**
 * Tạo prompt cho AI Highlight Text Planner
 * Phân tích kịch bản → tìm cụm từ cần hiển thị nổi bật trên màn hình
 *
 * @param sentences - Danh sách câu có timing từ matching.json
 */
export function buildHighlightTextPrompt(sentences: MatchingSentence[]): string {
    const scriptText = sentences
        .map((s) => `[Câu ${s.num}] (${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s): ${s.text}`)
        .join("\n");

    return `Bạn là một Video Editor chuyên nghiệp sản xuất phim Tài liệu/Youtube.
Nhiệm vụ: đọc kịch bản và Lập danh sách Cues (điểm nhấn) để chèn Highlight Text / Call-out (Chữ Nổi Bật Trên Màn Hình).

=== MỤC TIÊU ===
Xác định những CỤM TỪ HOẶC CON SỐ đắt giá cần phải hiện to lên màn hình để nhấn mạnh.
Không được gọi toàn bộ câu ra làm highlight, chỉ trích xuất từ 2-6 chữ đắt giá nhất trong một câu.
Ví dụ: 
- Con số cực sốc: "50 Tỷ Đô La", "Chỉ còn 3 ngày"
- Thông tin cảnh báo: "Nguy hiểm chết người", "Sập đổ"
- Tên gọi riêng/Định nghĩa mới

=== KỊCH BẢN VIDEO (có đánh số câu & timecode) ===
${scriptText}

=== NHIỆM VỤ CHI TIẾT ===
1. Tìm những cụm từ đắt giá. Lưu ý BẮT BUỘC cụm từ đó PHẢI XUẤT HIỆN chính xác trong nội dung câu đó.
2. Chọn ra tối đa 15 điểm cần Highlight Text cho toàn bộ video, tập trung ở các điểm đắt giá.

Trả về ĐÚNG chuẩn JSON sau, KHÔNG giải thích gì thêm, KHÔNG dùng markdown:
{
  "cues": [
    {
      "sentenceNum": 16,
      "textToHighlight": "hơn 50 tỷ đô la"
    },
    {
      "sentenceNum": 21,
      "textToHighlight": "Đế chế sụp đổ"
    }
  ]
}`;
}
