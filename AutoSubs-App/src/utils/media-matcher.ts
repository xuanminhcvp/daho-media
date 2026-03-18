// media-matcher.ts
// Thuật toán matching v4: CHARACTER-LEVEL ALIGNMENT + ANTI-JUMP PROTECTION
// Ghép tất cả Whisper words thành 1 chuỗi liên tục → tìm vị trí mỗi câu script
// → ánh xạ ngược về word index → lấy timing chính xác
// FIX v4: Ngăn chặn false-positive seed match khiến lastCharPos nhảy cóc

// ======================== INTERFACES ========================

export interface ScriptSentence {
  num: number;       // Số thứ tự câu
  text: string;      // Nội dung câu gốc
  start: number;     // Thời gian bắt đầu (giây)
  end: number;       // Thời gian kết thúc (giây)
  matchRate: string;  // Thông tin match type
  matchedWhisper: string; // Text Whisper đã match (để review)
  quality: "high" | "medium" | "low" | "none";
}

export interface WhisperWord {
  word: string;      // Từ đã normalize (chỉ a-z, 0-9)
  rawWord: string;   // Từ gốc
  start: number;
  end: number;
}

// ======================== NORMALIZATION ========================

/**
 * Chuẩn hóa text cho matching:
 * - lowercase
 * - bỏ dấu câu, giữ chữ + số + khoảng trắng
 * - tách từ ghép (twenty-second → twenty second)
 * - gộp khoảng trắng
 */
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/['']/g, "'")        // chuẩn hóa dấu nháy
    .replace(/[^a-z0-9\s]/g, " ") // bỏ tất cả dấu câu → thay bằng space
    .replace(/\s+/g, " ")         // gộp khoảng trắng liên tiếp
    .trim();
}

// ======================== PARSE SCRIPT ========================

/**
 * Parse script text thành danh sách câu có số thứ tự
 * Hỗ trợ format: "123. text", "123) text", "123: text"
 */
export function parseScript(scriptText: string): { num: number; text: string }[] {
  const sentences: { num: number; text: string }[] = [];
  const lines = scriptText.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Regex: số + dấu phân cách + text
    const match = trimmed.match(/^(\d+)[.):\s]+\s*(.*)/);
    if (match) {
      const text = match[2].trim();
      if (text.length > 0) {
        sentences.push({
          num: parseInt(match[1]),
          text: text,
        });
      }
    }
  }

  return sentences;
}

// ======================== EXTRACT WHISPER WORDS ========================

/**
 * Trích xuất word-level timing từ transcript JSON
 * Ưu tiên originalSegments (text gốc chưa xử lý số)
 */
export function extractWhisperWords(transcript: any): WhisperWord[] {
  const allWords: WhisperWord[] = [];
  // Ưu tiên originalSegments vì có text gốc (viết chữ thay vì số)
  const segments = transcript.originalSegments || transcript.segments || [];

  for (const seg of segments) {
    const words = seg.words || [];
    for (const w of words) {
      const raw = (w.word || "").trim();
      if (raw.length === 0) continue;

      // Chỉ giữ a-z và 0-9 cho matching
      const cleaned = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (cleaned.length === 0) continue; // bỏ word rỗng sau khi clean

      allWords.push({
        word: cleaned,
        rawWord: raw,
        start: parseFloat(w.start),
        end: parseFloat(w.end),
      });
    }
  }

  return allWords;
}

// ======================== CHARACTER INDEX ========================

/**
 * Ghép tất cả Whisper words thành 1 chuỗi liên tục
 * Tạo bảng ánh xạ: vị trí ký tự → word index
 * 
 * Ví dụ:
 *   words: ["february", "twenty", "second", ...]
 *   fullText: "february twenty second ..."
 *   charToWordIdx: [0,0,...,0, 1,1,...,1, 2,2,...,2, ...]
 *   wordStartChar: [0, 9, 16, ...]
 */
function buildCharacterIndex(whisperWords: WhisperWord[]): {
  fullText: string;
  charToWordIdx: number[];
  wordStartChar: number[];
} {
  const parts: string[] = [];
  const charToWordIdx: number[] = [];
  const wordStartChar: number[] = [];

  for (let i = 0; i < whisperWords.length; i++) {
    // Thêm khoảng trắng giữa các words (trừ word đầu tiên)
    if (i > 0) {
      charToWordIdx.push(i - 1); // Khoảng trắng thuộc word trước
      parts.push(" ");
    }

    // Ghi nhận vị trí ký tự bắt đầu của word này
    wordStartChar.push(charToWordIdx.length);

    // Thêm từng ký tự của word vào mapping
    const w = whisperWords[i].word;
    for (let c = 0; c < w.length; c++) {
      charToWordIdx.push(i);
    }
    parts.push(w);
  }

  return {
    fullText: parts.join(""),
    charToWordIdx,
    wordStartChar,
  };
}

