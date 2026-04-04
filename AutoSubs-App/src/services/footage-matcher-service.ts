/**
 * footage-matcher-service.ts
 *
 * Service AI matching: gửi script + footage metadata → AI gợi ý 5-10 footage
 * Dùng whisper word timing để gắn footage vào đúng thời điểm
 * Chia batch nếu thư viện footage lớn (>50 items)
 * 
 * Dùng CLAUDE (giống audio-director-service) cho phần text matching
 */

import type { FootageItem, FootageSuggestion } from "@/types/footage-types";

// ======================== CONSTANTS ========================

// Constant removed because we use NUM_BATCHES now
/** Thời gian cấm B-Roll ở đầu video (giây) — mặc định nếu chưa đọc settings */
const DEFAULT_BROLL_START = 60;

// Claude config — cùng cấu hình với audio-director-service
const CLAUDE_CONFIG = {
    baseUrl: "https://ezaiapi.com/v1",
    // apiKey: đã chuyển sang nhập qua Settings UI (không hardcode)
    model: "claude-sonnet-4-6",
    timeoutMs: 900000,  // 15 phút
    maxTokens: 16000,
};

/**
 * Bật chế độ mới:
 * - Chỉ gửi 1 request AI cho footage matching.
 * - Script gửi đi là 15 cụm timing (~30s/cụm) thay vì full kịch bản.
 */
const FOOTAGE_SINGLE_REQUEST_MODE = true;
const FOOTAGE_CLUSTER_COUNT = 15;
const FOOTAGE_CLUSTER_WINDOW_SEC = 30;

interface WordTimingToken {
    timestamp: number;
    word: string;
}

// ======================== HELPER: TẠO SCRIPT TIMING TEXT ========================

/**
 * Chuyển whisper words thành text format kèm timing cho AI
 * Format: "0.5s - 3.2s: The city never sleeps at night"
 *
 * @param sentences - Danh sách câu đã match { text, start, end }
 */
export function formatScriptWithTiming(
    sentences: Array<{ text: string; start: number; end: number; index?: number }>
): string {
    return sentences.map((s, i) => {
        const idx = s.index ?? i;
        return `[Sentence ${idx}] ${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s: "${s.text}"`;
    }).join("\n");
}

/**
 * Tạo cụm timing cho Footage prompt:
 * - Lấy tối đa `clusterCount` cụm, mỗi cụm ~`windowSec` giây.
 * - Mỗi cụm chứa danh sách câu có overlap với khoảng thời gian cụm.
 *
 * Mục tiêu:
 * - Giảm payload script gửi AI.
 * - Vẫn giữ mốc timing thật để AI đặt footage khớp nhịp kể chuyện.
 */
function buildFootageTimingClustersText(
    sentences: Array<{ text: string; start: number; end: number; index?: number }>,
    totalDurationSec: number,
    clusterCount: number = FOOTAGE_CLUSTER_COUNT,
    windowSec: number = FOOTAGE_CLUSTER_WINDOW_SEC
): string {
    if (!sentences.length) return "";

    const safeDuration = Math.max(
        totalDurationSec,
        ...sentences.map(s => Number.isFinite(s.end) ? s.end : 0),
        1
    );
    const count = Math.max(1, clusterCount);
    const step = Math.max(1, safeDuration / count);

    const chunks: string[] = [];
    for (let i = 0; i < count; i++) {
        const start = Math.max(0, i * step);
        const end = Math.min(safeDuration, start + windowSec);

        // Lấy các câu giao với cửa sổ thời gian.
        const overlapped = sentences.filter(s => s.end >= start && s.start <= end);
        if (!overlapped.length) continue;

        const lineText = overlapped.map((s) => {
            const idx = s.index ?? 0;
            return `[S${idx}] ${s.start.toFixed(2)}-${s.end.toFixed(2)}: "${s.text}"`;
        }).join("\n");

        chunks.push(
            `[[CLUSTER ${chunks.length + 1}]] ${start.toFixed(2)}-${end.toFixed(2)}\n${lineText}`
        );
    }

    // Nếu video rất ngắn hoặc timing thưa khiến cụm ít hơn mục tiêu, fallback sang format full.
    if (!chunks.length) {
        return formatScriptWithTiming(sentences);
    }

    return chunks.join("\n\n");
}

/**
 * Tạo cụm word timing dạng:
 * [[CLUSTER 1]] 0.00-30.00
 * [0.15] hello [0.38] world ...
 */
