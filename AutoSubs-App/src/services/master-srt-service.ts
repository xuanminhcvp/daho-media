export interface MasterWord {
  word: string
  start: number
  end: number
}

export interface MasterSrtResult {
  words: MasterWord[]
  createdAt: string
  totalWords: number
}

type WhisperToken = {
  word: string
  t: number
}

type WhisperBatch = {
  startIndex: number
  endIndex: number
  startTime: number
  endTime: number
}

const BATCH_COUNT = 4
const MAX_CONCURRENT = 4 // 4 request song song cho nhanh
const AI_TIMEOUT = 900_000
const RETRY_COUNT = 3
const RETRY_BASE_MS = 5000
const RETRYABLE_STATUS_CODES = [524, 429, 500, 502, 503]
const SCRIPT_OVERLAP_RATIO = 0.12 // giảm overlap để bớt prompt phình

// Chạy nhiều task bất đồng bộ với giới hạn số lượng đồng thời
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  maxConcurrent: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(maxConcurrent, tasks.length) }, async () => {
    while (nextIndex < tasks.length) {
      const currentIndex = nextIndex++
      results[currentIndex] = await tasks[currentIndex]()
    }
  })
  await Promise.all(workers)
  return results
}

async function callMasterSrtAI(prompt: string, label: string): Promise<string> {
  const { callAIMultiProvider } = await import("@/utils/ai-provider")
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
    try {
      const attemptLabel = attempt > 0
        ? `${label} (retry ${attempt}/${RETRY_COUNT})`
        : label

      const result = await callAIMultiProvider(
        prompt,
        attemptLabel,
        "auto",
        AI_TIMEOUT
      )

      if (attempt > 0) {
        console.log(`[MasterSRT] ✅ ${label}: thành công sau ${attempt} lần retry`)
      }

      return result
    } catch (err) {
      const errMsg = String(err)
      const isRetryable =
        RETRYABLE_STATUS_CODES.some(code => errMsg.includes(String(code))) ||
        errMsg.includes("abort") ||
        errMsg.includes("network") ||
        errMsg.includes("rate limit")

      if (isRetryable && attempt < RETRY_COUNT) {
        const delayMs = RETRY_BASE_MS * Math.pow(2, attempt)
        lastError = err as Error
        console.warn(`[MasterSRT] ⚠️ ${label}: ${errMsg.slice(0, 120)} → retry sau ${delayMs / 1000}s`)
        await new Promise(resolve => setTimeout(resolve, delayMs))
        continue
      }

      throw err
    }
  }

  throw lastError || new Error(`AI failed after ${RETRY_COUNT} retries`)
}

function parseWhisperWords(text: string): WhisperToken[] {
  const result: WhisperToken[] = []
  const regex = /\[(\d+\.?\d*)\]\s*(\S+)/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    result.push({
      t: parseFloat(match[1]),
      word: match[2]
    })
  }

  return result
}

function serializeWhisperTokens(tokens: WhisperToken[], startIndex: number, endIndex: number): string {
  const parts = new Array<string>(Math.max(0, endIndex - startIndex))
  let outIdx = 0

  for (let i = startIndex; i < endIndex; i++) {
    const w = tokens[i]
    parts[outIdx++] = `[${w.t.toFixed(2)}] ${w.word}`
  }

  return parts.join(" ")
}

