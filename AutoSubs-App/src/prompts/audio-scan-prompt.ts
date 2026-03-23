// audio-scan-prompt.ts
// Prompt để Gemini nghe và phân tích từng bài nhạc/SFX
// Tối ưu cho dòng 3D Investigative Documentary (25-27 phút)
// AI nghe audio thật → trả về metadata + timeline cảm xúc + beat timing + gợi ý cắt gọt

/**
 * Tạo prompt cho Gemini phân tích 1 bài nhạc nền hoặc SFX
 * Gemini sẽ nghe audio binary (base64) và trả về JSON metadata
 * Bao gồm:
 * - Timeline cảm xúc chi tiết
 * - Beat/hit timing chính xác (giây) — để biết từng nhịp nằm ở đâu
 * - Gợi ý cắt gọt tốt nhất — để FFmpeg trim trước khi import
 */
export function buildAudioScanPrompt(): string {
    return `Bạn là một Đạo diễn Âm nhạc (Music Supervisor) chuyên làm nhạc nền cho kênh YouTube 3D Investigative Documentary (25-27 phút).

Hãy nghe sâu bản nhạc/SFX này và NHẬN DIỆN CHI TIẾT TIMELINE + BEAT TIMING. Tự ước lượng độ dài file dựa trên số giây.

=== BỐI CẢNH SỬ DỤNG ===
Video dạng 3D INVESTIGATIVE DOCUMENTARY, narrator kể lại câu chuyện có thật:
- Điều tra → Căng thẳng → Hành động → Tiết lộ → Pháp lý → Twist → Trầm lắng...
- Nhạc nền cần đổi liên tục (mỗi đoạn 1-2 phút), khớp nhịp kể chuyện.
- SFX thường ngắn (1-10 giây), nhưng có thể có nhiều nhịp/hit bên trong.

=== YÊU CẦU ===
Trả về JSON đúng cấu trúc sau. Tự tính startSec/endSec cho timeline.

{
  "emotion": ["Căng thẳng", "Kịch tính"],
  "intensity": "Cao",
  "description": "Mô tả tổng quát: tone, màu sắc, dùng hợp cảnh nào trong video stories...",
  "tags": ["dark", "suspense", "cinematic"],
  "bestFor": ["Cảnh xung đột", "Trước plot twist"],
  "hasDrop": true,
  "hasBuildUp": true,
  "totalDurationSec": 85.0,
  "timeline": [
     { "startSec": 0.0, "endSec": 15.5, "phase": "intro", "emotion": "Rình rập, hồi hộp", "description": "Nhạc mở đầu nhẹ, tạo không khí bất an" },
     { "startSec": 15.5, "endSec": 45.0, "phase": "build-up", "emotion": "Dồn dập, leo thang", "description": "Tiếng trống dồn, cường độ tăng dần..." },
     { "startSec": 45.0, "endSec": 60.0, "phase": "climax", "emotion": "Bùng nổ, cao trào", "description": "Đỉnh điểm cảm xúc, tất cả nhạc cụ dồn vào..." },
     { "startSec": 60.0, "endSec": 85.0, "phase": "drop", "emotion": "Lắng xuống, trống rỗng", "description": "Nhạc cắt đột ngột hoặc fade nhẹ..." }
  ],
  "beats": [
     { "timeSec": 0.0, "type": "start", "description": "Bắt đầu bài" },
     { "timeSec": 2.3, "type": "hit", "description": "Bass drum hit" },
     { "timeSec": 5.1, "type": "hit", "description": "Cymbal crash" },
     { "timeSec": 15.5, "type": "transition", "description": "Chuyển sang build-up" },
     { "timeSec": 45.0, "type": "impact", "description": "Climax impact lớn nhất" },
     { "timeSec": 60.0, "type": "drop", "description": "Nhạc cắt đột ngột" },
     { "timeSec": 85.0, "type": "end", "description": "Kết thúc bài" }
  ],
  "trimSuggestions": [
     { "startSec": 0.0, "endSec": 5.5, "label": "Chỉ lấy impact mở đầu", "reason": "Phù hợp làm SFX ngắn cho plot twist" },
     { "startSec": 45.0, "endSec": 55.0, "label": "Đoạn climax mạnh nhất", "reason": "10 giây cao trào, dùng cho moment bùng nổ" },
     { "startSec": 15.5, "endSec": 60.0, "label": "Build-up → Climax", "reason": "Dùng cho cảnh dồn dập dài" }
  ]
}

GHI CHÚ:
- "bestFor": liệt kê 2-4 tình huống phim phù hợp nhất (vd: "Cảnh rượt đuổi", "Tiết lộ sự thật", "Hồi tưởng buồn"...)
- "hasDrop": true nếu nhạc có đoạn im lặng/cắt đột ngột (dùng cho plot twist)
- "hasBuildUp": true nếu nhạc có đoạn tăng dần cường độ (dùng cho dồn dập trước cao trào)
- "totalDurationSec": tổng độ dài file (giây) — ước lượng chính xác nhất có thể
- "phase": gắn nhãn từ danh sách: "intro", "build-up", "climax", "drop", "outro", "ambient", "tension", "release"
- "beats": liệt kê TỪNG nhịp/hit/đập quan trọng trong bài (timestamped):
    - "type" gồm: "start", "hit", "impact", "transition", "drop", "swell", "end"
    - Đặc biệt QUAN TRỌNG với SFX ngắn — vì user sẽ chỉ dùng 1 phần nhỏ của file
- "trimSuggestions": gợi ý 2-4 đoạn cắt gọt hay nhất từ file này:
    - Mục đích: FFmpeg sẽ cắt đoạn này ra dùng riêng (trim before import)
    - Ưu tiên: đoạn impact mạnh, đoạn climax, đoạn intro sạch...
    - label: tên ngắn gọn cho đoạn cắt
    - reason: giải thích vì sao đoạn này đáng cắt ra dùng
- Chỉ trả về JSON duy nhất hợp lệ, tuyệt đối KHÔNG thêm markdown!`;
}

