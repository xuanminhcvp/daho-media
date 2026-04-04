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
    maxFootagePerBatch: number = 15,
    bRollStartSec: number = 60
): string {
    return `You are a professional video editor selecting B-roll footage for a narration video.

=== SCRIPT WITH TIMING ===
${scriptWithTiming}

=== AVAILABLE FOOTAGE LIBRARY (JSON) ===
${footageListJson}

=== TASK ===
Select roughly ${maxFootagePerBatch} footage clips that would work as B-roll overlay for this short-form vertical video.
Total video duration: ${totalDurationSec.toFixed(1)} seconds.

Return a JSON array of selections:
[
  {
    "i": 3,
    "s": 72.5,
    "e": 76.0,
    "f": "city_night.mp4",
    "ts": 2.0,
    "te": 5.5
  }
]

=== RULES ===
1. Select about ${maxFootagePerBatch} footage clips — depending on the density requested
2. ⚠️ IMPORTANT: Do NOT place any footage in the FIRST ${bRollStartSec.toFixed(1)} SECONDS of the video. All startTime must be >= ${bRollStartSec.toFixed(1)}
3. Footage only needs to be LOOSELY RELATED (illustrative, metaphorical is OK)
4. Each footage trimmed segment must be 3-8 seconds (never exceed 20 seconds)
5. "trimStart" and "trimEnd" refer to the footage file's own timeline (not the video timeline)
6. "startTime" and "endTime" refer to WHERE on the video timeline to place the footage
7. Script is grouped into timing CLUSTERS (~30s each). You can place footage anywhere inside a relevant cluster (not required to match exact 30s boundaries)
8. Spread clips evenly throughout the video (after the blocked intro zone) — don't cluster in one section
9. Prefer unique footage files; if library is small, reusing a file is allowed to reach target clip count
10. Use the word timing to find natural transition points (start/end of sentences)
11. trimEnd - trimStart must equal endTime - startTime (same duration)
12. startTime must align with actual word timing from the script
13. Use compact keys ONLY to save tokens: i=sentenceIndex, s=startTime, e=endTime, f=footageFile, ts=trimStart, te=trimEnd

RESPOND WITH JSON ARRAY ONLY. No markdown code blocks.`;
}
