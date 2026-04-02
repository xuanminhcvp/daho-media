// reference-image-service.ts
// Service cho tính năng Reference Images — ảnh thực tế minh hoạ Documentary
// AI phân tích kịch bản → gợi ý 6-10 ảnh thực tế cần chèn
// Editor tìm ảnh thủ công → gán vào slot → import lên Track V4

import { readTextFile, exists } from "@tauri-apps/plugin-fs"
import { join } from "@tauri-apps/api/path"
import type {
    RefImageSuggestion,
    AIRefImageResult,
    RefImageCacheFile,
} from "@/types/reference-image-types"
import type { MatchingSentence } from "@/services/audio-director-service"

// ======================== CẤU HÌNH ========================

// File cache lưu kết quả AI + ảnh đã gán
const REF_IMAGE_CACHE_FILE = "autosubs_ref_images.json"

// ======================== GỌI AI ========================

/**
 * Gọi AI phân tích kịch bản → gợi ý 6-10 ảnh thực tế
 *
 * @param mediaFolder - Folder chứa matching.json (để lưu cache)
 * @param sentences - Danh sách câu từ matching.json
 * @param onProgress - Callback báo tiến trình
 * @param customStartTimeMs - Thời gian bắt đầu đoạn muốn thêm ảnh thủ công (optional)
 * @param customEndTimeMs - Thời gian kết thúc đoạn (optional)
 * @param timelineId - ID của timeline (tên file transcript) để load whisper words (optional)
 * @returns Danh sách gợi ý ảnh từ AI
 */