function splitWordIndicesAtSentenceBoundaries(
  allWords: WhisperToken[],
  numParts: number
): WhisperBatch[] {
  if (allWords.length === 0) return []

  const sentenceEnds: number[] = []
  for (let i = 0; i < allWords.length; i++) {
    const w = allWords[i].word
    if (w.endsWith(".") || w.endsWith("?") || w.endsWith("!")) {
      sentenceEnds.push(i + 1)
    }
  }

  // Không có dấu chấm câu (phổ biến với Whisper word-level)
  // → chia đều theo số từ thay vì gộp 1 batch khổng lồ
  if (sentenceEnds.length === 0) {
    const batches: WhisperBatch[] = []
    const chunkSize = Math.ceil(allWords.length / numParts)
    for (let p = 0; p < numParts; p++) {
      const start = p * chunkSize
      const end = Math.min((p + 1) * chunkSize, allWords.length)
      if (start >= allWords.length) break
      batches.push({
        startIndex: start,
        endIndex: end,
        startTime: allWords[start].t,
        endTime: allWords[end - 1].t
      })
    }
    console.log(`[MasterSRT] Không có dấu câu → chia đều ${batches.length} batch, mỗi batch ~${chunkSize} từ`)
    return batches
  }

  const batches: WhisperBatch[] = []
  const idealSize = Math.ceil(allWords.length / numParts)
  let partStart = 0

  for (let p = 0; p < numParts; p++) {
    if (p === numParts - 1) {
      batches.push({
        startIndex: partStart,
        endIndex: allWords.length,
        startTime: allWords[partStart].t,
        endTime: allWords[allWords.length - 1].t
      })
      break
    }

    const target = partStart + idealSize
    let bestIdx = -1
    let bestDist = Infinity

    for (const seIdx of sentenceEnds) {
      if (seIdx <= partStart) continue
      const dist = Math.abs(seIdx - target)
      if (dist < bestDist) {
        bestDist = dist
        bestIdx = seIdx
      }
    }

    if (bestIdx === -1 || bestIdx <= partStart) {
      bestIdx = Math.min(partStart + idealSize, allWords.length)
    }

    batches.push({
      startIndex: partStart,
      endIndex: bestIdx,
      startTime: allWords[partStart].t,
      endTime: allWords[bestIdx - 1].t
    })

    partStart = bestIdx
    if (partStart >= allWords.length) break
  }

  return batches
}

function buildScriptBatches(scriptText: string, batchCount: number): string[] {
  const scriptLines = scriptText.split(/\n+/).filter(l => l.trim())
  if (batchCount <= 1) return [scriptLines.join("\n")]

  const linesPerPart = scriptLines.length / batchCount
  const overlapSize = Math.ceil(linesPerPart * SCRIPT_OVERLAP_RATIO)
  const result = new Array<string>(batchCount)

  for (let i = 0; i < batchCount; i++) {
    const rawStart = Math.floor(linesPerPart * i)
    const rawEnd = Math.ceil(linesPerPart * (i + 1))
    const batchStart = Math.max(0, rawStart - overlapSize)
    const batchEnd = Math.min(scriptLines.length, rawEnd + overlapSize)
    result[i] = scriptLines.slice(batchStart, batchEnd).join("\n")
  }

  return result
}

function makeFallbackWords(batchWords: WhisperToken[]): MasterWord[] {
  const result = new Array<MasterWord>(batchWords.length)

  for (let i = 0; i < batchWords.length; i++) {
    const current = batchWords[i]
    const next = batchWords[i + 1]
    result[i] = {
      word: current.word,
      start: current.t,
      end: next ? next.t : current.t + 0.3
    }
  }

  return result
}

function parseAIResponse(
  aiResponse: string,
  fallbackWords: WhisperToken[]
): MasterWord[] {
  // === DEBUG: log raw response để bắt lỗi ===
  console.log(`[MasterSRT-Parse] Raw response length: ${aiResponse.length} chars`)
  console.log(`[MasterSRT-Parse] Raw response (first 500):`, aiResponse.slice(0, 500))

  let cleaned = aiResponse

  if (cleaned.includes("<thinking>")) {
    const before = cleaned.length
    cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    console.log(`[MasterSRT-Parse] Removed <thinking> block: ${before - cleaned.length} chars`)
  }

  const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlock) {
    cleaned = codeBlock[1]
    console.log(`[MasterSRT-Parse] Extracted from code block, length: ${cleaned.length}`)
  }

  let jsonStr = ""
  const firstBrace = cleaned.indexOf("{")
  const lastBrace = cleaned.lastIndexOf("}")

  console.log(`[MasterSRT-Parse] firstBrace=${firstBrace}, lastBrace=${lastBrace}, cleaned.length=${cleaned.length}`)

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    jsonStr = cleaned.slice(firstBrace, lastBrace + 1)
    console.log(`[MasterSRT-Parse] JSON slice length: ${jsonStr.length} (first 200):`, jsonStr.slice(0, 200))
  } else {
    console.error(`[MasterSRT-Parse] ❌ Không tìm thấy JSON! Cleaned (first 300):`, cleaned.slice(0, 300))
    throw new Error("AI response không chứa JSON hợp lệ")
  }

  const parsed = JSON.parse(jsonStr)
  console.log(`[MasterSRT-Parse] parsed keys:`, Object.keys(parsed || {}))

  const words = Array.isArray(parsed?.words)
    ? parsed.words
    : (Array.isArray(parsed) ? parsed : [])

  console.log(`[MasterSRT-Parse] words array length: ${words.length}, sample[0]:`, words[0])

  const result: MasterWord[] = []

  for (let i = 0; i < words.length; i++) {
    const item = words[i]
    if (!item) continue

    const rawStart = item.t ?? item.start
    const rawWord = item.w ?? item.word

    if (rawStart === undefined || rawWord === undefined || rawWord === null) {
      // Log vài item bị bỏ qua để debug
      if (i < 5) console.warn(`[MasterSRT-Parse] item[${i}] bị bỏ qua:`, item)
      continue
    }

    const start = Number(rawStart)
    if (!Number.isFinite(start)) {
      if (i < 5) console.warn(`[MasterSRT-Parse] item[${i}] start không hợp lệ:`, rawStart)
      continue
    }

    result.push({
      word: String(rawWord),
      start,
      end: start + 0.3
    })
  }

  console.log(`[MasterSRT-Parse] result.length: ${result.length} (fallback: ${fallbackWords.length})`)

  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }

  if (result.length < fallbackWords.length * 0.3 && fallbackWords.length > 10) {
    throw new Error(`AI response quá ngắn: ${result.length}/${fallbackWords.length}`)
  }

  return result
}

