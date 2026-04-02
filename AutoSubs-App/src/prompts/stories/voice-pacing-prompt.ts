// voice-pacing-prompt.ts
// ═══════════════════════════════════════════════════════════════════════════
// FILE QUY TẮC NHỊP CẮT VOICE (Voice Pacing Rules)
// ═══════════════════════════════════════════════════════════════════════════
// Quy tắc chung cho thể loại: 3D Investigative Documentary (Black Files)
// Dựa trên phân tích 10 kịch bản mẫu + EDITING_RHYTHM_GUIDE.md
//
// 👉 BẠN SỬA GIÁ TRỊ Ở ĐÂY → lưu → app tự cập nhật
// ═══════════════════════════════════════════════════════════════════════════


// ╔═══════════════════════════════════════════════════════════════╗
// ║  1. QUY TẮC NHỊP CƠ BẢN — theo dấu câu cuối                ║
// ╚═══════════════════════════════════════════════════════════════╝
// Đây là FALLBACK khi không xác định được loại câu nâng cao.
// Giá trị tham khảo từ EDITING_RHYTHM_GUIDE Mục IV — Bảng ngắt nghỉ.

export const PACING_RULES = {
    // --- DẤU CHẤM (.) — Kết thúc ý, chuyển ý nhẹ ---
    // Theo Guide: "Giữa 2 câu bình thường = 0.3–0.5s"
    //             "Sau câu kết thúc ý cuối đoạn = 0.8–1.2s"
    // → Mặc định 0.5s (câu bình thường), service sẽ tăng nếu là cuối đoạn
    period: {
        label: "Dấu chấm (.)",
        description: "Câu kết thúc ý → dừng nhẹ trước sang cảnh mới",
        minPause: 0.3,
        maxPause: 1.2,
        defaultPause: 0.5,
    },

    // --- DẤU HỎI (?) — Câu hỏi tu từ → PAUSE DÀI nhất ---
    // Theo Guide: "Sau câu hỏi tu từ = 1.5–2.5s"
    // Đây là "CỬA CHUYỂN CẢNH" giữa các hồi (Act)
    // PHẢI có pause dài ở đây — người xem cần ngấm câu hỏi
    question: {
        label: "Dấu hỏi (?)",
        description: "Câu hỏi tu từ → CỬA CHUYỂN CẢNH, giữ dài để ngấm",
        minPause: 1.5,
        maxPause: 2.5,
        defaultPause: 2.0,
    },

    // --- DẤU CHẤM THAN (!) — Cảm thán / nhấn mạnh ---
    // Theo Guide: câu hành động/action thường kết thúc bằng !
    // Nhấn rồi chuyển nhanh, không nghỉ lâu
    exclamation: {
        label: "Dấu chấm than (!)",
        description: "Cảm thán / nhấn mạnh → chuyển nhanh",
        minPause: 0.2,
        maxPause: 0.8,
        defaultPause: 0.4,
    },

    // --- CÂU NGẮN / LIỆT KÊ (≤ N từ) ---
    // Theo Guide: "Mỗi item 1.5s → 1.2s → 1s → 0.8s" (dồn tốc)
    // Pause giữa các câu ngắn liên tiếp = gần 0 (montage nhanh)
    shortSentence: {
        label: "Câu ngắn / liệt kê",
        description: "Câu dưới N từ → dồn dập, montage nhanh",
        maxWords: 6,
        minPause: 0.0,
        maxPause: 0.2,
        defaultPause: 0.1,
    },

    // --- BA CHẤM (...) — Suspense, bỏ lửng ---
    // Theo Guide: tạo dramatic effect, để người xem tự suy nghĩ
    ellipsis: {
        label: "Ba chấm (...)",
        description: "Bỏ lửng / suspense → để lắng",
        minPause: 1.2,
        maxPause: 2.5,
        defaultPause: 1.8,
    },

    // --- DẤU PHẨY (,) --- (KHÔNG DÙNG hiện tại, dành cho phrase-level sau)
    comma: {
        label: "Dấu phẩy (,)",
        description: "Ngắt nhịp nhẹ giữa phrase (chưa bật)",
        minPause: 0.0,
        maxPause: 0.3,
        defaultPause: 0.0,
    },
}


// ╔═══════════════════════════════════════════════════════════════╗
// ║  2. QUY TẮC NHỊP NÂNG CAO — theo LOẠI CÂU (8 loại)         ║
// ╚═══════════════════════════════════════════════════════════════╝
// Dựa trên Guide Mục III — "8 LOẠI CÂU & QUY TẮC NHỊP"
// Service sẽ phát hiện loại câu bằng keyword matching
// AI mode cũng tham khảo bảng này để quyết định pause

