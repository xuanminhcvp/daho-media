// audio-director-service.ts
// Service AI Đạo Diễn: đọc kịch bản (autosubs_matching.json) + catalog nhạc
// → AI phân tích cảm xúc từng cảnh và gợi ý bài nhạc phù hợp
// Không cần AI nghe lại audio — chỉ đọc text metadata đã lưu sẵn

import { readTextFile, exists } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import {
    AudioLibraryItem,
    AudioScene,
    AIDirectorResult,
} from "@/types/audio-types";
import { generateLogId } from "@/services/debug-logger";

// ======================== CẤU HÌNH ========================

// Claude (cùng config với ai-matcher.ts) — dùng cho TẤT CẢ phân tích TEXT
// (Director, SFX, Highlight, Retry nhạc)
// ⚡ BẢN MỚI: Round-robin Claude + Gemini (tránh rate limit)
const CLAUDE_CONFIG = {
    baseUrl: "https://ezaiapi.com/v1",
    // apiKey: đã chuyển sang nhập qua Settings UI (không hardcode)
    model: "claude-sonnet-4-6",
    timeoutMs: 900000,  // 15 phút (giống ai-matcher)
    maxTokens: 16000,
};

// Gemini CHỈ dùng cho audio-library-service (scan file audio cần gửi Base64)
// KHÔNG dùng cho text analysis — tất cả text analysis dùng Claude

const MATCHING_CACHE_FILE = "autosubs_matching.json";

// ======================== GỌI AI API (MULTI-PROVIDER) ========================

/**
 * Gọi AI — round-robin Claude/Gemini (tránh rate limit)
 * Wrapper cho callAIMultiProvider + retry logic
 * 
 * @param prompt - Nội dung prompt
 * @param label - Nhãn hiển thị trong Debug Panel
 * @param logId - ID debug log (nếu đã tạo trước)
 * @param startTime - Timestamp bắt đầu (để tính duration)
 * @param onProgress - Callback progress
 * @returns Content text từ AI
 */
async function callClaude(
    prompt: string,
    label: string,
    _logId?: string,
    _startTime?: number,
    onProgress?: (msg: string) => void
): Promise<string> {
    const { callAIMultiProvider } = await import("@/utils/ai-provider");
    
    // Retry config cho rate limit — tối đa 5 lần
    const MAX_RETRIES = 5;
    const RETRY_DELAYS = [10000, 20000, 40000, 80000, 120000];
    
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            onProgress?.(attempt > 0 
                ? `🔄 Retry ${attempt}/${MAX_RETRIES}...` 
                : "AI đang phân tích...");
            
            // Round-robin Claude/Gemini tự động
            const result = await callAIMultiProvider(
                prompt,
                label,
                "auto",
                CLAUDE_CONFIG.timeoutMs
            );
            return result;
        } catch (err) {
            const errMsg = String(err);
            
            // Rate limit → retry sau delay
            if ((errMsg.includes("429") || errMsg.includes("529") || errMsg.includes("rate limit")) && attempt < MAX_RETRIES) {
                const delay = RETRY_DELAYS[attempt] || 60000;
                console.warn(`[AudioDirector] ⚠️ Rate limit — retry ${attempt + 1}/${MAX_RETRIES} sau ${delay / 1000}s`);
                onProgress?.(`⏳ Rate limit — chờ ${delay / 1000}s rồi thử lại (${attempt + 1}/${MAX_RETRIES})...`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            
            // Lỗi khác → throw
            throw err;
        }
    }
    
    throw new Error("Hết retry attempts");
}

// ======================== LOAD KỊCH BẢN ========================

/** 1 câu trong matching.json */
export interface MatchingSentence {
    num: number;
    text: string;
    start: number;
    end: number;
    quality: string;
    // ⚠️ Bug fix #17: thêm 2 field optional — trước đây thiếu so với ScriptSentence
    // Downstream code (SFX, Music) có thể truy cập mà không bị undefined
    matchRate?: string;
    matchedWhisper?: string;
}

export interface SfxCue {
    sentenceNum: number;
    triggerWord: string;
    timeOffset: number;
    sfxCategory: string;
    searchKeywords: string[];
    reason: string;
    assignedSfxPath?: string;      // Đường dẫn file SFX cục bộ đã chọn
    assignedSfxName?: string;      // Tên file SFX (basename)
    assignedSfxFileName?: string;  // Tên file AI chọn từ thư viện (chính xác)
    trimStartSec?: number;         // Điểm cắt SFX bắt đầu (giây)
    trimEndSec?: number;           // Điểm cắt SFX kết thúc (giây)
    exactStartTime?: number;       // Thời điểm chính xác từ whisper words (giây)
}

export interface AISfxPlanResult {
    cues: SfxCue[];
    analyzedAt: string;
}

export interface HighlightCue {
    sentenceNum: number;
    textToHighlight: string;
    reason: string;
}

export interface AIHighlightPlanResult {
    cues: HighlightCue[];
    analyzedAt: string;
}

/**
 * Load dữ liệu kịch bản từ file autosubs_matching.json
 * @param mediaFolder - Thư mục chứa file matching.json
 */
