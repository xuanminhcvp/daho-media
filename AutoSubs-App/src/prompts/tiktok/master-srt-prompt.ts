export function buildMasterSrtPrompt(
  whisperWordsBatch: string,
  scriptBatch: string,
  batchIndex: number,
  totalBatches: number
): string {
  return [
    `Bạn là chuyên gia căn chỉnh word-level subtitle.`,
    `Nhiệm vụ: sửa text Whisper theo kịch bản gốc, nhưng giữ nguyên timestamp.`,

    `BATCH ${batchIndex}/${totalBatches}`,

    `WHISPER WORDS`,
    whisperWordsBatch,

    `SCRIPT`,
    scriptBatch,

    `QUY TẮC`,
    `- Giữ nguyên mọi timestamp.`,
    `- Chỉ dùng từ có trong Whisper hoặc trong script.`,
    `- Sửa lỗi ASR theo NGHĨA: số, tên riêng, địa danh, từ nghe gần giống.`,
    `- Bỏ qua khác biệt dấu câu.`,
    `- Nếu Whisper thừa từ không khớp script: bỏ từ đó.`,
    `- Nếu thiếu từ: chỉ thêm khi rất chắc chắn và gắn vào timestamp gần nhất.`,
    `- Không giải thích.`,

    `TRẢ VỀ JSON THUẦN:`,
    `{"words":[{"t":0.13,"w":"El"},{"t":0.45,"w":"Mencho"}]}`
  ].join("\n\n")
}
