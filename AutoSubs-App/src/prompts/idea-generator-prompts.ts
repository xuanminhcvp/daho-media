// idea-generator-prompts.ts
// Các prompt hỗ trợ chức năng sinh ý tưởng (gợi ý từ khóa BGM, SFX, Footage) dựa theo Profile
// Không phụ thuộc vào kịch bản (Script-independent)

export function buildIdeaGeneratorPrompt(mediaType: "music" | "sfx" | "footage", profileId: string): string {
    const randomSeed = Math.floor(Math.random() * 1000000);
    let profileName = "General Media";
    let profileDesc = "";
    
    if (profileId === "documentary") {
        profileName = "3D Investigative Documentary";
        profileDesc = "thể loại phim tài liệu điều tra giật gân, bí ẩn, hình ảnh 3D chân thực, tiết tấu dồn dập, sự thật bị che giấu";
    } else if (profileId === "tiktok") {
        profileName = "TikTok / YouTube Shorts (Short-form)";
        profileDesc = "thể loại video ngắn tốc độ nhanh, nhiều hook, giật gân, hài hước hoặc gây tò mò cường độ cao";
    } else if (profileId === "stories") {
        profileName = "Storytelling / Drama / Humanistic";
        profileDesc = "thể loại kể chuyện có cốt truyện lôi cuốn, gay cấn xung đột hoặc các câu chuyện nhân văn, cảm động, sâu sắc";
    }

    if (mediaType === "music") {
        return `You are a professional Music Supervisor for a YouTube channel focusing on ${profileName} (${profileDesc}).
Your job is to write Suno AI prompts that generate cinematic background music.

=== TASK ===
Generate EXACTLY 10 Suno AI music prompts suitable for this channel's style. No specific script is provided, base it entirely on the typical moods, hooks, and atmospheres of ${profileName}.

=== REQUIREMENTS ===
1. Each prompt must be ~50 words in English.
2. Include: instrumentation, tempo, mood, style, and key sonic elements.
3. EVERY prompt MUST contain the words "instrumental" and "no vocals" — this is CRITICAL so Suno does NOT generate singing voices.
4. DO NOT include lyrics, song names, or artist names.
5. Provide a VARIETY of moods (e.g., tension, action, calm, mystery, reveal, etc.).
6. Each prompt MUST start or end with: "instrumental, no vocals".
7. CRITICAL OBJECTIVE: Provide HIGHLY DIVERSE, unique prompts. Think outside the box. Avoid typical or overused prompts. Random variance token: ${randomSeed}.

=== RETURN FORMAT ===
Return ONLY valid JSON (NO markdown, NO other text):
{
  "prompts": [
    {
      "mood": "Tense/Suspenseful",
      "description": "Âm nhạc căng thẳng, hồi hộp — phù hợp cảnh mâu thuẫn leo thang",
      "prompt": "Instrumental, no vocals. Cinematic suspense underscore, low cello drones building slowly..."
    }
  ]
}`;
    }

    if (mediaType === "sfx") {
        return `You are a professional Sound Designer for a YouTube channel focusing on ${profileName} (${profileDesc}).

=== TASK ===
Suggest EXACTLY 10 SFX (sound effects) keywords that the user should download to build their sound library for this genre. No specific script is provided, so rely on the typical narrative hooks, transitions, and impacts used in ${profileName}.

=== REQUIREMENTS ===
1. Include cinematic sounds (e.g., braams, whooshes, impacts, risers) and genre-specific foley sounds.
2. Each keyword must be a short English phrase, easy to search on Freesound.org, Pixabay, Mixkit.
3. Sort by PRIORITY — most essential SFX first.
4. Return ONLY keywords (strings), no long descriptions.
5. CRITICAL OBJECTIVE: Provide HIGHLY DIVERSE, unique keywords. Think outside the box. Avoid typical or overused keywords. Random variance token: ${randomSeed}.

=== RETURN FORMAT ===
Return ONLY valid JSON (NO markdown, NO other text):
{
  "keywords": [
    "cinematic heavy impact",
    "dark tension riser",
    "glass shattering",
    "whoosh transition"
  ]
}`;
    }

    // mediaType === "footage"
    return `You are a professional Video Editor / Director for a YouTube channel focusing on ${profileName} (${profileDesc}).

=== TASK ===
Suggest EXACTLY 10 footage search keywords that the user should find to build their B-roll library for this genre. No specific script is provided, so rely on typical themes, metaphors, and visual styles used in ${profileName}.

=== REQUIREMENTS ===
1. Suggest high-quality, abstract, or highly relevant cinematic keywords (e.g., "dark clouds passing timelapse", "hacker typing in dark", "abandoned room slow pan").
2. Must be in English, suitable for search on Artgrid, Envato, Pexels, Storyblocks, etc.
3. Return ONLY keywords (strings), no long explanations.
4. CRITICAL OBJECTIVE: Provide HIGHLY DIVERSE, unique keywords. Think outside the box. Avoid typical or overused keywords. Random variance token: ${randomSeed}.

=== RETURN FORMAT ===
Return ONLY valid JSON (NO markdown, NO other text):
{
  "keywords": [
    "cinematic timelapse dark clouds",
    "detective evidence board",
    "police sirens flashing tracking shot"
  ]
}`;
}
