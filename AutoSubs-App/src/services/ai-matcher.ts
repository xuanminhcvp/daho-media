// ai-matcher.ts
// Service gọi AI (Claude Sonnet local) để matching script với Whisper transcript
// Chiến lược: cắt transcript 3 phần + gửi full kịch bản mỗi batch
// → Tiết kiệm token, AI tự tìm câu match cho phần transcript đó

import {
    ScriptSentence,
    extractWhisperWords,
} from "@/utils/media-matcher";
import { buildMatchPrompt } from "@/prompts/match-prompt";
import { writeTextFile, readTextFile, exists } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";

// ======================== CẤU HÌNH AI ========================
const AI_CONFIG = {
    baseUrl: "https://ezaiapi.com/v1",
    apiKey: "sk-570848c49fda787c748cd58f3a21a1d95f00afd87a5cba6e",
    model: "claude-sonnet-4-6",  // Sonnet — nhanh hơn Opus, vẫn chính xác tốt
    batchCount: 8,       // Chia transcript 8 phần (~60 câu/batch, tránh Claude 524 timeout)
    timeoutMs: 900000,   // 15 phút timeout per request
    maxTokens: 16000,    // Đủ cho output JSON
};

// Tên file lưu kết quả matching (KHÔNG dùng dấu . ở đầu — hidden file bị Tauri chặn trên macOS)
const MATCHING_CACHE_FILE = "autosubs_matching.json";

// ======================== LƯU / LOAD KẾT QUẢ ========================

export async function saveMatchingResults(
    mediaFolder: string,
    results: ScriptSentence[]
): Promise<void> {
    try {
        const filePath = await join(mediaFolder, MATCHING_CACHE_FILE);
        const data = {
            version: 2,
            savedAt: new Date().toISOString(),
            totalSentences: results.length,
            results,
        };
        console.log(`[AI Matcher] Đang lưu ${results.length} kết quả vào: ${filePath}`);
        await writeTextFile(filePath, JSON.stringify(data, null, 2));
        console.log(`[AI Matcher] ✅ Lưu thành công!`);
    } catch (error) {
        console.error("[AI Matcher] ❌ Lỗi lưu kết quả:", error);
        console.error("[AI Matcher] mediaFolder:", mediaFolder);
        console.error("[AI Matcher] MATCHING_CACHE_FILE:", MATCHING_CACHE_FILE);
    }
}

export async function loadMatchingResults(
    mediaFolder: string
): Promise<ScriptSentence[] | null> {
    try {
        const filePath = await join(mediaFolder, MATCHING_CACHE_FILE);
        console.log(`[AI Matcher] Đang tìm cache tại: ${filePath}`);

        const fileExists = await exists(filePath);
        console.log(`[AI Matcher] File exists: ${fileExists}`);

        if (!fileExists) {
            console.log(`[AI Matcher] Không tìm thấy cache file.`);
            return null;
        }

        const content = await readTextFile(filePath);
        const data = JSON.parse(content);

        if (data.version && data.results && Array.isArray(data.results)) {
            console.log(`[AI Matcher] ✅ Loaded ${data.results.length} kết quả từ cache (${data.savedAt})`);
            return data.results;
        }
        console.log(`[AI Matcher] ⚠️ File cache có format không đúng.`);
        return null;
    } catch (error) {
        console.error("[AI Matcher] ❌ Lỗi load cache:", error);
        console.error("[AI Matcher] mediaFolder:", mediaFolder);
        return null;
    }
}

// ======================== INTERFACES ========================
export interface AIMatchProgress {
    current: number;
    total: number;
    message: string;
}

// ======================== FORMAT WHISPER ========================

/** Cấu trúc 1 word đã format */
interface FormattedWord {
    timestamp: number;
    text: string;
    formatted: string; // "[0.16] February"
}

/**
 * Format TOÀN BỘ whisper segments thành mảng words có timestamps
 * Trả về array để dễ cắt theo vị trí
 */