function buildWordTimingClustersText(
    words: WordTimingToken[],
    totalDurationSec: number,
    clusterCount: number = FOOTAGE_CLUSTER_COUNT,
    windowSec: number = FOOTAGE_CLUSTER_WINDOW_SEC
): string {
    if (!words.length) return "";

    const safeDuration = Math.max(
        totalDurationSec,
        ...words.map(w => Number.isFinite(w.timestamp) ? w.timestamp : 0),
        1
    );
    const count = Math.max(1, clusterCount);
    const step = Math.max(1, safeDuration / count);

    const chunks: string[] = [];
    for (let i = 0; i < count; i++) {
        const start = Math.max(0, i * step);
        const end = Math.min(safeDuration, start + windowSec);
        const clusterWords = words.filter(w => w.timestamp >= start && w.timestamp <= end);
        if (!clusterWords.length) continue;

        const wordsLine = clusterWords
            .map(w => `[${w.timestamp.toFixed(2)}] ${w.word}`)
            .join(" ");

        chunks.push(`[[CLUSTER ${chunks.length + 1}]] ${start.toFixed(2)}-${end.toFixed(2)}\n${wordsLine}`);
    }

    return chunks.join("\n\n");
}

/**
 * Chuyển footage items thành JSON ngắn gọn cho AI
 * Chỉ gửi metadata cần thiết (bỏ filePath dài, bỏ hash)
 */
function formatFootageForAI(items: FootageItem[]): string {
    const simplified = items
        .filter(i => i.aiDescription)  // Chỉ gửi items đã scan AI
        .map(i => ({
            fileName: i.fileName,
            duration: i.durationSec,
            description: i.aiDescription,
            tags: i.aiTags,
            mood: i.aiMood,
        }));
    return JSON.stringify(simplified, null, 1);
}

// ======================== MAIN: AI MATCHING ========================

/**
 * Gọi AI matching footage → script
 * Nếu thư viện footage > 50 items → chia batch, merge kết quả
 *
 * @param sentences - Câu đã match từ whisper (có timing)
 * @param footageItems - Danh sách footage có metadata
 * @param apiKey - Gemini API key
 * @param totalDurationSec - Tổng thời lượng video
 * @returns Danh sách FootageSuggestion
 */