/**
 * Prompt riêng cho SFX — đơn giản hơn Music prompt rất nhiều.
 * Mỗi file SFX chỉ chứa 1 âm thanh duy nhất (đã cắt sẵn).
 * AI chỉ cần: nghe → mô tả → gắn tags → gợi ý dùng trong tình huống nào.
 * KHÔNG CẦN: timeline, beats, trimSuggestions (vì file đã sẵn, không cắt gọt).
 */
export function buildSfxScanPrompt(): string {
    return `Bạn là Sound Designer chuyên chọn SFX cho kênh YouTube 3D Investigative Documentary.

Hãy nghe file SFX này. Mỗi file CHỈ CÓ 1 ÂM THANH duy nhất (đã cắt gọt sẵn, không cần phân tích thời gian).

=== NHIỆM VỤ ===
Mô tả chi tiết âm thanh này dùng cho mục đích gì, phù hợp cảnh nào trong video stories.

=== YÊU CẦU ===
Trả về JSON đúng cấu trúc sau:

{
  "emotion": ["Căng thẳng", "Kịch tính"],
  "intensity": "Cao",
  "description": "Mô tả chi tiết âm thanh: nghe như thế nào, dùng trong cảnh gì, tạo cảm giác gì cho người nghe...",
  "tags": ["whoosh", "transition", "cinematic", "fast"],
  "bestFor": ["Chuyển cảnh nhanh", "Xuất hiện nhân vật", "Tiết lộ sự thật"]
}

GHI CHÚ:
- "emotion": 1-3 cảm xúc chính mà âm thanh này tạo ra (ví dụ: "Bất ngờ", "Sợ hãi", "Hào hứng", "Buồn bã"...)
- "intensity": "Cao" | "Trung bình" | "Thấp" — cường độ âm thanh
- "description": mô tả CHI TIẾT âm thanh nghe như thế nào + dùng hợp cảnh nào
  - Ví dụ: "Tiếng whoosh nhanh, sắc, phù hợp cho transition hoặc khi text xuất hiện nhanh trên màn hình"
  - Ví dụ: "Tiếng sấm sét xa, vang, tạo không khí bất an, dùng cho cảnh mở đầu kịch tính"
- "tags": 3-8 từ khóa tiếng Anh để tìm kiếm nhanh (ví dụ: "impact", "hit", "bass", "riser", "whoosh", "nature", "rain")
- "bestFor": 2-4 tình huống phim/video phù hợp nhất
  - Ví dụ: "Plot twist", "Chuyển cảnh", "Nhân vật xuất hiện", "Khoảnh khắc sốc", "Cảnh hồi tưởng"
- KHÔNG CẦN trả về timeline, beats, trimSuggestions (file đã có sẵn 1 âm thanh, không cắt gọt)
- Chỉ trả về JSON duy nhất hợp lệ, tuyệt đối KHÔNG thêm markdown!`;
}