function formatWhisperWords(segments: any[]): FormattedWord[] {
    const words: FormattedWord[] = [];

    for (const seg of segments) {
        const segStart = parseFloat(seg.start || "0");
        const segEnd = parseFloat(seg.end || "0");

        const segWords = seg.words || [];
        if (segWords.length > 0) {
            for (const w of segWords) {
                const ws = parseFloat(w.start || "0");
                const wt = (w.word || "").trim();
                if (!wt) continue;
                words.push({
                    timestamp: ws,
                    text: wt,
                    formatted: `[${ws.toFixed(2)}] ${wt}`,
                });
            }
        } else {
            const text = (seg.text || "").trim();
            if (text) {
                words.push({
                    timestamp: segStart,
                    text: text,
                    formatted: `[${segStart.toFixed(2)}-${segEnd.toFixed(2)}] ${text}`,
                });
            }
        }
    }

    return words;
}

/**
 * Cắt transcript thành N phần tại ranh giới câu (dấu . ? !)
 * Mỗi phần BẮT BUỘC kết thúc bằng dấu chấm câu → hết câu hoàn chỉnh
 * KHÔNG BAO GIỜ cắt lưng chừng giữa câu
 */
function splitTranscriptAtSentenceBoundaries(
    words: FormattedWord[],
    numParts: number
): { text: string; startTime: number; endTime: number }[] {
    if (words.length === 0) return [];

    // Bước 1: Tìm TẤT CẢ vị trí dấu chấm câu trong transcript
    // sentenceEnds[i] = index SAU word có dấu chấm (vị trí cắt hợp lệ)
    const sentenceEnds: number[] = [];
    for (let i = 0; i < words.length; i++) {
        const wordText = words[i].text;
        if (wordText.endsWith(".") || wordText.endsWith("?") || wordText.endsWith("!")) {
            sentenceEnds.push(i + 1); // Cắt SAU dấu chấm
        }
    }

    // Nếu không có dấu chấm nào → trả về nguyên 1 phần
    if (sentenceEnds.length === 0) {
        console.warn("[AI Matcher] ⚠️ Transcript không có dấu chấm câu nào!");
        return [{
            text: words.map(w => w.formatted).join(" "),
            startTime: words[0].timestamp,
            endTime: words[words.length - 1].timestamp,
        }];
    }

    const parts: { text: string; startTime: number; endTime: number }[] = [];
    const idealPartSize = Math.ceil(words.length / numParts);

    let partStart = 0;

    for (let p = 0; p < numParts; p++) {
        // Phần cuối: lấy hết phần còn lại
        if (p === numParts - 1) {
            const partWords = words.slice(partStart);
            if (partWords.length > 0) {
                parts.push({
                    text: partWords.map(w => w.formatted).join(" "),
                    startTime: partWords[0].timestamp,
                    endTime: partWords[partWords.length - 1].timestamp,
                });
            }
            break;
        }

        // Vị trí target để cắt (theo chia đều)
        const targetCut = partStart + idealPartSize;

        // Tìm dấu chấm câu GẦN NHẤT với targetCut (phải > partStart)
        let bestCutIdx = -1;
        let bestDistance = Infinity;

        for (const seIdx of sentenceEnds) {
            if (seIdx <= partStart) continue; // Phải sau vị trí bắt đầu hiện tại
            if (seIdx >= words.length) continue; // Không được vượt quá cuối

            const distance = Math.abs(seIdx - targetCut);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestCutIdx = seIdx;
            }
        }

        // Nếu không tìm được dấu chấm nào (rất hiếm) → lấy hết
        if (bestCutIdx === -1) {
            console.warn(`[AI Matcher] ⚠️ Batch ${p + 1}: không tìm thấy dấu chấm câu, lấy hết phần còn lại`);
            const partWords = words.slice(partStart);
            if (partWords.length > 0) {
                parts.push({
                    text: partWords.map(w => w.formatted).join(" "),
                    startTime: partWords[0].timestamp,
                    endTime: partWords[partWords.length - 1].timestamp,
                });
            }
            break;
        }

        // Tạo phần transcript (cắt tại dấu chấm câu)
        const partWords = words.slice(partStart, bestCutIdx);
        if (partWords.length > 0) {
            parts.push({
                text: partWords.map(w => w.formatted).join(" "),
                startTime: partWords[0].timestamp,
                endTime: partWords[partWords.length - 1].timestamp,
            });
            console.log(`[AI Matcher] Batch ${p + 1}: words ${partStart}-${bestCutIdx - 1}, ends with "${words[bestCutIdx - 1].text}"`);
        }

        partStart = bestCutIdx;
    }

    return parts;
}