export async function matchFootageToScript(
    sentences: Array<{ text: string; start: number; end: number; index?: number }>,
    footageItems: FootageItem[],
    _apiKey: string,   // Không dùng nữa (giữ param để tránh lỗi gọi từ UI)
    totalDurationSec: number,
    wordTimingTokens?: WordTimingToken[]
): Promise<FootageSuggestion[]> {
    // ── Đọc cấu hình từ Tauri Store (cùng nơi SettingsContext lưu) ────────────────
    let NUM_BATCHES = 1;
    let BROLL_START = DEFAULT_BROLL_START;
    let MAX_CONCURRENCY = 3;
    let TOTAL_FOOTAGE_CLIPS = 10;
    try {
        const { load } = await import('@tauri-apps/plugin-store');
        const store = await load('autosubs-store.json');
        const storedSettings = await store.get<any>('settings');
        if (storedSettings) {
            NUM_BATCHES = storedSettings.aiFootageBatches ?? 1;
            BROLL_START = storedSettings.bRollStartTime ?? DEFAULT_BROLL_START;
            MAX_CONCURRENCY = storedSettings.aiMaxConcurrency ?? 3;
            TOTAL_FOOTAGE_CLIPS = storedSettings.aiTotalFootageClips ?? 10;
            console.log(`[FootageMatcher] 🔧 Settings: numBatches=${NUM_BATCHES}, bRollStart=${BROLL_START}s, concurrency=${MAX_CONCURRENCY}, totalFootage=${TOTAL_FOOTAGE_CLIPS}`);
        }
    } catch {
        console.warn("[FootageMatcher] Không đọc được settings, dùng mặc định");
    }

    // Chỉ gửi items ĐÃ CÓ metadata AI
    const analyzedItems = footageItems.filter(i => i.aiDescription && i.aiDescription !== "");

    if (analyzedItems.length === 0) {
        throw new Error("Không có footage nào đã được scan AI. Hãy quét thư viện trước!");
    }

    // Build script text:
    // - Mode mới: chỉ gửi 15 cụm timing (giảm payload rất mạnh).
    // - Mode cũ: gửi full câu có timing.
    const scriptText = FOOTAGE_SINGLE_REQUEST_MODE
        ? ((wordTimingTokens && wordTimingTokens.length > 0)
            ? buildWordTimingClustersText(
                wordTimingTokens,
                totalDurationSec,
                FOOTAGE_CLUSTER_COUNT,
                FOOTAGE_CLUSTER_WINDOW_SEC
            )
            : buildFootageTimingClustersText(
                sentences,
                totalDurationSec,
                FOOTAGE_CLUSTER_COUNT,
                FOOTAGE_CLUSTER_WINDOW_SEC
            ))
        : formatScriptWithTiming(sentences);

    // Map fileName → filePath (để gắn lại fullPath sau)
    const pathMap = new Map(footageItems.map(i => [i.fileName, i.filePath]));

    if (FOOTAGE_SINGLE_REQUEST_MODE) {
        console.log(
            `[FootageMatcher] 🧠 Single request mode: clusters=${FOOTAGE_CLUSTER_COUNT}, window≈${FOOTAGE_CLUSTER_WINDOW_SEC}s, totalFootage=${TOTAL_FOOTAGE_CLIPS}`
        );

        const suggestions = await doMatchRequest(
            scriptText,
            analyzedItems,
            totalDurationSec,
            pathMap,
            sentences,
            TOTAL_FOOTAGE_CLIPS,
            BROLL_START
        );

        // Lọc thời gian cấm B-roll đầu video.
        const filtered = suggestions.filter(s => s.startTime >= BROLL_START);

        // Không dùng quá số lượng user đã set trong AI config.
        filtered.sort((a, b) => a.startTime - b.startTime);
        if (TOTAL_FOOTAGE_CLIPS > 0) {
            return filtered.slice(0, TOTAL_FOOTAGE_CLIPS);
        }
        return filtered;
    }

    // ===== Chia batch theo thông số NUM_BATCHES (legacy mode) =====
    const maxFootagePerBatch = Math.max(1, Math.round(TOTAL_FOOTAGE_CLIPS / NUM_BATCHES));
    const BATCH_SIZE = Math.max(1, Math.ceil(analyzedItems.length / NUM_BATCHES));

    if (analyzedItems.length <= BATCH_SIZE) {
        // Gửi 1 lần duy nhất (nhỏ, hoặc do NUM_BATCHES = 1)
        return await doMatchRequest(scriptText, analyzedItems, totalDurationSec, pathMap, sentences, maxFootagePerBatch, BROLL_START);
    }

    // Chia thành nhiều batch
    const batches: FootageItem[][] = [];
    for (let i = 0; i < analyzedItems.length; i += BATCH_SIZE) {
        batches.push(analyzedItems.slice(i, i + BATCH_SIZE));
    }
    console.log(`[FootageMatcher] Thư viện lớn (${analyzedItems.length} items) → ${batches.length} batch (theo setting), concurrency=${MAX_CONCURRENCY}`);

    // ── Chạy batch qua Worker Queue (giới hạn MAX_CONCURRENCY luồng song song) ──
    const allSuggestions: FootageSuggestion[] = [];
    let batchIdx = 0;
    let activeTasks = 0;
    await new Promise<void>((resolve, reject) => {
        const runNext = () => {
            // Nạp thêm luồng mới khi còn slot trống
            while (activeTasks < MAX_CONCURRENCY && batchIdx < batches.length) {
                const currentIdx = batchIdx;
                const currentBatch = batches[batchIdx];
                batchIdx++;
                activeTasks++;
                console.log(`[FootageMatcher] ▶ Batch ${currentIdx + 1}/${batches.length} bắt đầu (${currentBatch.length} items) | Yêu cầu AI chọn ${maxFootagePerBatch}`);

                doMatchRequest(scriptText, currentBatch, totalDurationSec, pathMap, sentences, maxFootagePerBatch, BROLL_START)
                    .then(results => {
                        console.log(`[FootageMatcher] ✅ Batch ${currentIdx + 1} xong → ${results.length} gợi ý`);
                        allSuggestions.push(...results);
                        activeTasks--;
                        if (batchIdx < batches.length) {
                            runNext(); // Nhả slot → nạp batch tiếp theo
                        } else if (activeTasks === 0) {
                            resolve(); // Hết tất cả batch
                        }
                    })
                    .catch(err => {
                        activeTasks--;
                        console.error(`[FootageMatcher] ❌ Batch ${currentIdx + 1} lỗi:`, err);
                        reject(err);
                    });
            }
        };
        runNext();
        if (batches.length === 0) resolve();
    });

    // Dedup: nếu nhiều batch gợi ý cùng câu → giữ cái đầu
    const seen = new Set<number>();
    const deduped = allSuggestions.filter(s => {
        if (seen.has(s.sentenceIndex)) return false;
        seen.add(s.sentenceIndex);
        return true;
    });

    // Lọc bỏ footage nằm trong BROLL_START giây đầu (theo profile config)
    const filtered = deduped.filter(s => s.startTime >= BROLL_START);
    if (BROLL_START > 0) {
        console.log(`[FootageMatcher] 🎬 Đã lọc bỏ footage trong ${BROLL_START}s đầu: ${deduped.length - filtered.length} item`);
    }

    // Giới hạn kết quả, rải đều theo thời gian (giới hạn cứng tối đa bằng TOTAL_FOOTAGE_CLIPS)
    if (filtered.length > TOTAL_FOOTAGE_CLIPS && TOTAL_FOOTAGE_CLIPS > 0) {
        filtered.sort((a, b) => a.startTime - b.startTime);
        const step = Math.max(1, Math.floor(filtered.length / TOTAL_FOOTAGE_CLIPS));
        const selected: FootageSuggestion[] = [];
        for (let i = 0; i < filtered.length && selected.length < TOTAL_FOOTAGE_CLIPS; i += step) {
            selected.push(filtered[i]);
        }
        return selected;
    }

    return filtered;
}

