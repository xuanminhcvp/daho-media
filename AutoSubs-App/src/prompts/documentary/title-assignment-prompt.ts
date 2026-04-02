// title-assignment-prompt.ts
// Prompt cho AI phân tích Whisper Words → xác định Text On Screen (Title Cards)
// V4: Vàng là màu chủ đạo, hạn chế xanh, 10 Fusion Compositions + giới hạn từ + text khớp 100% voice

// Import từ types tập trung (KHÔNG import từ service để tránh circular dependency)
import type { TextTemplate } from "@/types/title-types"

/**
 * Tạo prompt phân tích Whisper Words để tìm Text On Screen (Title) cues
 * AI sẽ chọn từ 10 template theo cảm xúc + ngữ cảnh của từng câu
 * V3: Thêm giới hạn từ + text phải khớp 100% lời narrator
 *
 * @param wordsText - Nội dung whisper words (format: "[0.13] February [0.77] twenty ...")
 * @param templates - Danh sách template đang bật
 * @param scriptText - Kịch bản gốc (optional) — dùng để AI so khớp text chính xác
 */
export function buildTitleFromWhisperPrompt(
  wordsText: string,
  templates: TextTemplate[],
  scriptText?: string
): string {
  // Mô tả các template đang bật cho AI
  const templateDescriptions = templates
    .filter(t => t.enabled)
    .map((t, i) =>
      `${i + 1}. ID: "${t.id}" — ${t.displayName}\n   Mô tả: ${t.description}\n   Quy tắc: ${t.usageRule}`
    )
    .join("\n\n")

  // Phần kịch bản gốc (nếu có)
  const scriptSection = scriptText
    ? `\n=== KỊCH BẢN GỐC (dùng để so khớp text chính xác) ===\n${scriptText}\n`
    : ""

  return `Bạn là Senior Video Editor chuyên sản xuất phim Tài liệu 3D YouTube (Investigative Documentary Style).

NHIỆM VỤ: Phân tích Whisper transcript (word-by-word timestamps) → xác định các cụm từ cần TEXT ON SCREEN.

=== FORMAT TRANSCRIPT ===
Mỗi word có timestamp trước: [giây] từ
Ví dụ: [34.20] February [34.50] twenty [34.80] second [35.10] 2026

=== QUAN TRỌNG: ĐÂY KHÔNG PHẢI SUBTITLE ===
Text On Screen xuất hiện ~20-25% thời lượng video.
PHẦN LỚN câu kể chuyện bình thường → KHÔNG cần Text On Screen.
Chỉ những câu CÓ GIÁ TRỊ THÔNG TIN CAO HOẶC CẢM XÚC MẠNH mới cần.

=== HỆ THỐNG TEMPLATE ===

Bạn có 10 template, phân theo 3 tiêu chí:

🎨 MÀU SẮC (chọn theo cảm xúc):
- VÀNG (gold): ⭐ MÀU CHỦ ĐẠO — trang trọng, ấn tượng, thông tin quan trọng, facts, quotes, nhân vật (chiếm 60-70% title cards)
- XANH (blue/teal): ⚠️ HẠN CHẾ — CHỈ dùng cho location, document pháp lý, thời gian cụ thể (tối đa 15-20% title cards)
- ĐỎ (red): Nguy hiểm, bạo lực, cảnh báo, chết chóc (10-15% title cards)

📐 KÍCH THƯỚC (chọn theo tầm quan trọng):
- TO (large): Full screen, impact lớn, câu quan trọng nhất — location/thời gian cũng dùng TO
- NHỎ (small): Lower-third, thông tin phụ, document dài, quote dài

🎬 HOẠT ẢNH (chọn theo cường độ cảm xúc):
- XUẤT HIỆN (fade-in): Nhẹ nhàng, trang trọng, kéo dài
- ĐẬP XUỐNG (slam): Mạnh mẽ, bất ngờ, impact
- ĐÁNH MÁY (typewriter): Tài liệu, hồ sơ, thông tin chính thức

=== ⚠️ GIỚI HẠN SỐ TỪ — BẮT BUỘC TUÂN THỦ ===

🔴 TEMPLATE "TO" (large): TỐI ĐA 4 TỪ — KHÔNG CÓ NGOẠI LỆ (kể cả location/thời gian)
   - 2-3 từ/dòng, tối đa 2 dòng, ≤4 từ tổng
   - Nếu location/thời gian dài hơn 4 từ → TÁCH thành 2 clips TO liên tiếp:
     * Clip 1: địa điểm (vd: "RURAL JALISCO") — ≤4 từ
     * Clip 2: thời gian (vd: "FEBRUARY 22, 2026") — ≤4 từ, start ngay sau clip 1
   - Ví dụ đúng: "$50 BILLION", "9 DEAD", "PART II", "RURAL JALISCO", "FEBRUARY 2026"
   - Ví dụ SAI (quá dài): "Rural Jalisco — February 22, 2026" → TÁCH thành 2 clips

🔵 TEMPLATE "NHỎ" (small): TỐI ĐA 15 TỪ cho 1 clip
   - Dòng 1: tối đa 10 từ
   - Dòng 2: tối đa 5 từ thêm
   - Nếu nội dung >15 từ → TÁCH thành 2 clips liên tiếp (cùng template, chia đều duration)

🚫 KHÔNG BAO GIỜ để text tràn khỏi màn hình. Ngắn gọn = tốt hơn dài.

=== ⚠️ TEXT PHẢI KHỚP 100% VOICE — KHÔNG ĐƯỢC CHẾ CHÁO ===

displayText PHẢI là đúng lời narrator nói trong audio/kịch bản.
- KHÔNG được tóm tắt, paraphrase, hoặc chế lại nội dung
- Lấy chính xác từ ngữ narrator nói (viết hoa toàn bộ nếu là title)
- Nếu có kịch bản gốc → so khớp để lấy text chính xác
- Chỉ được rút gọn KHI dùng template TO (≤4 từ): lấy keyword chính

=== DANH SÁCH TEMPLATE ĐANG BẬT ===
${templateDescriptions}
${scriptSection}
=== WHISPER WORDS TRANSCRIPT ===
${wordsText}

=== CÁCH LẤY TIMING ===
- start = timestamp của TỪ ĐẦU TIÊN trong cụm
- end = timestamp TỪ CUỐI CÙNG + 0.5 giây (để text hiện đủ lâu)
Ví dụ: "[34.20] February [34.50] twenty [34.80] second [35.10] 2026"
  → start = 34.20 (timestamp "February")
  → end = 35.10 + 0.5 = 35.60

=== QUY TẮC CHỌN TEMPLATE ===

⭐ VÀNG LÀ MÀU MẶC ĐỊNH — Khi phân vân giữa vàng và xanh → LUÔN CHỌN VÀNG.
⚠️ XANH chỉ được dùng khi nội dung là: địa danh cụ thể (location), tài liệu pháp lý, hoặc thời gian/ngày tháng năm. KHÔNG dùng xanh cho chapter/scene.

1. MAIN TITLE (đầu video): vàng to xuất hiện — CHỈ 1 LẦN, ≤4 từ
2. CHAPTER / SCENE / PHẦN: ⚠️ Dùng VÀNG to xuất hiện/đập xuống — ≤4 từ ("PART II", "THE GHOST") — KHÔNG dùng xanh cho chapter
3. LOCATION / THỜI GIAN rõ ràng: ⭐ Dùng TO (large) xuất hiện — TỐI ĐA 4 TỪ/clip, KHÔNG NGOẠI LỆ
   - Màu ưu tiên: VÀNG to xuất hiện (nếu location mang tính trang trọng/giới thiệu)
   - Màu thay thế: XANH to xuất hiện (nếu location thuần thông tin/trung tính) — hạn chế dùng
   - Nếu dài hơn 4 từ → TÁCH 2 clips liên tiếp (địa điểm / thời gian riêng biệt):
     * Clip 1: "RURAL JALISCO" (≤4 từ)
     * Clip 2: "FEBRUARY 22, 2026" (≤4 từ, ngay sau clip 1)
4. DOCUMENT / PHÁP LÝ rõ ràng: Xanh nhỏ đánh máy — ≤15 từ (bản án, hồ sơ, tài liệu chính thức)
5. ID CARD / NHÂN VẬT: Vàng nhỏ đánh máy — ≤15 từ
6. FACT / STAT (vừa): Vàng nhỏ xuất hiện — ≤15 từ
7. FACT / STAT (gây sốc, ngắn): Vàng to đập xuống — ≤4 từ ("$50 BILLION", "1,000 KILLED")
8. QUOTE / MOTIF / THÔNG TIN KỲ: Vàng nhỏ xuất hiện — ≤15 từ
9. DEATH (nặng nề, chậm): Đỏ to xuất hiện — ≤4 từ
10. DEATH (bất ngờ, sốc): Đỏ to đập xuống — ≤4 từ ("9 DEAD", "DIRECT HIT")

🚦 KIỂM TRA TỶ LỆ MÀU trước khi trả về:
   - Vàng: ≥60% tổng title cards ✅
   - Xanh: ≤20% tổng title cards ✅ (nếu vượt → chuyển sang vàng nhỏ)
   - Đỏ: ≤20% tổng title cards ✅

=== CÁCH XỬ LÝ NỘI DUNG DÀI ===
- Nếu câu narrator nói dài (>4 từ) mà cần nhấn mạnh → dùng template NHỎ
- Nếu muốn dùng template TO → chỉ lấy 2-4 keyword chính
- Nếu nội dung >15 từ → TÁCH thành 2 clips liên tiếp:
  * Clip 1: nửa đầu text, start = start gốc, end = giữa duration
  * Clip 2: nửa sau text, start = giữa duration, end = end gốc

=== QUY TẮC VIẾT HOA / VIẾT THƯỜNG (BẮT BUỘC) ===

🔠 TEMPLATE "TO" (large): VIẾT HOA TOÀN BỘ
   - Ví dụ: "$50 BILLION", "PART III", "9 DEAD", "HE WAS HUMAN", "DIRECT HIT"

🔡 TEMPLATE "NHỎ" (small): Viết thường, chỉ viết hoa:
   - Chữ cái đầu tiên của câu
   - Tên riêng (El Mencho, Nemesio Oseguera Cervantes)
   - Địa danh (Guadalajara, San Francisco, Mexico City)
   - Tên tổ chức (CJNG, FBI, DEA)
   - Viết tắt (U.S., RPG-7)
   - Ví dụ đúng: "Convicted — conspiracy to distribute heroin, U.S. District Court, 1994"
   - Ví dụ đúng: "Guadalajara, Mexico — July 17, 1966"
   - Ví dụ SAI: "CONVICTED — CONSPIRACY TO DISTRIBUTE HEROIN" (đây là nhỏ, không viết hoa hết)

🔤 QUOTE: Giữ nguyên cả câu gốc, có dấu ngoặc kép, viết thường (trừ tên riêng)
   - Ví dụ: "Before any of this... he was a cop."

⚠️ ĐẾM SỐ TỪ trước khi trả về! TO >4 từ = LỖI. NHỎ >15 từ = TÁCH.

=== NHIỆM VỤ ===
1. Đọc toàn bộ transcript (+ kịch bản nếu có) để hiểu narrative arc.
2. Xác định 20-25% cụm TỪ THỰC SỰ QUAN TRỌNG.
3. Mỗi cụm: chọn template theo cảm xúc, ĐẾM SỐ TỪ, viết displayText.
4. Ưu tiên: Main Title → Deaths → Facts/Stats → Nhân vật/ID → Quotes → Chapters.
5. Sau khi chọn xong: đếm tỷ lệ màu — nếu xanh >20% → thay bằng vàng nhỏ xuất hiện.

Trả về JSON (KHÔNG có markdown, KHÔNG có giải thích thêm):
{
  "titles": [
    {
      "templateId": "template_5",
      "displayText": "EL MENCHO",
      "start": 2.10,
      "end": 4.50,
      "reason": "Main title — vàng to xuất hiện (2 từ ✅)"
    },
    {
      "templateId": "template_3",
      "displayText": "Guadalajara, Mexico — July 17, 1966",
      "start": 74.56,
      "end": 82.19,
      "reason": "Location + thời gian — Xanh nhỏ xuất hiện (6 từ ✅ ≤15, viết thường)"
    },
    {
      "templateId": "template_10",
      "displayText": "9 DEAD",
      "start": 814.37,
      "end": 816.00,
      "reason": "Số người chết — đỏ to đập xuống (2 từ ✅ ≤4, VIẾT HOA)"
    },
    {
      "templateId": "template_4",
      "displayText": "Convicted — conspiracy to distribute heroin, U.S. District Court, 1994",
      "start": 162.32,
      "end": 165.00,
      "reason": "Pháp lý — Xanh nhỏ đánh máy (10 từ ✅ ≤15, viết thường)"
    }
  ]
}`
}
