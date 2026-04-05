// ai-matcher.ts
// Service gọi AI (Claude Sonnet local) để matching script với Whisper transcript
// Chiến lược: cắt transcript 3 phần + gửi full kịch bản mỗi batch
// → Tiết kiệm token, AI tự tìm câu match cho phần transcript đó

import {
    ScriptSentence,
    extractWhisperWords,
    matchScriptToTimeline,
} from "@/utils/media-matcher";
import {
    addDebugLog,
    generateLogId,
    updateDebugLog,
} from "@/services/debug-logger";
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

// ======================== CẤU HÌNH LOGIC-FIRST ========================
// Ý tưởng:
// 1) Chạy thuật toán deterministic trước (nhanh, ổn định)
// 2) Chỉ đẩy những câu "chưa chắc" sang AI để xử lý nốt
const LOGIC_FIRST_CONFIG = {
    // Chấp nhận kết quả logic ở mức high + medium.
    // low/none sẽ đưa sang AI để tránh boundary sai.
    acceptedQualities: new Set<ScriptSentence["quality"]>(["high", "medium"]),
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

/** Dữ liệu tóm tắt logic-first để đẩy vào DEBUG Panel cho dễ kiểm tra */
interface LogicFirstDebugSummary {
    totalSentences: number;
    totalWhisperWords: number;
    accepted: number;
    pending: number;
    coveragePercent: number;
    acceptedByQuality: {
        high: number;
        medium: number;
    };
    acceptedNums: number[];
    pendingNums: number[];
    batchPending: Array<{
        batchNum: number;
        sentenceRange: string;
        pendingCount: number;
        pendingNums: number[];
    }>;
}

/** Dòng timing debug gọn: num:start-end | text */
interface TimingAuditRow {
    num: number;
    start: number;
    end: number;
    range: string;
    resolver: "logic" | "ai" | "missing";
    matchRate: string;
    quality: ScriptSentence["quality"];
    script: string;
    whisper: string;
}

// ======================== FORMAT WHISPER ========================

/** Cấu trúc 1 word đã format */
interface FormattedWord {
    timestamp: number;
    text: string;
    formatted: string; // "[0.16] February"
}

/** Thông tin tối ưu prompt theo batch để debug/đánh giá chất lượng gửi AI */
interface FocusedPromptMeta {
    mode: "full" | "focused" | "fallback-center";
    fullWordCount: number;
    selectedWordCount: number;
    reductionPercent: number;
    startTime: number;
    endTime: number;
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

/**
 * Chỉ lấy word timing "đủ dùng" cho batch hiện tại thay vì gửi toàn bộ transcript part.
 * Mục tiêu:
 * - Giảm payload/token gửi AI.
 * - Vẫn giữ ngữ cảnh quanh các câu pending của batch.
 * - Có fallback an toàn nếu không focus được.
 */
function buildFocusedTranscriptSliceForBatch(params: {
    allWords: FormattedWord[];
    batchScript: { num: number; text: string }[];
    scriptSentences: { num: number; text: string }[];
    sentenceIndexByNum: Map<number, number>;
    totalDuration: number;
    partStartTime: number;
    partEndTime: number;
    maxWords?: number;
}): { text: string; meta: FocusedPromptMeta } {
    const {
        allWords,
        batchScript,
        scriptSentences,
        sentenceIndexByNum,
        totalDuration,
        partStartTime,
        partEndTime,
        maxWords = 1400,
    } = params;

    const partWords = allWords.filter(
        (w) => w.timestamp >= partStartTime - 0.01 && w.timestamp <= partEndTime + 0.01
    );
    const fullWordCount = partWords.length;

    // Part quá nhỏ: giữ nguyên cho an toàn.
    if (fullWordCount <= maxWords) {
        return {
            text: partWords.map((w) => w.formatted).join(" "),
            meta: {
                mode: "full",
                fullWordCount,
                selectedWordCount: fullWordCount,
                reductionPercent: 0,
                startTime: partWords[0]?.timestamp ?? partStartTime,
                endTime: partWords[partWords.length - 1]?.timestamp ?? partEndTime,
            },
        };
    }

    const partDuration = Math.max(1, partEndTime - partStartTime);
    const denom = Math.max(1, scriptSentences.length - 1);
    const halfWindowSec = Math.max(
        6,
        Math.min(45, (partDuration / Math.max(batchScript.length, 1)) * 1.2)
    );

    // 1) Tạo các window quanh expected-time của các câu pending trong batch.
    const rawWindows: Array<{ s: number; e: number }> = [];
    for (const sent of batchScript) {
        const idx = sentenceIndexByNum.get(sent.num) ?? 0;
        const expectedTime = (idx / denom) * totalDuration;
        const center = Math.min(partEndTime, Math.max(partStartTime, expectedTime));
        rawWindows.push({
            s: Math.max(partStartTime, center - halfWindowSec),
            e: Math.min(partEndTime, center + halfWindowSec),
        });
    }

    // 2) Merge windows để lấy vùng liên tục.
    rawWindows.sort((a, b) => a.s - b.s);
    const mergedWindows: Array<{ s: number; e: number }> = [];
    for (const w of rawWindows) {
        if (mergedWindows.length === 0) {
            mergedWindows.push({ ...w });
            continue;
        }
        const last = mergedWindows[mergedWindows.length - 1];
        if (w.s <= last.e + 1.5) {
            last.e = Math.max(last.e, w.e);
        } else {
            mergedWindows.push({ ...w });
        }
    }

    let selectedWords = partWords.filter((w) =>
        mergedWindows.some((mw) => w.timestamp >= mw.s && w.timestamp <= mw.e)
    );

    // Nếu vùng focus quá ít (ví dụ expected-time lệch), fallback sang chunk giữa part.
    if (selectedWords.length < Math.min(120, Math.floor(fullWordCount * 0.15))) {
        const take = Math.min(maxWords, fullWordCount);
        const centerIdx = Math.floor(fullWordCount / 2);
        const startIdx = Math.max(0, centerIdx - Math.floor(take / 2));
        selectedWords = partWords.slice(startIdx, startIdx + take);
        return {
            text: selectedWords.map((w) => w.formatted).join(" "),
            meta: {
                mode: "fallback-center",
                fullWordCount,
                selectedWordCount: selectedWords.length,
                reductionPercent: Number(
                    ((1 - selectedWords.length / Math.max(1, fullWordCount)) * 100).toFixed(2)
                ),
                startTime: selectedWords[0]?.timestamp ?? partStartTime,
                endTime: selectedWords[selectedWords.length - 1]?.timestamp ?? partEndTime,
            },
        };
    }

    // Cắt cứng nếu vẫn vượt maxWords.
    if (selectedWords.length > maxWords) {
        const step = Math.ceil(selectedWords.length / maxWords);
        selectedWords = selectedWords.filter((_, i) => i % step === 0).slice(0, maxWords);
    }

    return {
        text: selectedWords.map((w) => w.formatted).join(" "),
        meta: {
            mode: "focused",
            fullWordCount,
            selectedWordCount: selectedWords.length,
            reductionPercent: Number(
                ((1 - selectedWords.length / Math.max(1, fullWordCount)) * 100).toFixed(2)
            ),
            startTime: selectedWords[0]?.timestamp ?? partStartTime,
            endTime: selectedWords[selectedWords.length - 1]?.timestamp ?? partEndTime,
        },
    };
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
/**
 * Parse AI response — hỗ trợ 2 format:
 * 1. ★ Format siêu gọn (ưu tiên): mỗi dòng "num:start-end"
 *    VD: "1:0.15-22.34\n2:22.34-37.57"
 * 2. JSON fallback: [{"num":1,"start":0.15,"end":22.34}, ...]
 *
 * matchedWhisper sẽ được post-process từ word timestamps bên ngoài
 */
function parseAIResponse(aiResponse: string): { num: number; start: number; end: number; whisper: string }[] {
    // Bỏ thinking tags
    let cleaned = aiResponse.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");

    // Bỏ markdown code block (nếu AI vẫn wrap)
    const codeBlock = cleaned.match(/```(?:json|text)?\s*([\s\S]*?)```/);
    if (codeBlock) cleaned = codeBlock[1];

    // ==========================================
    // THỬ FORMAT SIÊU GỌN TRƯỚC (num:start-end)
    // Regex: "số : số.số - số.số" (linh hoạt khoảng trắng)
    // ==========================================
    const compactLineRegex = /^(\d+)\s*:\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/;
    const lines = cleaned.split("\n").map(l => l.trim()).filter(l => l.length > 0);

    // Đếm bao nhiêu dòng match format gọn
    const compactMatches = lines.filter(l => compactLineRegex.test(l));

    if (compactMatches.length >= 2) {
        // ★ Format siêu gọn — parse trực tiếp
        const results: { num: number; start: number; end: number; whisper: string }[] = [];
        for (const line of compactMatches) {
            const m = line.match(compactLineRegex);
            if (m) {
                const num = parseInt(m[1], 10);
                const start = parseFloat(m[2]);
                const end = parseFloat(m[3]);
                if (!isNaN(num) && !isNaN(start) && !isNaN(end)) {
                    results.push({
                        num,
                        start: Math.max(0, start),
                        end: Math.max(start, end),
                        whisper: "", // Post-process sẽ fill từ word timestamps
                    });
                }
            }
        }
        console.log(`[AI] ★ Parsed ${results.length} entries (format siêu gọn)`);
        return results;
    }

    // ==========================================
    // FALLBACK: JSON ARRAY (format cũ)
    // ==========================================
    console.log("[AI] ⚠️ Format gọn không nhận, thử JSON fallback...");
    let parsed: any[] = [];
    let useFallback = false;

    try {
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

    console.log(`[AI] Parsed ${results.length} entries (JSON fallback)`);
    return results;
}

/**
 * Chạy lớp logic-first để lấy các câu có độ tin cậy cao trước khi gọi AI.
 * - Nhanh vì không gọi network.
 * - Ổn định vì tuân theo thuật toán deterministic.
 * - Giảm token AI vì chỉ còn vài câu khó cần fallback.
 */
function buildLogicFirstSeed(
    scriptSentences: { num: number; text: string }[],
    whisperWords: ReturnType<typeof extractWhisperWords>
): {
    acceptedMap: Map<number, { start: number; end: number; whisper: string; quality: ScriptSentence["quality"]; matchRate: string }>;
    pendingNums: number[];
    coverage: number;
} {
    const logicResults = matchScriptToTimeline(scriptSentences, whisperWords);
    const acceptedMap = new Map<number, { start: number; end: number; whisper: string; quality: ScriptSentence["quality"]; matchRate: string }>();

    for (const row of logicResults) {
        // Chỉ nhận kết quả có thời gian hợp lệ + chất lượng đủ cao.
        const isValidTime =
            Number.isFinite(row.start) &&
            Number.isFinite(row.end) &&
            row.end > row.start;
        const isAcceptedQuality = LOGIC_FIRST_CONFIG.acceptedQualities.has(row.quality);

        if (isValidTime && isAcceptedQuality) {
            acceptedMap.set(row.num, {
                start: row.start,
                end: row.end,
                whisper: row.matchedWhisper || "",
                quality: row.quality,
                matchRate: `logic-${row.matchRate}`,
            });
        }
    }

    const pendingNums = scriptSentences
        .map((s) => s.num)
        .filter((num) => !acceptedMap.has(num));
    const coverage = scriptSentences.length > 0
        ? acceptedMap.size / scriptSentences.length
        : 0;

    return { acceptedMap, pendingNums, coverage };
}



// ======================== HÀM CHÍNH ========================
/** Event khi 1 batch AI Match hoàn tất — dùng cho Incremental Unlock */
export interface BatchCompleteEvent {
    /** Batch thứ mấy (1-indexed) */
    batchNum: number
    /** Tổng số batch */
    totalBatches: number
    /** Partial AI results của batch này */
    partialResults: { num: number; start: number; end: number; whisper: string }[]
    /** TimeRange của batch transcript */
    timeRange: string
}

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
    importType: 'video' | 'image' = 'video',
    /** Callback khi mỗi batch hoàn tất — cho phép Incremental Unlock từng batch */
    onBatchComplete?: (event: BatchCompleteEvent) => void,
    /** Callback SAU khi tất cả batch chính xong, TRƯỚC retry loop
     * → Cho phép Music/SFX/Footage bắt đầu sớm (không cần chờ retry) */
    onMainBatchesDone?: (earlyResults: ScriptSentence[]) => void
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

    // ======================== LOGIC-FIRST PASS ========================
    // Chạy deterministic matcher trước để "ăn" các câu dễ/ổn định.
    // AI chỉ xử lý phần còn lại (pending) để giảm lỗi và giảm thời gian.
    const logicSeed = buildLogicFirstSeed(scriptSentences, whisperWords);
    const pendingNumSet = new Set(logicSeed.pendingNums);
    console.log(
        `[AI Matcher] Logic-first: ${logicSeed.acceptedMap.size}/${scriptSentences.length} câu (${(logicSeed.coverage * 100).toFixed(1)}%), pending AI: ${logicSeed.pendingNums.length}`
    );

    // DEBUG Panel: tạo log riêng để user thấy rõ logic-first đã xử lý phần nào.
    const logicDebugStartedAt = Date.now();
    const logicDebugLogId = generateLogId();
    // Input audit cho Debug Panel:
    // - word timing (để kiểm chứng transcript đang dùng có đúng không)
    // - script chia câu đánh số (để đối chiếu num)
    const debugWordTimingLines = allFormattedWords.map((w) => w.formatted);
    const debugScriptNumbered = scriptSentences.map((s) => `${s.num}. ${s.text}`);
    const transcriptSource = (transcript?.source || "whisper").toString();
    const transcriptSourceFile = (transcript?.sourceFile || "").toString();
    const transcriptSentenceCount = Number(
        transcript?.sentenceCount ?? transcript?.stats?.sentenceCount ?? segments.length ?? 0
    );
    const transcriptWordCount = Number(
        transcript?.wordCount ?? transcript?.stats?.wordCount ?? allFormattedWords.length ?? 0
    );
    addDebugLog({
        id: logicDebugLogId,
        timestamp: new Date(),
        method: "LOGIC",
        url: "local://ai-matcher/logic-first",
        requestHeaders: { "Content-Type": "application/json" },
        requestBody: JSON.stringify({
            importType,
            transcriptAudit: {
                source: transcriptSource,
                sourceFile: transcriptSourceFile || "(không có)",
                sentenceCount: transcriptSentenceCount,
                wordCount: transcriptWordCount,
                totalWhisperWords: allFormattedWords.length,
                // Hiển thị full word timing để user kiểm tra trực tiếp từ Debug Panel.
                // Nếu transcript đến từ CapCut subtitle_cache_info thì đây là timing "reuse từ draft".
                wordTimingLines: debugWordTimingLines,
            },
            scriptAudit: {
                totalSentences: scriptSentences.length,
                numberedScriptLines: debugScriptNumbered,
            },
            config: {
                acceptedQualities: Array.from(LOGIC_FIRST_CONFIG.acceptedQualities),
                maxBatches: MAX_BATCHES,
                overlapRatio: OVERLAP_RATIO,
            },
        }, null, 2),
        status: null,
        responseHeaders: {},
        responseBody: "(đang tổng hợp logic-first...)",
        duration: 0,
        error: null,
        label: "Logic-first Matching",
    });

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
    const sentenceIndexByNum = new Map<number, number>(
        scriptSentences.map((s, idx) => [s.num, idx])
    );

    const scriptBatches: { num: number; text: string }[][] = [];
    const batchPendingSummary: LogicFirstDebugSummary["batchPending"] = [];
    let aiBatchCount = 0;
    for (let i = 0; i < N; i++) {
        // Tính vùng câu cho batch này (có overlap)
        const rawStart = Math.floor(sentencesPerPart * i);
        const rawEnd = Math.ceil(sentencesPerPart * (i + 1));
        const overlapSize = Math.ceil(sentencesPerPart * OVERLAP_RATIO);

        // Mở rộng ±overlap, clamp vào [0, totalSentences]
        const batchStart = Math.max(0, rawStart - overlapSize);
        const batchEnd = Math.min(totalSentences, rawEnd + overlapSize);

        // Chỉ giữ các câu pending (logic chưa xử lý chắc chắn).
        const batchPending = scriptSentences
            .slice(batchStart, batchEnd)
            .filter((s) => pendingNumSet.has(s.num));
        scriptBatches.push(batchPending);
        if (batchPending.length > 0) aiBatchCount++;
        batchPendingSummary.push({
            batchNum: i + 1,
            sentenceRange: `${scriptSentences[batchStart]?.num ?? "?"} → ${scriptSentences[batchEnd - 1]?.num ?? "?"}`,
            pendingCount: batchPending.length,
            pendingNums: batchPending.map((s) => s.num),
        });

        console.log(
            `[AI Matcher] Script batch ${i + 1}: vùng ${scriptSentences[batchStart]?.num} → ${scriptSentences[batchEnd - 1]?.num}, pending=${batchPending.length}`
        );
    }

    // Tổng hợp chi tiết logic-first để hiển thị trong DEBUG Panel.
    const acceptedNums = Array.from(logicSeed.acceptedMap.keys()).sort((a, b) => a - b);
    const acceptedByQuality = {
        high: 0,
        medium: 0,
    };
    for (const row of logicSeed.acceptedMap.values()) {
        if (row.quality === "high") acceptedByQuality.high++;
        if (row.quality === "medium") acceptedByQuality.medium++;
    }
    const logicSummary: LogicFirstDebugSummary = {
        totalSentences: scriptSentences.length,
        totalWhisperWords: allFormattedWords.length,
        accepted: logicSeed.acceptedMap.size,
        pending: logicSeed.pendingNums.length,
        coveragePercent: Number((logicSeed.coverage * 100).toFixed(2)),
        acceptedByQuality,
        acceptedNums,
        pendingNums: [...logicSeed.pendingNums],
        batchPending: batchPendingSummary,
    };
    updateDebugLog(logicDebugLogId, {
        status: 200,
        duration: Date.now() - logicDebugStartedAt,
        responseBody: JSON.stringify({
            summary: logicSummary,
            note: "acceptedNums = câu logic xử lý trước AI, pendingNums = câu chuyển AI fallback",
        }, null, 2),
    });

    onProgress?.({
        current: 0,
        total: Math.max(aiBatchCount, 1),
        message: aiBatchCount > 0
            ? `Logic-first xong. Đang xử lý AI fallback ${aiBatchCount} batch (concurrency tối đa ${MAX_CONCURRENCY})...`
            : `Logic-first đã xử lý toàn bộ, không cần gọi AI.`,
    });

    // Thu thập tất cả kết quả từ các batch
    const matchedMap = new Map<number, {
        start: number;
        end: number;
        whisper: string;
        source: "logic" | "ai";
        quality: ScriptSentence["quality"];
        matchRate: string;
    }>();
    // Seed trước các câu logic chắc chắn để AI chỉ cần xử lý phần còn thiếu.
    for (const [num, row] of logicSeed.acceptedMap.entries()) {
        matchedMap.set(num, {
            start: row.start,
            end: row.end,
            whisper: row.whisper,
            source: "logic",
            quality: row.quality,
            matchRate: row.matchRate,
        });
    }

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
    const batchPromptStats: Array<{
        batchNum: number;
        scriptCount: number;
        fullWordCount: number;
        selectedWordCount: number;
        reductionPercent: number;
        mode: FocusedPromptMeta["mode"];
        focusedTimeRange: string;
    }> = [];
    let batchIdx = 0;
    let activeTasks = 0;

    console.log(`[AI Matcher] ⚡ Bắt đầu AI fallback ${aiBatchCount} batch (concurrency tối đa ${MAX_CONCURRENCY} luồng song song)`);

    await new Promise<void>((resolve, reject) => {
        const runNext = () => {
            // Nạp thêm luồng mới khi còn slot trống
            while (activeTasks < MAX_CONCURRENCY && batchIdx < N) {
                // Batch rỗng nghĩa là phần này logic đã xử lý xong -> bỏ qua AI.
                while (batchIdx < N && scriptBatches[batchIdx].length === 0) {
                    batchIdx++;
                }
                if (batchIdx >= N) break;

                const i       = batchIdx;
                const part    = transcriptParts[i];
                const batchNum = i + 1;
                const timeRange = `${part.startTime.toFixed(0)}s → ${part.endTime.toFixed(0)}s`;
                const batchScript = scriptBatches[i];
                batchIdx++;
                activeTasks++;

                // Focus transcript cho batch này để giảm token gửi AI.
                const focusedSlice = buildFocusedTranscriptSliceForBatch({
                    allWords: allFormattedWords,
                    batchScript,
                    scriptSentences,
                    sentenceIndexByNum,
                    totalDuration,
                    partStartTime: part.startTime,
                    partEndTime: part.endTime,
                });
                const focusedTimeRange = `${focusedSlice.meta.startTime.toFixed(0)}s → ${focusedSlice.meta.endTime.toFixed(0)}s`;
                batchPromptStats.push({
                    batchNum,
                    scriptCount: batchScript.length,
                    fullWordCount: focusedSlice.meta.fullWordCount,
                    selectedWordCount: focusedSlice.meta.selectedWordCount,
                    reductionPercent: focusedSlice.meta.reductionPercent,
                    mode: focusedSlice.meta.mode,
                    focusedTimeRange,
                });

                onProgress?.({
                    current: i,
                    total: Math.max(aiBatchCount, 1),
                    message: `Batch ${batchNum}/${N}: ${timeRange} | focus=${focusedSlice.meta.selectedWordCount}/${focusedSlice.meta.fullWordCount} words (${activeTasks} luồng)...`,
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

                            const prompt = buildMatchPrompt(
                                batchScript,
                                focusedSlice.text,
                                batchNum,
                                N,
                                focusedTimeRange
                            );
                            console.log(
                                `[AI Matcher] Batch ${batchNum}: ${timeRange} → focus ${focusedTimeRange}, ` +
                                `${batchScript.length} câu, words ${focusedSlice.meta.selectedWordCount}/${focusedSlice.meta.fullWordCount} ` +
                                `(-${focusedSlice.meta.reductionPercent}%), prompt ~${(prompt.length / 1000).toFixed(0)}KB`
                            );

                            const response = await callAI(
                                prompt,
                                `Batch ${batchNum}/${N} (${focusedTimeRange}) ${batchScript.length} câu`
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

                        // ★ INCREMENTAL UNLOCK: Emit partial results ngay khi batch xong
                        // Orchestrator nhận event này để mở khoá sub-pipelines sớm
                        if (onBatchComplete && result.aiResults.length > 0) {
                            const part = transcriptParts[result.batchNum - 1];
                            onBatchComplete({
                                batchNum: result.batchNum,
                                totalBatches: N,
                                partialResults: result.aiResults,
                                timeRange: `${part?.startTime?.toFixed(0) || '?'}s → ${part?.endTime?.toFixed(0) || '?'}s`,
                            });
                        }

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

            // Trường hợp tất cả batch còn lại đều rỗng (không cần AI),
            // hoặc đã xử lý xong toàn bộ batch.
            if (batchIdx >= N && activeTasks === 0) {
                resolve();
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
                matchedMap.set(r.num, {
                    start: r.start,
                    end: r.end,
                    whisper: r.whisper,
                    source: "ai",
                    quality: "high",
                    matchRate: "ai-matched",
                });
            } else {
                const existing = matchedMap.get(r.num)!;
                // Ưu tiên match nằm gần expected position hơn (dựa trên scene index)
                // Scene num nhỏ → timing sớm, scene num lớn → timing muộn
                const sentIdx = sentenceIndexByNum.get(r.num) ?? 0;
                const expectedRatio = sentIdx / scriptSentences.length;
                const expectedTime = expectedRatio * totalDuration;
                const existingDist = Math.abs((existing.start + existing.end) / 2 - expectedTime);
                const newDist = Math.abs((r.start + r.end) / 2 - expectedTime);

                if (newDist < existingDist) {
                    console.log(`[AI Matcher] Batch ${batchNum}: Thay num=${r.num} (timing gần expected hơn: ${newDist.toFixed(0)} < ${existingDist.toFixed(0)})`);
                    matchedMap.set(r.num, {
                        start: r.start,
                        end: r.end,
                        whisper: r.whisper,
                        source: "ai",
                        quality: "high",
                        matchRate: "ai-matched",
                    });
                } else {
                    console.log(`[AI Matcher] Batch ${batchNum}: Giữ num=${r.num} cũ (timing cũ gần expected hơn)`);
                }
            }
        }
    }

    // ★ EARLY UNLOCK: Gọi callback TRƯỚC retry loop
    // Music/SFX/Footage chờ gate này → bắt đầu sớm hơn ~5-15s
    if (onMainBatchesDone) {
        // Tạo early results từ matchedMap hiện tại (CHƯA retry)
        const earlyResults: ScriptSentence[] = scriptSentences.map(sent => {
            const aiMatch = matchedMap.get(sent.num);
            if (aiMatch) {
                // Auto-extract whisper text từ word timestamps
                let earlyWhisper = aiMatch.whisper;
                if (!earlyWhisper) {
                    const wordsInRange = allFormattedWords.filter(
                        w => w.timestamp >= aiMatch.start - 0.05 && w.timestamp <= aiMatch.end + 0.05
                    );
                    earlyWhisper = wordsInRange.map(w => w.text).join(" ") || "(early auto-extracted)";
                }
                return {
                    num: sent.num,
                    text: sent.text,
                    start: aiMatch.start,
                    end: aiMatch.end,
                    matchRate: aiMatch.matchRate,
                    matchedWhisper: earlyWhisper,
                    quality: aiMatch.quality,
                };
            } else {
                // Ước lượng cho scenes thiếu
                const prevEnd = matchedMap.size > 0 ? Math.max(...Array.from(matchedMap.values()).map(v => v.end)) : 0;
                return {
                    num: sent.num,
                    text: sent.text,
                    start: prevEnd,
                    end: prevEnd + sent.text.split(' ').length * 0.4,
                    matchRate: 'ai-missing',
                    matchedWhisper: '(early estimate)',
                    quality: 'none' as const,
                };
            }
        });
        const matched = earlyResults.filter(r => r.quality !== 'none').length;
        console.log(`[AI Matcher] ★ EARLY UNLOCK: ${matched}/${scriptSentences.length} scenes → mở khoá Music/SFX/Footage`);
        onMainBatchesDone(earlyResults);
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

OUTPUT: Trả về TẤT CẢ ${cluster.length} câu, mỗi dòng: num:start-end
KHÔNG ĐƯỢC thiếu câu nào. VD:
${cluster.map((n, i) => `${n}:${(rangeStart + i * ((rangeEnd - rangeStart) / cluster.length)).toFixed(1)}-${(rangeStart + (i + 1) * ((rangeEnd - rangeStart) / cluster.length)).toFixed(1)}`).join("\n")}`;
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
                    matchedMap.set(r.num, {
                        start: r.start,
                        end: r.end,
                        whisper: r.whisper,
                        source: "ai",
                        quality: "high",
                        matchRate: "ai-retry",
                    });
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
            // ★ Post-process: tự extract whisper text từ word timestamps
            // Thay vì dùng AI viết lại → lấy trực tiếp từ Whisper data gốc (chính xác hơn)
            let matchedWhisper = aiMatch.whisper; // Fallback nếu AI vẫn trả whisper (JSON format cũ)
            if (!matchedWhisper) {
                // Extract words nằm trong range [start, end] từ Whisper transcript
                const wordsInRange = allFormattedWords.filter(
                    w => w.timestamp >= aiMatch.start - 0.05 && w.timestamp <= aiMatch.end + 0.05
                );
                matchedWhisper = wordsInRange.map(w => w.text).join(" ") || "(auto-extracted)";
            }

            allResults.push({
                num: sent.num,
                text: sent.text,
                start: aiMatch.start,
                end: aiMatch.end,
                matchRate: aiMatch.matchRate,
                matchedWhisper,
                quality: aiMatch.quality,
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
    const finalLogicHandled = allResults.filter((r) => r.matchRate.startsWith("logic-")).length;
    const finalAiHandled = allResults.filter((r) => r.quality !== "none" && r.matchRate.startsWith("ai-")).length;
    console.log(`[AI Matcher] Hoàn tất: ✅${stats.high} ❌${stats.none} | Gaps filled: ${gapsFilled}`);

    // ======================== BÁO CÁO CHẤT LƯỢNG CUỐI (DEBUG PANEL) ========================
    const durations = allResults.map((r) => Number((r.end - r.start).toFixed(6))).filter((d) => Number.isFinite(d));
    const minDurationSec = durations.length > 0 ? Math.min(...durations) : 0;
    const maxDurationSec = durations.length > 0 ? Math.max(...durations) : 0;
    const avgDurationSec = durations.length > 0
        ? Number((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(3))
        : 0;
    const suspiciousTooShortCount = durations.filter((d) => d < 0.2).length;
    const suspiciousTooLongCount = durations.filter((d) => d > 30).length;
    const orderViolations = allResults.reduce((acc, row, idx) => {
        if (idx === 0) return acc;
        return row.start < allResults[idx - 1].start ? acc + 1 : acc;
    }, 0);
    const overlapViolations = allResults.reduce((acc, row, idx) => {
        if (idx === 0) return acc;
        return row.start < allResults[idx - 1].end ? acc + 1 : acc;
    }, 0);

    const promptCompression = (() => {
        if (batchPromptStats.length === 0) {
            return {
                totalBatchesUsedAI: 0,
                totalFullWords: 0,
                totalSelectedWords: 0,
                averageReductionPercent: 0,
                note: "Không có batch AI (logic-first đã xử lý toàn bộ).",
            };
        }
        const totalFullWords = batchPromptStats.reduce((a, b) => a + b.fullWordCount, 0);
        const totalSelectedWords = batchPromptStats.reduce((a, b) => a + b.selectedWordCount, 0);
        const averageReductionPercent = totalFullWords > 0
            ? Number(((1 - totalSelectedWords / totalFullWords) * 100).toFixed(2))
            : 0;
        return {
            totalBatchesUsedAI: batchPromptStats.length,
            totalFullWords,
            totalSelectedWords,
            averageReductionPercent,
            byBatch: batchPromptStats
                .sort((a, b) => a.batchNum - b.batchNum)
                .map((s) => ({
                    batchNum: s.batchNum,
                    mode: s.mode,
                    scriptCount: s.scriptCount,
                    focusedTimeRange: s.focusedTimeRange,
                    words: `${s.selectedWordCount}/${s.fullWordCount}`,
                    reductionPercent: s.reductionPercent,
                })),
        };
    })();

    const finalResultsPreview = allResults.slice(0, 60).map((r) => ({
        num: r.num,
        start: Number(r.start.toFixed(3)),
        end: Number(r.end.toFixed(3)),
        durationSec: Number((r.end - r.start).toFixed(3)),
        source: r.matchRate.startsWith("logic-") ? "logic" : r.matchRate.startsWith("ai-") ? "ai" : "unknown",
        matchRate: r.matchRate,
        quality: r.quality,
        whisperPreview: (r.matchedWhisper || "").slice(0, 120),
    }));

    // Tạo audit theo từng câu để user soi được "Logic làm gì" vs "AI làm gì".
    const buildTimingAuditRows = (rows: ScriptSentence[]): TimingAuditRow[] =>
        rows.map((r) => {
            const resolver: "logic" | "ai" | "missing" =
                r.matchRate.startsWith("logic-")
                    ? "logic"
                    : r.matchRate.startsWith("ai-")
                        ? "ai"
                        : "missing";
            return {
                num: r.num,
                start: Number(r.start.toFixed(3)),
                end: Number(r.end.toFixed(3)),
                range: `${r.start.toFixed(3)}-${r.end.toFixed(3)}`,
                resolver,
                matchRate: r.matchRate,
                quality: r.quality,
                script: r.text,
                whisper: r.matchedWhisper || "",
            };
        });

    const timingAuditRows = buildTimingAuditRows(allResults);
    const logicTimingRows = timingAuditRows.filter((r) => r.resolver === "logic");
    const aiTimingRows = timingAuditRows.filter((r) => r.resolver === "ai");
    const missingTimingRows = timingAuditRows.filter((r) => r.resolver === "missing");

    // Update lại log logic-first để user nhìn thấy kết quả cuối sau khi AI fallback hoàn tất.
    updateDebugLog(logicDebugLogId, {
        status: stats.none > 0 ? 206 : 200,
        duration: Date.now() - logicDebugStartedAt,
        responseBody: JSON.stringify({
            summary: {
                totalSentences: allResults.length,
                logicHandled: finalLogicHandled,
                aiHandled: finalAiHandled,
                missing: stats.none,
                logicPercent: allResults.length > 0
                    ? Number(((finalLogicHandled / allResults.length) * 100).toFixed(2))
                    : 0,
                aiPercent: allResults.length > 0
                    ? Number(((finalAiHandled / allResults.length) * 100).toFixed(2))
                    : 0,
                missingPercent: allResults.length > 0
                    ? Number(((stats.none / allResults.length) * 100).toFixed(2))
                    : 0,
                gapsFilled,
            },
            matchRateBreakdown: allResults.reduce<Record<string, number>>((acc, row) => {
                acc[row.matchRate] = (acc[row.matchRate] || 0) + 1;
                return acc;
            }, {}),
            promptCompression,
            qualityChecks: {
                orderViolations,
                overlapViolations,
                minDurationSec: Number(minDurationSec.toFixed(3)),
                maxDurationSec: Number(maxDurationSec.toFixed(3)),
                avgDurationSec,
                suspiciousTooShortCount,
                suspiciousTooLongCount,
                totalDurationSec: Number(totalDuration.toFixed(3)),
            },
            transcriptInputAudit: {
                source: transcriptSource,
                sourceFile: transcriptSourceFile || "(không có)",
                sentenceCount: transcriptSentenceCount,
                wordCount: transcriptWordCount,
                totalWhisperWords: allFormattedWords.length,
                wordTimingLinesPreview: {
                    totalLines: debugWordTimingLines.length,
                    first80: debugWordTimingLines.slice(0, 80),
                    last20: debugWordTimingLines.slice(-20),
                },
            },
            scriptInputAudit: {
                totalSentences: debugScriptNumbered.length,
                numberedScriptLines: debugScriptNumbered,
            },
            sentenceTimingAudit: {
                // Dạng compact để bạn dán/chấm nhanh.
                logicCompact: logicTimingRows.map((r) => `${r.num}:${r.range}`),
                aiCompact: aiTimingRows.map((r) => `${r.num}:${r.range}`),
                missingCompact: missingTimingRows.map((r) => `${r.num}:${r.range}`),
                // Dạng đầy đủ để soi chất lượng chi tiết từng câu.
                logicDetailed: logicTimingRows,
                aiDetailed: aiTimingRows,
                missingDetailed: missingTimingRows,
                finalOrderedTimeline: timingAuditRows,
            },
            finalResultsPreview,
            note: "sentenceTimingAudit tách riêng logic/ai theo num:start-end để bạn đối chiếu câu nào match chuẩn.",
        }, null, 2),
    });

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
