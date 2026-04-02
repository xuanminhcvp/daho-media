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
    totalDurationSec: number
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

    // Build script text
    const scriptText = formatScriptWithTiming(sentences);

    // Map fileName → filePath (để gắn lại fullPath sau)
    const pathMap = new Map(footageItems.map(i => [i.fileName, i.filePath]));

    // ===== Chia batch theo thông số NUM_BATCHES =====
    const maxFootagePerBatch = Math.max(1, Math.round(TOTAL_FOOTAGE_CLIPS / NUM_BATCHES));
    const BATCH_SIZE = Math.max(1, Math.ceil(analyzedItems.length / NUM_BATCHES));

    if (analyzedItems.length <= BATCH_SIZE) {
        // Gửi 1 lần duy nhất (nhỏ, hoặc do NUM_BATCHES = 1)
        return await doMatchRequest(scriptText, analyzedItems, totalDurationSec, pathMap, sentences, maxFootagePerBatch);
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

                doMatchRequest(scriptText, currentBatch, totalDurationSec, pathMap, sentences, maxFootagePerBatch)
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
    maxFootagePerBatch: number
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
    const prompt = buildFootageMatchPrompt(scriptText, footageJson, totalDurationSec, maxFootagePerBatch);

    const label = `📽️ Footage Match (${footageItems.length} footage × ${sentences.length} câu)`;

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

    // Chuyển thành FootageSuggestion (gắn filePath)
    const suggestions: FootageSuggestion[] = parsed.map(item => {
        const sentIdx = item.sentenceIndex ?? 0;
        const sentence = sentences[sentIdx];
        return {
            sentenceIndex: sentIdx,
            sentenceText: sentence?.text || "",
            startTime: item.startTime ?? sentence?.start ?? 0,
            endTime: item.endTime ?? sentence?.end ?? 0,
            footageFile: item.footageFile || "",
            footagePath: pathMap.get(item.footageFile) || "",
            trimStart: item.trimStart ?? 0,
            trimEnd: item.trimEnd ?? 5,
            reason: item.reason || "",
        };
    }).filter(s => s.footagePath);  // Bỏ items không tìm thấy file

    console.log(`[FootageMatcher] ✅ AI gợi ý ${suggestions.length} footage clips`);
    return suggestions;
}
