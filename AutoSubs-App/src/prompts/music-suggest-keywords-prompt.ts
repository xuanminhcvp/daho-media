// music-suggest-keywords-prompt.ts
// Prompt cho AI gợi ý ~10 Suno AI prompts để tạo nhạc nền
// Dùng Claude phân tích thể loại video → gợi ý bộ prompt Suno phù hợp

/**
 * Tạo prompt gợi ý 10 Suno AI prompts cho user tạo nhạc nền
 * Mỗi prompt ~50 từ tiếng Anh, phù hợp với Suno AI để tạo nhạc
 *
 * @param fullScript - Toàn bộ nội dung kịch bản (tất cả câu chất lượng high/medium)
 */
export function buildMusicSuggestKeywordsPrompt(fullScript: string): string {
  return `You are a professional Music Supervisor for YouTube 3D Investigative Documentary channels.
Your job is to write Suno AI prompts that generate cinematic background music.

=== TASK ===
Based on the FULL script below, generate EXACTLY 10 Suno AI music prompts.
Each prompt creates 1 unique background music track suitable for different scenes in this video.

=== CONTEXT ===
The video is a 3D Investigative Documentary (25-27 minutes) — narrator tells a real investigative story with 3D-rendered visuals.
The story shifts between: investigation → tension → action → revelation → legal/political → twist → reflection...
User will use Suno AI to generate these tracks, then import them as BGM into the video.

=== SUNO AI PROMPT RULES ===
1. Each prompt must be ~50 words in English
2. Include: instrumentation, tempo, mood, style, and key sonic elements
3. EVERY prompt MUST contain the words "instrumental" and "no vocals" — this is CRITICAL so Suno does NOT generate singing voices
4. DO NOT include lyrics, song names, or artist names
4. Cover a VARIETY of moods across 10 prompts (tailored for investigative documentary):
   - 3 prompts: Investigative/Tension (dark, thriller, building dread, surveillance feel)
   - 2 prompts: Dramatic Action (epic, orchestral peak, chase/raid energy)
   - 2 prompts: Calm/Reflective (gentle, contemplative, aftermath, backstory)
   - 1 prompt: Dark/Mystery (eerie, unsettling, conspiracy, hacking)
   - 1 prompt: Legal/Political (courtroom gravity, formal, institutional weight)
   - 1 prompt: Revelation/Twist (shocking reveal, dramatic turn, cinematic hit)
5. Each prompt MUST start or end with: "instrumental, no vocals"

=== FULL SCRIPT ===
${fullScript}

=== RETURN FORMAT ===
Return ONLY valid JSON, NO explanations, NO markdown:
{
  "prompts": [
    {
      "mood": "Tense/Suspenseful",
      "description": "Âm nhạc căng thẳng, hồi hộp — phù hợp cảnh mâu thuẫn leo thang",
      "prompt": "Instrumental, no vocals. Cinematic suspense underscore, low cello drones building slowly, staccato strings, distant piano echoes fading in and out, sparse percussion with tension pulses, dark atmospheric pads, gradually intensifying, 60 BPM, modern thriller film score style, pure mood and texture"
    }
  ]
}`;
}