export const SENTENCE_TYPE_RULES = {

    // Loại 1: CÂU NGÀY THÁNG (Timestamp)
    // Dấu hiệu: bắt đầu bằng tháng (January, February...) hoặc có năm 4 chữ số
    // → "Reset nhịp thở", chapter marker
    timestamp: {
        label: "📅 Ngày tháng",
        description: "Chapter marker — reset nhịp thở",
        pauseAfter: 1.2,         // Dài hơn bình thường
        pauseBefore: 1.5,         // Pause dài TRƯỚC timestamp mới (chuyển hồi)
        keywords: ["January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"],
    },

    // Loại 2: CÂU HÀNH ĐỘNG (Action)
    // Dấu hiệu: động từ mạnh ở đầu/giữa câu
    // → Nhanh, dồn dập, pause rất ngắn
    action: {
        label: "⚡ Hành động",
        description: "Dồn dập, cắt nhanh",
        pauseAfter: 0.2,
        keywords: ["storm", "stormed", "seized", "arrested", "shot", "killed",
            "exploded", "detonated", "crashed", "fled", "escaped",
            "launched", "attacked", "raided", "breached", "hacked"],
    },

    // Loại 3: CÂU MÔ TẢ / XÂY DỰNG (Description/Setup)
    // Dấu hiệu: câu dài (>20 từ), ít động từ mạnh
    // → Chậm, cho người xem ngấm hình ảnh
    description: {
        label: "🎬 Mô tả",
        description: "Chậm, breathing room, không cắt giữa câu",
        pauseAfter: 0.7,
        minWords: 20,             // Câu ≥ 20 từ = mô tả dài
    },

    // Loại 4: CÂU SỐ LIỆU (Data/Stats)
    // Dấu hiệu: có con số + đơn vị ($, million, billion, percent, %)
    // → Nhấn vào con số, pause sau để ngấm
    stats: {
        label: "📊 Số liệu",
        description: "Nhấn con số, pause sau để ngấm",
        pauseAfter: 0.6,
        keywords: ["million", "billion", "thousand", "percent", "%", "$",
            "revenue", "subscribers"],
    },

    // Loại 5: CÂU HỎI TU TỪ (Rhetorical Questions)
    // → PAUSE DÀI NHẤT (đã xử lý ở PACING_RULES.question)
    // Service sẽ dùng PACING_RULES.question.defaultPause = 2.0s

    // Loại 6: TRÍCH DẪN TRỰC TIẾP (Direct Quotes)
    // Dấu hiệu: ngoặc kép trong câu, hoặc pattern "he said" / "she tells"
    // → Pause trước 0.5s + pause sau 1.0s
    quote: {
        label: "💬 Trích dẫn",
        description: "Pause trước + sau để chuyển gear nghe",
        pauseAfter: 1.0,
        pauseBefore: 0.5,
        keywords: ["he says", "she says", "he said", "she said", "he tells",
            "she tells", "he explains", "telling reporters"],
    },

    // Loại 7: CÂU LIỆT KÊ (Lists/Sequences)
    // Dấu hiệu: nhiều dấu phẩy + "and" hoặc "every"
    // → Dồn tốc, mỗi item nhanh hơn item trước
    list: {
        label: "📋 Liệt kê",
        description: "Dồn tốc — mỗi item nhanh hơn",
        pauseAfter: 0.1,
        keywords: ["every server", "every cable", "every piece"],
    },

    // Loại 8: CÂU TWIST / PLOT TWIST
    // Dấu hiệu: bắt đầu bằng "But" hoặc "However"
    // → Dramatic pause TRƯỚC câu "But" (1.0-1.5s)
    twist: {
        label: "🔄 Plot Twist",
        description: "Dramatic pause TRƯỚC \"But\" — chuyển nhịp",
        pauseAfter: 0.5,
        pauseBefore: 1.2,         // Pause dài TRƯỚC từ "But"
        keywords: ["But ", "However,", "Or is it?", "Here's what"],
    },
}


// ╔═══════════════════════════════════════════════════════════════╗
// ║  3. CẤU HÌNH CHUNG                                          ║
// ╚═══════════════════════════════════════════════════════════════╝

