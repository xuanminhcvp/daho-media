// subtitle-matcher-service.ts
// Service so khớp kịch bản → whisper transcript để tạo phụ đề stories
// Tận dụng lại pattern từ ai-matcher.ts:
//   - Cùng AI_CONFIG, callAI(), formatWhisperWords()
//   - Cùng strategy 5 batch song song + overlap + retry
// Khác biệt:
//   - Output: SubtitleLine[] (text + start + end), KHÔNG có num
//   - AI tự tách câu dài thành nhiều dòng ngắn

import { SubtitleLine } from "@/types/audio-types";
import { extractWhisperWords } from "@/utils/media-matcher";
import { buildSubtitleMatchPrompt, buildSubtitleRetryPrompt } from "@/prompts/subtitle-match-prompt";
import { writeTextFile, readTextFile, exists } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";

// ======================== CẤU HÌNH AI ========================
const AI_CONFIG = {
    baseUrl: "https://ezaiapi.com/v1",
    apiKey: "sk-570848c49fda787c748cd58f3a21a1d95f00afd87a5cba6e",
    model: "claude-sonnet-4-6",
    batchCount: 6,        // Documentary 25-27min: 6 phần (ngắn hơn Stories → ít batch hơn)
    maxConcurrent: 5,     // Tối đa 5 request đồng thời (API giới hạn 6, chừa 1 buffer)
    timeoutMs: 900000,    // 15 phút timeout per request
    maxTokens: 8000,      // Batch nhỏ → cần ít token hơn
    retryCount: 3,        // Retry tối đa 3 lần khi lỗi 524/429/5xx
    retryBaseMs: 5000,    // Retry delay cơ sở: 5s → 10s → 20s (exponential)
};

// ======================== CONCURRENCY LIMITER ========================
/**
 * Chạy nhiều task bất đồng bộ với giới hạn số lượng đồng thời
 * Ví dụ: 12 batch, maxConcurrent=5 → chạy 5 đầu, khi 1 xong → bắt đầu cái thứ 6
 * @param tasks - Mảng hàm async cần chạy
 * @param maxConcurrent - Số lượng tối đa chạy đồng thời
 */
async function runWithConcurrency<T>(
    tasks: (() => Promise<T>)[],
    maxConcurrent: number
): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let nextIndex = 0;

    // Tạo N worker chạy song song, mỗi worker tự lấy task tiếp theo khi xong
    const workers = Array.from({ length: Math.min(maxConcurrent, tasks.length) }, async () => {
        while (nextIndex < tasks.length) {
            const currentIndex = nextIndex++;
            results[currentIndex] = await tasks[currentIndex]();
        }
    });

    await Promise.all(workers);
    return results;
}

// Tên file cache kết quả phụ đề
const SUBTITLE_CACHE_FILE = "autosubs_subtitle_lines.json";

// ======================== PROGRESS CALLBACK ========================
export interface SubtitleMatchProgress {
    current: number;
    total: number;
    message: string;
}

// ======================== FORMAT WHISPER ========================

/** 1 word đã format có timestamp */
interface FormattedWord {
    timestamp: number;
    text: string;
    formatted: string; // "[0.16] February"
}

/**
 * Format TOÀN BỘ whisper segments thành mảng words có timestamps
 * (Tương tự ai-matcher.ts)
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
 * (Tương tự ai-matcher.ts)
 */
function splitTranscriptAtSentenceBoundaries(
    words: FormattedWord[],
    numParts: number
): { text: string; startTime: number; endTime: number }[] {
    if (words.length === 0) return [];

    // Tìm TẤT CẢ vị trí dấu chấm câu
    const sentenceEnds: number[] = [];
    for (let i = 0; i < words.length; i++) {
        const wordText = words[i].text;
        if (wordText.endsWith(".") || wordText.endsWith("?") || wordText.endsWith("!")) {
            sentenceEnds.push(i + 1);
        }
    }

    // Nếu không có dấu chấm nào → trả về 1 phần
    if (sentenceEnds.length === 0) {
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
        // Phần cuối: lấy hết
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

        const targetCut = partStart + idealPartSize;

        // Tìm dấu chấm câu GẦN NHẤT với targetCut
        let bestCutIdx = -1;
        let bestDistance = Infinity;
        for (const seIdx of sentenceEnds) {
            if (seIdx <= partStart) continue;
            if (seIdx >= words.length) continue;
            const distance = Math.abs(seIdx - targetCut);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestCutIdx = seIdx;
            }
        }

        if (bestCutIdx === -1) {
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

        const partWords = words.slice(partStart, bestCutIdx);
        if (partWords.length > 0) {
            parts.push({
                text: partWords.map(w => w.formatted).join(" "),
                startTime: partWords[0].timestamp,
                endTime: partWords[partWords.length - 1].timestamp,
            });
        }
        partStart = bestCutIdx;
    }

    return parts;
}