// ======================== TÌM CÂU TRONG TEXT ========================

/**
 * Tìm vị trí của câu script trong chuỗi Whisper
 * 
 * Chiến lược (theo thứ tự ưu tiên):
 * 1. Exact match: tìm toàn bộ câu
 * 2. Long seed (4-5 words đầu): đủ dài để tránh false positive
 * 3. Short seed (3 words đầu): chỉ dùng khi gần vị trí mong đợi
 * 4. Mid seed: tìm 3+ words ở giữa câu
 * 
 * KHÔNG dùng seed 2 words — quá dễ false positive (ví dụ "san francisco")
 * 
 * @param sentenceNorm - Câu script đã normalize
 * @param fullText - Chuỗi Whisper liên tục
 * @param searchFrom - Bắt đầu tìm từ vị trí nào
 * @param maxLookAhead - Tìm tối đa bao nhiêu ký tự phía trước
 */
function findSentenceInText(
  sentenceNorm: string,
  fullText: string,
  searchFrom: number,
  maxLookAhead: number = 8000 // Tăng từ 5000 lên 8000 để tránh miss
): { charStart: number; charEnd: number; matchType: string } | null {

  const words = sentenceNorm.split(" ").filter(w => w.length > 0);
  if (words.length === 0) return null;

  const searchEnd = Math.min(searchFrom + maxLookAhead, fullText.length);
  const searchRegion = fullText.substring(searchFrom, searchEnd);

  // === Chiến lược 1: Tìm TOÀN BỘ câu ===
  const fullIdx = searchRegion.indexOf(sentenceNorm);
  if (fullIdx >= 0) {
    return {
      charStart: searchFrom + fullIdx,
      charEnd: searchFrom + fullIdx + sentenceNorm.length - 1,
      matchType: "exact",
    };
  }

  // === Chiến lược 2: Tìm bằng SEED DÀI (4-5 words đầu) ===
  // Seed dài = ít false positive
  for (let seedLen = Math.min(5, words.length); seedLen >= 4; seedLen--) {
    const seed = words.slice(0, seedLen).join(" ");
    const seedIdx = searchRegion.indexOf(seed);
    if (seedIdx >= 0) {
      const absoluteStart = searchFrom + seedIdx;
      return {
        charStart: absoluteStart,
        charEnd: absoluteStart + sentenceNorm.length - 1,
        matchType: `seed-${seedLen}`,
      };
    }
  }

  // === Chiến lược 3: Tìm bằng SEED 3 words đầu ===
  // Chấp nhận seed 3 words nhưng kiểm tra KHOẢNG CÁCH
  // Nếu match quá xa (> 2000 chars) so với lastCharPos → bỏ qua
  if (words.length >= 3) {
    const seed = words.slice(0, 3).join(" ");
    const seedIdx = searchRegion.indexOf(seed);
    if (seedIdx >= 0 && seedIdx < 2000) { // Chỉ chấp nhận nếu gần
      const absoluteStart = searchFrom + seedIdx;
      return {
        charStart: absoluteStart,
        charEnd: absoluteStart + sentenceNorm.length - 1,
        matchType: "seed-3",
      };
    }
  }

  // === Chiến lược 4: Tìm bằng SEED 3+ words ở GIỮA câu ===
  // Khi words đầu bị Whisper nghe sai
  if (words.length >= 5) {
    for (let startWord = 1; startWord <= Math.min(3, words.length - 3); startWord++) {
      const seed = words.slice(startWord, startWord + 3).join(" ");
      const seedIdx = searchRegion.indexOf(seed);
      if (seedIdx >= 0 && seedIdx < 2000) {
        // Tính lại start: lùi lại cho các words trước seed
        const prefixLen = words.slice(0, startWord).join(" ").length + 1;
        const absoluteStart = Math.max(searchFrom, searchFrom + seedIdx - prefixLen);
        return {
          charStart: absoluteStart,
          charEnd: absoluteStart + sentenceNorm.length - 1,
          matchType: `mid-seed-${startWord}`,
        };
      }
    }
  }

  // === KHÔNG dùng tail-seed hay seed-2 — quá dễ false positive ===

  // === Không tìm thấy ===
  return null;
}

// ======================== THUẬT TOÁN MATCHING CHÍNH v4 ========================

/**
 * Pipeline:
 * 1. Ghép Whisper words thành 1 chuỗi liên tục (character index)
 * 2. Với mỗi câu script tuần tự, tìm vị trí trong chuỗi
 * 3. Ánh xạ vị trí ký tự → word index → timing
 * 4. Anti-jump: nếu match nhảy quá xa so với câu trước → bỏ qua
 */
