// sfx-director-prompt.ts
// Prompt cho AI Sound Designer: phân tích kịch bản 3D Documentary → gợi ý điểm chèn SFX
// ĐÃ nâng cấp: gửi kèm THƯ VIỆN SFX (metadata) + WHISPER WORDS (timing từng từ)
// → AI chọn trực tiếp file SFX từ thư viện + gợi ý đoạn cắt (trim)
// → Chia 5 batch song song để xử lý nhanh

import type { MatchingSentence } from "@/services/audio-director-service";
import type { AudioLibraryItem } from "@/types/audio-types";

// ======================== TYPES ========================

/** 1 word từ whisper (word-level timestamp) */
export interface WhisperWordCompact {
    /** Giây bắt đầu */
    t: number;
    /** Nội dung từ */
    w: string;
    /** Giây kết thúc */
    e: number;
}

// ======================== BUILD SFX LIBRARY TEXT ========================

/**
 * Chuyển danh sách SFX items thành text mô tả cho prompt
 * Gửi TOÀN BỘ metadata: emotion, tags, description, timeline, beats, trimSuggestions...
 * Để AI có đầy đủ thông tin chọn file SFX phù hợp nhất
 *
 * @param sfxItems - Danh sách SFX đã phân tích bởi Gemini
 * @returns Text mô tả thư viện SFX
 */
function buildSfxLibraryText(sfxItems: AudioLibraryItem[]): string {
    // Chỉ lấy item đã có AI metadata (bỏ qua item chưa scan hoặc lỗi)
    const validItems = sfxItems.filter(
        (item) => item.aiMetadata && !item.aiMetadata.emotion.includes("Lỗi")
    );

    if (validItems.length === 0) {
        return "(Thư viện SFX trống hoặc chưa scan AI)";
    }

    return validItems
        .map((item, idx) => {
            const m = item.aiMetadata!;
            let text = `--- SFX #${idx + 1}: "${item.fileName}" ---\n`;
            text += `Cảm xúc: ${m.emotion.join(", ")}\n`;
            text += `Cường độ: ${m.intensity}\n`;
            text += `Mô tả: ${m.description}\n`;
            text += `Tags: ${m.tags.join(", ")}\n`;

            // bestFor — tình huống phù hợp
            if (m.bestFor && m.bestFor.length > 0) {
                text += `Phù hợp cho: ${m.bestFor.join("; ")}\n`;
            }

            // Thông tin kỹ thuật
            text += `Tổng độ dài: ${m.totalDurationSec ?? "?"}s`;
            if (m.hasBuildUp) text += ` | Có build-up`;
            if (m.hasDrop) text += ` | Có drop`;
            text += `\n`;

            // Timeline — diễn biến cảm xúc theo thời gian
            if (m.timeline && m.timeline.length > 0) {
                text += `Timeline:\n`;
                m.timeline.forEach((seg) => {
                    // phase tồn tại trong data AI trả về nhưng không có trong type chính thức
                    text += `  [${seg.startSec}s-${seg.endSec}s] ${(seg as any).phase || ""} — ${seg.emotion}: ${seg.description}\n`;
                });
            }

            // Beats — nhịp quan trọng
            if (m.beats && m.beats.length > 0) {
                text += `Beats: ${m.beats.map((b) => `[${b.timeSec}s] ${b.type}: ${b.description}`).join(" | ")}\n`;
            }

            // Trim suggestions — gợi ý đoạn cắt
            if (m.trimSuggestions && m.trimSuggestions.length > 0) {
                text += `Trim gợi ý:\n`;
                m.trimSuggestions.forEach((ts) => {
                    text += `  "${ts.label}" (${ts.startSec}s-${ts.endSec}s): ${ts.reason}\n`;
                });
            }

            return text;
        })
        .join("\n");
}

// ======================== BUILD WHISPER WORDS TEXT ========================

