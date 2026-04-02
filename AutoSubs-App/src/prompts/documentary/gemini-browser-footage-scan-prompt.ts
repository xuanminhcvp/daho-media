export function buildGeminiBrowserFootagePrompt(): string {
    return `Bạn là chuyên gia phân tích video documentary chuyên nghiệp.

Tôi đang cung cấp cho bạn 1 video clip ngắn (stock footage).
Hãy phân tích nội dung hình ảnh, chuyển động máy quay (camera movement), cảm xúc (mood), và môi trường/ánh sáng (setting/lighting) của đoạn video này.

=== YÊU CẦU ===
Trả về JSON đúng cấu trúc sau. KHÔNG thêm markdown hay text ngoài JSON:

{
  "description": "Mô tả ngắn gọn bằng tiếng Anh (ví dụ: 'Aerial drone shot slowly panning over a modern city skyline at sunset')",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "mood": "Một từ bằng tiếng Anh mô tả cảm xúc (ví dụ: Cinematic, Calm, Dramatic, Energetic, Dark, Mysterious, Warm, Peaceful...)"
}

GHI CHÚ:
- Description: Miêu tả bằng TIẾNG ANH bao gồm đối tượng, góc máy, ánh sáng, thời gian.
- Tags: 5-8 từ khoá bằng TIẾNG ANH (subject, setting, time, action, style).
- Mood: 1 từ tiếng Anh đại diện.
- Chỉ trả về JSON thuần, KHÔNG thêm code block markdown hay bất kỳ chữ nào khác!`;
}