export async function analyzeScriptForRefImages(
    mediaFolder: string,
    sentences: MatchingSentence[],
    onProgress?: (msg: string) => void,
    customStartTimeMs?: number,
    customEndTimeMs?: number,
    timelineId?: string
): Promise<AIRefImageResult> {
    const startTime = Date.now()

    onProgress?.("🔍 AI đang phân tích kịch bản tìm moment cần ảnh thực tế...")

    // Load whisper words (word-level timing) từ transcript file
    // AI sẽ dùng để tính startTime chính xác tới từng từ
    let whisperWordsText = ""
    if (timelineId) {
        try {
            const { readTranscript } = await import("@/utils/file-utils")
            const { extractWhisperWords } = await import("@/utils/media-matcher")
            const transcript = await readTranscript(`${timelineId}.json`)
            if (transcript) {
                const words = extractWhisperWords(transcript)
                // Format chuẩn: [start] word — giống SFX Director prompt, 10 từ mỗi dòng
                const lines: string[] = []
                let currentLine: string[] = []
                for (const w of words.slice(0, 3000)) {
                    currentLine.push(`[${w.start.toFixed(2)}] ${w.rawWord}`)
                    if (currentLine.length >= 10) {
                        lines.push(currentLine.join(" "))
                        currentLine = []
                    }
                }
                if (currentLine.length > 0) lines.push(currentLine.join(" "))
                whisperWordsText = lines.join("\n")
                console.log(`[RefImage] ✅ Loaded ${words.length} whisper words cho ${timelineId}`)
            }
        } catch (err) {
            console.warn("[RefImage] ⚠️ Không load được whisper words:", err)
        }
    }

    // Import prompt builder
    const { buildRefImagePrompt, buildRefImageCustomPrompt } = await import("../prompts/documentary/reference-image-prompt")

    // Build prompt 
    let prompt = "";
    const isCustom = customStartTimeMs !== undefined && customEndTimeMs !== undefined;
    
    if (isCustom) {
        prompt = buildRefImageCustomPrompt(sentences, customStartTimeMs!, customEndTimeMs!);
    } else {
        // Gửi whisper words để AI tính word-level timing
        prompt = buildRefImagePrompt(sentences, whisperWordsText || undefined);
    }

    // Gọi AI (round-robin Claude/Gemini)
    const { callAIMultiProvider } = await import("@/utils/ai-provider")

    let suggestions: any[] = [];
    
    // Đọc cài đặt batch từ Tauri Store
    let REF_BATCH_COUNT = 1;
    let MAX_CONCURRENCY = 6;
    try {
        const { load } = await import('@tauri-apps/plugin-store');
        const store = await load('autosubs-store.json');
        const storedSettings = await store.get<any>('settings');
        if (storedSettings?.aiRefImageBatches) {
            REF_BATCH_COUNT = storedSettings.aiRefImageBatches;
            MAX_CONCURRENCY = storedSettings.aiMaxConcurrency ?? 6;
        }
    } catch {
        console.warn('[RefImage] Không đọc được settings, dùng mặc định 1 batch');
    }

    try {
        if (isCustom || REF_BATCH_COUNT <= 1) {
            // Chạy 1 batch (như cũ)
            onProgress?.(`Đang phân tích 1 batch toàn cục...`)
            const content = await callAIMultiProvider(
                prompt,
                "AI Gợi Ý Ảnh Tham Khảo",
                "auto",
                900000 
            );
            suggestions = parseRefImageResponse(content, sentences);
        } else {
            // Chạy multi-batch song song
            onProgress?.(`Đang chia kịch bản thành ${REF_BATCH_COUNT} batch để tìm ảnh...`)
            const batchSize = Math.max(1, Math.ceil(sentences.length / REF_BATCH_COUNT));
            const batches: MatchingSentence[][] = [];
            for (let i = 0; i < sentences.length; i += batchSize) {
                batches.push(sentences.slice(i, i + batchSize));
            }

            let batchIdx = 0;
            let activeTasks = 0;
            const allContents: string[] = [];

            await new Promise<void>((resolve, reject) => {
                const runNext = () => {
                    while (activeTasks < MAX_CONCURRENCY && batchIdx < batches.length) {
                        const currentIdx = batchIdx;
                        const batchSentences = batches[batchIdx];
                        batchIdx++;
                        activeTasks++;

                        const batchPrompt = buildRefImagePrompt(batchSentences, whisperWordsText || undefined);
                        
                        callAIMultiProvider(
                            batchPrompt,
                            `AI Ảnh Tham Khảo (Batch ${currentIdx + 1}/${batches.length})`,
                            "auto",
                            900000
                        ).then(content => {
                            allContents.push(content);
                            activeTasks--;
                            if (batchIdx < batches.length) runNext();
                            else if (activeTasks === 0) resolve();
                        }).catch(err => {
                            activeTasks--;
                            reject(err);
                        });
                    }
                };
                runNext();
            });

            // Parse tất cả kết quả và gộp lại
            for (const content of allContents) {
                suggestions.push(...parseRefImageResponse(content, sentences));
            }
            
            // Lọc bớt nếu quá nhiều ảnh rác (giữ giới hạn ~15-20 cái)
            if (suggestions.length > 20) {
                suggestions = suggestions.slice(0, 20);
            }
        }
    } catch (err) {
        console.error("[RefImage] ❌ Lỗi gọi AI:", err)
        throw new Error(`AI phân tích thất bại: ${String(err)}`)
    }

    // Nếu không phải custom manual add thì mới lưu cache toàn bộ kịch bản
    let result: AIRefImageResult;
    
    if (!isCustom) {
        result = {
            suggestions,
            analyzedAt: new Date().toISOString(),
        }
        await saveRefImageCache(mediaFolder, result)
    } else {
        // Chỉ mượn data structure để trả về 1 item
         result = {
            suggestions,
            analyzedAt: new Date().toISOString(),
        }
    }

    const duration = Date.now() - startTime
    console.log(`[RefImage] ✅ ${suggestions.length} ảnh gợi ý | ${(duration / 1000).toFixed(1)}s`)
    onProgress?.(`✅ ${suggestions.length} ảnh gợi ý (${(duration / 1000).toFixed(1)}s)`)

    return result
}

// ======================== PARSE RESPONSE ========================

/**
 * Parse JSON từ AI → RefImageSuggestion[]
 * Validate + bổ sung thông tin từ sentences
 */
