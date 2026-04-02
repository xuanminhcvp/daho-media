// reference-image-prompt.ts
// Prompt cho AI phân tích kịch bản documentary → gợi ý ảnh thực tế cần chèn
// Tối ưu cho 3D Investigative Documentary (25-27 phút)
// AI nhận: kịch bản + whisper words → trả về 6-10 ảnh quan trọng nhất

/**
 * Build prompt gợi ý ảnh tham khảo thực tế
 * AI đọc toàn bộ kịch bản + whisper words timing
 * → chọn 6-10 moment "đắt giá" nhất cần ảnh minh hoạ
 *
 * @param sentences - Danh sách câu từ matching.json (có timing)
 * @param whisperWordsText - Whisper words đã format (optional, để AI tính timing chính xác)
 */
export function buildRefImagePrompt(
    sentences: Array<{ num: number; text: string; start: number; end: number }>,
    whisperWordsText?: string
): string {
    // Format kịch bản có timecode
    const scriptText = sentences
        .map((s) => `[Câu ${s.num}] (${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s): ${s.text}`)
        .join("\n")

    // Tổng duration video
    const totalDuration = sentences.length > 0
        ? sentences[sentences.length - 1].end
        : 0
    const totalMinutes = Math.round(totalDuration / 60)

    return `Bạn là một Researcher / Picture Editor chuyên nghiệp cho kênh YouTube 3D Investigative Documentary (${totalMinutes} phút).

=== NHIỆM VỤ ===
Đọc kịch bản bên dưới và xác định CHÍNH XÁC 6-10 moment quan trọng nhất cần chèn ẢNH THỰC TẾ minh hoạ.
Đây là ảnh thật (chụp thật, tài liệu thật, bản đồ thật) — KHÔNG PHẢI ảnh 3D hay AI generated.

=== THỂ LOẠI: 3D INVESTIGATIVE DOCUMENTARY ===
Video documentary điều tra với hình ảnh 3D, kể lại câu chuyện có thật.
Khi kịch bản nhắc đến nhân vật, địa điểm, sự kiện CÓ THẬT → cần ảnh thực tế để tăng tính xác thực.

=== QUY TẮC CHỌN ẢNH ===
1. CHỈ CHỌN 6-10 ẢNH cho toàn video. Không spam. Chọn moment "đắt giá" nhất.
2. Ưu tiên ảnh khi kịch bản nhắc đến:
   - 👤 Nhân vật thật: mugshot, chân dung, ảnh đời thường
   - 📄 Tài liệu: giấy tờ, số liệu liệu, hồ sơ
   - 📰 Tin tức: screenshot báo chí (headline), tiêu đề tin
   - 📍 Địa điểm thật: hiện trường, toà nhà, thành phố
   - 🗺️ Bản đồ: vị trí, tuyến đường, khu vực hoạt động
   - ⚡ Sự kiện thật: phiên toà, bắt giữ, hiện trường vụ án
   - 🔧 Bằng chứng / Tang vật: vũ khí, xe cộ, vật chứng, ảnh minh hoạ khái niệm (ví dụ: dòng tiền rửa tiền)

3. KHÔNG chọn ảnh cho:
   - Đoạn narration chung chung, không nhắc tên cụ thể
   - Đoạn mô tả cảm xúc, suy nghĩ (3D đã lo)
   - Đoạn chuyển cảnh, kết nối (không cần ảnh)

4. MỖI CÂU CÓ THỂ CẦN NHIỀU ẢNH nếu nội dung câu đề cập nhiều đối tượng khác nhau.

5. TIMING — QUAN TRỌNG: Dùng WHISPER WORDS để tìm timing chính xác tới từng từ!
   - Mỗi dòng trong WHISPER WORDS: word|start_second|end_second
   - Tìm từ khoá chính trong whisper words → lấy timing của từ đó (không dùng timing câu)
   - Ví dụ: nhắc "El Mencho" → tìm "El" và "Mencho" trong whisper words → startTime = lúc chữ "El" bắt đầu
   - Ảnh xuất hiện đúng lúc từ khoá được nói — không phải đầu câu!
   - Khi 1 câu cần 2 ảnh → dùng timing từng từ khoá riêng biệt.

6. LOẠI TRỪ: 
   - KHÔNG chọn ảnh biểu đồ (infographic) hoặc ảnh stock minh họa chung chung (phong cảnh, người mẫu...).
   - Chỉ chọn ảnh có tính DẪN CHỨNG, TÀI LIỆU, THỰC TẾ.

7. TỪ KHOÁ TÌM KIẾM: Cung cấp 2-3 variants để tìm trên Google/Pinterest/Wikipedia.
   - Ưu tiên từ khoá tiếng Anh (dễ tìm ảnh quốc tế hơn)
   - Kèm năm/context cụ thể nếu có

${whisperWordsText
    ? `=== WHISPER WORDS (timing từng từ) ===
Format: [giây] từ — mỗi dòng 10 từ
${whisperWordsText}`
    : `=== KỊCH BẢN VIDEO (timecode cấp câu — whisper words chưa có) ===
${scriptText}`
}

=== OUTPUT FORMAT ===
Trả về JSON duy nhất, KHÔNG có text giải thích:
{
  "suggestions": [
    {
      "sentenceNum": 15,
      "description": "Mugshot chính thức của Pablo Escobar năm 1991",
      "searchKeywords": ["Pablo Escobar mugshot 1991", "Escobar mug shot police"],
      "type": "portrait",
      "startTime": 12.3,
      "endTime": 15.0,
      "source": "wikipedia",
      "priority": "high",
      "reason": "Kịch bản nhắc đến Pablo Escobar lần đầu — cần cho khán giả biết mặt nhân vật chính"
    }
  ]
}

⚠️ type phải là 1 trong: portrait, location, map, event, document, headline, evidence
⚠️ source phải là 1 trong: google, pinterest, wikipedia
⚠️ priority phải là 1 trong: high, medium, low
⚠️ startTime/endTime lấy từ WHISPER WORDS — timing chính xác của từ khoá, không phải đầu câu
⚠️ Tối thiểu 6, tối đa 10 suggestions (nếu phân tích toàn bộ video). Chọn lọc kỹ!`
}

