// footage-suggest-keywords-prompt.ts
// Prompt cho AI gợi ý ~15 từ khóa footage cần tải về (Envato, Pexels, Pixabay...)
// AI phân tích kịch bản → gợi ý video minh hoạ phù hợp thể loại

/**
 * Tạo prompt gợi ý ~15 từ khóa footage stock video cho user tìm mua
 * AI sẽ phân tích TOÀN BỘ kịch bản → gợi ý B-roll phù hợp
 *
 * @param fullScript - Toàn bộ nội dung kịch bản (text)
 */
export function buildFootageSuggestKeywordsPrompt(fullScript: string): string {
  return `You are a professional Video Editor for YouTube Storytelling Drama channels.

=== TASK ===
Based on the FULL script below, suggest EXACTLY 15 stock footage keywords that the user should download from Envato Elements, Pexels, or Pixabay to use as B-roll in their video.

=== REQUIREMENTS ===
1. Include 3 types:
   - "Atmospheric/Cinematic" (40%): aerial city, dark clouds, rain on window, candle flame, slow motion smoke...
   - "Story Context" (40%): footage matching the story setting and events (hospital hallway, courtroom, car driving night, old photo album...)
   - "Emotional/Abstract" (20%): footage for emotional emphasis (lonely person silhouette, hands trembling, clock ticking, tears close up...)
2. Each keyword must be a SHORT English phrase (2-4 words), optimized for stock footage search
3. Sort by PRIORITY — most versatile/reusable footage first
4. Keywords should be generic enough to find on stock footage sites, not too specific
5. Focus on footage that can illustrate multiple scenes (reusable)

=== FULL SCRIPT ===
${fullScript}

=== RETURN FORMAT ===
Return ONLY valid JSON, NO explanations, NO markdown:
{
  "keywords": [
    "aerial city night",
    "rain on window",
    "dark clouds timelapse",
    "hospital corridor",
    "lonely person silhouette",
    "car driving night",
    "old photos album",
    "candle flame close up",
    "courtroom interior",
    "hands shaking nervous",
    "sunrise timelapse",
    "foggy street morning",
    "clock ticking close up",
    "ocean waves dramatic",
    "empty room abandoned"
  ]
}`;
}