function parseRefImageResponse(
    aiResponse: string,
    sentences: MatchingSentence[]
): RefImageSuggestion[] {
    // Clean response: bỏ thinking tags + markdown code block
    let cleaned = aiResponse.replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (codeBlock) cleaned = codeBlock[1]

    // Tìm JSON object
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
        console.error("[RefImage] AI response không có JSON:", cleaned.slice(0, 500))
        throw new Error("AI không trả về JSON hợp lệ")
    }

    const parsed = JSON.parse(jsonMatch[0])
    const rawSuggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : []

    // Build lookup: sentenceNum → sentence text
    const sentenceByNum = new Map<number, MatchingSentence>()
    for (const s of sentences) {
        sentenceByNum.set(s.num, s)
    }

    // Validate + enrich
    const results: RefImageSuggestion[] = []
    let idCounter = 1

    for (const raw of rawSuggestions) {
        const sentNum = raw.sentenceNum || 0
        const sentence = sentenceByNum.get(sentNum)

        // Validate type
        const validTypes = ['portrait', 'location', 'map', 'event', 'document', 'headline', 'evidence']
        const type = validTypes.includes(raw.type) ? raw.type : 'event'

        // Validate source
        const validSources = ['google', 'pinterest', 'wikipedia']
        const source = validSources.includes(raw.source) ? raw.source : 'google'

        // Validate priority
        const validPriorities = ['high', 'medium', 'low']
        const priority = validPriorities.includes(raw.priority) ? raw.priority : 'medium'

        results.push({
            id: `ref_${idCounter++}`,
            sentenceNum: sentNum,
            sentenceText: sentence?.text || raw.sentenceText || "",
            description: raw.description || "",
            searchKeywords: Array.isArray(raw.searchKeywords) ? raw.searchKeywords : [],
            type,
            startTime: raw.startTime ?? sentence?.start ?? 0,
            endTime: raw.endTime ?? sentence?.end ?? 0,
            source,
            priority,
            reason: raw.reason || "",
        })
    }

    console.log(`[RefImage] Parsed ${results.length} suggestions từ AI`)
    return results
}

// ======================== LƯU / LOAD CACHE ========================

/**
 * Lưu kết quả AI vào file cache trong mediaFolder
 */
export async function saveRefImageCache(
    mediaFolder: string,
    result: AIRefImageResult
): Promise<void> {
    try {
        const filePath = await join(mediaFolder, REF_IMAGE_CACHE_FILE)
        const data: RefImageCacheFile = {
            version: 1,
            savedAt: new Date().toISOString(),
            aiResult: result,
        }
        const { writeTextFile } = await import("@tauri-apps/plugin-fs")
        await writeTextFile(filePath, JSON.stringify(data, null, 2))
        console.log(`[RefImage] ✅ Lưu cache → ${filePath}`)
    } catch (err) {
        console.warn("[RefImage] ⚠️ Lỗi lưu cache:", err)
    }
}

/**
 * Load cache ảnh tham khảo (nếu đã có)
 */
export async function loadRefImageCache(
    mediaFolder: string
): Promise<AIRefImageResult | null> {
    try {
        const filePath = await join(mediaFolder, REF_IMAGE_CACHE_FILE)
        const fileExists = await exists(filePath)
        if (!fileExists) return null

        const content = await readTextFile(filePath)
        const data: RefImageCacheFile = JSON.parse(content)

        if (data.version && data.aiResult) {
            console.log(`[RefImage] ✅ Loaded cache: ${data.aiResult.suggestions.length} suggestions (${data.savedAt})`)
            return data.aiResult
        }
        return null
    } catch (err) {
        console.warn("[RefImage] ⚠️ Lỗi load cache:", err)
        return null
    }
}

/**
 * Cập nhật 1 suggestion (khi editor gán ảnh vào slot)
 * Lưu lại cache sau khi update
 */
export async function updateRefImageSuggestion(
    mediaFolder: string,
    suggestionId: string,
    updates: Partial<RefImageSuggestion>
): Promise<void> {
    const cached = await loadRefImageCache(mediaFolder)
    if (!cached) return

    const idx = cached.suggestions.findIndex(s => s.id === suggestionId)
    if (idx === -1) return

    // Merge updates
    cached.suggestions[idx] = { ...cached.suggestions[idx], ...updates }

    // Lưu lại
    await saveRefImageCache(mediaFolder, cached)
    console.log(`[RefImage] ✅ Updated suggestion ${suggestionId}`)
}
