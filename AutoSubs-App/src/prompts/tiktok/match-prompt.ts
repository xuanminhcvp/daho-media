// match-prompt.ts
// Template prompt cho AI thực hiện text-audio alignment
// Mỗi batch: 1/N transcript + PHẦN kịch bản TƯƠNG ỨNG (đánh số, có overlap)
// AI match câu script với timing Whisper trong phần transcript đó

/**
 * Tạo prompt cho AI matching
 *
 * @param allSentences - Phần câu script tương ứng với batch này (có overlap)
 * @param whisperPart - 1 PHẦN Whisper transcript
 * @param batchNum - Batch hiện tại
 * @param totalBatches - Tổng số batch
 * @param partTimeRange - Khoảng thời gian của phần transcript này
 */
export function buildMatchPrompt(
   allSentences: { num: number; text: string }[],
   whisperPart: string,
   batchNum: number,
   totalBatches: number,
   partTimeRange: string
): string {
   // Format danh sách câu script
   const sentenceList = allSentences.map((s) => `${s.num}. ${s.text}`).join("\n");
   const firstNum = allSentences[0]?.num || 0;
   const lastNum = allSentences[allSentences.length - 1]?.num || 0;

   return `Bạn là chuyên gia căn chỉnh audio-text (forced alignment). Khớp chính xác câu script với thời gian trong Whisper transcript.

=== BỐI CẢNH ===
- Kịch bản voiceover gồm ${allSentences.length} câu (#${firstNum} → #${lastNum})
- Transcript PHẦN ${batchNum}/${totalBatches} (khoảng ${partTimeRange})
- CHỈ trả kết quả cho các câu xuất hiện trong phần transcript này
- Câu nào KHÔNG thuộc phần transcript này → KHÔNG trả về

=== KHÁC BIỆT SCRIPT vs WHISPER ===
1. SỐ: Script viết CHỮ, Whisper viết SỐ
   "twenty-second" = "22", "two thousand twenty-six" = "2026"
   "fifty billion" = "$50 billion", "nineteen sixty-six" = "1966"

2. TÊN RIÊNG: Whisper phiên âm khác
   "Oseguera Cervantes" ≈ "Osiguera Servantes"
   "Jalisco" ≈ "Halisco", "Michoacán" ≈ "Michua Khan"

3. CÂU NGẮN: Script tách nhỏ, Whisper gộp
   Script: "Trucks." + "Buses." + "Cars." → Whisper: "trucks, buses, cars."

4. DẤU CÂU khác nhau → bỏ qua

=== WHISPER TRANSCRIPT (PHẦN ${batchNum}/${totalBatches}) ===
Format: [giây] từ [giây] từ ... Mỗi [X.XX] = thời điểm BẮT ĐẦU nói từ đó.

${whisperPart}

=== KỊCH BẢN (PHẦN ${batchNum}/${totalBatches}) ===
${sentenceList}

=== QUY TẮC ===
1. Thứ tự thời gian: start(N) ≤ start(N+1)
2. Match theo NGHĨA, không so text chính xác
3. end(N) ≈ start(N+1) — không chồng chéo
4. CHỈ trả câu có trong phần transcript này
5. Mỗi câu match được PHẢI có timing chính xác
6. ⚠️ RANH GIỚI CÂU: Mỗi câu script CHỈ chứa whisper words thuộc chính câu đó.
   KHÔNG bao gồm words thuộc câu trước hoặc câu sau.
   Whisper có thể thêm dấu chấm giữa câu (VD: script "A — B" → whisper "A. B")
   → Vẫn phải gộp cả "A. B" vào CÙNG 1 câu script.

=== OUTPUT ===
CHỈ plain text, mỗi dòng 1 câu, format: num:start-end
KHÔNG JSON, KHÔNG markdown, KHÔNG giải thích, KHÔNG whisper text.
Ví dụ:
1:0.15-22.34
2:22.34-37.57
3:37.57-53.89`;
}