export function matchScriptToTimeline(
  scriptSentences: { num: number; text: string }[],
  whisperWords: WhisperWord[]
): ScriptSentence[] {
  console.log(`[Matcher v4] Bắt đầu: ${scriptSentences.length} câu, ${whisperWords.length} words`);

  // Bước 1: Xây dựng character index
  const { fullText, charToWordIdx } = buildCharacterIndex(whisperWords);
  console.log(`[Matcher v4] Full text length: ${fullText.length} chars`);
  console.log(`[Matcher v4] Full text starts: "${fullText.substring(0, 100)}"`);

  const results: ScriptSentence[] = [];
  let lastCharPos = 0;           // Vị trí ký tự hiện tại trong fullText
  // @ts-expect-error kept for debugging
  let _lastMatchedCharEnd = 0;    // Vị trí charEnd của match cuối cùng thành công
  let consecutiveMisses = 0;     // Đếm số câu miss liên tiếp

  for (let i = 0; i < scriptSentences.length; i++) {
    const sent = scriptSentences[i];
    const sentNorm = normalizeForMatch(sent.text);

    // Debug: log câu đầu tiên
    if (i < 3) {
      console.log(`[Matcher v4] Câu ${sent.num}: norm="${sentNorm}" | searchFrom=${lastCharPos}`);
    }

    // Tìm câu trong text Whisper
    const match = findSentenceInText(sentNorm, fullText, lastCharPos);

    if (match) {
      // === ANTI-JUMP CHECK ===
      // Nếu match nhảy quá xa (>3000 chars ≈ ~500 words ≈ ~3 phút audio)
      // so với vị trí hiện tại → nhiều khả năng là false positive
      const jumpDistance = match.charStart - lastCharPos;
      if (jumpDistance > 3000 && match.matchType !== "exact") {
        // Nghi ngờ false positive → bỏ qua match này
        console.warn(`[Matcher v4] ⚠️ Câu ${sent.num}: SKIP vì jump quá xa (${jumpDistance} chars), type=${match.matchType}`);

        // Fallback: ước lượng timing
        const prevEnd = results.length > 0 ? results[results.length - 1].end : 0;
        const duration = sentNorm.split(" ").length * 0.4;
        results.push({
          num: sent.num, text: sent.text,
          start: prevEnd, end: prevEnd + duration,
          matchRate: "skipped-jump", matchedWhisper: "(bỏ qua vì jump quá xa)",
          quality: "none",
        });
        consecutiveMisses++;
        continue;
      }

      // Ánh xạ vị trí ký tự → word index
      const clampedStart = Math.min(match.charStart, charToWordIdx.length - 1);
      const clampedEnd = Math.min(match.charEnd, charToWordIdx.length - 1);
      const startWordIdx = charToWordIdx[clampedStart];
      const endWordIdx = charToWordIdx[clampedEnd];

      // Lấy timing từ word index
      const startTime = whisperWords[startWordIdx].start;
      const endTime = whisperWords[endWordIdx].end;

      // Lấy text Whisper đã match
      const matchedWhisper = whisperWords
        .slice(startWordIdx, endWordIdx + 1)
        .map(w => w.rawWord)
        .join(" ")
        .trim();

      // Xác định quality
      const quality: ScriptSentence["quality"] =
        match.matchType === "exact" ? "high" :
          match.matchType.startsWith("seed-") && parseInt(match.matchType.split("-")[1]) >= 3 ? "high" :
            match.matchType.startsWith("seed-") ? "medium" :
              match.matchType.startsWith("mid-seed") ? "medium" : "low";

      results.push({
        num: sent.num, text: sent.text,
        start: startTime, end: endTime,
        matchRate: match.matchType, matchedWhisper: matchedWhisper,
        quality: quality,
      });

      // Di chuyển search position tới SAU match hiện tại
      // Chỉ advance bằng đúng chiều dài câu đã match (không dùng charEnd - có thể overshoot)
      lastCharPos = match.charStart + sentNorm.length;
      _lastMatchedCharEnd = match.charEnd;
      consecutiveMisses = 0;

    } else {
      // === KHÔNG MATCH ===
      // Ước lượng timing từ câu trước
      const prevEnd = results.length > 0 ? results[results.length - 1].end : 0;
      const duration = sentNorm.split(" ").length * 0.4; // ~0.4s/word

      results.push({
        num: sent.num, text: sent.text,
        start: prevEnd, end: prevEnd + duration,
        matchRate: "no-match",
        matchedWhisper: "(không tìm thấy trong transcript)",
        quality: "none",
      });

      consecutiveMisses++;

      // Nếu miss quá nhiều liên tiếp (>5), có thể lastCharPos bị kẹt
      // → thử nhích nhẹ lastCharPos lên để thoát khỏi vùng kẹt
      if (consecutiveMisses > 5 && consecutiveMisses % 5 === 0) {
        const nudge = 100; // Nhích 100 chars ≈ ~15 words
        lastCharPos = Math.min(lastCharPos + nudge, fullText.length);
        console.warn(`[Matcher v4] ⚠️ ${consecutiveMisses} misses liên tiếp, nhích lastCharPos +${nudge} → ${lastCharPos}`);
      }

      console.warn(`[Matcher v4] ❌ Câu ${sent.num}: no match, searchFrom=${lastCharPos}, norm="${sentNorm.slice(0, 40)}..."`);
    }
  }

  // Thống kê kết quả
  const stats = {
    high: results.filter(r => r.quality === "high").length,
    medium: results.filter(r => r.quality === "medium").length,
    low: results.filter(r => r.quality === "low").length,
    none: results.filter(r => r.quality === "none").length,
  };
  console.log(`[Matcher v4] ✅${stats.high} 🟡${stats.medium} 🟠${stats.low} ❌${stats.none}`);

  return results;
}