export async function loadMatchingScript(
    mediaFolder: string
): Promise<{
    sentences: MatchingSentence[],
    aiDirectorResult?: AIDirectorResult,
    aiSfxPlanResult?: AISfxPlanResult,
    aiHighlightPlanResult?: AIHighlightPlanResult,
    templateAssignmentResult?: any
} | null> {
    try {
        const filePath = await join(mediaFolder, MATCHING_CACHE_FILE);
        const fileExists = await exists(filePath);

        if (!fileExists) {
            console.warn("[AudioDirector] Không tìm thấy autosubs_matching.json");
            return null;
        }

        const content = await readTextFile(filePath);
        const data = JSON.parse(content);

        if (data.results && Array.isArray(data.results)) {
            console.log(`[AudioDirector] Loaded ${data.results.length} câu từ matching.json`);
            return {
                sentences: data.results as MatchingSentence[],
                aiDirectorResult: data.directorResult as AIDirectorResult | undefined,
                aiSfxPlanResult: data.sfxPlanResult as AISfxPlanResult | undefined,
                aiHighlightPlanResult: data.highlightPlanResult as AIHighlightPlanResult | undefined,
                templateAssignmentResult: data.templateAssignmentResult || undefined
            };
        }
        return null;
    } catch (error) {
        console.error("[AudioDirector] Lỗi load matching.json:", error);
        return null;
    }
}

// ======================== BUILD CATALOG TEXT ========================
// Đã chuyển sang file prompts/audio-director-prompt.ts
// Import lại để dùng trong hàm analyzeScriptForMusic
// import { buildDirectorPrompt } from "@/prompts/documentary/audio-director-prompt"; // unused — giữ lại để tham khảo
// import { buildDirectorPrompt } from "@/prompts/documentary/audio-director-prompt"; // unused — giữ lại để tham khảo
import type { WhisperWordCompact } from "@/prompts/documentary/sfx-director-prompt";

// ======================== GỌI AI ========================

/**
 * Gọi AI để phân tích kịch bản và gợi ý nhạc nền theo từng Scene
 *
 * @param sentences - Danh sách câu từ matching.json
 * @param musicItems - Thư viện nhạc đã có metadata AI
 * @param onProgress - Callback báo tiến trình
 */
