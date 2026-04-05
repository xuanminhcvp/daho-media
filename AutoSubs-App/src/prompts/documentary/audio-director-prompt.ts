// audio-director-prompt.ts
// Prompt cho AI Đạo Diễn: phân tích kịch bản → gợi ý nhạc nền phù hợp từng scene
// Tối ưu cho dòng 3D Investigative Documentary (25-27 phút)
// AI đọc text kịch bản + catalog nhạc → chọn bài + chọn đoạn nhạc chính xác

import type { AudioLibraryItem } from "@/types/audio-types";
import type { MatchingSentence } from "@/services/audio-director-service";

/**
 * Tạo text mô tả catalog nhạc nền để gửi cho AI
 * Format ngắn gọn, bao gồm bestFor + phase để AI chọn đúng đoạn
 */
export function buildMusicCatalogText(musicItems: AudioLibraryItem[]): string {
    const analyzed = musicItems.filter((item) => item.aiMetadata !== null);

    if (analyzed.length === 0) {
        return "(Chưa có nhạc nền nào được phân tích)";
    }

    const lines = analyzed.map((item, i) => {
        const meta = item.aiMetadata!;
        let info = `${i + 1}. "${item.fileName}" | Cảm xúc: ${meta.emotion.join(", ")} | Cường độ: ${meta.intensity} | ${meta.description}`;

        // Thêm bestFor nếu có (từ prompt scan mới)
        if (meta.bestFor && meta.bestFor.length > 0) {
            info += `\n   >> DÙNG CHO: ${meta.bestFor.join(", ")}`;
        }

        // Thêm đặc tính drop/build-up
        const features: string[] = [];
        if (meta.hasDrop) features.push("CÓ DROP");
        if (meta.hasBuildUp) features.push("CÓ BUILD-UP");
        if (features.length > 0) {
            info += ` [${features.join(", ")}]`;
        }

        // Nếu bài nhạc có timeline chi tiết, in ra cho AI biết để chọn đoạn nhạc
        if (meta.timeline && meta.timeline.length > 0) {
            const tl = meta.timeline.map((t: any) => {
                const phase = t.phase ? `(${t.phase}) ` : "";
                return `[${t.startSec}s-${t.endSec}s: ${phase}${t.emotion}]`;
            }).join(" | ");
            info += `\n   >> TIMELINE: ${tl}`;
        }
        return info;
    });

    return lines.join("\n\n");
}

/**
 * Tạo prompt cho AI Đạo Diễn phân tích kịch bản và gợi ý nhạc nền
 * Tối ưu cho 3D Investigative Documentary 25-27 phút: 12-20 scene, cảm xúc điều tra
 *
 * @param sentences - Danh sách câu từ matching.json
 * @param musicItems - Thư viện nhạc đã có metadata AI
 */