/**
 * Prompt AI gợi ý 1 ảnh cụ thể dựa trên khoảng thời gian bạn nhập
 */
export function buildRefImageCustomPrompt(
    sentences: Array<{ num: number; text: string; start: number; end: number }>,
    startTimeMs: number,
    endTimeMs: number
): string {
    const startS = startTimeMs / 1000;
    const endS = endTimeMs / 1000;
    
    // Lọc ra các câu rơi vào khoảng thời gian này
    const relevantSentences = sentences.filter(s => 
        (s.start >= startS && s.start <= endS) || 
        (s.end >= startS && s.end <= endS) ||
        (s.start <= startS && s.end >= endS)
    );

    const scriptText = relevantSentences
        .map((s) => `[Câu ${s.num}] (${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s): ${s.text}`)
        .join("\n");

    return `Bạn là một Researcher / Picture Editor chuyên nghiệp.
Phân tích đoạn kịch bản ngắn sau đây (từ ${startS}s đến ${endS}s) và đề xuất ĐÚNG 1 hình ảnh THỰC TẾ mang tính dẫn chứng/minh hoạ phù hợp nhất cho khoảng thời gian này.

=== QUY TẮC ===
1. CHỈ CHỌN 1 ẢNH DUY NHẤT.
2. KHÔNG chèn ảnh 3D, AI generated, biểu đồ (infographic), hay ảnh stock chung chung. 
3. Ưu tiên: nhân vật thật, địa điểm thật, bản đồ, sự kiện, bằng chứng (evidence), tin tức (headline).
4. Cung cấp 2-3 từ khoá tìm kiếm tốt nhất (ưu tiên tiếng Anh, kèm context/năm).

=== ĐOẠN KỊCH BẢN ===
${scriptText}

=== OUTPUT FORMAT ===
Trả về JSON duy nhất:
{
  "suggestions": [
     {
      "sentenceNum": ${relevantSentences[0]?.num || 1},
      "description": "...",
      "searchKeywords": ["...", "..."],
      "type": "evidence",
      "startTime": ${startS},
      "endTime": ${endS},
      "source": "google",
      "priority": "high",
      "reason": "..."
     }
  ]
}
⚠️ type phải là 1 trong: portrait, location, map, event, document, headline, evidence
⚠️ Không kèm text giải thích, chỉ json hợp lệ.`;
}