export async function analyzeScriptForMusic(
    mediaFolder: string,
    sentences: MatchingSentence[],
    musicItems: AudioLibraryItem[],
    onProgress?: (msg: string) => void
): Promise<AIDirectorResult> {
    const startTime = Date.now();

    // Tổng duration video
    const totalDuration = sentences.length > 0
        ? Math.max(...sentences.map(s => s.end))
        : 0;
    const totalMinutes = Math.round(totalDuration / 60);

    // Đọc Config từ Profile động và Settings (Tauri Store)
    const { getActiveProfileId } = await import('@/config/activeProfile');
    const { formatConfig } = await import(`../prompts/${getActiveProfileId()}/config`);

    let MUSIC_BATCH_COUNT = formatConfig.MUSIC_BATCH_COUNT || 1;
    try {
        const { load } = await import('@tauri-apps/plugin-store');
        const store = await load('autosubs-store.json');
        const storedSettings = await store.get<any>('settings');
        if (storedSettings?.aiAudioBatches) {
            MUSIC_BATCH_COUNT = storedSettings.aiAudioBatches;
        }
    } catch {
        // Fallback to profile config
    }
    const batchDuration = totalDuration / MUSIC_BATCH_COUNT;

    console.log(`[AudioDirector] 🚀 Chạy ${MUSIC_BATCH_COUNT} batch song song | Video: ${totalMinutes}min | ${sentences.length} câu | Config: ${getActiveProfileId()}`);
    onProgress?.(`🚀 Đang phân tích ${MUSIC_BATCH_COUNT} batch song song (${musicItems.length} bài nhạc)...`);

    // Import prompt batch (đã chuyển vào trong vòng lặp)

    // Kết quả tích lũy
    let allScenes: AudioScene[] = [];

    // Build lookup map một lần
    const musicByFileName = new Map<string, AudioLibraryItem>();
    for (const item of musicItems) {
        musicByFileName.set(item.fileName.toLowerCase(), item);
    }

    // ========== Helper: chạy 1 batch (dùng chung cho cả batch 1 và batch 2-5) ==========
    const runSingleBatch = async (
        batchIdx: number,
        coherenceRef: Array<{ sceneId: number; emotion: string; assignedMusicFileName: string | null }>
    ): Promise<AudioScene[]> => {
        const batchNum = batchIdx + 1;
        const batchTimeStart = batchIdx * batchDuration;
        const batchTimeEnd = (batchIdx + 1) * batchDuration;

        // Lọc sentences trong batch này
        const batchSentences = sentences.filter(
            (s) => s.start >= batchTimeStart && s.start < batchTimeEnd
        );

        if (batchSentences.length === 0) {
            console.log(`[AudioDirector] Batch ${batchNum}: Không có câu → bỏ qua`);
            return [];
        }

        console.log(`[AudioDirector] Batch ${batchNum}: ${batchTimeStart.toFixed(0)}s-${batchTimeEnd.toFixed(0)}s | ${batchSentences.length} câu`);
        onProgress?.(`📦 Batch ${batchNum}/${MUSIC_BATCH_COUNT}: ${batchSentences.length} câu (${Math.round(batchTimeStart)}s-${Math.round(batchTimeEnd)}s)...`);

        // Build prompt — truyền coherence reference (từ batch 1)
        const { getActiveProfileId } = await import('@/config/activeProfile');
        const { buildDirectorBatchPrompt } = await import(`../prompts/${getActiveProfileId()}/audio-director-prompt`);
        const prompt = buildDirectorBatchPrompt(
            batchSentences,
            musicItems,
            batchNum,
            MUSIC_BATCH_COUNT,
            batchTimeStart,
            batchTimeEnd,
            totalDuration,
            coherenceRef
        );

        // Gọi Claude + retry 1 lần
        let batchScenes: AudioScene[] = [];
        const MAX_BATCH_RETRIES = 1;

        for (let attempt = 0; attempt <= MAX_BATCH_RETRIES; attempt++) {
            try {
                const logId = generateLogId();
                const label = attempt === 0
                    ? `AI Đạo Diễn Batch ${batchNum}/${MUSIC_BATCH_COUNT}`
                    : `AI Đạo Diễn Batch ${batchNum} (retry)`;

                const content = await callClaude(prompt, label, logId, Date.now(), onProgress);

                // Parse response
                batchScenes = parseBatchDirectorResponse(content, musicByFileName);
                console.log(`[AudioDirector] ✅ Batch ${batchNum}: ${batchScenes.length} scenes`);
                break; // Thành công → thoát retry loop

            } catch (err) {
                console.error(`[AudioDirector] ❌ Batch ${batchNum} attempt ${attempt + 1} lỗi:`, err);
                if (attempt < MAX_BATCH_RETRIES) {
                    onProgress?.(`🔄 Batch ${batchNum} retry... (lỗi: ${String(err).substring(0, 80)})`);
                } else {
                    console.warn(`[AudioDirector] ⚠️ Batch ${batchNum} thất bại sau ${MAX_BATCH_RETRIES + 1} lần`);
                    onProgress?.(`⚠️ Batch ${batchNum} thất bại — sẽ lấp nhạc liền kề sau`);
                }
            }
        }

        return batchScenes;
    };

    // ========== THỰC THI TOÀN BỘ BATCH SONG SONG ==========
    onProgress?.(`⏳ Đang chạy ${MUSIC_BATCH_COUNT} batch AI song song...`);
    
    const batchPromises: Promise<{ batchIdx: number; scenes: AudioScene[] }>[] = [];

    for (let batchIdx = 0; batchIdx < MUSIC_BATCH_COUNT; batchIdx++) {
        // Capture batchIdx
        const idx = batchIdx;
        batchPromises.push(
            runSingleBatch(idx, []).then(scenes => ({
                batchIdx: idx,
                scenes,
            }))
        );
    }

    // Chờ tất cả xong
    const batchResults = await Promise.allSettled(batchPromises);

    // Ghép kết quả
    const successResults: { batchIdx: number; scenes: AudioScene[] }[] = [];
    for (const result of batchResults) {
        if (result.status === 'fulfilled') {
            successResults.push(result.value);
        } else {
            console.error(`[AudioDirector] ❌ Batch lỗi:`, result.reason);
        }
    }
    // Sort theo batch để scenes đúng thứ tự
    successResults.sort((a, b) => a.batchIdx - b.batchIdx);
    for (const r of successResults) {
        allScenes.push(...r.scenes);
    }

    console.log(`[AudioDirector] 🎵 Tất cả ${MUSIC_BATCH_COUNT} batch hoàn tất: ${allScenes.length} scenes tổng cộng`);

    // ========== MUSIC RETRY — tối đa 2 round (giống image import) ==========
    // Sau khi 5 batch chạy xong, kiểm tra scene trống nhạc (> 30s)
    // Nếu còn trống → gọi AI retry để chọn nhạc, tối đa 2 lần
    const { buildMusicRetryPrompt } = await import("../prompts/documentary/music-retry-prompt");
    const GAP_THRESHOLD_SEC = 30;
    const MAX_RETRY_ROUNDS = 2;

    // Tạo AIDirectorResult tạm để truyền vào mergeRetryResults
    const tempResult: AIDirectorResult = {
        scenes: allScenes,
        sfxAssignments: [],
        analyzedAt: new Date().toISOString(),
    };

    for (let retryRound = 1; retryRound <= MAX_RETRY_ROUNDS; retryRound++) {
        // Tìm scene trống nhạc (> 30s)
        const gapScenes = allScenes.filter(
            (s) => !s.assignedMusic && (s.endTime - s.startTime) > GAP_THRESHOLD_SEC
        );

        if (gapScenes.length === 0) {
            console.log(`[AudioDirector] ✅ Retry round ${retryRound}: Không còn scene trống → bỏ qua`);
            break;
        }

        console.log(`[AudioDirector] 🔄 Retry round ${retryRound}/${MAX_RETRY_ROUNDS}: ${gapScenes.length} scene trống nhạc`);
        onProgress?.(`🔄 Retry ${retryRound}/${MAX_RETRY_ROUNDS}: ${gapScenes.length} scene trống nhạc — AI đang chọn lại...`);

        try {
            // Build prompt retry (chỉ gửi scene trống + catalog nhạc)
            const retryPrompt = buildMusicRetryPrompt(gapScenes, musicItems, retryRound);
            const retryLogId = generateLogId();
            const retryLabel = `AI Nhạc Nền Retry ${retryRound}/${MAX_RETRY_ROUNDS} (${gapScenes.length} scenes)`;

            // Gọi Claude
            const retryContent = await callClaude(retryPrompt, retryLabel, retryLogId, Date.now(), onProgress);

            // Merge kết quả retry vào allScenes (ghi đè scene trống)
            mergeRetryResults(tempResult, retryContent, musicItems);

            // Đếm scene đã được gán nhạc sau retry
            const remainingGaps = allScenes.filter(
                (s) => !s.assignedMusic && (s.endTime - s.startTime) > GAP_THRESHOLD_SEC
            );
            const fixed = gapScenes.length - remainingGaps.length;
            console.log(`[AudioDirector] 🔄 Retry ${retryRound}: Gán được ${fixed}/${gapScenes.length} scene, còn ${remainingGaps.length} trống`);
            onProgress?.(`🔄 Retry ${retryRound}: ✅ ${fixed} scene được gán nhạc, còn ${remainingGaps.length} trống`);

            // Nếu đã gán hết → không cần retry tiếp
            if (remainingGaps.length === 0) {
                console.log(`[AudioDirector] ✅ Retry ${retryRound}: Tất cả scene đã có nhạc!`);
                break;
            }
        } catch (err) {
            console.error(`[AudioDirector] ❌ Retry ${retryRound} lỗi:`, err);
            onProgress?.(`⚠️ Retry ${retryRound} lỗi: ${String(err).substring(0, 80)}`);
            // Không throw — tiếp tục retry hoặc fill gaps
        }
    }

    // ========== FILL GAPS — FALLBACK CUỐI (lấp scene trống bằng nhạc liền kề) ==========
    // Chỉ chạy nếu sau 2 round retry vẫn còn scene trống
    const finalGapScenes = allScenes.filter(
        (s) => !s.assignedMusic && (s.endTime - s.startTime) > GAP_THRESHOLD_SEC
    );

    if (finalGapScenes.length > 0) {
        console.log(`[AudioDirector] 🔧 Fill gaps: ${finalGapScenes.length} scene vẫn trống sau ${MAX_RETRY_ROUNDS} retry`);
        onProgress?.(`🔧 Lấp ${finalGapScenes.length} scene trống bằng nhạc liền kề (fallback)...`);
        fillMusicGaps(allScenes);
    }

    const result: AIDirectorResult = {
        scenes: allScenes,
        sfxAssignments: [],
        analyzedAt: new Date().toISOString(),
    };

    const duration = Date.now() - startTime;
    console.log(`[AudioDirector] ✅ Hoàn tất: ${allScenes.length} scenes | ${(duration / 1000).toFixed(1)}s`);
    onProgress?.(`✅ Hoàn tất! ${allScenes.length} scenes (${(duration / 1000).toFixed(1)}s)`);

    // ========== LƯU CACHE ==========
    const filePath = await join(mediaFolder, MATCHING_CACHE_FILE);
    if (await exists(filePath)) {
        onProgress?.("Đang lưu cache AI Đạo diễn...");
        const currentContent = await readTextFile(filePath);
        const currentJson = JSON.parse(currentContent);
        currentJson.directorResult = result;
        const { writeTextFile } = await import('@tauri-apps/plugin-fs');
        await writeTextFile(filePath, JSON.stringify(currentJson, null, 2));
    }

    return result;
}