// ======================== GỌI AI API (MULTI-PROVIDER) ========================

/** Các HTTP status code có thể retry (lỗi tạm thời) */
const RETRYABLE_STATUS_CODES = [524, 429, 500, 502, 503];

/**
 * Gọi AI với auto-retry và round-robin Claude/Gemini
 * Retry tối đa 3 lần, delay tăng dần: 5s → 10s → 20s
 */
async function callAI(prompt: string, label: string = "AI Call", timeoutMs?: number): Promise<string> {
    const { callAIMultiProvider } = await import("@/utils/ai-provider");
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= AI_CONFIG.retryCount; attempt++) {
        try {
            const attemptLabel = attempt > 0
                ? `📝 Subtitle: ${label} (retry ${attempt}/${AI_CONFIG.retryCount})`
                : `📝 Subtitle: ${label}`;

            const result = await callAIMultiProvider(
                prompt,
                attemptLabel,
                "auto",
                timeoutMs || AI_CONFIG.timeoutMs
            );

            if (attempt > 0) {
                console.log(`[Subtitle] ✅ ${label}: thành công sau ${attempt} lần retry`);
            }
            return result;
        } catch (err) {
            const errMsg = String(err);

            // Lỗi tạm thời (rate limit, server, timeout) → retry
            const isRetryable = RETRYABLE_STATUS_CODES.some(code => errMsg.includes(String(code)))
                || errMsg.includes("abort") || errMsg.includes("network") || errMsg.includes("rate limit");

            if (isRetryable && attempt < AI_CONFIG.retryCount) {
                const delayMs = AI_CONFIG.retryBaseMs * Math.pow(2, attempt);
                console.warn(`[Subtitle] ⚠️ ${label}: ${errMsg.slice(0, 100)} → retry ${attempt + 1}/${AI_CONFIG.retryCount} sau ${delayMs / 1000}s`);
                lastError = err as Error;
                await new Promise(resolve => setTimeout(resolve, delayMs));
                continue;
            }

            throw err;
        }
    }

    throw lastError || new Error(`AI API failed after ${AI_CONFIG.retryCount} retries`);
}

// ======================== PARSE AI RESPONSE ========================
/**
 * Parse AI response → SubtitleLine[]
 * AI trả về: [{"text": "...", "start": 0.00, "end": 0.00}, ...]
 * Xử lý cả JSON bị truncated (output bị cắt cụt)
 */
function parseSubtitleResponse(aiResponse: string): SubtitleLine[] {
    // Bỏ thinking tags
    let cleaned = aiResponse.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");

    // Bỏ markdown code block
    const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) cleaned = codeBlock[1];

    // Tìm JSON array hoàn chỉnh
    let jsonMatch = cleaned.match(/\[[\s\S]*\]/);

    // ⭐ JSON bị truncated → khôi phục phần đã có
    if (!jsonMatch) {
        const openBracket = cleaned.indexOf("[");
        if (openBracket === -1) {
            console.error("[Subtitle] Response không có JSON:", cleaned.slice(0, 500));
            throw new Error("AI response không chứa JSON array");
        }
        const afterOpen = cleaned.slice(openBracket);
        const lastBrace = afterOpen.lastIndexOf("}");
        if (lastBrace === -1) {
            throw new Error("AI response JSON truncated quá nhiều");
        }
        const truncatedJson = afterOpen.slice(0, lastBrace + 1) + "]";
        console.warn(`[Subtitle] ⚠️ JSON truncated! Khôi phục ${truncatedJson.length} chars`);
        jsonMatch = [truncatedJson];
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) throw new Error("Không phải array");

    // Filter: chỉ lấy item hợp lệ (có text + start + end)
    const results: SubtitleLine[] = parsed
        .filter(
            (r: any) =>
                typeof r.text === "string" &&
                r.text.trim().length > 0 &&
                typeof r.start === "number" &&
                typeof r.end === "number"
        )
        .map((r: any) => ({
            text: r.text.trim(),
            start: Math.max(0, r.start),
            end: Math.max(r.start, r.end),
        }));

    console.log(`[Subtitle] Parsed ${results.length} dòng phụ đề`);
    return results;
}