// ======================== GỌI AI API (MULTI-PROVIDER) ========================
// ⚡ Round-robin Claude/Gemini — 5 batch song song, chia tải 2 provider
async function callAI(prompt: string, label: string = "AI Call", timeoutMs?: number): Promise<string> {
    const { callAIMultiProvider } = await import("@/utils/ai-provider");
    return callAIMultiProvider(prompt, label, "auto", timeoutMs || AI_CONFIG.timeoutMs);
}

// ======================== PARSE AI RESPONSE ========================
// AI trả về: [{"num": X, "start": 0.00, "end": 0.00, "whisper": "matched text"}]
// ⭐ Xử lý cả trường hợp JSON bị truncated (AI output bị cắt cụt)
function parseAIResponse(aiResponse: string): { num: number; start: number; end: number; whisper: string }[] {
    // Bỏ thinking tags
    let cleaned = aiResponse.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");

    // Bỏ markdown code block
    const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) cleaned = codeBlock[1];

    // Tìm JSON array hoàn chỉnh
    let jsonMatch = cleaned.match(/\[[\s\S]*\]/);

    // ⭐ Nếu không tìm thấy ] đóng → JSON bị truncated
    // Tìm [ mở, sau đó tìm } cuối cùng hợp lệ, thêm ] để parse phần đã có
    if (!jsonMatch) {
        const openBracket = cleaned.indexOf("[");
        if (openBracket === -1) {
            console.error("[AI] Response không có JSON:", cleaned.slice(0, 500));
            throw new Error("AI response không chứa JSON array");
        }

        // Tìm } cuối cùng (kết thúc object cuối)
        const afterOpen = cleaned.slice(openBracket);
        const lastBrace = afterOpen.lastIndexOf("}");
        if (lastBrace === -1) {
            console.error("[AI] JSON truncated nghiêm trọng, không có {} nào:", cleaned.slice(0, 500));
            throw new Error("AI response JSON truncated quá nhiều");
        }

        // Cắt tới } cuối + thêm ] để tạo valid JSON array
        const truncatedJson = afterOpen.slice(0, lastBrace + 1) + "]";
        console.warn(`[AI] ⚠️ JSON bị truncated! Khôi phục ${truncatedJson.length} chars`);
        jsonMatch = [truncatedJson];
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) throw new Error("Không phải array");

    const results = parsed
        .filter(
            (r: any) =>
                typeof r.num === "number" &&
                typeof r.start === "number" &&
                typeof r.end === "number"
        )
        .map((r: any) => ({
            num: r.num,
            start: Math.max(0, r.start),
            end: Math.max(r.start, r.end),
            whisper: typeof r.whisper === "string" ? r.whisper : "",
        }));

    console.log(`[AI] Parsed ${results.length} entries thành công`);
    return results;
}



// ======================== HÀM CHÍNH ========================
/**
 * AI matching: chia CẢ transcript lẫn script theo tỷ lệ + overlap
 *
 * Mỗi batch: 1/N transcript + phần script TƯƠNG ỨNG (±20% overlap)
 * → Prompt nhỏ hơn, AI output ngắn hơn, không bị truncate
 * → Overlap đảm bảo câu ở ranh giới không bị bỏ sót
 */