// ======================== PARSE BATCH RESPONSE ========================

/**
 * Parse response từ 1 batch AI Director → AudioScene[]
 * Tái sử dụng logic parse giống parseDirectorResponse nhưng gọn hơn
 */
function parseBatchDirectorResponse(
    aiResponse: string,
    musicByFileName: Map<string, AudioLibraryItem>
): AudioScene[] {
    // Clean response
    let cleaned = aiResponse.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");
    const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) cleaned = codeBlock[1];

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        console.error("[AudioDirector] Batch response không có JSON:", cleaned.slice(0, 300));
        throw new Error(`AI Đạo Diễn không trả về JSON. Preview: "${cleaned.slice(0, 200)}"`);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const rawScenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];

    return rawScenes.map((raw: any) => {
        // Tìm nhạc AI chọn
        let assignedMusic: AudioLibraryItem | null = null;
        if (raw.assignedMusicFileName && raw.assignedMusicFileName !== "null") {
            const key = String(raw.assignedMusicFileName).toLowerCase();
            assignedMusic = musicByFileName.get(key) || null;

            // Tìm gần đúng
            if (!assignedMusic) {
                for (const [name, item] of musicByFileName) {
                    if (name.includes(key) || key.includes(name)) {
                        assignedMusic = item;
                        break;
                    }
                }
            }
        }

        return {
            sceneId: raw.sceneId || 0,
            startTime: raw.startTime ?? 0,
            endTime: raw.endTime ?? 0,
            emotion: raw.emotion || "Không xác định",
            emotionReason: raw.emotionReason || "",
            assignedMusic,
            assignedMusicStartTime: raw.assignedMusicStartTime ?? 0.0,
            assignedMusicReason: raw.assignedMusicReason || "",
            searchKeywords: Array.isArray(raw.searchKeywords) ? raw.searchKeywords : [],
            sentenceNums: Array.isArray(raw.sentenceNums) ? raw.sentenceNums : [],
        } as AudioScene & { assignedMusicReason: string };
    });
}

// ======================== PARSE KẾT QUẢ AI ========================

/**
 * Parse JSON từ AI Đạo Diễn thành AudioScene[]
 * Map tên file nhạc AI chọn → AudioLibraryItem thực tế
 */