export function buildDirectorPrompt(
    sentences: MatchingSentence[],
    musicItems: AudioLibraryItem[]
): string {
    const catalogText = buildMusicCatalogText(musicItems);

    // Tạo script text — gửi TẤT CẢ câu có timing (không filter quality)
    // Vì trong Auto Media, tất cả câu đều matched có start/end
    const scriptText = sentences
        .filter((s) => s.start > 0 || s.end > 0)
        .map((s) => `[${s.start.toFixed(1)}s] ${s.text}`)
        .join("\n");

    // Ước lượng số scene dựa trên độ dài video
    const totalDuration = sentences.length > 0
        ? sentences[sentences.length - 1].end
        : 0;
    const videoDurationMin = Math.round(totalDuration / 60);
    // Documentary 25-27min: mỗi scene ~1-2 phút → 12-20 scenes
    const minScenes = Math.max(8, Math.round(videoDurationMin / 2.5));
    const maxScenes = Math.max(15, Math.round(videoDurationMin * 0.8));

    return `Bạn là một Đạo diễn Âm thanh chuyên nghiệp cho kênh YouTube 3D Investigative Documentary (${videoDurationMin} phút).

=== THỂ LOẠI: 3D INVESTIGATIVE DOCUMENTARY ===
Video documentary điều tra với hình ảnh 3D, kể lại câu chuyện có thật:
- 🔍 Điều tra / Investigative → dẫn dắt người xem vào vụ án, sự kiện
- 😰 Căng thẳng / Suspense → trước khi tiết lộ twist
- ⚡ Hành động / Action → đột kích, truy bắt, đối đầu
- 📅 Chuyển thời gian / Time Jump → nhảy giữa các mốc thời gian quan trọng
- 🎯 Tiết lộ / Revelation → tiết lộ bí mật, danh tính, sự thật
- 🌐 Bối cảnh / Context → giải thích quy mô, ảnh hưởng toàn cầu
- 💀 Đe dọa / Threatening → nguy hiểm, áp lực, đe dọa tính mạng
- 🏛️ Pháp lý / Legal → phiên tòa, kết án, bản án
- 🔄 Twist / Plot Reversal → lật ngược tình thế, bất ngờ
- 🌅 Trầm lắng / Reflective → hậu quả, suy ngẫm, kết thúc

=== KỊCH BẢN VIDEO (với timecode) ===
${scriptText}

=== CATALOG NHẠC NỀN CÓ SẴN ===
${catalogText}

=== NHIỆM VỤ ===
1. Đọc kịch bản, phân tích sự thay đổi cảm xúc theo từng khoảnh khắc.

2. Chia video thành ${minScenes} đến ${maxScenes} Scene (sceneId: 1, 2, 3...).
   ⚠️ TUYỆT ĐỐI KHÔNG giữ một bài nhạc quá 3 phút!
   - Mỗi scene = 1-3 phút (tối ưu 1.5-2 phút)
   - Khi cảm xúc thay đổi đột ngột → BẮT BUỘC tách scene mới
   - Khi có plot twist → tạo scene riêng (có thể chỉ 30s)

3. ⚠️ BẮT BUỘC gán nhạc cho MỌI scene! Không được để scene nào > 30 giây mà không có nhạc.
   - Chọn bài phù hợp NHẤT từ Catalog (ghi rõ tên file)
   - Ưu tiên bài có "bestFor" khớp với tình huống cảnh
   - Nếu cảnh cần build-up → chọn bài có "hasBuildUp: true"
   - Nếu cảnh có plot twist → chọn bài có "hasDrop: true"
   - Nếu không có bài hoàn hảo → vẫn chọn bài GẦN NHẤT (best effort), KHÔNG được để "null"
   - CHỈ được để "null" khi CỐ TÌNH im lặng ≤ 30 giây vì mục đích nghệ thuật (VD: sau plot twist, cần vài giây im lặng tạo sốc)

4. VỊ TRÍ NHẠC (assignedMusicStartTime):
   Các bản nhạc có TIMELINE (phase: intro, build-up, climax, drop...).
   Chọn đoạn nhạc sao cho PHASE của nhạc khớp với MẠCH CẢM XÚC của scene.
   Ví dụ:
   - Scene "căng thẳng leo thang" → lấy nhạc từ phase "build-up"
   - Scene "bùng nổ" → lấy nhạc từ phase "climax"
   - Scene "sau twist, im lặng" → lấy nhạc từ phase "drop"

5. KỸ THUẬT CHUYỂN NHẠC (transition):
   - "cut" = cắt đột ngột (tạo sốc, plot twist)
   - "crossfade" = fade chéo mượt (chuyển cảm xúc dần)
   - "fade-out" = nhạc cũ tắt dần trước khi nhạc mới vào

6. sentenceNums: danh sách số câu thuộc scene này.

7. 🎵 COHERENCE NHẠC (RẤT QUAN TRỌNG):
   Toàn bộ video phải có SỰ THỐNG NHẤT ÂM NHẠC — giống soundtrack phim chuyên nghiệp:
   - Ưu tiên chọn nhạc cùng "gia đình nhạc cụ" (VD: nếu scene đầu chọn piano → các scene sau cũng ưu tiên piano/strings, không nhảy sang EDM)
   - Tối đa 2-3 họ phong cách trên toàn video (VD: Piano family + Orchestral family)
   - TRÁNH chuyển đột ngột giữa thể loại khác hẳn (acoustic → electronic, chill → hardcore)
   - Trong crossfade, 2 bản nhạc liên tiếp PHẢI cùng phong cách hoặc ít nhất cùng tempo
   - Có thể lặp lại cùng 1 bài nhạc (ở đoạn khác) nếu phù hợp — phim hay luôn dùng lại theme

Trả về JSON (KHÔNG markdown, KHÔNG giải thích ngoài JSON):
{
  "scenes": [
    {
      "sceneId": 1,
      "startTime": 0.0,
      "endTime": 90.0,
      "emotion": "Căng thẳng, rình rập",
      "emotionReason": "Mô tả ngắn vì sao cảm xúc đó",
      "assignedMusicFileName": "dark_tension.mp3",
      "assignedMusicStartTime": 25.5,
      "transition": "crossfade",
      "sentenceNums": [1,2,3,4,5]
    }
  ]
}`;
}

// ======================== BATCH PROMPT ========================

