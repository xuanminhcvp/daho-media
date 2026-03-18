// music-retry-prompt.ts
// Prompt retry khi AI Đạo Diễn trả về scene trống (không có nhạc > 30s)
// Gửi lại CHỈ các scene bị trống + catalog → yêu cầu AI chọn nhạc

import type { AudioLibraryItem } from "@/types/audio-types";
import type { AudioScene } from "@/types/audio-types";
import { buildMusicCatalogText } from "@/prompts/audio-director-prompt";

/**
 * Tạo prompt retry cho các scene bị trống nhạc (null hoặc gap > 30s)
 * AI sẽ nhận danh sách scene cụ thể cần gán nhạc + catalog
 *
 * @param gapScenes - Danh sách scene bị trống nhạc
 * @param musicItems - Catalog nhạc nền
 * @param retryNumber - Lần retry (1 hoặc 2)
 */
export function buildMusicRetryPrompt(
    gapScenes: AudioScene[],
    musicItems: AudioLibraryItem[],
    retryNumber: number
): string {
    const catalogText = buildMusicCatalogText(musicItems);

    // Mô tả các scene bị trống
    const gapList = gapScenes.map((s) => {
        const duration = (s.endTime - s.startTime).toFixed(0);
        return `- Scene ${s.sceneId} (${s.startTime.toFixed(1)}s → ${s.endTime.toFixed(1)}s, ${duration}s): "${s.emotion}" — ${s.emotionReason || "không rõ lý do"}`;
    }).join("\n");

    const urgency = retryNumber === 2
        ? "⚠️ ĐÂY LÀ LẦN RETRY CUỐI CÙNG. Nếu bạn vẫn không chọn được, hệ thống sẽ tự lấp bằng nhạc của scene liền kề. Hãy CỐ GẮNG TỐI ĐA chọn bài gần nhất."
        : "Lần trước bạn chưa chọn được nhạc cho các scene này. Hãy xem lại catalog kỹ hơn và chọn bài GẦN ĐÚNG NHẤT.";

    return `Bạn là AI Đạo Diễn Âm thanh. Lần phân tích trước, bạn đã BỎ TRỐNG nhạc cho ${gapScenes.length} scene dưới đây.

${urgency}

=== CÁC SCENE CẦN GÁN NHẠC (bắt buộc) ===
${gapList}

=== CATALOG NHẠC NỀN CÓ SẴN ===
${catalogText}

=== QUY TẮC ===
1. BẮT BUỘC chọn nhạc cho MỌI scene trong danh sách trên
2. Nếu không có bài hoàn hảo → chọn bài CÓ CẢM XÚC GẦN NHẤT
3. Chỉ dùng "null" nếu scene ≤ 30 giây VÀ cố tình im lặng vì nghệ thuật
4. Trả về field "assignedMusicStartTime" = vị trí bắt đầu lấy nhạc trong bài
5. 🎵 COHERENCE: Ưu tiên chọn nhạc cùng phong cách/nhạc cụ với scene liền kề (trước/sau). Tránh chọn thể loại quá khác biệt nếu có lựa chọn tương đương.

Trả về JSON (KHÔNG markdown, KHÔNG giải thích ngoài JSON):
{
  "scenes": [
    {
      "sceneId": 5,
      "assignedMusicFileName": "dark_tension.mp3",
      "assignedMusicStartTime": 15.0,
      "assignedMusicReason": "Chọn bài này vì cảm xúc gần nhất với scene căng thẳng"
    }
  ]
}`;
}