// @ts-expect-error kept for future use
function _parseDirectorResponse(
    aiResponse: string,
    musicItems: AudioLibraryItem[],
    _sentences: MatchingSentence[]
): AIDirectorResult {
    // Debug: log raw response length
    console.log(`[AudioDirector] Raw AI response length: ${aiResponse.length} chars`)
    console.log(`[AudioDirector] Raw AI response preview:`, aiResponse.slice(0, 500))

    // Bỏ thinking tags
    let cleaned = aiResponse.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");

    // Bỏ markdown code block
    const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) cleaned = codeBlock[1];

    // Tìm JSON object
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        console.error("[AudioDirector] AI không trả về JSON. Cleaned:", cleaned.slice(0, 500));
        throw new Error(`AI Đạo Diễn không trả về JSON hợp lệ. Response preview: "${cleaned.slice(0, 200)}"`);
    }

    let parsed: any;
    try {
        parsed = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
        console.error("[AudioDirector] JSON parse error:", parseErr, "| JSON preview:", jsonMatch[0].slice(0, 300));
        throw new Error(`AI Đạo Diễn JSON parse lỗi: ${parseErr}. Preview: "${jsonMatch[0].slice(0, 200)}"`);
    }
    const rawScenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];

    // Build lookup map: fileName → AudioLibraryItem
    const musicByFileName = new Map<string, AudioLibraryItem>();
    for (const item of musicItems) {
        musicByFileName.set(item.fileName.toLowerCase(), item);
    }

    // Convert sang AudioScene[]
    const scenes: AudioScene[] = rawScenes.map((raw: any) => {
        // Tìm nhạc được AI chọn
        let assignedMusic: AudioLibraryItem | null = null;
        if (raw.assignedMusicFileName && raw.assignedMusicFileName !== "null") {
            const key = String(raw.assignedMusicFileName).toLowerCase();
            assignedMusic = musicByFileName.get(key) || null;

            // Nếu không tìm chính xác, tìm gần đúng (chứa tên)
            if (!assignedMusic) {
                for (const [name, item] of musicByFileName) {
                    if (name.includes(key) || key.includes(name)) {
                        assignedMusic = item;
                        break;
                    }
                }
            }
        }

        return {
            sceneId: raw.sceneId || 0,
            startTime: raw.startTime ?? 0,
            endTime: raw.endTime ?? 0,
            emotion: raw.emotion || "Không xác định",
            emotionReason: raw.emotionReason || "",
            assignedMusic,
            assignedMusicStartTime: raw.assignedMusicStartTime ?? 0.0,
            assignedMusicReason: raw.assignedMusicReason || "",
            searchKeywords: Array.isArray(raw.searchKeywords) ? raw.searchKeywords : [],
            sentenceNums: Array.isArray(raw.sentenceNums) ? raw.sentenceNums : [],
        } as AudioScene & { assignedMusicReason: string };
    });

    console.log(`[AudioDirector] ✅ ${scenes.length} Scenes phân tích xong`);
    scenes.forEach((s) => {
        console.log(
            `  Scene ${s.sceneId} (${s.startTime.toFixed(0)}s–${s.endTime.toFixed(0)}s): ${s.emotion} → ${s.assignedMusic?.fileName ?? "null"}`
        );
    });

    return {
        scenes,
        sfxAssignments: [],
        analyzedAt: new Date().toISOString(),
    };
}

// ======================== MERGE RETRY RESULTS ========================

/**
 * Merge kết quả retry vào result gốc
 * AI retry trả về danh sách scene mới với nhạc đã gán → ghi đè vào scene tương ứng
 */
function mergeRetryResults(
    result: AIDirectorResult,
    retryResponse: string,
    musicItems: AudioLibraryItem[]
): void {
    try {
        // Clean response
        let cleaned = retryResponse.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");
        const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlock) cleaned = codeBlock[1];
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return;

        const parsed = JSON.parse(jsonMatch[0]);
        const retryScenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];

        // Build lookup map
        const musicByFileName = new Map<string, AudioLibraryItem>();
        for (const item of musicItems) {
            musicByFileName.set(item.fileName.toLowerCase(), item);
        }

        // Merge: ghi đè scene gốc nếu retry trả về nhạc
        let merged = 0;
        for (const retryScene of retryScenes) {
            const sceneId = retryScene.sceneId;
            const target = result.scenes.find((s) => s.sceneId === sceneId);
            if (!target) continue;

            // Tìm nhạc
            const fileName = retryScene.assignedMusicFileName;
            if (!fileName || fileName === "null") continue;

            const key = String(fileName).toLowerCase();
            let foundMusic = musicByFileName.get(key) || null;

            // Tìm gần đúng
            if (!foundMusic) {
                for (const [name, item] of musicByFileName) {
                    if (name.includes(key) || key.includes(name)) {
                        foundMusic = item;
                        break;
                    }
                }
            }

            if (foundMusic) {
                target.assignedMusic = foundMusic;
                target.assignedMusicStartTime = retryScene.assignedMusicStartTime ?? 0;
                (target as any).assignedMusicReason = retryScene.assignedMusicReason || "(retry)";
                merged++;
                console.log(`[AudioDirector] 🔄 Retry merge: Scene ${sceneId} → ${foundMusic.fileName}`);
            }
        }

        console.log(`[AudioDirector] 🔄 Retry merged: ${merged}/${retryScenes.length} scenes`);
    } catch (err) {
        console.warn("[AudioDirector] ⚠️ Lỗi merge retry:", err);
    }
}

// ======================== FILL MUSIC GAPS (FALLBACK CUỐI) ========================

/**
 * Lấp scene trống nhạc bằng nhạc của scene liền kề
 * - Ưu tiên lấy nhạc từ scene trước (phía trên)
 * - Nếu scene đầu tiên trống → lấy từ scene sau (phía dưới)
 * - Đánh dấu scene đã fill bằng tag "(auto-fill)"
 */