// ======================== LƯU / LOAD CACHE ========================

/** Lưu kết quả phụ đề vào file cache */
export async function saveSubtitleLines(
    folder: string,
    lines: SubtitleLine[]
): Promise<void> {
    try {
        const filePath = await join(folder, SUBTITLE_CACHE_FILE);
        const data = {
            version: 1,
            savedAt: new Date().toISOString(),
            totalLines: lines.length,
            lines,
        };
        await writeTextFile(filePath, JSON.stringify(data, null, 2));
        console.log(`[Subtitle] ✅ Lưu ${lines.length} dòng phụ đề → ${filePath}`);
    } catch (error) {
        console.error("[Subtitle] ❌ Lỗi lưu cache:", error);
    }
}

/** Load kết quả phụ đề từ cache */
export async function loadSubtitleLines(
    folder: string
): Promise<SubtitleLine[] | null> {
    try {
        const filePath = await join(folder, SUBTITLE_CACHE_FILE);
        const fileExists = await exists(filePath);
        if (!fileExists) return null;

        const content = await readTextFile(filePath);
        const data = JSON.parse(content);

        if (data.version && data.lines && Array.isArray(data.lines)) {
            console.log(`[Subtitle] ✅ Loaded ${data.lines.length} dòng từ cache (${data.savedAt})`);
            return data.lines;
        }
        return null;
    } catch (error) {
        console.error("[Subtitle] ❌ Lỗi load cache:", error);
        return null;
    }
}

// ======================== HÀM CHÍNH ========================
/**
 * AI matching tạo phụ đề: chia transcript 5 batch song song + retry
 *
 * Flow:
 * 1. Format whisper words → cắt 5 phần tại ranh giới câu
 * 2. Chia script text tương ứng (có overlap ±20%)
 * 3. Gửi 5 batch song song → AI trả về SubtitleLine[]
 * 4. Merge + sort theo thời gian
 * 5. Retry cho đoạn thiếu
 * 6. Normalize timing (tăng dần, fill kín)
 *
 * @param scriptText  - Kịch bản gốc (text liên tục, KHÔNG có số thứ tự)
 * @param transcript  - Whisper transcript object (có segments + words)
 * @param onProgress  - Callback cập nhật tiến trình
 * @param saveFolder  - Thư mục lưu cache (nếu có)
 */