function appendDeduped(target: MasterWord[], source: MasterWord[]): void {
  for (let i = 0; i < source.length; i++) {
    const w = source[i]
    const prev = target[target.length - 1]

    if (
      prev &&
      Math.abs(prev.start - w.start) < 0.05 &&
      prev.word === w.word
    ) {
      continue
    }

    target.push(w)
  }
}

export async function createMasterSrt(
  whisperWordsText: string,
  scriptText: string,
  onProgress?: (msg: string, percent: number) => void
): Promise<MasterSrtResult> {
  const { buildMasterSrtPrompt } = await import("@/prompts/master-srt-prompt")

  // Parse duy nhất 1 lần
  const allTokens = parseWhisperWords(whisperWordsText)
  if (allTokens.length === 0) {
    return {
      words: [],
      createdAt: new Date().toISOString(),
      totalWords: 0
    }
  }

  const transcriptParts = splitWordIndicesAtSentenceBoundaries(allTokens, BATCH_COUNT)
  // Gửi FULL kịch bản cho mỗi batch — AI cần toàn bộ script để so khớp chuẩn
  const fullScript = scriptText.trim()

  onProgress?.(`Chia ${allTokens.length} từ → ${transcriptParts.length} batch`, 5)
  console.log(`[MasterSRT] ${allTokens.length} words → ${transcriptParts.length} batches`)

  const totalBatches = transcriptParts.length
  let completedCount = 0

  // Tạo 4 task song song — mỗi task parse batch riêng, không giữ string thừa
  const batchTasks = transcriptParts.map((part, i) => async (): Promise<MasterWord[]> => {
    const batchWords = allTokens.slice(part.startIndex, part.endIndex)
    const timeRange = `${part.startTime.toFixed(0)}s → ${part.endTime.toFixed(0)}s`

    console.log(`[DEBUG-MSRT] ▶ Batch ${i + 1} BẮT ĐẦU — ${timeRange}, ${batchWords.length} từ`)

    try {
      const whisperBatchText = serializeWhisperTokens(allTokens, part.startIndex, part.endIndex)
      const prompt = buildMasterSrtPrompt(
        whisperBatchText,
        fullScript,  // Gửi FULL kịch bản — AI cần toàn bộ để so khớp chuẩn
        i + 1,
        totalBatches
      )

      console.log(`[DEBUG-MSRT] Batch ${i + 1}: prompt ${(prompt.length / 1000).toFixed(1)}KB — gọi AI...`)

      const response = await callMasterSrtAI(
        prompt,
        `Master SRT batch ${i + 1}/${totalBatches} (${timeRange})`
      )

      // ★ Điểm quan trọng: AI đã trả về
      console.log(`[DEBUG-MSRT] ★ Batch ${i + 1} AI XONG — response: ${response.length} chars, type: ${typeof response}`)
      console.log(`[DEBUG-MSRT] Batch ${i + 1} snippet:`, response.slice(0, 200))

      console.log(`[DEBUG-MSRT] Batch ${i + 1} → parseAIResponse bắt đầu...`)
      const result = parseAIResponse(response, batchWords)
      console.log(`[DEBUG-MSRT] ★ Batch ${i + 1} parseAIResponse XONG — ${result.length} từ`)

      completedCount++
      const progressMsg = `✓ ${completedCount}/${totalBatches} batch xong (batch ${i + 1}: ${result.length} từ)`
      console.log(`[DEBUG-MSRT] Batch ${i + 1} → onProgress: "${progressMsg}"`)
      onProgress?.(progressMsg, 10 + (completedCount / totalBatches) * 80)

      console.log(`[DEBUG-MSRT] ✅ Batch ${i + 1} HOÀN TẤT — trả về ${result.length} words`)
      return result
    } catch (err) {
      console.error(`[DEBUG-MSRT] ❌ Batch ${i + 1} LỖI:`, err)
      console.error(`[DEBUG-MSRT] Batch ${i + 1} stack:`, (err as Error)?.stack)
      completedCount++
      onProgress?.(
        `⚠ Batch ${i + 1} dùng text gốc | ${completedCount}/${totalBatches}`,
        10 + (completedCount / totalBatches) * 80
      )
      const fallback = makeFallbackWords(batchWords)
      console.log(`[DEBUG-MSRT] Batch ${i + 1} fallback: ${fallback.length} từ`)
      return fallback
    }
  })

  // Chạy song song tối đa MAX_CONCURRENT batch
  console.log(`[DEBUG-MSRT] ▶ runWithConcurrency bắt đầu — ${totalBatches} tasks, max ${MAX_CONCURRENT}`)
  onProgress?.(`Gửi ${totalBatches} batch (max ${MAX_CONCURRENT} đồng thời)...`, 10)
  const batchResults = await runWithConcurrency(batchTasks, MAX_CONCURRENT)
  console.log(`[DEBUG-MSRT] ★ runWithConcurrency XONG — ${batchResults.length} batch results`)
  batchResults.forEach((r, i) => console.log(`[DEBUG-MSRT]   Batch ${i + 1} result: ${r?.length ?? 'null'} từ`))

  // Gom kết quả theo thứ tự thời gian + loại trùng
  console.log(`[DEBUG-MSRT] ▶ appendDeduped bắt đầu...`)
  const allWords: MasterWord[] = []
  for (const batch of batchResults) {
    appendDeduped(allWords, batch)
  }
  console.log(`[DEBUG-MSRT] ★ appendDeduped XONG — tổng ${allWords.length} từ`)

  // Fill end time: end(i) = start(i+1)
  for (let i = 0; i < allWords.length - 1; i++) {
    allWords[i].end = allWords[i + 1].start
  }

  const finalResult = {
    words: allWords,
    createdAt: new Date().toISOString(),
    totalWords: allWords.length
  }
  console.log(`[DEBUG-MSRT] ★★★ createMasterSrt RETURN — ${finalResult.totalWords} từ`)

  onProgress?.(`✅ Master SRT: ${allWords.length} từ`, 100)

  return finalResult
}