function fillMusicGaps(scenes: AudioScene[]): void {
    let filled = 0;

    for (let i = 0; i < scenes.length; i++) {
        if (scenes[i].assignedMusic) continue; // Đã có nhạc → bỏ qua

        const duration = scenes[i].endTime - scenes[i].startTime;
        if (duration <= 30) continue; // Scene ngắn ≤ 30s → cho phép trống (nghệ thuật)

        // Tìm scene gần nhất có nhạc — ưu tiên phía trước
        let donor: AudioScene | null = null;

        // Tìm scene trước có nhạc
        for (let j = i - 1; j >= 0; j--) {
            if (scenes[j].assignedMusic) {
                donor = scenes[j];
                break;
            }
        }

        // Nếu không có scene trước → tìm scene sau
        if (!donor) {
            for (let j = i + 1; j < scenes.length; j++) {
                if (scenes[j].assignedMusic) {
                    donor = scenes[j];
                    break;
                }
            }
        }

        if (donor && donor.assignedMusic) {
            scenes[i].assignedMusic = donor.assignedMusic;
            scenes[i].assignedMusicStartTime = donor.assignedMusicStartTime;
            (scenes[i] as any).assignedMusicReason = `(auto-fill từ Scene ${donor.sceneId})`;
            filled++;
            console.log(`[AudioDirector] 🔧 Fill gap: Scene ${scenes[i].sceneId} ← nhạc từ Scene ${donor.sceneId} (${donor.assignedMusic.fileName})`);
        }
    }

    if (filled > 0) {
        console.log(`[AudioDirector] 🔧 Đã lấp ${filled} scene trống bằng nhạc liền kề`);
    }
}

// ======================== AI GỢI Ý SFX (5 BATCH SONG SONG) ========================

// (Đã xóa khai báo hardcode tĩnh cho documentary)

/**
 * Gọi AI để phân tích kịch bản và gợi ý các điểm cần chèn SFX.
 * PHIÊN BẢN MỚI: Chia 5 batch song song, gửi kèm:
 *   - Thư viện SFX (metadata đầy đủ)
 *   - Whisper words (timing chính xác từng từ)
 * AI trả về: assignedSfxFileName + trim + exactStartTime
 *
 * Nếu không có sfxItems hoặc whisperWords → fallback về prompt cũ (1 request)
 *
 * @param mediaFolder - Thư mục chứa matching.json
 * @param sentences - Danh sách câu từ matching.json  
 * @param sfxItems - Thư viện SFX đã scan AI (có metadata)
 * @param whisperWords - Whisper words (word-level timestamps)
 * @param onProgress - Callback báo tiến trình
 */
