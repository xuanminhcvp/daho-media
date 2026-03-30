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
Trả về JSONchính xác theo cấu trúc sau. KHÔNG thêm markdown hay text ngoài JSON:

{
  "emotion": ["Căng thẳng", "Kịch tính"],
  "intensity": "Cao",
  "description": "Mô tả tổng quát: tone, màu sắc, phù hợp cảnh nào...",
  "tags": ["dark", "suspense", "cinematic"],
  "bestFor": ["Cảnh xung đột", "Trước plot twist"],
  "hasDrop": true,
  "hasBuildUp": true,
  "totalDurationSec": 85.0,
  "timeline": [
     { "startSec": 0.0, "endSec": 15.5, "phase": "intro", "emotion": "Rình rập, hồi hộp", "description": "Nhạc mở đầu nhẹ..." },
     { "startSec": 15.5, "endSec": 45.0, "phase": "build-up", "emotion": "Dồn dập", "description": "Tiếng trống dồn..." },
     { "startSec": 45.0, "endSec": 60.0, "phase": "climax", "emotion": "Bùng nổ", "description": "Đỉnh điểm cảm xúc..." },
     { "startSec": 60.0, "endSec": 85.0, "phase": "drop", "emotion": "Lắng xuống", "description": "Nhạc fade..." }
  ],
  "beats": [
     { "timeSec": 0.0, "type": "start", "description": "Bắt đầu bài" },
     { "timeSec": 15.5, "type": "transition", "description": "Chuyển sang build-up" },
     { "timeSec": 45.0, "type": "impact", "description": "Climax impact lớn nhất" },
     { "timeSec": 60.0, "type": "drop", "description": "Nhạc cắt đột ngột" },
     { "timeSec": 85.0, "type": "end", "description": "Kết thúc bài" }
  ],
  "trimSuggestions": [
     { "startSec": 0.0, "endSec": 5.5, "label": "Impact mở đầu", "reason": "Phù hợp làm SFX ngắn cho plot twist" },
     { "startSec": 45.0, "endSec": 55.0, "label": "Đoạn climax mạnh", "reason": "10 giây cao trào" }
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
