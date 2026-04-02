// gemini-browser-image-scan-prompt.ts
// Prompt scan ảnh qua Gemini BROWSER (không cần API key)
// Kết quả trả về JSON → lưu vào autosubs_image_metadata.json (cùng folder với ảnh)

/**
 * Prompt gửi vào Gemini chat khi upload ảnh để kiểm tra AI-generated
 * Dùng cho tab Gemini Scan → scan ảnh từ Image Import hoặc folder tùy chọn
 */
export function buildGeminiBrowserImagePrompt(): string {
    return `Bạn là chuyên gia phân tích hình ảnh AI (AI Image Detector).

Hãy phân tích ảnh vừa upload và xác định:
1. Ảnh này có phải do AI tạo ra không?
2. Nếu là AI: dùng tool gì? (Midjourney, DALL-E, Stable Diffusion, Flux, Firefly...)
3. Chất lượng ảnh có phù hợp dùng trong video documentary không?

=== YÊU CẦU ===
Trả về JSON đúng cấu trúc sau. KHÔNG thêm markdown hay text ngoài JSON:

{
  "isAIGenerated": true,
  "confidence": 95,
  "aiTool": "Midjourney",
  "aiIndicators": ["Tay có chi tiết mờ", "Nền blur không tự nhiên", "Ánh sáng quá hoàn hảo"],
  "quality": "high",
  "qualityScore": 88,
  "usableForDocumentary": true,
  "description": "Mô tả ngắn gọn: ảnh chụp gì, màu sắc/tông màu tổng thể, cảm nhận chung",
  "tags": ["portrait", "cinematic", "dark-tone", "studio"],
  "issues": ["Ngón tay bị biến dạng nhẹ ở góc phải"],
  "recommendation": "Có thể dùng — chất lượng ổn, ít artifact rõ ràng"
}

GHI CHÚ:
- "isAIGenerated": true nếu ảnh do AI tạo, false nếu là ảnh thật/chụp
- "confidence": 0-100 (% chắc chắn về nhận định isAIGenerated)
- "aiTool": tên tool AI nếu nhận ra, null nếu không xác định hoặc ảnh thật
- "aiIndicators": danh sách dấu hiệu nhận biết AI (nếu có)
- "quality": "high" | "medium" | "low" — chất lượng tổng thể của ảnh
- "qualityScore": 0-100 điểm chất lượng
- "usableForDocumentary": true nếu ảnh đủ chất lượng dùng trong video
- "issues": danh sách vấn đề (artifact, blur, biến dạng...) — mảng rỗng [] nếu không có
- "recommendation": câu nhận xét ngắn gọn 1 dòng về việc có nên dùng không
- Chỉ trả về JSON thuần, KHÔNG thêm markdown hay text nào khác!`;
}