export async function analyzeScriptForSFX(
    mediaFolder: string,
    sentences: MatchingSentence[],
    sfxItems?: AudioLibraryItem[],
    whisperWords?: WhisperWordCompact[],
    onProgress?: (msg: string) => void
): Promise<AISfxPlanResult> {
    // ========== FALLBACK: nếu không có SFX library hoặc whisper → dùng prompt cũ ==========
    const validSfxItems = sfxItems?.filter(
        (item) => item.aiMetadata && !item.aiMetadata.emotion.includes("Lỗi")
    ) || [];

    if (validSfxItems.length === 0 || !whisperWords || whisperWords.length === 0) {
        console.log("[SFX Planner] ⚠️ Không có SFX library hoặc whisper words → fallback prompt cũ");
        return analyzeScriptForSFX_legacy(mediaFolder, sentences, onProgress);
    }

    // ========== CHIA 5 BATCH THEO THỜI GIAN ==========
    const totalDuration = sentences.length > 0
        ? Math.max(...sentences.map(s => s.end))
        : 0;
    // totalMinutes used to be here, deleted to fix lint

    // Lấy config SFX từ profile động và Settings (Tauri Store)
    const { getActiveProfileId } = await import('@/config/activeProfile');
    const { formatConfig } = await import(`../prompts/${getActiveProfileId()}/config`);

    let SFX_BATCH_COUNT = formatConfig.SFX_BATCH_COUNT || 1;
    let totalSfxCues = formatConfig.MAX_SFX_CUES_PER_BATCH || 10;
    try {
        const { load } = await import('@tauri-apps/plugin-store');
        const store = await load('autosubs-store.json');
        const storedSettings = await store.get<any>('settings');
        if (storedSettings?.aiSfxBatches) {
            SFX_BATCH_COUNT = storedSettings.aiSfxBatches;
        }
        if (storedSettings?.aiTotalSfxCues) {
            totalSfxCues = storedSettings.aiTotalSfxCues;
        }
    } catch {
        // Fallback to profile config
    }

    // Tự động phân bổ theo mật độ: lùi trên xuống, chia đều cho các Batch
    const maxCuesPerBatch = Math.max(1, Math.round(totalSfxCues / SFX_BATCH_COUNT));
    const batchDuration = totalDuration / SFX_BATCH_COUNT;

    console.log(`[SFX Planner] 🚀 Chia ${SFX_BATCH_COUNT} batch song song | Tổng SFX nhắm tới: ${totalSfxCues} | Max ${maxCuesPerBatch} cues/batch`);
    onProgress?.(`🚀 Chia ${SFX_BATCH_COUNT} batch song song (${validSfxItems.length} SFX, max ${maxCuesPerBatch}/đợt)...`);

    // ========== TẠO CÁC BATCH ==========
    interface BatchData {
        batchNum: number;
        sentences: MatchingSentence[];
        whisperWords: WhisperWordCompact[];
        timeStart: number;
        timeEnd: number;
    }

    const batches: BatchData[] = [];
    for (let i = 0; i < SFX_BATCH_COUNT; i++) {
        const timeStart = i * batchDuration;
        const timeEnd = (i + 1) * batchDuration;

        // Lọc sentences theo time range (câu nào start nằm trong batch)
        const batchSentences = sentences.filter(
            (s) => s.start >= timeStart && s.start < timeEnd
        );

        // Lọc whisper words theo time range (thêm margin 2s mỗi bên)
        const margin = 2;
        const batchWhisperWords = whisperWords.filter(
            (w) => w.t >= (timeStart - margin) && w.t < (timeEnd + margin)
        );

        batches.push({
            batchNum: i + 1,
            sentences: batchSentences,
            whisperWords: batchWhisperWords,
            timeStart,
            timeEnd,
        });

        console.log(
            `[SFX Planner]   Batch ${i + 1}: ${timeStart.toFixed(0)}s-${timeEnd.toFixed(0)}s | ${batchSentences.length} câu | ${batchWhisperWords.length} words`
        );
    }

    // ========== GỌI 5 BATCH SONG SONG ==========
    const batchPromises = batches.map(async (batch) => {
        // Bỏ qua batch không có câu nào
        if (batch.sentences.length === 0) {
            console.log(`[SFX Planner]   Batch ${batch.batchNum}: Không có câu → bỏ qua`);
            return [] as SfxCue[];
        }

        const logId = generateLogId();
        const startTime = Date.now();

        onProgress?.(`📦 Batch ${batch.batchNum}/${SFX_BATCH_COUNT}: ${batch.sentences.length} câu đang phân tích...`);

        // Build prompt cho batch này
        const { getActiveProfileId } = await import('@/config/activeProfile');
        const { buildSfxBatchPrompt } = await import(`../prompts/${getActiveProfileId()}/sfx-director-prompt`);
        const prompt = buildSfxBatchPrompt(
            batch.sentences,
            sfxItems!,  // Gửi TOÀN BỘ thư viện (kể cả item chưa scan)
            batch.whisperWords,
            batch.batchNum,
            SFX_BATCH_COUNT,
            totalDuration,
            maxCuesPerBatch
        );

        try {
            // Gọi Claude
            let content = await callClaude(
                prompt,
                `AI SFX Batch ${batch.batchNum}/${SFX_BATCH_COUNT} (${batch.timeStart.toFixed(0)}s-${batch.timeEnd.toFixed(0)}s)`,
                logId,
                startTime
            );

            // Clean response: bỏ thinking tags + markdown
            content = content.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");
            content = content.replace(/```(?:json)?\s*([\s\S]*?)```/, "$1");

            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                console.warn(`[SFX Planner] ⚠️ Batch ${batch.batchNum}: AI không trả về JSON`);
                return [] as SfxCue[];
            }

            const parsed = JSON.parse(jsonMatch[0]);
            const cues: SfxCue[] = Array.isArray(parsed.cues) ? parsed.cues : [];

            // Map assignedSfxFileName → assignedSfxPath (tìm file thực tế)
            const sfxByFileName = new Map<string, AudioLibraryItem>();
            for (const item of sfxItems!) {
                sfxByFileName.set(item.fileName.toLowerCase(), item);
            }

            for (const cue of cues) {
                if (cue.assignedSfxFileName) {
                    const key = cue.assignedSfxFileName.toLowerCase();
                    const found = sfxByFileName.get(key);
                    if (found) {
                        cue.assignedSfxPath = found.filePath;
                        cue.assignedSfxName = found.fileName;
                    } else {
                        // Tìm gần đúng (chứa tên)
                        for (const [name, item] of sfxByFileName) {
                            if (name.includes(key) || key.includes(name)) {
                                cue.assignedSfxPath = item.filePath;
                                cue.assignedSfxName = item.fileName;
                                cue.assignedSfxFileName = item.fileName;
                                break;
                            }
                        }
                    }
                }
            }

            console.log(`[SFX Planner] ✅ Batch ${batch.batchNum}: ${cues.length} cues`);
            return cues;

        } catch (err) {
            console.error(`[SFX Planner] ❌ Batch ${batch.batchNum} lỗi:`, err);
            return [] as SfxCue[];
        }
    });

    // ========== CHỜ TẤT CẢ 5 BATCH HOÀN TẤT ==========
    onProgress?.(`⏳ Đang chờ ${SFX_BATCH_COUNT} batch hoàn tất...`);
    const batchResults = await Promise.all(batchPromises);

    // ========== MERGE KẾT QUẢ ==========
    const allCues: SfxCue[] = [];
    for (let i = 0; i < batchResults.length; i++) {
        console.log(`[SFX Planner] Batch ${i + 1} → ${batchResults[i].length} cues`);
        allCues.push(...batchResults[i]);
    }

    // Sort theo thời gian (exactStartTime hoặc sentence start)
    allCues.sort((a, b) => {
        const aTime = a.exactStartTime ?? 0;
        const bTime = b.exactStartTime ?? 0;
        return aTime - bTime;
    });

    console.log(`[SFX Planner] ✅ TỔNG CỘNG: ${allCues.length} SFX cues`);
    onProgress?.(`✅ Hoàn tất! ${allCues.length} SFX cues từ ${SFX_BATCH_COUNT} batch.`);

    const result: AISfxPlanResult = {
        cues: allCues,
        analyzedAt: new Date().toISOString(),
    };

    // ========== LƯU CACHE ==========
    const filePath = await join(mediaFolder, MATCHING_CACHE_FILE);
    if (await exists(filePath)) {
        onProgress?.("Đang lưu cache AI SFX Planner...");
        const currentContent = await readTextFile(filePath);
        const currentJson = JSON.parse(currentContent);
        currentJson.sfxPlanResult = result;
        const { writeTextFile } = await import('@tauri-apps/plugin-fs');
        await writeTextFile(filePath, JSON.stringify(currentJson, null, 2));
    }

    return result;
}

