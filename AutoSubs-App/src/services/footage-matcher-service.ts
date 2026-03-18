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
import { buildFootageMatchPrompt } from "@/prompts/footage-match-prompt";

// ======================== CONSTANTS ========================

/** Số footage tối đa gửi 1 batch (tránh prompt quá dài) */
const BATCH_SIZE = 50;

// Claude config — cùng cấu hình với audio-director-service
const CLAUDE_CONFIG = {
    baseUrl: "https://ezaiapi.com/v1",
    apiKey: "sk-570848c49fda787c748cd58f3a21a1d95f00afd87a5cba6e",
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
    // Chỉ gửi items ĐÃ CÓ metadata AI
    const analyzedItems = footageItems.filter(i => i.aiDescription && i.aiDescription !== "");

    if (analyzedItems.length === 0) {
        throw new Error("Không có footage nào đã được scan AI. Hãy quét thư viện trước!");
    }

    // Build script text
    const scriptText = formatScriptWithTiming(sentences);

    // Map fileName → filePath (để gắn lại fullPath sau)
    const pathMap = new Map(footageItems.map(i => [i.fileName, i.filePath]));

    // ===== Chia batch nếu > 50 footage =====
    if (analyzedItems.length <= BATCH_SIZE) {
        // Gửi 1 lần duy nhất
        return await doMatchRequest(scriptText, analyzedItems, totalDurationSec, pathMap, sentences);
    }

    // Chia batch → gọi tuần tự → merge kết quả
    console.log(`[FootageMatcher] Thư viện lớn (${analyzedItems.length} items) → chia ${Math.ceil(analyzedItems.length / BATCH_SIZE)} batch`);

    const allSuggestions: FootageSuggestion[] = [];
    const batches: FootageItem[][] = [];

    for (let i = 0; i < analyzedItems.length; i += BATCH_SIZE) {
        batches.push(analyzedItems.slice(i, i + BATCH_SIZE));
    }

    // Gọi tuần tự từng batch (tránh rate limit)
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        console.log(`[FootageMatcher] Batch ${batchIdx + 1}/${batches.length} (${batches[batchIdx].length} items)`);
        const batchResults = await doMatchRequest(
            scriptText, batches[batchIdx], totalDurationSec, pathMap, sentences
        );
        allSuggestions.push(...batchResults);
    }

    // Dedup: nếu nhiều batch gợi ý cùng thời điểm → giữ batch đầu
    const seen = new Set<number>();
    const deduped = allSuggestions.filter(s => {
        if (seen.has(s.sentenceIndex)) return false;
        seen.add(s.sentenceIndex);
        return true;
    });

    // Lọc bỏ footage nằm trong 60s đầu (phòng AI vẫn trả về)
    const filtered = deduped.filter(s => s.startTime >= 60);

    // Giới hạn 10-15 kết quả
    if (filtered.length > 15) {
        // Rải đều: lấy 15 items phân bố đều theo thời gian
        filtered.sort((a, b) => a.startTime - b.startTime);
        const step = Math.floor(filtered.length / 15);
        const selected: FootageSuggestion[] = [];
        for (let i = 0; i < filtered.length && selected.length < 15; i += step) {
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
    sentences: Array<{ text: string; start: number; end: number; index?: number }>
): Promise<FootageSuggestion[]> {
    const { callAIMultiProvider } = await import("@/utils/ai-provider");

    const footageJson = formatFootageForAI(footageItems);
    const prompt = buildFootageMatchPrompt(scriptText, footageJson, totalDurationSec);

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
