// gemini-browser-image-scan-prompt.ts
// Prompt scan footage/ảnh thủ công qua Gemini WEB (gemini.google.com)
// Workflow: Upload ảnh/video lên Gemini web → paste prompt → copy JSON kết quả → paste vào app
// Không cần API key Gemini - hoàn toàn miễn phí!

/**
 * Prompt gửi vào Gemini chat khi upload ảnh/video (footage)
 * Kết quả lưu vào autosubs_image_metadata.json cùng cấu trúc chuẩn của tab Footage/Image
 */
export function buildGeminiBrowserImagePrompt(): string {
    return `You are a professional video editor analyzing stock footage or images.

I'm uploading an image or video footage clip. Analyze the visual content and return a JSON object.

=== YÊU CẦU ===
Trả về JSON đúng cấu trúc bên dưới. KHÔNG thêm markdown \`\`\`json hay text ngoài JSON:

{
  "description": "One sentence describing the footage content and camera movement (e.g. 'Aerial drone shot slowly panning over a modern city skyline at sunset')",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "mood": "One word mood (e.g. Cinematic, Calm, Dramatic, Energetic, Dark, Mysterious, Warm, Peaceful, Intense, Romantic)"
}

RULES:
- Description should mention: subject, camera movement (if video), lighting, background.
- Tags should be 5-8 specific keywords for content matching (subject, setting, time, action, style).
- All text values in English.
- Return ONLY the JSON object, absolutely NO markdown code blocks (\`\`\`json).

RESPOND WITH JSON ONLY.`;
}