export async function aiMatchScriptToTimeline(
    scriptSentences: { num: number; text: string }[],
    transcript: any,
    onProgress?: (progress: AIMatchProgress) => void,
    mediaFolder?: string
): Promise<ScriptSentence[]> {
    const segments = transcript.originalSegments || transcript.segments || [];
    const whisperWords = extractWhisperWords(transcript);

    const totalDuration =
        whisperWords.length > 0 ? whisperWords[whisperWords.length - 1].end : 0;

    // Format toàn bộ words
    const allFormattedWords = formatWhisperWords(segments);

    console.log(
        `[AI Matcher] ${scriptSentences.length} câu, ${allFormattedWords.length} words, ${totalDuration.toFixed(0)}s`
    );

    // ⭐ Cắt transcript thành N phần tại ranh giới câu
    const rawTranscriptParts = splitTranscriptAtSentenceBoundaries(
        allFormattedWords,
        AI_CONFIG.batchCount
    );

    // ⭐ Thêm OVERLAP cho transcript — mỗi phần lấy thêm 15% words
    // từ phần liền kề (trước + sau) để câu ở ranh giới không bị trượt
    const TRANSCRIPT_OVERLAP_RATIO = 0.15; // 15% overlap mỗi bên
    const wordsPerPart = Math.ceil(allFormattedWords.length / rawTranscriptParts.length);
    const transcriptOverlapWords = Math.ceil(wordsPerPart * TRANSCRIPT_OVERLAP_RATIO);

    const transcriptParts: { text: string; startTime: number; endTime: number }[] = [];

    for (let i = 0; i < rawTranscriptParts.length; i++) {
        const part = rawTranscriptParts[i];

        // Tìm vị trí bắt đầu và kết thúc trong allFormattedWords
        // dựa trên timestamp
        let startIdx = 0;
        let endIdx = allFormattedWords.length;

        // Tìm startIdx = word đầu tiên có timestamp >= part.startTime
        for (let w = 0; w < allFormattedWords.length; w++) {
            if (allFormattedWords[w].timestamp >= part.startTime - 0.01) {
                startIdx = w;
                break;
            }
        }
        // Tìm endIdx = word cuối cùng có timestamp <= part.endTime
        for (let w = allFormattedWords.length - 1; w >= 0; w--) {
            if (allFormattedWords[w].timestamp <= part.endTime + 0.01) {
                endIdx = w + 1;
                break;
            }
        }

        // Mở rộng overlap: lấy thêm words trước và sau
        const overlapStart = Math.max(0, startIdx - transcriptOverlapWords);
        const overlapEnd = Math.min(allFormattedWords.length, endIdx + transcriptOverlapWords);

        const expandedWords = allFormattedWords.slice(overlapStart, overlapEnd);
        transcriptParts.push({
            text: expandedWords.map(w => w.formatted).join(" "),
            startTime: expandedWords[0]?.timestamp || 0,
            endTime: expandedWords[expandedWords.length - 1]?.timestamp || 0,
        });
    }

    console.log(`[AI Matcher] Chia transcript ${transcriptParts.length} phần (overlap ±${transcriptOverlapWords} words):`);
    transcriptParts.forEach((p, i) =>
        console.log(`  Phần ${i + 1}: ${p.startTime.toFixed(0)}s → ${p.endTime.toFixed(0)}s (~${(p.text.length / 1000).toFixed(0)}KB)`)
    );

    // ⭐ Chia script theo tỷ lệ với overlap ±20%
    // Script theo thứ tự thời gian nên chia tỷ lệ rất chính xác
    const totalSentences = scriptSentences.length;
    const N = transcriptParts.length;
    const SCRIPT_OVERLAP_RATIO = 0.20; // 20% overlap mỗi bên
    const sentencesPerPart = totalSentences / N;

    const scriptBatches: { num: number; text: string }[][] = [];
    for (let i = 0; i < N; i++) {
        // Tính vùng câu cho batch này (có overlap)
        const rawStart = Math.floor(sentencesPerPart * i);
        const rawEnd = Math.ceil(sentencesPerPart * (i + 1));
        const overlapSize = Math.ceil(sentencesPerPart * SCRIPT_OVERLAP_RATIO);

        // Mở rộng ±overlap, clamp vào [0, totalSentences]
        const batchStart = Math.max(0, rawStart - overlapSize);
        const batchEnd = Math.min(totalSentences, rawEnd + overlapSize);

        scriptBatches.push(scriptSentences.slice(batchStart, batchEnd));
        console.log(`[AI Matcher] Script batch ${i + 1}: câu ${scriptSentences[batchStart]?.num} → ${scriptSentences[batchEnd - 1]?.num} (${batchEnd - batchStart} câu, overlap ±${overlapSize})`);
    }

    onProgress?.({
        current: 0,
        total: N,
        message: `Đang xử lý ${N} batch (script chia tỷ lệ + overlap)...`,
    });

    // Thu thập tất cả kết quả từ các batch
    const matchedMap = new Map<number, { start: number; end: number; whisper: string }>();

    // ⚡ Gửi SONG SONG tất cả batch cùng lúc
    const batchPromises = transcriptParts.map(async (part, i) => {
        const batchNum = i + 1;
        const timeRange = `${part.startTime.toFixed(0)}s → ${part.endTime.toFixed(0)}s`;
        const batchScript = scriptBatches[i];

        onProgress?.({
            current: i,
            total: N,
            message: `Đang gửi ${N} batch song song...`,
        });

        try {
            // ⭐ Tạo prompt: 1/N transcript + phần script TƯƠNG ỨNG (không full)
            const prompt = buildMatchPrompt(
                batchScript,
                part.text,
                batchNum,
                N,
                timeRange
            );

            console.log(`[AI Matcher] Batch ${batchNum}: transcript ${timeRange}, ${batchScript.length} câu script, prompt ~${(prompt.length / 1000).toFixed(0)}KB`);

            // Gọi AI (song song)
            const response = await callAI(
                prompt,
                `Batch ${batchNum}/${N} (${timeRange}) ${batchScript.length} câu`
            );

            // Parse kết quả (có xử lý truncated JSON)
            const aiResults = parseAIResponse(response);
            console.log(`[AI Matcher] Batch ${batchNum}: ${aiResults.length} câu matched ✅`);

            return { batchNum, aiResults };
        } catch (error) {
            console.error(`[AI Matcher] Batch ${batchNum} LỖI:`, error);
            return { batchNum, aiResults: [] as { num: number; start: number; end: number; whisper: string }[] };
        }
    });

    // Chờ TẤT CẢ batch hoàn thành
    const batchResults = await Promise.all(batchPromises);

    // Ghép kết quả từ tất cả batch (theo thứ tự batch 1 → N)
    for (const { batchNum, aiResults } of batchResults.sort((a, b) => a.batchNum - b.batchNum)) {
        // ⭐ Lưu kết quả: ưu tiên timing nằm TRONG time range hợp lý của batch
        for (const r of aiResults) {
            if (!matchedMap.has(r.num)) {
                matchedMap.set(r.num, { start: r.start, end: r.end, whisper: r.whisper });
            } else {
                const existing = matchedMap.get(r.num)!;
                // Ưu tiên match nằm gần expected position hơn (dựa trên scene index)
                // Scene num nhỏ → timing sớm, scene num lớn → timing muộn
                const sentIdx = scriptSentences.findIndex(s => s.num === r.num);
                const expectedRatio = sentIdx / scriptSentences.length;
                const expectedTime = expectedRatio * totalDuration;
                const existingDist = Math.abs((existing.start + existing.end) / 2 - expectedTime);
                const newDist = Math.abs((r.start + r.end) / 2 - expectedTime);

                if (newDist < existingDist) {
                    console.log(`[AI Matcher] Batch ${batchNum}: Thay num=${r.num} (timing gần expected hơn: ${newDist.toFixed(0)} < ${existingDist.toFixed(0)})`);
                    matchedMap.set(r.num, { start: r.start, end: r.end, whisper: r.whisper });
                } else {
                    console.log(`[AI Matcher] Batch ${batchNum}: Giữ num=${r.num} cũ (timing cũ gần expected hơn)`);
                }
            }
        }
    }

    // ======================== RETRY LOOP — SCENES THIẾU ========================
    // Retry nhiều lần cho đến khi hết missing hoặc đạt max rounds
    // Round 1: buffer 5s, prompt bình thường
    // Round 2+: buffer 10s, force-match (bắt AI phải ghép dù Whisper nghe sai)

    const MAX_RETRY_ROUNDS = 2;

    for (let round = 1; round <= MAX_RETRY_ROUNDS; round++) {
        const missingNums = scriptSentences
            .map(s => s.num)
            .filter(num => !matchedMap.has(num));

        // Hết missing → dừng retry
        if (missingNums.length === 0) {
            console.log(`[AI Matcher] ✅ Retry round ${round}: không còn scenes thiếu!`);
            break;
        }

        // Buffer time rộng dần theo round: 5s → 15s → 30s
        const timeBuffer = round === 1 ? 5 : round === 2 ? 15 : 30;
        // Context sentences cũng tăng dần: 3 → 5 → 8
        const contextSize = round === 1 ? 3 : round === 2 ? 5 : 8;
        const isForceMode = round >= 2;

        console.log(`[AI Matcher] ⚠️ Round ${round}/${MAX_RETRY_ROUNDS}: ${missingNums.length} scenes thiếu: ${missingNums.join(", ")}`);
        console.log(`[AI Matcher] 🔄 Buffer: ±${timeBuffer}s, Force: ${isForceMode}`);

        // Gom scenes thiếu thành cụm liên tiếp
        // Ví dụ: [321,322,323,330,331] → [[321,322,323], [330,331]]
        const clusters: number[][] = [];
        let currentCluster: number[] = [missingNums[0]];

        for (let i = 1; i < missingNums.length; i++) {
            if (missingNums[i] - missingNums[i - 1] <= 2) {
                // Khoảng cách ≤ 2 → cùng cụm (cho phép gap nhỏ)
                currentCluster.push(missingNums[i]);
            } else {
                clusters.push(currentCluster);
                currentCluster = [missingNums[i]];
            }
        }
        clusters.push(currentCluster);

        console.log(`[AI Matcher] 🔄 Round ${round}: ${clusters.length} cụm thiếu`);

        onProgress?.({
            current: N,
            total: N + clusters.length,
            message: `Retry round ${round}: ${missingNums.length} scenes thiếu (${clusters.length} cụm)...`,
        });

        // Retry song song cho tất cả cụm
        const retryPromises = clusters.map(async (cluster, ci) => {
            try {
                const clusterMin = cluster[0];
                const clusterMax = cluster[cluster.length - 1];

                // Tìm time range từ scenes xung quanh đã có timing
                let timeStart = 0;
                let timeEnd = totalDuration;

                // Tìm scene trước gần nhất đã có timing
                for (let n = clusterMin - 1; n >= 1; n--) {
                    if (matchedMap.has(n)) {
                        timeStart = Math.max(0, matchedMap.get(n)!.start - timeBuffer);
                        break;
                    }
                }

                // Tìm scene sau gần nhất đã có timing
                for (let n = clusterMax + 1; n <= scriptSentences[scriptSentences.length - 1].num + 10; n++) {
                    if (matchedMap.has(n)) {
                        timeEnd = matchedMap.get(n)!.end + timeBuffer;
                        break;
                    }
                }

                // Cắt transcript đúng khoảng time range
                const relevantWords = allFormattedWords.filter(
                    w => w.timestamp >= timeStart && w.timestamp <= timeEnd
                );

                if (relevantWords.length === 0) {
                    console.warn(`[AI Matcher] Round ${round} cụm ${ci + 1}: không có transcript trong ${timeStart.toFixed(0)}s → ${timeEnd.toFixed(0)}s`);
                    return [];
                }

                const transcriptSlice = relevantWords.map(w => w.formatted).join(" ");

                // Lấy script text: scenes thiếu + context trước/sau (tăng dần)
                const contextStart = Math.max(0, scriptSentences.findIndex(s => s.num === clusterMin) - contextSize);
                const contextEnd = Math.min(scriptSentences.length, scriptSentences.findIndex(s => s.num === clusterMax) + 1 + contextSize);
                const retryScripts = scriptSentences.slice(contextStart, contextEnd);

                const timeRange = `${timeStart.toFixed(0)}s → ${timeEnd.toFixed(0)}s`;

                console.log(`[AI Matcher] Round ${round} cụm ${ci + 1}: scenes ${clusterMin}-${clusterMax}, transcript ${timeRange}, ${relevantWords.length} words`);

                // Tạo prompt — round 2+ thêm force-match instruction
                let prompt = buildMatchPrompt(
                    retryScripts.map(s => ({ num: s.num, text: s.text })),
                    transcriptSlice,
                    1,
                    1,
                    timeRange
                );

                // Force-match: bắt AI PHẢI trả về timing cho MỌI câu
                if (isForceMode) {
                    const mustMatchNums = cluster.join(", ");
                    // Tính time range chính xác cho chia đều
                    const rangeStart = timeStart;
                    const rangeEnd = timeEnd;

                    prompt += `\n\n=== CHẾ ĐỘ BẮT BUỘC — KHÔNG ĐƯỢC BỎ SÓT ===
⚠️ CÁC CÂU SAU BẮT BUỘC PHẢI CÓ TRONG OUTPUT: #${mustMatchNums}

QUAN TRỌNG: Whisper thường nghe SAI, phiên âm sai, thiếu từ, hoặc gộp nhiều câu.
→ KHÔNG cần match text chính xác.
→ Chỉ cần ước lượng timing TƯƠNG ĐỐI dựa trên vị trí trong kịch bản.

CÁCH LÀM ĐƠN GIẢN:
1. Khoảng thời gian khả dụng: ${rangeStart.toFixed(1)}s → ${rangeEnd.toFixed(1)}s
2. Chia đều khoảng thời gian này cho ${cluster.length} câu (#${mustMatchNums})
3. Mỗi câu ≈ ${((rangeEnd - rangeStart) / cluster.length).toFixed(1)}s
4. Nếu thấy text tương đồng trong transcript → dùng timing chính xác đó
5. Nếu KHÔNG tìm thấy → chia đều thời gian

OUTPUT: Trả về JSON array cho TẤT CẢ ${cluster.length} câu. KHÔNG ĐƯỢC thiếu câu nào.
[{"num": X, "start": 0.00, "end": 0.00, "whisper": "estimated"}, ...]`;
                }

                const response = await callAI(
                    prompt,
                    `Round ${round} retry scenes ${clusterMin}-${clusterMax} (${timeRange})`,
                    isForceMode ? 45000 : 30000  // Force mode: 45s, bình thường: 30s
                );

                const retryResults = parseAIResponse(response);
                console.log(`[AI Matcher] Round ${round} cụm ${ci + 1}: ${retryResults.length} kết quả ✅`);

                return retryResults;
            } catch (error) {
                console.error(`[AI Matcher] Round ${round} cụm ${ci + 1} LỖI:`, error);
                return [];
            }
        });

        const retryResults = await Promise.all(retryPromises);

        // Merge kết quả retry — chỉ thêm cho scenes đang thiếu
        let retryFilled = 0;
        for (const results of retryResults) {
            for (const r of results) {
                if (!matchedMap.has(r.num)) {
                    matchedMap.set(r.num, { start: r.start, end: r.end, whisper: r.whisper });
                    retryFilled++;
                }
            }
        }

        const stillMissing = scriptSentences.filter(s => !matchedMap.has(s.num)).length;
        console.log(`[AI Matcher] 🔄 Round ${round} hoàn tất: +${retryFilled} scenes, còn thiếu: ${stillMissing}`);

        // Hết missing → dừng
        if (stillMissing === 0) break;
    }

    // ⭐ Ghép kết quả: lặp qua tất cả câu script theo thứ tự
    const allResults: ScriptSentence[] = [];

    for (const sent of scriptSentences) {
        const aiMatch = matchedMap.get(sent.num);

        if (aiMatch) {
            // Dùng trực tiếp whisper text từ AI (chính xác hơn cách tính tolerance ±0.1)
            const matchedWhisper = aiMatch.whisper || "(AI matched)";

            allResults.push({
                num: sent.num,
                text: sent.text,
                start: aiMatch.start,
                end: aiMatch.end,
                matchRate: "ai-matched",
                matchedWhisper,
                quality: "high",
            });
        } else {
            // AI không trả về → ước lượng từ câu trước/sau
            const prevEnd = allResults.length > 0 ? allResults[allResults.length - 1].end : 0;
            const dur = sent.text.split(" ").length * 0.4;
            allResults.push({
                num: sent.num,
                text: sent.text,
                start: prevEnd,
                end: prevEnd + dur,
                matchRate: "ai-missing",
                matchedWhisper: "(AI không trả về)",
                quality: "none",
            });
        }
    }

    // ======================== NORMALIZE FRAME-BASED ========================
    // Chuyển toàn bộ timing sang frame integer (24fps) → ép tăng dần → fill kín
    // Tránh lệch do float rounding khi import vào DaVinci Resolve

    const FPS = 24;
    const totalFrames = Math.max(1, Math.round(totalDuration * FPS));

    // Bước 1: Chuyển seconds → frames
    const framed = allResults.map(r => ({
        ref: r,
        startFrame: Math.max(0, Math.round(r.start * FPS)),
        endFrame: Math.max(1, Math.round(r.end * FPS)),
    }));

    // Bước 2: Forward pass — ép tăng dần tuyệt đối theo thứ tự scene
    let fixedOrder = 0;
    for (let i = 1; i < framed.length; i++) {
        const prev = framed[i - 1];
        const curr = framed[i];

        // Start phải >= end của scene trước
        if (curr.startFrame < prev.endFrame) {
            curr.startFrame = prev.endFrame;
            fixedOrder++;
        }
        // End phải > start (tối thiểu 1 frame)
        if (curr.endFrame <= curr.startFrame) {
            curr.endFrame = curr.startFrame + 1;
            fixedOrder++;
        }
    }

    if (fixedOrder > 0) {
        console.log(`[AI Matcher] 🔧 Đã sửa ${fixedOrder} scenes sai thứ tự (frame-based)`);
    }

    // Bước 3: Fill kín — clip[i].endFrame = clip[i+1].startFrame
    let gapsFilled = 0;
    for (let i = 0; i < framed.length - 1; i++) {
        if (framed[i].endFrame !== framed[i + 1].startFrame) {
            framed[i].endFrame = framed[i + 1].startFrame;
            gapsFilled++;
        }
        // Đảm bảo >= 1 frame
        if (framed[i].endFrame <= framed[i].startFrame) {
            framed[i].endFrame = framed[i].startFrame + 1;
        }
    }

    // Clip cuối kéo tới hết audio
    if (framed.length > 0) {
        const last = framed[framed.length - 1];
        if (last.endFrame < totalFrames) {
            last.endFrame = totalFrames;
            gapsFilled++;
        }
    }

    // Bước 4: Ghi lại start/end chính xác (frame → seconds)
    for (const f of framed) {
        f.ref.start = f.startFrame / FPS;
        f.ref.end = f.endFrame / FPS;
    }

    if (gapsFilled > 0) {
        console.log(`[AI Matcher] 🔧 Đã lấp ${gapsFilled} gaps (frame-based, ${FPS}fps) — timeline kín 100%`);
    }

    // Thống kê
    const stats = {
        high: allResults.filter((r) => r.quality === "high").length,
        none: allResults.filter((r) => r.quality === "none").length,
    };
    console.log(`[AI Matcher] Hoàn tất: ✅${stats.high} ❌${stats.none} | Gaps filled: ${gapsFilled}`);

    // Lưu kết quả
    if (mediaFolder) {
        await saveMatchingResults(mediaFolder, allResults);
    }

    onProgress?.({
        current: transcriptParts.length,
        total: transcriptParts.length,
        message: `Hoàn tất! ✅${stats.high} matched, ❌${stats.none} missing, 🔧${gapsFilled} gaps filled`,
    });

    return allResults;
}