export interface VerifyResult {
  totalMasterWords: number
  totalScriptWords: number
  matchedWords: number
  matchPercent: number
  timestampGaps: number
  verdict: "good" | "ok" | "poor"
  unmatchedSamples: string[]
}

export function verifyMasterSrt(
  masterWords: MasterWord[],
  scriptText: string
): VerifyResult {
  const scriptWordsRaw = scriptText
    .replace(/[^\w\s'-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 0)

  const scriptWordsLower = new Set(scriptWordsRaw.map(w => w.toLowerCase()))

  let matchedCount = 0
  const unmatched: string[] = []

  for (const mw of masterWords) {
    const wordLower = mw.word.toLowerCase().replace(/[^\w'-]/g, "")
    if (wordLower.length === 0) continue

    if (scriptWordsLower.has(wordLower)) {
      matchedCount++
    } else {
      const found = scriptWordsRaw.some(sw => {
        const swLower = sw.toLowerCase()
        return swLower === wordLower || swLower.includes(wordLower) || wordLower.includes(swLower)
      })

      if (found) {
        matchedCount++
      } else if (unmatched.length < 20) {
        unmatched.push(mw.word)
      }
    }
  }

  let gapCount = 0
  for (let i = 1; i < masterWords.length; i++) {
    if (masterWords[i].start - masterWords[i - 1].start > 5) gapCount++
  }

  const matchPercent = masterWords.length > 0
    ? Math.round((matchedCount / masterWords.length) * 1000) / 10
    : 0

  let verdict: "good" | "ok" | "poor"
  if (matchPercent >= 90) verdict = "good"
  else if (matchPercent >= 75) verdict = "ok"
  else verdict = "poor"

  return {
    totalMasterWords: masterWords.length,
    totalScriptWords: scriptWordsRaw.length,
    matchedWords: matchedCount,
    matchPercent,
    timestampGaps: gapCount,
    verdict,
    unmatchedSamples: unmatched
  }
}