// ======================== EXPORT REPORT ========================

/**
 * Tạo report chi tiết về kết quả matching
 * Bao gồm: thống kê, mỗi câu (script vs whisper), timing, quality
 */
export function generateMatchReport(
  results: ScriptSentence[],
  mediaFiles: string[]
): string {
  const lines: string[] = [];

  lines.push("═══════════════════════════════════════════════════════");
  lines.push("    MEDIA IMPORT — MATCHING REPORT v4");
  lines.push("═══════════════════════════════════════════════════════");
  lines.push(`Tổng số câu script: ${results.length}`);
  lines.push(`Tổng số video files: ${mediaFiles.length}`);
  lines.push(`Thời gian tạo: ${new Date().toLocaleString("vi-VN")}`);
  lines.push("");

  const stats = {
    high: results.filter(r => r.quality === "high").length,
    medium: results.filter(r => r.quality === "medium").length,
    low: results.filter(r => r.quality === "low").length,
    none: results.filter(r => r.quality === "none").length,
  };

  lines.push("📊 THỐNG KÊ:");
  lines.push(`  ✅ High quality:   ${stats.high} câu (${Math.round(stats.high / results.length * 100)}%)`);
  lines.push(`  🟡 Medium quality: ${stats.medium} câu`);
  lines.push(`  🟠 Low quality:    ${stats.low} câu`);
  lines.push(`  ❌ No match:       ${stats.none} câu`);
  lines.push("");
  lines.push("───────────────────────────────────────────────────────");

  for (const r of results) {
    const hasFile = mediaFiles.some(f => getFileNumber(f) === r.num);
    const duration = (r.end - r.start).toFixed(2);
    const qi = r.quality === "high" ? "✅" : r.quality === "medium" ? "🟡" : r.quality === "low" ? "🟠" : "❌";
    const fi = hasFile ? "📁" : "⚠️ NO FILE";

    lines.push("");
    lines.push(`${qi} CÂU ${r.num} [${r.matchRate}] ${fi}`);
    lines.push(`  📝 Script:  "${r.text}"`);
    lines.push(`  🎤 Whisper: "${r.matchedWhisper}"`);
    lines.push(`  ⏱️ Timing:  ${r.start.toFixed(2)}s → ${r.end.toFixed(2)}s (${duration}s)`);

    if (r.quality === "none") {
      lines.push(`  ⚠️ KHÔNG TÌM THẤY trong transcript!`);
    }
  }

  lines.push("");
  lines.push("═══════════════════════════════════════════════════════");
  lines.push("   CÂU KHÔNG MATCH:");
  lines.push("═══════════════════════════════════════════════════════");

  const problems = results.filter(r => r.quality === "none");
  if (problems.length === 0) {
    lines.push("  Không có — tất cả match tốt! 🎉");
  } else {
    for (const r of problems) {
      lines.push(`  Câu ${r.num}: "${r.text.slice(0, 60)}..."`);
    }
  }

  return lines.join("\n");
}

// ======================== HELPERS ========================

/** Sắp xếp file paths theo số trong tên file */
export function sortFilesByNumber(filePaths: string[]): string[] {
  return [...filePaths].sort((a, b) => getFileNumber(a) - getFileNumber(b));
}

/** Lấy số từ tên file (ví dụ: "scene_42.mp4" → 42) */
export function getFileNumber(filePath: string): number {
  const name = filePath.split(/[/\\]/).pop() || "";
  const match = name.match(/(\d+)/);
  return match ? parseInt(match[1]) : 0;
}
