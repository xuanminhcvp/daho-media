// title-assignment-prompt.ts
// Prompt cho AI phân tích Whisper Words → xác định Text On Screen (Title Cards)
// Hỗ trợ 8 loại template đầy đủ cho phim tài liệu YouTube

import type { TextTemplate } from "@/services/template-assignment-service"

/**
 * Tạo prompt phân tích Whisper Words để tìm Text On Screen (Title) cues
 *
 * @param wordsText - Nội dung whisper words (format: "[0.13] February [0.77] twenty ...")
 * @param templates - Danh sách template đang bật
 */
export function buildTitleFromWhisperPrompt(
    wordsText: string,
    templates: TextTemplate[]
): string {
    // Mô tả các template đang bật cho AI
    const templateDescriptions = templates
        .filter(t => t.enabled)
        .map((t, i) =>
            `${i + 1}. ID: "${t.id}" — ${t.displayName}\n   Mô tả: ${t.description}\n   Quy tắc: ${t.usageRule}`
        )
        .join("\n\n")

    return `Bạn là Senior Video Editor chuyên sản xuất phim Tài liệu YouTube (3D Investigative Documentary Style).

NHIỆM VỤ: Phân tích Whisper transcript (word-by-word timestamps) → xác định các cụm từ cần TEXT ON SCREEN.

=== FORMAT TRANSCRIPT ===
Mỗi word có timestamp trước: [giây] từ
Ví dụ: [34.20] February [34.50] twenty [34.80] second [35.10] 2026

=== QUAN TRỌNG: ĐÂY KHÔNG PHẢI SUBTITLE ===
Text On Screen xuất hiện ~20-25% thời lượng video.
PHẦN LỚN câu kể chuyện bình thường → KHÔNG cần Text On Screen.
Chỉ những câu CÓ GIÁ TRỊ THÔNG TIN CAO HOặC CẢM XÚC MẠNH mới cần.

=== 8 LOẠI TEXT ON SCREEN ===

📌 LOẠI 1 — DOCUMENT / ID CARD (template_1)
Khi nào: Giới thiệu tên người + chức danh chính thức LẦN ĐẦU, văn bản pháp lý, phán quyết tòa
Ví dụ: "NEMESIO OSEGUERA CERVANTES — CJNG Cartel Leader", "FBI Indictment No. 2024-CR-0451"
⚠️ Khi gặp: "FBI special agent", "cartel leader", "former president", "arrested", "indicted" → CHECK xem đây có phải lần đầu giới thiệu không.

📌 LOẠI 2 — LOCATION / IMPACT (template_2)
Khi nào: Địa điểm + mốc thời gian cụ thể (đặc biệt là lần đầu hoặc khi chuyển cảnh)
Ví dụ: "GUADALAJARA, 2003", "STOCKHOLM — 2006", "FEBRUARY 22, 2026"
⚠️ BẮT BUỘC: KHÔNG bỏ qua câu nào có: tên thành phố/quốc gia + năm, năm cụ thể ("In 2003", "By 1995"), "in [city]", "at [location]"

📌 LOẠI 3 — DEATH / VIOLENCE (template_3)
Khi nào: Số người chết/bị thương, bạo lực cụ thể, vũ khí, thảm họa có tên
Ví dụ: "9 OFFICERS KILLED", "252 BLOCKADES", "CAR BOMB — GUADALAJARA"
⚠️ Khi gặp số + "dead", "killed", "murdered", "wounded" → LUÔN dùng template này

📌 LOẠI 4 — QUOTE / MOTIF (template_4)
Khi nào: Trích dẫn trực tiếp có nguồn, câu nhận định triết lý sâu sắc, câu kết chương có sức nặng
Ví dụ: '"He was untouchable." — DEA Official', "Power always has one weakness."
⚠️ Câu có dấu ngoặc kép + người nói → LUÔN là template này

📌 LOẠI 5 — MAIN TITLE (template_5)
Khi nào: CHỈ xuất hiện 1 lần duy nhất — câu MỞ ĐẦU video giới thiệu chủ đề tổng quan
Ví dụ: "THE WORLD'S MOST WANTED CARTEL", "THIS IS THE STORY OF..."
⚠️ Chỉ dùng cho câu đầu tiên của transcript — sau đó KHÔNG dùng nữa

📌 LOẠI 6 — CHAPTER / SCENE (template_6)
Khi nào: Câu báo hiệu chuyển chương, nhảy timeline, plot twist lớn, reveal bất ngờ
Ví dụ: "SIX MONTHS LATER", "PART II: THE FALL", "BUT THEN EVERYTHING CHANGED"
⚠️ Khi gặp: "months later", "years later", "meanwhile", "but then", "however" → CHECK xem có phải chuyển cảnh lớn không

📌 LOẠI 7 — FACT / STAT CARD (template_7)
Khi nào: Số liệu kinh tế, thống kê quan trọng (KHÔNG phải địa điểm/thời gian, KHÔNG phải bạo lực)
Ví dụ: "$50 BILLION IN ANNUAL REVENUE", "90% OF U.S. COCAINE SUPPLY", "OPERATIONS IN 40+ COUNTRIES"
⚠️ Khi gặp: số tiền ($), %, "million", "billion", số lượng lớn + danh từ → dùng template này thay vì template_2

📌 LOẠI 8 — EMPHASIS / KEY TEXT (template_8)
Khi nào: Câu đỉnh điểm cảm xúc của đoạn — câu mà nếu cắt ra khỏi video vẫn nói lên thông điệp chính
Ví dụ: "THEY FOUND HIM THROUGH THE ONE VULNERABILITY NO POWER CAN ELIMINATE", "HE WAS HUMAN"
⚠️ Câu ngắn, súc tích, có sức nặng tâm lý mạnh → template này

=== DANH SÁCH TEMPLATE ĐANG BẬT ===
${templateDescriptions}

=== WHISPER WORDS TRANSCRIPT ===
${wordsText}

=== CÁCH LẤY TIMING ===
- start = timestamp của TỪ ĐẦU TIÊN trong cụm
- end = timestamp TỪ CUỐI CÙNG + 0.5 giây (để text hiện đủ lâu)
Ví dụ: "[34.20] February [34.50] twenty [34.80] second [35.10] 2026"
  → start = 34.20 (timestamp "February")
  → end = 35.10 + 0.5 = 35.60

=== QUY TẮC displayText ===
- MAIN TITLE: VIẾT HOA hoàn toàn, ngắn gọn (không quá 8 từ)
- CHAPTER: VIẾT HOA, dùng số La Mã nếu phù hợp ("PART II: THE FALL")
- LOCATION: "THÀNH PHỐ, NĂM" (VD: "GUADALAJARA, 2003")
- FACT/STAT: Số + đơn vị VIẾT HOA ("$50 BILLION", "90% OF COCAINE")
- DEATH: Ngắn gọn VIẾT HOA ("9 OFFICERS KILLED")
- LOWER THIRD: "TÊN ĐẦY ĐỦ — CHỨC DANH"
- QUOTE: Giữ nguyên kèm dấu ngoặc kép và nguồn
- EMPHASIS: Câu nguyên văn quan trọng, có thể dùng ELLIPSIS (...)

=== NHIỆM VỤ ===
1. Đọc toàn bộ transcript để hiểu narrative arc.
2. Xác định 20-25% cụm TỪ THỰC SỰ QUAN TRỌNG (không lấy câu bình thường).
3. Ưu tiên: Main Title (đầu video) → Location → Deaths → Facts/Stats → Chapters → Quotes → Emphasis → Lower Thirds.
4. Mỗi cụm: chọn đúng template, viết displayText ngắn gọn súc tích, set start/end từ word timestamps.

Trả về JSON (KHÔNG có markdown, KHÔNG có giải thích thêm):
{
  "titles": [
    {
      "templateId": "template_5",
      "displayText": "THE WORLD'S MOST POWERFUL CARTEL",
      "start": 2.10,
      "end": 4.50,
      "reason": "Câu mở đầu video — Main Title"
    },
    {
      "templateId": "template_6",
      "displayText": "SIX MONTHS LATER",
      "start": 245.30,
      "end": 247.00,
      "reason": "Chuyển timeline — Chapter/Scene"
    },
    {
      "templateId": "template_7",
      "displayText": "$50 BILLION ANNUAL REVENUE",
      "start": 120.50,
      "end": 122.80,
      "reason": "Số liệu doanh thu lớn — Fact/Stat Card"
    },
    {
      "templateId": "template_8",
      "displayText": "THEY FOUND HIM THE WAY THEY ALWAYS FIND HIM",
      "start": 1854.60,
      "end": 1858.00,
      "reason": "Câu nhấn mạnh đỉnh điểm — Emphasis"
    }
  ]
}`
}