/**
 * Prompt cho AI Đạo Diễn — phiên bản BATCH
 * Documentary 25-27min → mặc định gửi 1 batch duy nhất (toàn bộ video)
 * Giữ lại batch logic để tương thích nếu cần chia nhỏ sau này
 *
 * @param sentences - Câu trong batch này
 * @param musicItems - TẤT CẢ thư viện nhạc (để AI coherence)
 * @param batchNum - Số thứ tự batch (mặc định 1)
 * @param totalBatches - Tổng số batch
 * @param batchTimeStart - Thời gian bắt đầu batch (giây)
 * @param batchTimeEnd - Thời gian kết thúc batch (giây)
 * @param totalDuration - Tổng độ dài video (giây)
 * @param previousScenes - Scenes từ batch trước (để AI biết nhạc nào đã dùng, giữ coherence)
 */
export function buildDirectorBatchPrompt(
    sentences: MatchingSentence[],
    musicItems: AudioLibraryItem[],
    batchNum: number,
    totalBatches: number,
    batchTimeStart: number,
    batchTimeEnd: number,
    totalDuration: number,
    previousScenes?: Array<{ sceneId: number; emotion: string; assignedMusicFileName: string | null }>
): string {
    const catalogText = buildMusicCatalogText(musicItems);

    // Script text chỉ cho batch này
    const scriptText = sentences
        .filter((s) => s.start > 0 || s.end > 0)
        .map((s) => `[${s.start.toFixed(1)}s] Câu ${s.num}: ${s.text}`)
        .join("\n");

    const videoDurationMin = Math.round(totalDuration / 60);
    const batchDurationMin = Math.round((batchTimeEnd - batchTimeStart) / 60);

    // Documentary 25-27min: 12-20 scene cho toàn video
    // Nếu 1 batch = toàn video → 12-20 scene
    // Nếu chia nhỏ → tính tỷ lệ
    const minScenes = Math.max(8, Math.round(batchDurationMin / 2.5));
    const maxScenes = Math.max(12, Math.round(batchDurationMin * 0.8));

    // Tóm tắt nhạc đã dùng ở batch trước (coherence)
    let previousContext = '';
    if (previousScenes && previousScenes.length > 0) {
        const last5 = previousScenes.slice(-5);
        previousContext = `\n=== NHẠC ĐÃ DÙNG Ở CÁC BATCH TRƯỚC (để giữ coherence) ===
${last5.map(s => `Scene ${s.sceneId}: ${s.emotion} → "${s.assignedMusicFileName || 'null'}"`).join('\n')}
⚠️ Ưu tiên giữ phong cách nhạc THỐNG NHẤT với các batch trước! Tránh chuyển đột ngột sang thể loại khác.
`;
    }

    return `Bạn là Đạo diễn Âm thanh cho 3D Investigative Documentary (${videoDurationMin} phút).
Đây là BATCH ${batchNum}/${totalBatches} (${batchTimeStart.toFixed(0)}s → ${batchTimeEnd.toFixed(0)}s, ~${batchDurationMin} phút).
${previousContext}
=== KỊCH BẢN BATCH ${batchNum} (${batchTimeStart.toFixed(0)}s - ${batchTimeEnd.toFixed(0)}s) ===
${scriptText}

=== CATALOG NHẠC NỀN ===
${catalogText}

=== NHIỆM VỤ ===
1. Phân tích cảm xúc đoạn script trên, chia thành ${minScenes}-${maxScenes} Scene.
   - sceneId BẮT ĐẦU từ ${(previousScenes?.length || 0) + 1} (tiếp nối batch trước)
   - Mỗi scene = 1-3 phút, KHÔNG giữ 1 bài quá 3 phút
   - startTime/endTime = trong khoảng ${batchTimeStart.toFixed(0)}s - ${batchTimeEnd.toFixed(0)}s

2. BẮT BUỘC gán nhạc cho MỌI scene! Không được để scene nào > 30s mà không có nhạc.
   - Chọn bài phù hợp NHẤT từ Catalog (ghi rõ tên file)
   - Nếu không có bài hoàn hảo → chọn bài GẦN NHẤT, KHÔNG được để "null"
   - CHỈ null khi cố tình im lặng ≤ 30s

3. Giữ COHERENCE nhạc: ưu tiên cùng phong cách/nhạc cụ với batch trước.

4. Chọn assignedMusicStartTime phù hợp phase nhạc (intro/build-up/climax/drop).

5. transition: "cut" | "crossfade" | "fade-out"

Trả về JSON (KHÔNG markdown, KHÔNG giải thích):
{
  "scenes": [
    {
      "sceneId": ${(previousScenes?.length || 0) + 1},
      "startTime": ${batchTimeStart.toFixed(1)},
      "endTime": ${(batchTimeStart + 90).toFixed(1)},
      "emotion": "...",
      "emotionReason": "...",
      "assignedMusicFileName": "file.mp3",
      "assignedMusicStartTime": 0.0,
      "transition": "crossfade",
      "sentenceNums": [...]
    }
  ]
}`;
}
