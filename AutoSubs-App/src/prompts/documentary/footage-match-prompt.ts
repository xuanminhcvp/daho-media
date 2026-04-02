/**
 * footage-match-prompt.ts
 *
 * Prompt cho AI matching footage với script
 * AI nhận: script (whisper word timing) + danh sách footage metadata
 * AI trả: 10-15 footage suggestions (câu nào, footage nào, trim bao lâu)
 * Bỏ qua 1 phút đầu tiên video (không đặt footage)
 */

/**
 * Tạo prompt matching footage → script
 * @param scriptWithTiming - Script với word timing từ whisper
 * @param footageListJson - Danh sách footage metadata (JSON string)
 * @param totalDurationSec - Tổng thời lượng video (giây)
 */
export function buildFootageMatchPrompt(
    scriptWithTiming: string,
    footageListJson: string,
    totalDurationSec: number,
    maxFootagePerBatch: number = 15
): string {
    return `You are a professional video editor selecting B-roll footage for a narration video.

=== SCRIPT WITH TIMING ===
${scriptWithTiming}

=== AVAILABLE FOOTAGE LIBRARY (JSON) ===
${footageListJson}

=== TASK ===
Select roughly ${maxFootagePerBatch} footage clips that would work as B-roll overlay for this narration video.
Total video duration: ${totalDurationSec.toFixed(1)} seconds.

Return a JSON array of selections:
[
  {
    "sentenceIndex": 3,
    "startTime": 72.5,
    "endTime": 76.0,
    "footageFile": "city_night.mp4",
    "trimStart": 2.0,
    "trimEnd": 5.5,
    "reason": "Câu nói về thành phố ban đêm — footage aerial city night phù hợp để minh hoạ"
  }
]

=== RULES ===
1. Select about ${maxFootagePerBatch} footage clips — depending on the density requested
2. ⚠️ IMPORTANT: Do NOT place any footage in the FIRST 60 SECONDS of the video. All startTime must be >= 60.0
3. Footage only needs to be LOOSELY RELATED (illustrative, metaphorical is OK)
4. Each footage trimmed segment must be 3-8 seconds (never exceed 20 seconds)
5. "trimStart" and "trimEnd" refer to the footage file's own timeline (not the video timeline)
6. "startTime" and "endTime" refer to WHERE on the video timeline to place the footage
7. Spread clips evenly throughout the video (after the first 60s) — don't cluster in one section
8. DO NOT use the same footage file more than once
9. Use the word timing to find natural transition points (start/end of sentences)
10. trimEnd - trimStart must equal endTime - startTime (same duration)
11. startTime must align with actual word timing from the script
12. "reason" should be in Vietnamese

RESPOND WITH JSON ARRAY ONLY. No markdown code blocks.`;
}
