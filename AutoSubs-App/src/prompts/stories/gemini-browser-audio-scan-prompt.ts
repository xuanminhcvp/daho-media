// gemini-browser-audio-scan-prompt.ts
// Prompt scan audio/SFX thủ công qua Gemini WEB (gemini.google.com)
// Workflow: Upload file lên Gemini web → paste prompt → copy JSON kết quả → paste vào app
// Không cần API key Gemini - hoàn toàn miễn phí!

/**
 * Prompt cho nhạc nền — gửi vào Gemini web khi upload file nhạc
 * Cấu trúc JSON chuẩn khớp hoàn toàn với auto-scan-prompt.ts
 */
export function buildGeminiBrowserAudioPrompt(): string {
    return `Bạn là một Đạo diễn Âm nhạc (Music Supervisor) chuyên làm nhạc nền cho kênh YouTube Stories dạng kể chuyện dài (50 phút - 1 tiếng).

Hãy upload file audio/nhạc nền này và nghe sâu. Sau đó NHẬN DIỆN CHI TIẾT TIMELINE + BEAT TIMING. Tự ước lượng độ dài file dựa trên số giây.

=== BỐI CẢNH SỬ DỤNG ===
Video dạng STORIES YOUTUBE kể chuyện dài, liên tục thay đổi nhịp cảm xúc:
- Căng thẳng → Xung đột → Cao trào → Hả hê → Bi thương → Plot twist...
- Nhạc nền cần đổi liên tục (mỗi đoạn 1-3 phút), cắt nhanh theo mạch chuyện.
- Nhạc thường là file dài, có nhiều đoạn build-up và climax.

=== YÊU CẦU ===
Hãy giữ mọi text/description CỰC KỲ NGẮN GỌN (dưới 10 chữ) để tiết kiệm token.
Trả về JSON đúng cấu trúc bên dưới. Tự tính startSec/endSec cho timeline. KHÔNG thêm markdown \`\`\`json hay bất kỳ text nào ngoài JSON:

{
  "emotion": ["Căng thẳng", "Kịch tính"],
  "intensity": "Cao",
  "description": "Nhạc u ám, nhịp căng thẳng phù hợp cảnh rượt đuổi",
  "tags": ["dark", "suspense", "cinematic"],
  "bestFor": ["Cảnh xung đột", "Trước plot twist"],
  "totalDurationSec": 85.0,
  "timeline": [
     { "startSec": 0.0, "endSec": 15.5, "phase": "intro", "emotion": "Rình rập, hồi hộp" },
     { "startSec": 15.5, "endSec": 45.0, "phase": "build-up", "emotion": "Dồn dập, leo thang" },
     { "startSec": 45.0, "endSec": 60.0, "phase": "climax", "emotion": "Bùng nổ, cao trào" },
     { "startSec": 60.0, "endSec": 85.0, "phase": "drop", "emotion": "Lắng xuống, trống rỗng" }
  ],
  "beats": [
     { "timeSec": 0.0, "type": "start" },
     { "timeSec": 2.3, "type": "hit" },
     { "timeSec": 15.5, "type": "transition" },
     { "timeSec": 45.0, "type": "impact" },
     { "timeSec": 60.0, "type": "drop" },
     { "timeSec": 85.0, "type": "end" }
  ]
}

GHI CHÚ QUAN TRỌNG:
- "bestFor": liệt kê 2-4 tình huống phim phù hợp nhất.
- "phase": gắn nhãn từ danh sách: "intro", "build-up", "climax", "drop", "outro", "ambient", "tension", "release"
- "beats": liệt kê TỪNG nhịp/hit/đập quan trọng trong bài (timestamped) với type gồm: "start", "hit", "impact", "transition", "drop", "swell", "end".
- Chỉ trả về JSON thuần, KHÔNG CÓ text giải thích, KHÔNG CÓ markdown format \`\`\`json!`;
}

/**
 * Prompt cho SFX — gửi vào Gemini web khi upload file hiệu ứng âm thanh
 * Cấu trúc JSON chuẩn khớp hoàn toàn với sfx-scan-prompt (ko có timeline)
 */
export function buildGeminiBrowserSfxPrompt(): string {
    return `Bạn là Sound Designer chuyên chọn SFX cho kênh YouTube Stories dạng kể chuyện dài.

Hãy nghe file SFX này. File CHỈ CÓ 1 ÂM THANH DUY NHẤT (đã cắt gọt sẵn, không cần phân tích thời gian hay timeline).

=== NHIỆM VỤ ===
Mô tả chi tiết âm thanh này dùng cho mục đích gì, phù hợp cảnh nào trong video stories.

=== YÊU CẦU ===
Trả về JSON đúng cấu trúc bên dưới. KHÔNG thêm markdown \`\`\`json hay text ngoài JSON:

{
  "emotion": ["Căng thẳng", "Kịch tính"],
  "intensity": "Cao",
  "description": "Mô tả chi tiết âm thanh: nghe như thế nào, dùng trong cảnh gì, tạo cảm giác gì...",
  "tags": ["whoosh", "transition", "cinematic", "fast"],
  "bestFor": ["Chuyển cảnh nhanh", "Xuất hiện nhân vật", "Tiết lộ sự thật"]
}

GHI CHÚ QUAN TRỌNG:
- "intensity": "Cao" | "Trung bình" | "Thấp" — cường độ âm thanh
- "tags": 3-8 từ khóa tiếng Anh để tìm kiếm nhanh (ví dụ: "impact", "hit", "bass", "riser", "whoosh")
- KHÔNG CẦN trả về timeline, beats, trimSuggestions (file đã có sẵn 1 âm thanh, không cắt gọt)
- Chỉ trả về JSON thuần, KHÔNG CÓ text giải thích, KHÔNG CÓ markdown format \`\`\`json!`;
}

