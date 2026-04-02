// idea-generator-service.ts
// Service tạo danh sách gợi ý nhạc nền, sfx, footage riêng biệt, 
// không phụ thuộc kịch bản, chỉ sử dụng profile hiện tại.

import { buildIdeaGeneratorPrompt } from "@/prompts/idea-generator-prompts";
import { getActiveProfileId } from "@/config/activeProfile";

import { callAIMultiProvider } from "@/utils/ai-provider";

export type MusicKeywordSuggestion = {
    mood: string;        
    description: string; 
    prompt: string;      
};

export async function generateMediaIdeas(
    mediaType: "music" | "sfx" | "footage",
    onProgress?: (msg: string) => void
): Promise<any> {
    const profileId = getActiveProfileId();

    onProgress?.(`Đang tạo 10 gợi ý ${mediaType.toUpperCase()} cho profile: ${profileId}...`);

    const prompt = buildIdeaGeneratorPrompt(mediaType, profileId);

    try {
        const timeoutMs = 90000; // 90s timeout
        let result = await callAIMultiProvider(
            prompt,
            `Idea Generator (${mediaType.toUpperCase()})`,
            "auto",
            timeoutMs
        );

        // Parse result
        let cleaned = result.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");
        const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlock) cleaned = codeBlock[1];

        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("Format JSON không hợp lệ từ AI.");

        const parsed = JSON.parse(jsonMatch[0]);

        if (mediaType === "music") {
            const prompts: MusicKeywordSuggestion[] = Array.isArray(parsed.prompts)
                ? parsed.prompts.map((item: any) => ({
                    mood: item.mood || "Unknown",
                    description: item.description || "",
                    prompt: item.prompt || "",
                }))
                : [];
            return prompts;
        } else {
            // sfx & footage return string[]
            const keywords: string[] = Array.isArray(parsed.keywords)
                ? parsed.keywords.map((kw: any) => typeof kw === "string" ? kw : kw.keyword || String(kw))
                : [];
            return keywords;
        }

    } catch (e) {
        console.error(`[IdeaGenerator] Error generating ${mediaType}:`, e);
        throw new Error(`Lỗi gọi AI sinh ý tưởng ${mediaType}: ` + String(e));
    }
}
