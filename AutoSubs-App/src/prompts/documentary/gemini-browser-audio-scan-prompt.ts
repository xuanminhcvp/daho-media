// gemini-browser-audio-scan-prompt.ts
// Prompt scan audio qua Gemini BROWSER (không cần API key)
// Khác với audio-scan-prompt.ts (gửi base64 qua API):
//   - File này: Gemini đọc file upload trực tiếp trên trình duyệt
//   - Kết quả vẫn cùng format JSON → lưu vào autosubs_audio_metadata.json

/**
 * Prompt gửi vào Gemini chat khi upload file audio
 * Kết quả JSON cùng cấu trúc AudioAIMetadata (audio-types.ts)
 * → có thể merge với kết quả scan qua API key
 */
export function buildGeminiBrowserAudioPrompt(): string {
    return `Bạn là một Đạo diễn Âm nhạc (Music Supervisor) chuyên làm nhạc nền cho kênh YouTube Investigative Documentary.

Hãy nghe sâu bản nhạc/SFX vừa upload và NHẬN DIỆN CHI TIẾT TIMELINE + BEAT TIMING.

=== BỐI CẢNH ===
Video dạng INVESTIGATIVE DOCUMENTARY, narrator kể lại câu chuyện có thật:
- Điều tra → Căng thẳng → Hành động → Tiết lộ → Pháp lý → Twist → Trầm lắng...
- Nhạc nền cần đổi liên tục (mỗi đoạn 1-2 phút), khớp nhịp kể chuyện.

=== YÊU CẦU ===
Hãy giữ mọi text/description CỰC KỲ NGẮN GỌN (dưới 10 chữ) để tiết kiệm token.
Trả về JSONchính xác theo cấu trúc sau. KHÔNG thêm markdown hay text ngoài JSON:

{
  "emotion": ["Căng thẳng", "Kịch tính"],
  "intensity": "Cao",
  "description": "Nhạc u ám, nhịp căng thẳng phù hợp cảnh rượt đuổi",
  "tags": ["dark", "suspense", "cinematic"],
  "bestFor": ["Cảnh xung đột", "Trước plot twist"],
  "totalDurationSec": 85.0,
  "timeline": [
     { "startSec": 0.0, "endSec": 15.5, "phase": "intro", "emotion": "Rình rập, hồi hộp" },
     { "startSec": 15.5, "endSec": 45.0, "phase": "build-up", "emotion": "Dồn dập" },
     { "startSec": 45.0, "endSec": 60.0, "phase": "climax", "emotion": "Bùng nổ" },
     { "startSec": 60.0, "endSec": 85.0, "phase": "drop", "emotion": "Lắng xuống" }
  ],
  "beats": [
     { "timeSec": 0.0, "type": "start" },
     { "timeSec": 15.5, "type": "transition" },
     { "timeSec": 45.0, "type": "impact" },
     { "timeSec": 60.0, "type": "drop" },
     { "timeSec": 85.0, "type": "end" }
  ]
}

GHI CHÚ:
- "intensity": "Cao" | "Trung bình" | "Thấp"
- "phase": "intro" | "build-up" | "climax" | "drop" | "outro" | "ambient" | "tension" | "release"
- Chỉ trả về JSON thuần, KHÔNG thêm markdown \`\`\`json hay bất kỳ text nào khác!`;
}

/**
 * Prompt riêng cho SFX — đơn giản hơn music
 */
export function buildGeminiBrowserSfxPrompt(): string {
    return `Bạn là Sound Designer chuyên chọn SFX cho kênh YouTube Investigative Documentary.

Hãy nghe file SFX này. File CHỈ CÓ 1 ÂM THANH duy nhất (đã cắt sẵn).

=== YÊU CẦU ===
Trả về JSON đúng cấu trúc sau. KHÔNG thêm markdown hay text ngoài JSON:

{
  "emotion": ["Căng thẳng", "Kịch tính"],
  "intensity": "Cao",
  "description": "Mô tả chi tiết: nghe như thế nào, dùng trong cảnh gì...",
  "tags": ["whoosh", "transition", "cinematic"],
  "bestFor": ["Chuyển cảnh nhanh", "Tiết lộ sự thật"],
  "timeline": []
}

GHI CHÚ:
- KHÔNG CẦN timeline, beats, trimSuggestions (file đã có 1 âm thanh, không cắt gọt)
- "intensity": "Cao" | "Trung bình" | "Thấp"
- Chỉ trả về JSON thuần, KHÔNG thêm markdown hay text khác!`;
}