export async function aiSubtitleMatch(
    scriptText: string,
    transcript: any,
    onProgress?: (progress: SubtitleMatchProgress) => void,
    saveFolder?: string
): Promise<SubtitleLine[]> {
    const segments = transcript.originalSegments || transcript.segments || [];
    const whisperWords = extractWhisperWords(transcript);
    const totalDuration =
        whisperWords.length > 0 ? whisperWords[whisperWords.length - 1].end : 0;

    // Format toàn bộ words
    const allFormattedWords = formatWhisperWords(segments);

    console.log(
        `[Subtitle] Script: ${scriptText.length} chars, ${allFormattedWords.length} words, ${totalDuration.toFixed(0)}s`
    );

    // ⭐ Cắt transcript thành N phần tại ranh giới câu
    const rawTranscriptParts = splitTranscriptAtSentenceBoundaries(
        allFormattedWords,
        AI_CONFIG.batchCount
    );

    // ⭐ Thêm OVERLAP cho transcript — 15% words mỗi bên
    const TRANSCRIPT_OVERLAP_RATIO = 0.15;
    const wordsPerPart = Math.ceil(allFormattedWords.length / rawTranscriptParts.length);
    const transcriptOverlapWords = Math.ceil(wordsPerPart * TRANSCRIPT_OVERLAP_RATIO);

    const transcriptParts: { text: string; startTime: number; endTime: number }[] = [];

    for (let i = 0; i < rawTranscriptParts.length; i++) {
        const part = rawTranscriptParts[i];

        // Tìm startIdx/endIdx trong allFormattedWords dựa trên timestamp
        let startIdx = 0;
        let endIdx = allFormattedWords.length;
        for (let w = 0; w < allFormattedWords.length; w++) {
            if (allFormattedWords[w].timestamp >= part.startTime - 0.01) {
                startIdx = w;
                break;
            }
        }
        for (let w = allFormattedWords.length - 1; w >= 0; w--) {
            if (allFormattedWords[w].timestamp <= part.endTime + 0.01) {
                endIdx = w + 1;
                break;
            }
        }

        // Mở rộng overlap
        const overlapStart = Math.max(0, startIdx - transcriptOverlapWords);
        const overlapEnd = Math.min(allFormattedWords.length, endIdx + transcriptOverlapWords);
        const expandedWords = allFormattedWords.slice(overlapStart, overlapEnd);

        transcriptParts.push({
            text: expandedWords.map(w => w.formatted).join(" "),
            startTime: expandedWords[0]?.timestamp || 0,
            endTime: expandedWords[expandedWords.length - 1]?.timestamp || 0,
        });
    }

    // ⭐ Chia script text thành N phần theo tỷ lệ (có overlap ±20%)
    // Script là text liên tục → chia theo dòng/câu
    const scriptLines = scriptText.split(/\n+/).filter(l => l.trim());
    const totalLines = scriptLines.length;
    const N = transcriptParts.length;
    const SCRIPT_OVERLAP_RATIO = 0.20;
    const linesPerPart = totalLines / N;

    const scriptBatches: string[] = [];
    for (let i = 0; i < N; i++) {
        const rawStart = Math.floor(linesPerPart * i);
        const rawEnd = Math.ceil(linesPerPart * (i + 1));
        const overlapSize = Math.ceil(linesPerPart * SCRIPT_OVERLAP_RATIO);

        const batchStart = Math.max(0, rawStart - overlapSize);
        const batchEnd = Math.min(totalLines, rawEnd + overlapSize);

        scriptBatches.push(scriptLines.slice(batchStart, batchEnd).join("\n"));
        console.log(`[Subtitle] Script batch ${i + 1}: dòng ${batchStart + 1} → ${batchEnd} (${batchEnd - batchStart} dòng)`);
    }

    console.log(`[Subtitle] Chia ${N} batch (transcript overlap ±${transcriptOverlapWords} words, script overlap ±20%):`);
    transcriptParts.forEach((p, i) =>
        console.log(`  Phần ${i + 1}: ${p.startTime.toFixed(0)}s → ${p.endTime.toFixed(0)}s (~${(p.text.length / 1000).toFixed(0)}KB)`)
    );

    onProgress?.({
        current: 0,
        total: N,
        message: `Đang gửi ${N} batch (tối đa ${AI_CONFIG.maxConcurrent} đồng thời)...`,
    });

    // ⚡ Gửi batch với giới hạn concurrency (API cho phép tối đa 6 đồng thời)
    const batchTasks = transcriptParts.map((part, i) => async () => {
        const batchNum = i + 1;
        const timeRange = `${part.startTime.toFixed(0)}s → ${part.endTime.toFixed(0)}s`;

        try {
            const prompt = buildSubtitleMatchPrompt(
                scriptBatches[i],
                part.text,
                batchNum,
                N,
                timeRange
            );

            console.log(`[Subtitle] Batch ${batchNum}: transcript ${timeRange}, script ~${(scriptBatches[i].length / 1000).toFixed(0)}KB, prompt ~${(prompt.length / 1000).toFixed(0)}KB`);

            const response = await callAI(
                prompt,
                `Batch ${batchNum}/${N} (${timeRange})`
            );

            const lines = parseSubtitleResponse(response);
            console.log(`[Subtitle] Batch ${batchNum}: ${lines.length} dòng phụ đề ✅`);

            onProgress?.({
                current: batchNum,
                total: N,
                message: `Batch ${batchNum}/${N} xong (${lines.length} dòng)`,
            });

            return { batchNum, lines };
        } catch (error) {
            console.error(`[Subtitle] Batch ${batchNum} LỖI:`, error);
            return { batchNum, lines: [] as SubtitleLine[] };
        }
    });

    const batchResults = await runWithConcurrency(batchTasks, AI_CONFIG.maxConcurrent);

    // ======================== MERGE KẾT QUẢ ========================
    // Gộp tất cả dòng phụ đề từ N batch → sort theo start time
    // Xử lý overlap: nếu 2 dòng trùng text + timing gần nhau → chỉ giữ 1
    const allLines: SubtitleLine[] = [];

    for (const { lines } of batchResults.sort((a, b) => a.batchNum - b.batchNum)) {
        for (const line of lines) {
            // Kiểm tra trùng lặp từ overlap: text giống nhau + timing gần (±2s)
            const isDuplicate = allLines.some(
                existing =>
                    existing.text === line.text &&
                    Math.abs(existing.start - line.start) < 2.0
            );
            if (!isDuplicate) {
                allLines.push(line);
            }
        }
    }

    // Sort theo start time
    allLines.sort((a, b) => a.start - b.start);

    console.log(`[Subtitle] Sau merge: ${allLines.length} dòng phụ đề (đã remove ${batchResults.reduce((s, b) => s + b.lines.length, 0) - allLines.length} duplicates overlap)`);

    // ======================== RETRY — CÂU SCRIPT THIẾU ========================
    // So sánh từng câu script với kết quả AI → tìm câu chưa xuất hiện → retry
    // Tương tự pattern retry loop trong ai-matcher.ts (image import)

    /**
     * Hàm fuzzy match: kiểm tra 1 dòng phụ đề có CHỨA nội dung câu script không
     * Normalize text (lowercase, bỏ dấu câu) trước khi so sánh
     * Trả về true nếu ≥60% từ trong scriptLine xuất hiện trong subtitleText
     */
    function isScriptLineMatched(scriptLine: string, subtitleLines: SubtitleLine[]): boolean {
        const normalize = (s: string) => s.toLowerCase().replace(/[.,!?;:"""''()\[\]{}]/g, "").trim();
        const scriptWords = normalize(scriptLine).split(/\s+/).filter(w => w.length > 1);
        if (scriptWords.length === 0) return true; // Câu rỗng → coi như đã match

        // Ghép tất cả subtitle text thành 1 chuỗi để search
        const allSubText = normalize(subtitleLines.map(l => l.text).join(" "));

        // Đếm từ script xuất hiện trong subtitle output
        let matchCount = 0;
        for (const word of scriptWords) {
            if (allSubText.includes(word)) matchCount++;
        }

        // ≥60% từ match → coi là đã có phụ đề cho câu này
        return matchCount / scriptWords.length >= 0.6;
    }

    // Tìm các dòng script CHƯA có phụ đề (chưa xuất hiện trong output)
    const missingLineIndices: number[] = [];
    for (let i = 0; i < scriptLines.length; i++) {
        const line = scriptLines[i].trim();
        if (!line) continue; // Bỏ dòng trống

        if (!isScriptLineMatched(line, allLines)) {
            missingLineIndices.push(i);
        }
    }

    console.log(`[Subtitle] Kiểm tra ${scriptLines.length} dòng script → ${missingLineIndices.length} dòng thiếu phụ đề`);

    // ⭐ RETRY LOOP — tối đa 2 rounds
    const MAX_RETRY_ROUNDS = 2;

    for (let round = 1; round <= MAX_RETRY_ROUNDS; round++) {
        // Tìm lại missing sau mỗi round
        const currentMissing: number[] = [];
        for (let i = 0; i < scriptLines.length; i++) {
            const line = scriptLines[i].trim();
            if (!line) continue;
            if (!isScriptLineMatched(line, allLines)) {
                currentMissing.push(i);
            }
        }

        if (currentMissing.length === 0) {
            console.log(`[Subtitle] ✅ Round ${round}: không còn câu thiếu!`);
            break;
        }

        console.log(`[Subtitle] ⚠️ Round ${round}/${MAX_RETRY_ROUNDS}: ${currentMissing.length} câu thiếu`);

        // Buffer time rộng dần: 5s → 10s
        const timeBuffer = round === 1 ? 5 : 10;
        // Context lines tăng dần: 3 → 5
        const contextSize = round === 1 ? 3 : 5;
        const isForceMode = round >= 2;

        // ⭐ Gom câu thiếu thành CỤM LIÊN TIẾP
        // Ví dụ: lines [2,3,4,10,11] → [[2,3,4], [10,11]]
        const clusters: number[][] = [];
        let currentCluster: number[] = [currentMissing[0]];

        for (let i = 1; i < currentMissing.length; i++) {
            if (currentMissing[i] - currentMissing[i - 1] <= 2) {
                // Khoảng cách ≤ 2 dòng → cùng cụm
                currentCluster.push(currentMissing[i]);
            } else {
                clusters.push(currentCluster);
                currentCluster = [currentMissing[i]];
            }
        }
        clusters.push(currentCluster);

        console.log(`[Subtitle] 🔄 Round ${round}: ${clusters.length} cụm thiếu`);

        onProgress?.({
            current: N,
            total: N + clusters.length,
            message: `Retry round ${round}: ${currentMissing.length} câu thiếu (${clusters.length} cụm)...`,
        });

        // ⚡ Retry với giới hạn concurrency (tránh vượt 6 request đồng thời)
        const retryTasks = clusters.map((cluster, ci) => async () => {
            try {
                const clusterFirst = cluster[0];
                const clusterLast = cluster[cluster.length - 1];

                // ⭐ Ước lượng time range dựa trên vị trí câu trong script
                // Câu ở 30% script → tương ứng ~30% timeline
                const ratioStart = Math.max(0, clusterFirst - contextSize) / totalLines;
                const ratioEnd = Math.min(totalLines, clusterLast + contextSize + 1) / totalLines;
                let timeStart = Math.max(0, ratioStart * totalDuration - timeBuffer);
                let timeEnd = Math.min(totalDuration, ratioEnd * totalDuration + timeBuffer);

                // Nếu có phụ đề trước/sau gần nhất → dùng timing đó chính xác hơn
                const nearbyBefore = allLines.filter(l => l.end <= ratioStart * totalDuration + timeBuffer);
                const nearbyAfter = allLines.filter(l => l.start >= ratioEnd * totalDuration - timeBuffer);
                if (nearbyBefore.length > 0) {
                    timeStart = Math.max(0, nearbyBefore[nearbyBefore.length - 1].start - timeBuffer);
                }
                if (nearbyAfter.length > 0) {
                    timeEnd = Math.min(totalDuration, nearbyAfter[0].end + timeBuffer);
                }

                // Lấy transcript words trong time range
                const relevantWords = allFormattedWords.filter(
                    w => w.timestamp >= timeStart && w.timestamp <= timeEnd
                );

                if (relevantWords.length === 0) {
                    console.warn(`[Subtitle] Round ${round} cụm ${ci + 1}: không có transcript trong ${timeStart.toFixed(0)}s → ${timeEnd.toFixed(0)}s`);
                    return [];
                }

                const whisperSlice = relevantWords.map(w => w.formatted).join(" ");

                // Lấy script text: câu thiếu + context trước/sau
                const scriptStart = Math.max(0, clusterFirst - contextSize);
                const scriptEnd = Math.min(totalLines, clusterLast + 1 + contextSize);
                const scriptChunk = scriptLines.slice(scriptStart, scriptEnd).join("\n");

                const timeRange = `${timeStart.toFixed(0)}s → ${timeEnd.toFixed(0)}s`;

                console.log(`[Subtitle] Round ${round} cụm ${ci + 1}: dòng ${clusterFirst + 1}-${clusterLast + 1}, transcript ${timeRange}, ${relevantWords.length} words`);

                // Tạo prompt retry
                let prompt = buildSubtitleRetryPrompt(
                    scriptChunk,
                    whisperSlice,
                    timeRange
                );

                // ⭐ Force-match round 2+: force AI to create subtitles for ALL missing lines
                if (isForceMode) {
                    const missingTexts = cluster.map(idx => scriptLines[idx]?.trim()).filter(Boolean);
                    prompt += `\n\n=== MANDATORY MODE — DO NOT SKIP ANY LINE ===
⚠️ The following lines MUST have subtitles:
${missingTexts.map((t, i) => `${i + 1}. "${t}"`).join("\n")}

IMPORTANT: Whisper often mishears, misspells, or merges words.
→ Do NOT require exact text match with Whisper.
→ If NOT found in Whisper → distribute timing evenly across ${timeRange} for ${missingTexts.length} lines.
→ Each line ≈ ${((timeEnd - timeStart) / Math.max(1, missingTexts.length)).toFixed(1)}s

⚠️ NEVER TRANSLATE the text. Use the EXACT text from the script above.
OUTPUT: Return JSON array for ALL ${missingTexts.length} lines. Do NOT skip any.`;
                }

                const response = await callAI(
                    prompt,
                    `Round ${round} cụm ${ci + 1} (${timeRange})`,
                    isForceMode ? 60000 : 45000
                );

                return parseSubtitleResponse(response);
            } catch (error) {
                console.error(`[Subtitle] Round ${round} cụm ${ci + 1} LỖI:`, error);
                return [];
            }
        });

        const retryResults = await runWithConcurrency(retryTasks, AI_CONFIG.maxConcurrent);

        // Merge retry results — chỉ thêm dòng chưa trùng
        let retryAdded = 0;
        for (const lines of retryResults) {
            for (const line of lines) {
                const isDuplicate = allLines.some(
                    existing =>
                        existing.text === line.text &&
                        Math.abs(existing.start - line.start) < 2.0
                );
                if (!isDuplicate) {
                    allLines.push(line);
                    retryAdded++;
                }
            }
        }

        // Re-sort sau retry
        allLines.sort((a, b) => a.start - b.start);

        // Đếm lại missing
        const stillMissing = scriptLines.filter(l => l.trim() && !isScriptLineMatched(l, allLines)).length;
        console.log(`[Subtitle] 🔄 Round ${round} hoàn tất: +${retryAdded} dòng, còn thiếu: ${stillMissing}`);

        if (stillMissing === 0) break;
    }

    // ======================== NORMALIZE TIMING ========================
    // Đảm bảo timing tăng dần tuyệt đối + fill kín

    let fixedCount = 0;
    for (let i = 1; i < allLines.length; i++) {
        // start phải >= end trước
        if (allLines[i].start < allLines[i - 1].end) {
            allLines[i].start = allLines[i - 1].end;
            fixedCount++;
        }
        // end phải > start (tối thiểu 0.1s)
        if (allLines[i].end <= allLines[i].start) {
            allLines[i].end = allLines[i].start + 0.5;
            fixedCount++;
        }
    }

    // Fill kín: end(i) = start(i+1) — phụ đề liên tục
    for (let i = 0; i < allLines.length - 1; i++) {
        const gap = allLines[i + 1].start - allLines[i].end;
        // Chỉ fill nếu gap nhỏ (< 1s) — gap lớn giữ nguyên (khoảng lặng tự nhiên)
        if (gap > 0 && gap < 1.0) {
            allLines[i].end = allLines[i + 1].start;
        }
    }

    if (fixedCount > 0) {
        console.log(`[Subtitle] 🔧 Đã sửa ${fixedCount} timing sai thứ tự`);
    }

    // Lưu cache
    if (saveFolder) {
        await saveSubtitleLines(saveFolder, allLines);
    }

    onProgress?.({
        current: N + missingLineIndices.length,
        total: N + missingLineIndices.length,
        message: `Hoàn tất! ${allLines.length} dòng phụ đề`,
    });

    console.log(`[Subtitle] ✅ Hoàn tất: ${allLines.length} dòng phụ đề, timing ${allLines[0]?.start.toFixed(1)}s → ${allLines[allLines.length - 1]?.end.toFixed(1)}s`);
    return allLines;
}
