// sfx-suggest-keywords-prompt.ts
// Prompt cho AI gợi ý ~20 từ khóa SFX cần tải về xây thư viện
// Dùng Claude Sonnet 4 phân tích thể loại video → gợi ý bộ SFX cần có

/**
 * Tạo prompt gợi ý ~20 từ khóa SFX cho user tải về
 * AI sẽ phân tích TOÀN BỘ kịch bản → gợi ý SFX phù hợp thể loại
 *
 * @param fullScript - Toàn bộ nội dung kịch bản (tất cả câu chất lượng high/medium)
 */
export function buildSfxSuggestKeywordsPrompt(fullScript: string): string {
  return `You are a professional Sound Designer for YouTube Storytelling Drama channels.

=== TASK ===
Based on the FULL script below, suggest EXACTLY 20 SFX (sound effects) keywords that the user should download to build their SFX library.

=== REQUIREMENTS ===
1. Include 2 types:
   - "Cinema SFX" (70%): braam, impact, riser, sub drop, whoosh, transition, reveal stinger, emotional swell...
   - "Context SFX" (30%): sounds matching the story genre (glass breaking, fire, phone ring, car crash...)
2. Each keyword must be a SHORT English phrase, easy to search on Freesound.org, Pixabay, Mixkit...
3. Sort by PRIORITY — most important SFX first
4. Keywords only, no descriptions needed

=== FULL SCRIPT ===
${fullScript}

=== RETURN FORMAT ===
Return ONLY valid JSON, NO explanations, NO markdown:
{
  "keywords": [
    "cinematic braam",
    "deep sub drop",
    "glass breaking",
    "dark tension riser",
    "whoosh transition"
  ]
}`;
}
