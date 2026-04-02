// subtitle-match-prompt.ts
// Prompt for AI to match script → whisper words and create subtitles
// Different from match-prompt.ts:
//   - No numbering (num) — continuous text
//   - AI splits long sentences into shorter subtitle lines (≤ 45 chars)
//   - Output: [{text, start, end}, ...] — each element is a separate subtitle line

/**
 * Build the main matching prompt for subtitle generation
 *
 * @param scriptText    - Script text for this batch (no numbering)
 * @param whisperPart   - Formatted whisper transcript: "[0.16] word [0.32] word ..."
 * @param batchNum      - Current batch number (1-12)
 * @param totalBatches  - Total number of batches
 * @param partTimeRange - Time range: "0s → 600s"
 * @param maxCharsPerLine - Max characters per subtitle line (default 45)
 */
export function buildSubtitleMatchPrompt(
    scriptText: string,
    whisperPart: string,
    batchNum: number,
    totalBatches: number,
    partTimeRange: string,
    maxCharsPerLine: number = 45
): string {
    return `You are a subtitle creation expert. Your task: match the original script with a Whisper transcript to create subtitles with accurate timing.

=== CONTEXT ===
- This is part ${batchNum}/${totalBatches} of the video (approximately ${partTimeRange})
- ONLY create subtitles for content that BELONGS to this transcript section
- Content NOT in this section → SKIP

=== CRITICAL RULE: NEVER TRANSLATE ===
⚠️ You MUST use the EXACT text from the original script below.
⚠️ NEVER translate, paraphrase, or change the language of the script.
⚠️ If the script is in English, output MUST be in English.
⚠️ If the script is in Vietnamese, output MUST be in Vietnamese.
⚠️ Copy the script text EXACTLY — only split into shorter lines if needed.

=== SUBTITLE RULES ===

1. **SPLIT LONG SENTENCES**: Each subtitle line MAXIMUM ${maxCharsPerLine} characters.
   - If the original sentence is longer → SPLIT into 2-3 consecutive subtitle lines
   - Each line is a separate element in the output
   - Timing is divided proportionally by word count

   Example: "In 2026 the Sinaloa Cartel controlled all drug trafficking routes from Mexico to the United States"
   → Split into 3 lines:
     {"text": "In 2026 the Sinaloa Cartel", "start": 12.34, "end": 14.80}
     {"text": "controlled all drug trafficking routes", "start": 14.80, "end": 17.20}
     {"text": "from Mexico to the United States", "start": 17.20, "end": 19.60}

2. **SHORT SENTENCES** (≤ ${maxCharsPerLine} chars): keep as-is, 1 line = 1 subtitle

3. **WHERE TO SPLIT**: Split at natural boundaries:
   - After commas, semicolons
   - Between main/subordinate clauses
   - After conjunctions (and, but, or, because, so...)
   - NEVER split in the middle of a noun phrase or verb phrase

4. **TIMING**: 
   - start(N) must increase: start(1) < start(2) < start(3) ...
   - end(N) ≈ start(N+1) — continuous, no gaps
   - Use precise timing from Whisper words

5. **SCRIPT vs WHISPER DIFFERENCES**: 
   - NUMBERS: Script writes words → Whisper writes digits ("twenty-second" = "22")
   - PROPER NOUNS: Whisper may transcribe differently ("Jalisco" ≈ "Halisco")
   - PUNCTUATION differs → ignore
   - Match by MEANING, not exact text

=== WHISPER TRANSCRIPT (PART ${batchNum}/${totalBatches}) ===
Format: [seconds] word [seconds] word ... Each [X.XX] = start time of that word.

${whisperPart}

=== ORIGINAL SCRIPT (PART ${batchNum}/${totalBatches}) ===
${scriptText}

=== OUTPUT ===
ONLY JSON array, NO markdown, NO explanation.
Each element = 1 subtitle line (already split short):
[
  {"text": "Short subtitle line", "start": 0.00, "end": 0.00},
  {"text": "Next content", "start": 0.00, "end": 0.00},
  ...
]`;
}

/**
 * Retry prompt for missing sections — force AI to create subtitles
 *
 * @param scriptChunk     - Script text chunk to retry
 * @param whisperSlice    - Whisper transcript in the time range
 * @param timeRange       - Time range: "120s → 180s"
 * @param maxCharsPerLine - Max characters per line
 */
export function buildSubtitleRetryPrompt(
    scriptChunk: string,
    whisperSlice: string,
    timeRange: string,
    maxCharsPerLine: number = 45
): string {
    return `You are a subtitle expert. Create subtitles for the following script section.

=== CRITICAL: NEVER TRANSLATE ===
⚠️ Use the EXACT text from the script below. NEVER translate or change the language.

=== RULES ===
- Each subtitle line MAXIMUM ${maxCharsPerLine} characters
- Long sentences → SPLIT into 2-3 consecutive lines
- Timing must fall within range ${timeRange}
- You MUST create subtitles for ALL content below
- If no exact Whisper match → distribute timing evenly

=== WHISPER TRANSCRIPT ===
${whisperSlice}

=== SCRIPT TO SUBTITLE ===
${scriptChunk}

=== OUTPUT ===
ONLY JSON array:
[
  {"text": "subtitle line", "start": 0.00, "end": 0.00},
  ...
]`;
}

/**
 * Prompt chia nhỏ câu từ Matching_sentence (có sẵn thời gian 1 câu dài)
 */
export function buildSubtitleMatchFromSentencesPrompt(
    sentencesJson: string,
    whisperPart: string,
    batchNum: number,
    totalBatches: number,
    maxCharsPerLine: number = 45
): string {
    return `You are a subtitle creation expert.
Your task is to take a list of long sentences (which already have accurate start and end times) and split them into shorter subtitle lines suitable for short videos (TikTok/Shorts).

=== CONTEXT ===
- This is part ${batchNum}/${totalBatches} of the video script.
- Each sentence provided below has a "text", "start" (seconds), and "end" (seconds).

=== CRITICAL RULES ===
1. **NEVER TRANSLATE**: Use the EXACT text from the input sentences. If it's Vietnamese, output Vietnamese. Do not change any words.
2. **MAX CHARACTERS**: Each subtitle line MAXIMUM ${maxCharsPerLine} characters.
3. **SPLIT LONG SENTENCES**: If a sentence length > ${maxCharsPerLine}, split it into 2-3 logical lines (at commas, conjunctions, etc).
4. **TIMING**: 
${whisperPart ? `   - Use the WHISPER TRANSCRIPT below to find the EXACT start time of words within the sentence!
   - Your output MUST align perfectly with the whisper word timings to avoid fractional/estimated times.` : `   - When you split a sentence, you MUST linearly divide the time from the original sentence's start/end.
   - Example output split: {"text": "Xin chào", "start": 0.0, "end": 2.0}`}

=== INPUT SENTENCES ===
${sentencesJson}
${whisperPart ? `\n=== WHISPER TRANSCRIPT (EXACT WORD TIMING) ===
Format: [seconds] word [seconds] word ... Each [X.XX] = start time of that word.
${whisperPart}\n` : ''}
=== OUTPUT FORMAT ===
ONLY output a JSON array of the split subtitle lines. NO markdown formatting, NO extra text.
[
  {"text": "Short subtitle line 1", "start": 0.00, "end": 2.00},
  {"text": "Short subtitle line 2", "start": 2.00, "end": 4.00}
]
`;
}