/**
 * Chuyển whisper words thành text compact cho prompt
 * Format: [0.13-0.77] February | [0.77-1.01] twenty | ...
 *
 * @param words - Mảng whisper words (đã filter theo time range)
 * @returns Text compact whisper words
 */
function buildWhisperWordsText(words: WhisperWordCompact[]): string {
    if (words.length === 0) return "(Không có whisper words)";

    // Format gọn: mỗi dòng ~10 words
    const lines: string[] = [];
    let currentLine: string[] = [];

    for (const w of words) {
        currentLine.push(`[${w.t.toFixed(2)}] ${w.w}`);
        if (currentLine.length >= 10) {
            lines.push(currentLine.join(" "));
            currentLine = [];
        }
    }
    if (currentLine.length > 0) {
        lines.push(currentLine.join(" "));
    }

    return lines.join("\n");
}

// ======================== PROMPT CHÍNH (BATCH) ========================

/**
 * Tạo prompt cho AI SFX Planner — PHIÊN BẢN BATCH
 * Mỗi batch nhận:
 *   - 1 phần kịch bản (sentences)
 *   - 1 phần whisper words (cùng time range)
 *   - TOÀN BỘ thư viện SFX (metadata)
 *
 * AI sẽ:
 *   1. Phân tích phần kịch bản → tìm điểm chèn SFX
 *   2. Chọn file SFX phù hợp nhất từ thư viện
 *   3. Gợi ý trim (cắt) SFX nếu cần
 *   4. Dùng whisper words để xác định chính xác thời điểm triggerWord
 *
 * @param sentences - Phần kịch bản cho batch này
 * @param sfxItems - TOÀN BỘ thư viện SFX (giống nhau cho mọi batch)
 * @param whisperWords - Phần whisper words cho batch này
 * @param batchNum - Số batch hiện tại (1-5)
 * @param totalBatches - Tổng số batch (5)
 * @param totalDuration - Tổng thời lượng video (giây)
 * @param maxCuesPerBatch - Số SFX tối đa cho batch này
 */