export const PACING_CONFIG = {
    // --- Chọn mode phân tích ---
    // "ai"    = gửi script cho AI → AI phân tích context, chọn pause thông minh
    // "rules" = chỉ dùng quy tắc ở trên (nhanh, offline, không tốn API)
    mode: "ai" as "ai" | "rules",

    // --- Ngưỡng câu ngắn ---
    shortSentenceMaxWords: 6,

    // --- Nhóm câu ngắn liên tiếp ---
    // true = nếu 2+ câu ngắn liên tiếp → pause = 0 (montage dồn dập)
    // Theo Guide Pattern B: "Staccato Burst"
    groupShortSentences: true,

    // --- Ngưỡng câu dài (mô tả) ---
    // Câu ≥ N từ sẽ được coi là câu mô tả → pause dài hơn
    longSentenceMinWords: 20,

    // --- Giới hạn pause toàn cục ---
    // Dù AI gợi ý pause 5s, vẫn bị clamp bởi min/max này
    globalMaxPause: 3.0,
    globalMinPause: 0.0,

    // --- Quy tắc "Hít thở" (Breathing Rule) ---
    // Theo Guide: "Mỗi 45s nội dung dày đặc → 10-15s ambient breathing"
    // Service sẽ tự tính: nếu tổng thời gian câu vượt ngưỡng mà chưa có
    // câu hỏi tu từ / timestamp → tự thêm pause dài hơn
    breathingIntervalSeconds: 45,
    breathingPauseBoost: 0.5,     // Thêm 0.5s vào pause của câu gần nhất

    // --- Câu cuối cùng → pause = 0 (không cần nghỉ sau câu cuối) ---
    zeroPauseLastSentence: true,
}


// ╔═══════════════════════════════════════════════════════════════╗
// ║  4. AI PROMPT TEMPLATE                                       ║
// ╚═══════════════════════════════════════════════════════════════╝
// Prompt gửi cho AI khi mode = "ai"
// AI sẽ phân tích ngữ cảnh thông minh hơn rule-based

export function buildVoicePacingPrompt(scriptText: string): string {
    return `You are an expert video editor specializing in pacing for 3D Investigative Documentaries (Black Files style).

I have a voice-over SCRIPT below. Analyze EACH SENTENCE and decide the SILENCE duration (in seconds) to insert AFTER each sentence.

## 🎯 KEY PACING RULES (from editing guide):

### Rule 1: Pause by sentence type
| Type | Pause after | Detection |
|------|------------|-----------|
| Normal sentence (.) | 0.3–0.5s | Default |
| End of paragraph/idea (.) | 0.8–1.2s | Last sentence before topic change |
| Rhetorical question (?) | 1.5–2.5s | "How did...", "What happens when..." |
| Exclamation (!) | 0.2–0.4s | Action/emphasis |
| Ellipsis (...) | 1.2–2.0s | Suspense |

### Rule 2: Pause by content type
| Content | Pause after | Description |
|---------|------------|-------------|
| Timestamp/Date | 1.0–1.5s after, +1.5s BEFORE | "January 9th, 2022..." = chapter marker |
| Action sequences | 0.1–0.3s | "stormed", "seized" → fast, staccato |
| Long description (>20 words) | 0.5–0.8s | Breathing room |
| Statistics/Numbers | 0.5–0.8s | "$30 billion", "25 million" → let data sink in |
| Direct quotes | 0.8–1.2s | "He says..." → gear change for listener |
| Lists/Sequences | 0.0–0.2s | "every server, every cable" → rapid montage |
| Plot twist ("But...") | 0.5s after, +1.0–1.5s BEFORE | Dramatic pause before "But" |

### Rule 3: Breathing Rule (45/15)
- Every ~45s of dense content → boost pause to 0.8–1.2s for breathing room
- Don't let 10+ sentences pass without at least one pause ≥ 0.8s

### Rule 4: Short sentence grouping
- If 2+ consecutive short sentences (≤6 words) → pause = 0.0 between them (staccato burst)
- LAST item in a list → slightly longer pause (0.3–0.5s)

### Rule 5: Emotion curve
- Don't make all pauses the same! Vary them:
  ❌ WRONG: 0.5 → 0.5 → 0.5 → 0.5 → 0.5
  ✅ RIGHT: 0.3 → 0.7 → 0.1 → 1.5 → 0.4

### Rule 6: Last sentence
- Last sentence of entire script → pause = 0.0

## SCRIPT:

${scriptText}

## OUTPUT FORMAT:
Return ONLY a JSON array. Each element:
- "num": sentence number (integer)
- "pause": silence after sentence (seconds, 1 decimal)
- "reason": short reason in Vietnamese

Example:
[
  { "num": 1, "pause": 1.2, "reason": "Ngày tháng, chapter marker" },
  { "num": 2, "pause": 0.3, "reason": "Hành động, dồn dập" },
  { "num": 3, "pause": 2.0, "reason": "Câu hỏi tu từ, chuyển hồi" },
  { "num": 4, "pause": 0.0, "reason": "Câu ngắn liệt kê" }
]

RETURN ONLY JSON. NO explanation.`
}