// ======================== INTERNAL: GỌI 1 REQUEST AI ========================

async function doMatchRequest(
    scriptText: string,
    footageItems: FootageItem[],
    totalDurationSec: number,
    pathMap: Map<string, string>,
    sentences: Array<{ text: string; start: number; end: number; index?: number }>,
    maxFootagePerBatch: number,
    bRollStartSec: number
): Promise<FootageSuggestion[]> {
    const { callAIMultiProvider } = await import("@/utils/ai-provider");

    const footageJson = formatFootageForAI(footageItems);
    const { getActiveProfileId } = await import('@/config/activeProfile');
    const profileId = getActiveProfileId();

    const footageMatchModules: Record<string, () => Promise<{ buildFootageMatchPrompt: Function }>> = {
        documentary: () => import('../prompts/documentary/footage-match-prompt'),
        stories:     () => import('../prompts/stories/footage-match-prompt'),
        tiktok:      () => import('../prompts/tiktok/footage-match-prompt'),
    };

    const loadModule = footageMatchModules[profileId] ?? footageMatchModules['documentary'];
    const { buildFootageMatchPrompt } = await loadModule();
    const prompt = buildFootageMatchPrompt(
        scriptText,
        footageJson,
        totalDurationSec,
        maxFootagePerBatch,
        bRollStartSec
    );

    const label = `📽️ Footage Match (lib=${footageItems.length} items, ask=${maxFootagePerBatch} clips, script=${sentences.length} câu)`;

    // Round-robin Claude/Gemini — tự retry rate limit
    const rawText = await callAIMultiProvider(
        prompt,
        label,
        "auto",
        CLAUDE_CONFIG.timeoutMs
    );

    // Parse JSON array từ response
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
        console.error("[FootageMatcher] AI không trả về JSON array:", rawText);
        return [];
    }

    const parsed: any[] = JSON.parse(jsonMatch[0]);

    // Chuyển thành FootageSuggestion (gắn filePath).
    // Hỗ trợ cả schema đầy đủ và schema rút gọn để tiết kiệm token:
    // - full: sentenceIndex/startTime/endTime/footageFile/trimStart/trimEnd
    // - short: i/s/e/f/ts/te
    const suggestions: FootageSuggestion[] = parsed.map(item => {
        const sentIdxRaw = item.i ?? item.sentenceIndex ?? 0;
        const sentIdx = Number.isFinite(Number(sentIdxRaw)) ? Number(sentIdxRaw) : 0;
        const sentence = sentences[sentIdx];

        const footageFile = String(item.f ?? item.footageFile ?? "");
        const startRaw = item.s ?? item.startTime;
        const endRaw = item.e ?? item.endTime;
        const trimStartRaw = item.ts ?? item.trimStart;
        const trimEndRaw = item.te ?? item.trimEnd;

        const startTime = Number.isFinite(Number(startRaw))
            ? Number(startRaw)
            : (sentence?.start ?? 0);
        const endTime = Number.isFinite(Number(endRaw))
            ? Number(endRaw)
            : (sentence?.end ?? 0);
        const trimStart = Number.isFinite(Number(trimStartRaw)) ? Number(trimStartRaw) : 0;
        const trimEnd = Number.isFinite(Number(trimEndRaw)) ? Number(trimEndRaw) : 5;

        return {
            sentenceIndex: sentIdx,
            sentenceText: sentence?.text || "",
            startTime,
            endTime,
            footageFile,
            footagePath: pathMap.get(footageFile) || "",
            trimStart,
            trimEnd,
            reason: String(item.r ?? item.reason ?? ""),
        };
    }).filter(s => s.footagePath);  // Bỏ items không tìm thấy file

    console.log(`[FootageMatcher] ✅ AI gợi ý ${suggestions.length} footage clips`);
    return suggestions;
}