export function buildSfxBatchPrompt(
    sentences: MatchingSentence[],
    sfxItems: AudioLibraryItem[],
    whisperWords: WhisperWordCompact[],
    batchNum: number,
    totalBatches: number,
    totalDuration: number,
    maxCuesPerBatch: number
): string {
    // Tạo text kịch bản — gửi tất cả câu có timing (không filter quality)
    const scriptText = sentences
        .filter((s) => s.start > 0 || s.end > 0)
        .map((s) => `[Câu ${s.num}: ${s.start.toFixed(1)}s] ${s.text}`)
        .join("\n");

    // Tạo text thư viện SFX — gửi TOÀN BỘ metadata
    const sfxLibraryText = buildSfxLibraryText(sfxItems);

    // Tạo text whisper words — phần tương ứng batch này
    const whisperText = buildWhisperWordsText(whisperWords);

    const totalMinutes = Math.round(totalDuration / 60);

    return `Bạn là một Sound Designer chuyên nghiệp đang làm âm thanh cho kênh YouTube dạng 3D Investigative Documentary.

=== THỂ LOẠI NỘI DUNG ===
Video này là dạng 3D Documentary điều tra — narrator kể lại câu chuyện có thật với hình ảnh 3D.
Video dài khoảng ${totalMinutes} phút (~${Math.round(totalDuration)}s).
Bạn đang xử lý PHẦN ${batchNum}/${totalBatches} của video.

=== MỤC TIÊU ===
Video hiện tại CHỈ CÓ giọng kể chuyện (voice narration) và nhạc nền (BGM). Chưa có bất kỳ SFX nào.
Nhiệm vụ: thêm SFX cho PHẦN ${batchNum} của video.

🎬 LOẠI 1: "Cinema Sound Effects" — hiệu ứng cinema tạo nhịp điệm kể chuyện:
   - TẠO NHỊP ĐIỆM kể chuyện (pacing rhythm)
   - ĐÁNH DẤU các plot twist / revelation
   - BUILD TENSION trước những khoảnh khắc quan trọng
   - NHẤN MẠNH emotional climax

🔊 LOẠI 2: "SFX bối cảnh chọn lọc" — CHỈ ở những moment thật sự biểu tượng:
   - Tiếng kính vỡ khi nhận tin dữ, tiếng nổ, lửa cháy...
   - KHÔNG spam — chỉ chọn 0-1 moment bối cảnh đắt giá nhất trong phần này

=== CÁC LOẠI SFX (CATEGORIES) ===

📌 "impact" — Đánh dấu thông tin sốc, plot twist, revelation
📌 "tension" — Tăng hồi hộp, căng thẳng trước climax
📌 "sub_drop" — Cắt đứt, khoảng lặng đe dọa
📌 "transition" — Chuyển cảnh, nhảy thời gian
📌 "emotional" — Cao trào cảm xúc, moment đẹp
📌 "reveal" — Tiết lộ danh tính, bí mật, twist
📌 "ambient" — SFX bối cảnh biểu tượng (DÙNG RẤT ÍT)
📌 "foley" — Tiếng động nhỏ tạo immersive (DÙNG RẤT ÍT)

=== THƯ VIỆN SFX CỦA BẠN (${sfxItems.filter(i => i.aiMetadata && !i.aiMetadata.emotion.includes("Lỗi")).length} file) ===
Bạn PHẢI chọn file SFX từ thư viện bên dưới. KHÔNG được bịa tên file.
Đọc kỹ mô tả, emotion, tags, bestFor, timeline, và trimSuggestions để chọn file phù hợp nhất.

${sfxLibraryText}

=== KỊCH BẢN VIDEO (PHẦN ${batchNum}/${totalBatches}) ===
${scriptText}

=== WHISPER WORDS — TIMING CHÍNH XÁC TỪNG TỪ (PHẦN ${batchNum}/${totalBatches}) ===
Dùng dữ liệu bên dưới để tìm CHÍNH XÁC thời điểm triggerWord được narrator nói ra.
Format: [giây_bắt_đầu] từ
Ưu tiên lấy thời điểm BẮT ĐẦU của triggerWord từ whisper words (không cần ước lượng timeOffset).

${whisperText}

=== NHIỆM VỤ CHI TIẾT ===
1. Đọc kịch bản phần ${batchNum}. Tìm ĐÚNG những khoảnh khắc "đắt giá" để chèn SFX cinema.
   ⚠️ KHÔNG spam SFX. Chỉ chọn ${maxCuesPerBatch} SFX cho phần này (tối đa).
2. Với mỗi SFX cue:
   a) Chọn file SFX phù hợp nhất từ THƯ VIỆN (dựa trên emotion, tags, bestFor, intensity)
   b) Dùng WHISPER WORDS để tìm chính xác giây bắt đầu (exactStartTime) của triggerWord
   c) Nếu file SFX quá dài cho moment đó → chọn đoạn trim phù hợp từ trimSuggestions
3. triggerWord phải là CỤM TỪ CHÍNH XÁC xuất hiện trong câu kịch bản.

Trả về ĐÚNG chuẩn JSON sau, KHÔNG giải thích gì thêm, KHÔNG dùng markdown:
{
  "cues": [
    {
      "sentenceNum": 277,
      "triggerWord": "killed your parents",
      "exactStartTime": 2181.5,
      "sfxCategory": "impact",
      "assignedSfxFileName": "Impact-Dramatic_Deep-Dramatic-Impact-With-Long-Tail-Hard_SDT3-0546.wav",
      "trimStartSec": 0,
      "trimEndSec": 2.5
    }
  ]
}

CHÚ Ý:
- assignedSfxFileName PHẢI LÀ tên file chính xác từ thư viện (copy/paste y hệt, KHÔNG đổi tên)
- exactStartTime lấy từ whisper words (giây chính xác triggerWord được nói ra)
- trimStartSec/trimEndSec: đoạn cắt SFX (lấy từ trimSuggestions hoặc tự chọn phù hợp)
- Nếu file SFX ngắn (< 3s) và dùng trọn → trimStartSec = 0, trimEndSec = totalDurationSec
- KHÔNG trùng file SFX trong cùng 1 batch (mỗi cue chọn file KHÁC NHAU nếu có thể)`;
}

