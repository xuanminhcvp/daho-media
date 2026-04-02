/**
 * footage-scan-prompt.ts
 *
 * Prompt gửi cho AI Vision (Gemini) kèm 3 frame ảnh từ footage
 * AI mô tả nội dung video clip, gắn tags, xác định mood
 */

/**
 * Tạo prompt cho AI Vision scan footage
 * Gửi kèm 3 frame (đầu, giữa, cuối) dưới dạng base64
 * AI trả về JSON: { description, tags, mood }
 */
export function buildFootageScanPrompt(): string {
    return `You are a professional video editor analyzing stock footage clips.

I'm showing you 3 frames from a video clip (beginning, middle, end).

Analyze the visual content and return a JSON object with:

{
  "description": "One sentence describing the footage content and camera movement (e.g. 'Aerial drone shot slowly panning over a modern city skyline at sunset')",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "mood": "One word mood (e.g. Cinematic, Calm, Dramatic, Energetic, Dark, Mysterious, Warm, Peaceful, Intense, Romantic)"
}

RULES:
- Description should mention: subject, camera movement, lighting, time of day
- Tags should be 5 specific keywords for content matching
- Tags should include: subject, setting, time, action, style
- All text in English
- Return ONLY the JSON object, no markdown code blocks

RESPOND WITH JSON ONLY.`;
}