// ======================== LEGACY SFX ANALYZE (PROMPT CŨ) ========================

/**
 * Hàm cũ (1 request, không có SFX library, không whisper words)
 * Dùng làm fallback khi user chưa có thư viện SFX hoặc whisper words
 */
async function analyzeScriptForSFX_legacy(
    mediaFolder: string,
    sentences: MatchingSentence[],
    onProgress?: (msg: string) => void
): Promise<AISfxPlanResult> {
    const logId = generateLogId();
    const startTime = Date.now();

    onProgress?.("Đang gửi kịch bản cho AI Director (SFX) — chế độ cũ...");

    const { getActiveProfileId } = await import('@/config/activeProfile');
    const { buildSfxDirectorPrompt } = await import(`../prompts/${getActiveProfileId()}/sfx-director-prompt`);
    const prompt = buildSfxDirectorPrompt(sentences);

    try {
        let content = await callClaude(prompt, `AI SFX Planner (legacy): ${sentences.length} câu`, logId, startTime, onProgress);

        console.log(`[SFX Legacy] Raw response length: ${content.length}, preview:`, content.slice(0, 500));

        content = content.replace(/```(?:json)?\s*([\s\S]*?)```/, "$1");

        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.error("[SFX Legacy] Không tìm thấy JSON trong response:", content.slice(0, 500));
            throw new Error(`AI SFX Planner không trả về JSON hợp lệ. Preview: "${content.slice(0, 200)}"`);
        }
        let parsed: any;
        try {
            parsed = JSON.parse(jsonMatch[0]);
        } catch (parseErr) {
            console.error("[SFX Legacy] JSON parse error:", parseErr, "| Preview:", jsonMatch[0].slice(0, 300));
            throw new Error(`AI SFX Planner JSON parse lỗi: ${parseErr}. Preview: "${jsonMatch[0].slice(0, 200)}"`);
        }

        const result: AISfxPlanResult = {
            cues: Array.isArray(parsed.cues) ? parsed.cues : [],
            analyzedAt: new Date().toISOString()
        };

        // Cache lưu lại
        const filePath = await join(mediaFolder, MATCHING_CACHE_FILE);
        if (await exists(filePath)) {
            onProgress?.("Đang lưu cache AI SFX Planner...");
            const currentContent = await readTextFile(filePath);
            const currentJson = JSON.parse(currentContent);
            currentJson.sfxPlanResult = result;
            const { writeTextFile } = await import('@tauri-apps/plugin-fs');
            await writeTextFile(filePath, JSON.stringify(currentJson, null, 2));
        }

        return result;
    } catch (error) {
        throw error;
    }
}

// ======================== AI GỢI Ý HIGHLIGHT TEXT ========================

/**
 * Gửi kịch bản cho AI để tìm ra các nhóm từ cần Highlight / Call-out Text.
 */
export async function analyzeScriptForHighlightText(
    mediaFolder: string,
    sentences: MatchingSentence[],
    onProgress?: (progress: string) => void
): Promise<AIHighlightPlanResult> {
    const logId = generateLogId();
    const startTime = Date.now();

    onProgress?.("Đang gửi kịch bản cho AI Director (Highlight Text)...");

    // ==== PROMPT từ file prompts/ (dễ chỉnh sửa riêng) ====
    const { getActiveProfileId } = await import('@/config/activeProfile');
    const { buildHighlightTextPrompt } = await import(`../prompts/${getActiveProfileId()}/highlight-text-prompt`);
    const prompt = buildHighlightTextPrompt(sentences);

    try {
        // Gọi Claude thay Gemini cho Highlight analysis
        let content = await callClaude(prompt, `AI Highlight Planner (Claude): phân tích ${sentences.length} câu`, logId, startTime, onProgress);

        content = content.replace(/```(?:json)?\s*([\s\S]*?)```/, "$1");

        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error("AI Highlight Planner không trả về JSON hợp lệ");
        }
        const parsed = JSON.parse(jsonMatch[0]);

        const result: AIHighlightPlanResult = {
            cues: Array.isArray(parsed.cues) ? parsed.cues : [],
            analyzedAt: new Date().toISOString()
        };

        const filePath = await join(mediaFolder, MATCHING_CACHE_FILE);
        if (await exists(filePath)) {
            onProgress?.("Đang lưu cache AI Highlight Planner...");
            const currentContent = await readTextFile(filePath);
            const currentJson = JSON.parse(currentContent);
            currentJson.highlightPlanResult = result;
            const { writeTextFile } = await import('@tauri-apps/plugin-fs');
            await writeTextFile(filePath, JSON.stringify(currentJson, null, 2));
        }

        return result;

    } catch (error) {
        throw error;
    }
}