// ======================== LEGACY PROMPT (GIỮ LẠI CHO BACKWARD COMPAT) ========================

/**
 * Prompt cũ (không có SFX library + whisper words)
 * Giữ lại trong trường hợp user chưa có thư viện SFX hoặc whisper words
 *
 * @param sentences - Danh sách câu có timing từ matching.json
 */
export function buildSfxDirectorPrompt(sentences: MatchingSentence[]): string {
    // Gửi tất cả câu có timing (không filter quality)
    const scriptText = sentences
        .filter((s) => s.start > 0 || s.end > 0)
        .map((s) => `[Câu ${s.num}: ${s.start.toFixed(1)}s] ${s.text}`)
        .join("\n");

    const totalDuration = sentences.length > 0
        ? Math.max(...sentences.map(s => s.end))
        : 0;
    const totalMinutes = Math.round(totalDuration / 60);

    return `Bạn là một Sound Designer chuyên nghiệp đang làm âm thanh cho kênh YouTube dạng 3D Investigative Documentary.

=== THỂ LOẠI NỘI DUNG ===
Video này là dạng 3D Documentary điều tra — narrator kể lại câu chuyện có thật với hình ảnh 3D.
Giọng kể chuyện liên tục, có build-up dần, có plot twist, có cao trào kịch tính.
Video dài khoảng ${totalMinutes} phút (~${Math.round(totalDuration)}s).

=== MỤC TIÊU QUAN TRỌNG NHẤT ===
Video hiện tại CHỈ CÓ giọng kể chuyện (voice narration) và nhạc nền (BGM). Chưa có bất kỳ SFX nào.
Nhiệm vụ là thêm 2 loại SFX:

🎬 LOẠI 1: "Cinema Sound Effects" — hiệu ứng cinema tạo nhịp điệm kể chuyện
🔊 LOẠI 2: "SFX bối cảnh chọn lọc" — CHỈ ở những moment thật sự biểu tượng

=== CÁC LOẠI SFX (CATEGORIES) ===
📌 "impact" | "tension" | "sub_drop" | "transition" | "emotional" | "reveal" | "ambient" | "foley"

=== KỊCH BẢN VIDEO (có đánh số câu & timecode) ===
${scriptText}

=== NHIỆM VỤ CHI TIẾT ===
1. Đọc TOÀN BỘ kịch bản. Hiểu cấu trúc drama: setup → build → twist → climax → resolution.
2. Tìm ĐÚNG những khoảnh khắc "đắt giá" để chèn SFX cinema. 
   ⚠️ KHÔNG spam SFX. Chỉ chọn những moment thực sự bước ngoặt.
3. GIỚI HẠN: Tối đa 12 SFX cho video 25-27 phút. Tần suất lý tưởng ~1 SFX mỗi 2-3 phút.
4. triggerWord phải là CỤM TỪ CHÍNH XÁC xuất hiện trong câu.
5. timeOffset: ước lượng giây từ đầu câu đến lúc triggerWord được nói ra.

Trả về ĐÚNG chuẩn JSON sau, KHÔNG giải thích gì thêm, KHÔNG dùng markdown:
{
  "cues": [
    {
      "sentenceNum": 16,
      "triggerWord": "killed your parents",
      "timeOffset": 1.2,
      "sfxCategory": "impact"
    }
  ]
}`;
}
