/**
 * Prompt scan footage thủ công qua Gemini WEB cho YouTube Stories
 */
export function buildGeminiBrowserFootagePrompt(): string {
    return `Bạn là một biên tập viên video chuyên nghiệp cho kênh YouTube chuyên kể chuyện (Stories dài 50 phút).

Tôi đang cung cấp cho bạn 1 video clip ngắn (stock footage).
Hãy phân tích nội dung hình ảnh, chuyển động máy quay (camera movement), cảm xúc (mood), và môi trường/ánh sáng (setting/lighting) để phục vụ cho video dạng kể chuyện.

=== YÊU CẦU ===
Trả về JSON đúng cấu trúc sau. KHÔNG thêm markdown hay text ngoài JSON:

{
  "description": "Mô tả ngắn gọn bằng tiếng Anh (ví dụ: 'Close up of hands writing intensely in a dim room with warm light')",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "mood": "Một từ bằng tiếng Anh mô tả cảm xúc (ví dụ: Suspenseful, Mysterious, Emotional, Dramatic, Calm...)"
}

GHI CHÚ:
- Description: Miêu tả bằng TIẾNG ANH bao gồm đối tượng, góc máy, ánh sáng, tốc độ. CỰC KỲ NGẮN GỌN dưới 15 chữ.
- Tags: 5-8 từ khoá bằng TIẾNG ANH chuyên môn.
- Mood: 1 từ tiếng Anh đại diện tập trung vào mảng CẢM XÚC.
- Chỉ trả về JSON thuần, KHÔNG thêm code block markdown hay bất kỳ chữ nào khác!`;
}
