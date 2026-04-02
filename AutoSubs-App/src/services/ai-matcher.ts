// ai-matcher.ts
// Service gọi AI (Claude Sonnet local) để matching script với Whisper transcript
// Chiến lược: cắt transcript 3 phần + gửi full kịch bản mỗi batch
// → Tiết kiệm token, AI tự tìm câu match cho phần transcript đó

import {
    ScriptSentence,
    extractWhisperWords,
} from "@/utils/media-matcher";
import { writeTextFile, readTextFile, exists } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";

// ======================== CẤU HÌNH AI ========================
const AI_CONFIG = {
    baseUrl: "https://ezaiapi.com/v1",
    // apiKey: đã chuyển sang nhập qua Settings UI (không hardcode)
    model: "claude-sonnet-4-6",  // Sonnet — nhanh hơn Opus, vẫn chính xác tốt
    batchCount: 4,       // Chia transcript 4 phần (Documentary 25-27min ~200-350 câu → ~50-87 câu/batch)
    timeoutMs: 900000,   // 15 phút timeout per request
    maxTokens: 16000,    // Đủ cho output JSON
    batchRetryCount: 3,  // Retry tối đa 3 lần khi batch lỗi (429, 500, 524, timeout)
    batchRetryBaseMs: 3000, // Delay cơ sở: 3s → 6s → 12s (exponential backoff)
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

    // Nếu không có dấu chấm nào (phổ biến với raw Whisper) → chia đều theo số lượng từ
    if (sentenceEnds.length === 0) {
        console.warn("[AI Matcher] ⚠️ Transcript không có dấu chấm câu nào, chia đều theo số lượng từ!");
        const parts: { text: string; startTime: number; endTime: number }[] = [];
        const chunkSize = Math.ceil(words.length / numParts);
        for (let p = 0; p < numParts; p++) {
            const startIdx = p * chunkSize;
            const endIdx = Math.min((p + 1) * chunkSize, words.length);
            if (startIdx >= words.length) break;
            
            const chunkWords = words.slice(startIdx, endIdx);
            parts.push({
                text: chunkWords.map(w => w.formatted).join(" "),
                startTime: chunkWords[0].timestamp,
                endTime: chunkWords[chunkWords.length - 1].timestamp,
            });
        }
        return parts;
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

    let parsed: any[] = [];
    let useFallback = false;

    try {
        // Tìm JSON array hoàn chỉnh
        let jsonMatch = cleaned.match(/\[[\s\S]*\]/);

        if (!jsonMatch) {
            useFallback = true;
        } else {
            parsed = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(parsed)) {
                useFallback = true;
            }
        }
    } catch (err) {
        console.warn("[AI Matcher] JSON Parse error, falling back to manual extraction:", err);
        useFallback = true;
    }

    // ⭐ Nếu bị móp méo dữ liệu hoặc JSON.parse thất bại → tìm bằng Regex từng object
    if (useFallback) {
        console.log("[AI Matcher] ⚠️ Kích hoạt fallback Regex JSON parser...");
        parsed = [];
        const objectRegex = /\{\s*"num"\s*:\s*\d+[\s\S]*?\}/g;
        let match;
        while ((match = objectRegex.exec(cleaned)) !== null) {
            try {
                // Thêm } phòng trường hợp object rớt chữ cuối cùng
                let str = match[0];
                parsed.push(JSON.parse(str));
            } catch (e) {
                // Bỏ qua object bị gãy
            }
        }
    }

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
    mediaFolder?: string,
    importType: 'video' | 'image' = 'video'
): Promise<ScriptSentence[]> {
    const segments = transcript.originalSegments || transcript.segments || [];
    const whisperWords = extractWhisperWords(transcript);

    const { getActiveProfileId } = await import('@/config/activeProfile');

    // Đọc cài đặt từ Tauri Store (giống footage-matcher-service)
    let MAX_CONCURRENCY = 6; // mặc định nếu không đọc được
    let MAX_BATCHES = importType === 'image' ? 2 : 4; // mặc định số batch tuỳ loại 
    let OVERLAP_RATIO = 0.15; // mặc định overlap
    try {
        const { load } = await import('@tauri-apps/plugin-store');
        const store = await load('autosubs-store.json');
        const storedSettings = await store.get<any>('settings');
        if (storedSettings) {
            MAX_CONCURRENCY = storedSettings.aiMaxConcurrency ?? 6;
            MAX_BATCHES = importType === 'image' 
                ? (storedSettings.aiImageImportBatches ?? 2)
                : (storedSettings.aiMediaImportBatches ?? 4);
            OVERLAP_RATIO = storedSettings.aiBatchOverlapRatio ?? 0.15;
            console.log(`[AI Matcher] 🔧 Settings (${importType}): maxConcurrency=${MAX_CONCURRENCY}, batches=${MAX_BATCHES}, overlap=${OVERLAP_RATIO}`);
        }
    } catch {
        console.warn(`[AI Matcher] Không đọc được settings, dùng mặc định ${importType} concurrency=6, batches=${MAX_BATCHES}, overlap=0.15`);
    }

    // Dùng static map thay vì dynamic import template string
    // Vite KHÔNG thể resolve @/ alias trong `import(\`@/prompts/${id}/...\`)` lúc runtime
    const matchPromptModules: Record<string, () => Promise<{ buildMatchPrompt: Function }>> = {
        documentary: () => import('../prompts/documentary/match-prompt'),
        stories:     () => import('../prompts/stories/match-prompt'),
        tiktok:      () => import('../prompts/tiktok/match-prompt'),
    };
    const profileId = getActiveProfileId();
    const loadModule = matchPromptModules[profileId] ?? matchPromptModules['documentary'];
    const { buildMatchPrompt } = await loadModule();

    const totalDuration =
        whisperWords.length > 0 ? whisperWords[whisperWords.length - 1].end : 0;

    // Format toàn bộ words
    const allFormattedWords = formatWhisperWords(segments);

    console.log(
        `[AI Matcher] ${scriptSentences.length} câu, ${allFormattedWords.length} words, ${totalDuration.toFixed(0)}s`
    );

    // ⭐ Cắt transcript thành N phần tại ranh giới câu (N = MAX_BATCHES đọc từ cài đặt)
    const rawTranscriptParts = splitTranscriptAtSentenceBoundaries(
        allFormattedWords,
        MAX_BATCHES
    );

    // ⭐ Thêm OVERLAP cho transcript — mỗi phần lấy thêm % words
    // từ phần liền kề (trước + sau) để câu ở ranh giới không bị trượt
    const wordsPerPart = Math.ceil(allFormattedWords.length / rawTranscriptParts.length);
    const transcriptOverlapWords = Math.ceil(wordsPerPart * OVERLAP_RATIO);

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

    // ⭐ Chia script theo tỷ lệ với overlap tùy chỉnh
    // Script theo thứ tự thời gian nên chia tỷ lệ rất chính xác
    const totalSentences = scriptSentences.length;
    const N = transcriptParts.length;
    const sentencesPerPart = totalSentences / N;

    const scriptBatches: { num: number; text: string }[][] = [];
    for (let i = 0; i < N; i++) {
        // Tính vùng câu cho batch này (có overlap)
        const rawStart = Math.floor(sentencesPerPart * i);
        const rawEnd = Math.ceil(sentencesPerPart * (i + 1));
        const overlapSize = Math.ceil(sentencesPerPart * OVERLAP_RATIO);

        // Mở rộng ±overlap, clamp vào [0, totalSentences]
        const batchStart = Math.max(0, rawStart - overlapSize);
        const batchEnd = Math.min(totalSentences, rawEnd + overlapSize);

        scriptBatches.push(scriptSentences.slice(batchStart, batchEnd));
        console.log(`[AI Matcher] Script batch ${i + 1}: câu ${scriptSentences[batchStart]?.num} → ${scriptSentences[batchEnd - 1]?.num} (${batchEnd - batchStart} câu, overlap ±${overlapSize})`);
    }

    onProgress?.({
        current: 0,
        total: N,
        message: `Đang xử lý ${N} batch (concurrency tối đa ${MAX_CONCURRENCY})...`,
    });

    // Thu thập tất cả kết quả từ các batch
    const matchedMap = new Map<number, { start: number; end: number; whisper: string }>();

    // ⭐ Danh sách HTTP status/error có thể retry (lỗi tạm thời)
    const RETRYABLE_PATTERNS = ["429", "500", "502", "503", "524", "529", "rate limit", "timeout", "timed out", "ETIMEDOUT", "abort"];

    /** Kiểm tra lỗi có thể retry không */
    function isRetryableError(err: unknown): boolean {
        const msg = String(err).toLowerCase();
        return RETRYABLE_PATTERNS.some(p => msg.includes(p.toLowerCase()));
    }

    // ⚡ Worker Queue giới hạn MAX_CONCURRENCY luồng song song (lấy từ AI Config)
    // Giống pattern của footage-matcher-service: tránh 429 rate limit
    type BatchResult = { batchNum: number; aiResults: { num: number; start: number; end: number; whisper: string }[] };
    const batchResults: BatchResult[] = [];
    let batchIdx = 0;
    let activeTasks = 0;

    console.log(`[AI Matcher] ⚡ Bắt đầu ${N} batch (concurrency tối đa ${MAX_CONCURRENCY} luồng song song)`);

    await new Promise<void>((resolve, reject) => {
        const runNext = () => {
            // Nạp thêm luồng mới khi còn slot trống
            while (activeTasks < MAX_CONCURRENCY && batchIdx < N) {
                const i       = batchIdx;
                const part    = transcriptParts[i];
                const batchNum = i + 1;
                const timeRange = `${part.startTime.toFixed(0)}s → ${part.endTime.toFixed(0)}s`;
                const batchScript = scriptBatches[i];
                batchIdx++;
                activeTasks++;

                onProgress?.({
                    current: i,
                    total: N,
                    message: `Batch ${batchNum}/${N}: ${timeRange} (${activeTasks} luồng đang chạy)...`,
                });

                // Hàm xử lý 1 batch (có retry bên trong)
                (async (): Promise<BatchResult> => {
                    for (let attempt = 0; attempt <= AI_CONFIG.batchRetryCount; attempt++) {
                        try {
                            if (attempt > 0) {
                                console.log(`[AI Matcher] 🔄 Batch ${batchNum}: retry lần ${attempt}/${AI_CONFIG.batchRetryCount}...`);
                                onProgress?.({
                                    current: i,
                                    total: N,
                                    message: `Batch ${batchNum}/${N}: retry lần ${attempt}/${AI_CONFIG.batchRetryCount}...`,
                                });
                            }

                            const prompt = buildMatchPrompt(batchScript, part.text, batchNum, N, timeRange);
                            console.log(`[AI Matcher] Batch ${batchNum}: ${timeRange}, ${batchScript.length} câu, prompt ~${(prompt.length / 1000).toFixed(0)}KB`);

                            const response = await callAI(
                                prompt,
                                `Batch ${batchNum}/${N} (${timeRange}) ${batchScript.length} câu`
                            );

                            const aiResults = parseAIResponse(response);
                            console.log(`[AI Matcher] Batch ${batchNum}: ${aiResults.length} câu matched ✅${attempt > 0 ? ` (sau ${attempt} retry)` : ''}`);
                            return { batchNum, aiResults };
                        } catch (error) {
                            const errMsg = String(error);
                            if (isRetryableError(error) && attempt < AI_CONFIG.batchRetryCount) {
                                const delayMs = AI_CONFIG.batchRetryBaseMs * Math.pow(2, attempt);
                                console.warn(`[AI Matcher] ⚠️ Batch ${batchNum}: ${errMsg.slice(0, 150)} → retry sau ${delayMs / 1000}s`);
                                await new Promise(r => setTimeout(r, delayMs));
                                continue;
                            }
                            console.error(`[AI Matcher] ❌ Batch ${batchNum} THẤT BẠI:`, errMsg.slice(0, 200));
                            return { batchNum, aiResults: [] };
                        }
                    }
                    return { batchNum, aiResults: [] }; // fallback TypeScript
                })()
                    .then(result => {
                        batchResults.push(result);
                        activeTasks--;
                        if (batchIdx < N) {
                            runNext(); // Nhả slot → chạy batch tiếp
                        } else if (activeTasks === 0) {
                            resolve(); // Hết tất cả
                        }
                    })
                    .catch(err => {
                        activeTasks--;
                        reject(err);
                    });
            }
        };
        runNext();
        if (N === 0) resolve();
    });

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
