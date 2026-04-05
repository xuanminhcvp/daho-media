// capcut-subtitle-source-service.ts
// ============================================================
// Mục tiêu:
// - Đọc word timing subtitle có sẵn trong CapCut Draft.
// - Chuyển dữ liệu đó về format transcript nội bộ của app (segments + words).
// - Cho phép pipeline Auto Media tái sử dụng trực tiếp, không cần chạy Whisper lại.
//
// Request vào service:
// - draftDirPath: đường dẫn thư mục draft CapCut
//   Ví dụ: ~/Movies/CapCut/User Data/Projects/com.lveditor.draft/AutoMedia_2026-04-04
//
// Response trả về:
// - transcript: object tương thích saveTranscript/processTranscriptionResults
// - stats: số câu/số từ + file nguồn đã đọc
//
// Ghi chú:
// - CapCut lưu time theo milliseconds (ms), app dùng seconds (s).
// - 1 giây = 1000 ms.
// ============================================================

import { exists, readDir, readTextFile } from '@tauri-apps/plugin-fs'
import { join, homeDir } from '@tauri-apps/api/path'

interface CapCutWordRaw {
  text?: string
  start_time?: number
  end_time?: number
}

interface CapCutSentenceRaw {
  text?: string
  start_time?: number
  end_time?: number
  words?: CapCutWordRaw[]
}

interface CapCutSubtitleCacheRaw {
  sentence_list?: CapCutSentenceRaw[]
}

interface CapCutWordsObjectRaw {
  start_time?: number[]
  end_time?: number[]
  text?: string[]
}

interface InternalWord {
  word: string
  start: number
  end: number
  line_number: number
}

interface InternalSegment {
  id: number
  start: number
  end: number
  text: string
  words: InternalWord[]
}

export interface CapCutSubtitleTranscriptResult {
  transcript: {
    segments: InternalSegment[]
    originalSegments: InternalSegment[]
    speakers: any[]
    processing_time_sec: number
    source: 'capcut_subtitle_cache'
  }
  stats: {
    sourceFile: string
    sentenceCount: number
    wordCount: number
  }
}

/** 1 draft hiển thị trong dropdown chọn nhanh */
export interface CapCutDraftSubtitleOption {
  /** Tên thư mục draft (label ngắn cho UI) */
  name: string
  /** Đường dẫn tuyệt đối thư mục draft */
  path: string
  /** Draft này có subtitle_cache_info hay không (optional, chỉ có khi quét sâu) */
  hasSubtitleCache?: boolean
  /** Số câu subtitle (optional, chỉ có khi quét sâu) */
  sentenceCount?: number
}

/**
 * Kết quả discovery draft root cho CapCut.
 * UI dùng metadata này để quyết định có hiện nút chọn root thủ công hay không.
 */
export interface CapCutDraftDiscoveryResult {
  drafts: CapCutDraftSubtitleOption[]
  /** Root mặc định app kỳ vọng */
  defaultDraftsRoot: string
  /** Root Projects cha để mở file picker nhanh */
  projectsRoot: string
  /** Root thực tế đang dùng để list drafts */
  usedDraftsRoot: string
  /** Mặc định com.lveditor.draft không tồn tại */
  isDefaultDraftsRootMissing: boolean
  /** Có đang dùng root custom do user chọn hay không */
  isUsingCustomRoot: boolean
}

/** Đổi milliseconds -> seconds, làm tròn 3 chữ số cho ổn định hiển thị */
function msToSec(ms: number): number {
  return Math.max(0, Math.round((ms / 1000) * 1000) / 1000)
}

/** Parse JSON an toàn: lỗi parse thì trả null thay vì throw */
function safeJsonParse(content: string): any | null {
  try {
    return JSON.parse(content)
  } catch {
    return null
  }
}

/**
 * Tìm subtitle cache trong 1 object draft JSON.
 * Ưu tiên đúng key `subtitle_cache_info` và có sentence_list.
 */
function extractSubtitleCacheFromDraftJson(draftJson: any): CapCutSubtitleCacheRaw | null {
  if (!draftJson || typeof draftJson !== 'object') return null

  const direct = draftJson.subtitle_cache_info
  if (direct && Array.isArray(direct.sentence_list) && direct.sentence_list.length > 0) {
    return direct
  }

  // Fallback: recursive scan các object con, đề phòng CapCut đổi vị trí field.
  const stack: any[] = [draftJson]
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue

    if (node.subtitle_cache_info && Array.isArray(node.subtitle_cache_info.sentence_list) && node.subtitle_cache_info.sentence_list.length > 0) {
      return node.subtitle_cache_info
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') stack.push(value)
    }
  }

  return null
}

/**
 * Chuyển sentence_list CapCut -> segments nội bộ.
 * Rule cứng:
 * - start/end tăng dần
 * - end >= start
 * - words nằm trong biên segment
 */
function convertSentenceListToSegments(sentenceList: CapCutSentenceRaw[]): InternalSegment[] {
  const segments: InternalSegment[] = []

  for (let i = 0; i < sentenceList.length; i++) {
    const s = sentenceList[i] || {}

    const rawStartMs = Number(s.start_time ?? 0)
    const rawEndMs = Number(s.end_time ?? rawStartMs)

    const segStart = msToSec(rawStartMs)
    const segEnd = Math.max(segStart, msToSec(rawEndMs))

    const wordsRaw = Array.isArray(s.words) ? s.words : []
    const words: InternalWord[] = wordsRaw
      .map((w) => {
        const text = String(w?.text ?? '').trim()
        if (!text) return null

        const wStart = Math.max(segStart, msToSec(Number(w?.start_time ?? rawStartMs)))
        const wEnd = Math.max(wStart, Math.min(segEnd, msToSec(Number(w?.end_time ?? rawEndMs))))

        return {
          word: text,
          start: wStart,
          end: wEnd,
          line_number: 0,
        }
      })
      .filter((w): w is InternalWord => Boolean(w))

    const textFromWords = words.map((w) => w.word).join(' ').trim()
    const text = textFromWords || String(s.text ?? '').trim()

    if (!text) continue

    segments.push({
      id: i,
      start: segStart,
      end: segEnd,
      text,
      words,
    })
  }

  // Ép lại timeline không chồng chéo + đúng thứ tự.
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].start < segments[i - 1].start) {
      segments[i].start = segments[i - 1].start
    }
    if (segments[i].end < segments[i].start) {
      segments[i].end = segments[i].start
    }
  }

  return segments
}

/**
 * Fallback extractor:
 * Đọc word timing từ materials.texts[].words và map theo text track segments.
 *
 * Dữ liệu CapCut kiểu này thường có:
 * - tracks[type=text].segments[].target_timerange.start (microseconds)
 * - materials.texts[].words.start_time/end_time/text (milliseconds, relative theo segment)
 *
 * Request:
 * - draftJson: object draft_info.json
 *
 * Response:
 * - segments nội bộ có words absolute time (seconds)
 */
function extractSegmentsFromMaterialsWords(draftJson: any): InternalSegment[] {
  if (!draftJson || typeof draftJson !== 'object') return []

  const tracks = Array.isArray(draftJson?.tracks) ? draftJson.tracks : []
  const materialsTexts = Array.isArray(draftJson?.materials?.texts) ? draftJson.materials.texts : []
  if (materialsTexts.length === 0) return []

  const textMatById = new Map<string, any>()
  for (const m of materialsTexts) {
    const id = String(m?.id ?? '')
    if (id) textMatById.set(id, m)
  }

  const segmentsOut: InternalSegment[] = []
  let idx = 0

  for (const track of tracks) {
    if (String(track?.type || '').toLowerCase() !== 'text') continue
    const segs = Array.isArray(track?.segments) ? track.segments : []

    for (const seg of segs) {
      const materialId = String(seg?.material_id ?? '')
      if (!materialId) continue
      const mat = textMatById.get(materialId)
      if (!mat) continue

      const wordsObj: CapCutWordsObjectRaw | null =
        mat?.words && typeof mat.words === 'object' ? mat.words : null
      if (!wordsObj) continue

      const starts = Array.isArray(wordsObj.start_time) ? wordsObj.start_time : []
      const ends = Array.isArray(wordsObj.end_time) ? wordsObj.end_time : []
      const texts = Array.isArray(wordsObj.text) ? wordsObj.text : []
      const n = Math.min(starts.length, ends.length, texts.length)
      if (n <= 0) continue

      const segStartUs = Number(seg?.target_timerange?.start ?? 0)
      const segDurationUs = Number(seg?.target_timerange?.duration ?? 0)
      const segStartSec = Math.max(0, segStartUs / 1_000_000)
      const segEndFromDuration = Math.max(segStartSec, segStartSec + segDurationUs / 1_000_000)

      const words: InternalWord[] = []
      const textTokens: string[] = []

      for (let i = 0; i < n; i++) {
        const tkRaw = String(texts[i] ?? '')
        textTokens.push(tkRaw)

        const tk = tkRaw.trim()
        // Token trắng chỉ dùng để ghép text segment, không đẩy vào words list.
        if (!tk) continue

        const wStartSec = msToSec(segStartSec * 1000 + Number(starts[i] ?? 0))
        const wEndSec = msToSec(segStartSec * 1000 + Number(ends[i] ?? starts[i] ?? 0))
        words.push({
          word: tk,
          start: wStartSec,
          end: Math.max(wStartSec, wEndSec),
          line_number: 0,
        })
      }

      if (words.length === 0) continue

      const joinedText = textTokens.join('').replace(/\s+/g, ' ').trim()
      const segStart = words[0].start
      const segEnd = Math.max(words[words.length - 1].end, segEndFromDuration)

      segmentsOut.push({
        id: idx++,
        start: segStart,
        end: segEnd,
        text: joinedText || words.map((w) => w.word).join(' '),
        words,
      })
    }
  }

  // ======================== FALLBACK CỨNG ========================
  // Một số draft (sau khi convert/ghi đè) có materials.texts[].words đầy đủ
  // nhưng mapping qua tracks/material_id bị thiếu hoặc không nhất quán.
  // Khi đó vẫn dựng transcript từ chính materials words để không mất dữ liệu timing.
  //
  // Cách dựng:
  // - Mỗi text material thành 1 segment.
  // - Timing words là relative (ms) -> cộng dồn theo cursorMs để tạo timeline liên tục.
  if (segmentsOut.length === 0 && materialsTexts.length > 0) {
    let cursorMs = 0

    for (const mat of materialsTexts) {
      const wordsObj: CapCutWordsObjectRaw | null =
        mat?.words && typeof mat.words === 'object' ? mat.words : null
      if (!wordsObj) continue

      const starts = Array.isArray(wordsObj.start_time) ? wordsObj.start_time : []
      const ends = Array.isArray(wordsObj.end_time) ? wordsObj.end_time : []
      const texts = Array.isArray(wordsObj.text) ? wordsObj.text : []
      const n = Math.min(starts.length, ends.length, texts.length)
      if (n <= 0) continue

      const words: InternalWord[] = []
      const textTokens: string[] = []
      let localMaxEndMs = 0

      for (let i = 0; i < n; i++) {
        const tkRaw = String(texts[i] ?? '')
        textTokens.push(tkRaw)

        const startMs = Number(starts[i] ?? 0)
        const endMs = Number(ends[i] ?? starts[i] ?? 0)
        localMaxEndMs = Math.max(localMaxEndMs, endMs)

        const tk = tkRaw.trim()
        if (!tk) continue

        const wStartSec = msToSec(cursorMs + startMs)
        const wEndSec = msToSec(cursorMs + Math.max(startMs, endMs))
        words.push({
          word: tk,
          start: wStartSec,
          end: Math.max(wStartSec, wEndSec),
          line_number: 0,
        })
      }

      // Không có token chữ thì bỏ qua material này nhưng vẫn tiến cursor để giữ nhịp timeline.
      if (words.length === 0) {
        cursorMs += Math.max(1, localMaxEndMs)
        continue
      }

      const joinedText = textTokens.join('').replace(/\s+/g, ' ').trim()
      const segStart = words[0].start
      const segEnd = Math.max(words[words.length - 1].end, msToSec(cursorMs + localMaxEndMs))

      segmentsOut.push({
        id: idx++,
        start: segStart,
        end: segEnd,
        text: joinedText || words.map((w) => w.word).join(' '),
        words,
      })

      cursorMs += Math.max(1, localMaxEndMs)
    }
  }

  // Sort + normalize để tránh lệch thứ tự.
  segmentsOut.sort((a, b) => a.start - b.start)
  for (let i = 1; i < segmentsOut.length; i++) {
    if (segmentsOut[i].start < segmentsOut[i - 1].start) {
      segmentsOut[i].start = segmentsOut[i - 1].start
    }
    if (segmentsOut[i].end < segmentsOut[i].start) {
      segmentsOut[i].end = segmentsOut[i].start
    }
  }

  return segmentsOut
}

/**
 * Tìm file draft_info có subtitle cache:
 * 1) Ưu tiên root draft_info.json.
 * 2) Nếu root không có, quét Timelines/<timeline-id>/draft_info.json và lấy file có nhiều sentence nhất.
 */
async function resolveDraftInfoWithSubtitle(draftDirPath: string): Promise<{ sourceFile: string; sentenceList: CapCutSentenceRaw[] } | null> {
  const rootDraftInfoPath = await join(draftDirPath, 'draft_info.json')

  if (await exists(rootDraftInfoPath)) {
    const rootContent = await readTextFile(rootDraftInfoPath)
    const rootJson = safeJsonParse(rootContent)
    const rootCache = extractSubtitleCacheFromDraftJson(rootJson)
    if (rootCache?.sentence_list && rootCache.sentence_list.length > 0) {
      return { sourceFile: rootDraftInfoPath, sentenceList: rootCache.sentence_list }
    }
  }

  const timelinesDir = await join(draftDirPath, 'Timelines')
  if (!(await exists(timelinesDir)) ) return null

  const timelineEntries = await readDir(timelinesDir)
  let best: { sourceFile: string; sentenceList: CapCutSentenceRaw[] } | null = null

  for (const entry of timelineEntries) {
    if (!entry.isDirectory || !entry.name) continue
    const timelineDraftPath = await join(timelinesDir, entry.name, 'draft_info.json')
    if (!(await exists(timelineDraftPath))) continue

    const content = await readTextFile(timelineDraftPath)
    const json = safeJsonParse(content)
    const cache = extractSubtitleCacheFromDraftJson(json)
    if (!cache?.sentence_list || cache.sentence_list.length === 0) continue

    if (!best || cache.sentence_list.length > best.sentenceList.length) {
      best = { sourceFile: timelineDraftPath, sentenceList: cache.sentence_list }
    }
  }

  return best
}

/**
 * API chính: đọc subtitle có sẵn từ draft CapCut.
 */
export async function buildTranscriptFromCapCutDraftSubtitle(
  draftDirPath: string,
): Promise<CapCutSubtitleTranscriptResult> {
  if (!draftDirPath) {
    throw new Error('Thiếu đường dẫn draft CapCut')
  }

  const found = await resolveDraftInfoWithSubtitle(draftDirPath)
  let sourceFile = ''
  let segments: InternalSegment[] = []

  if (found) {
    sourceFile = found.sourceFile
    segments = convertSentenceListToSegments(found.sentenceList)
  } else {
    // Fallback: thử đọc từ materials.texts[].words ở root draft_info + timeline draft_info.
    const rootDraftInfoPath = await join(draftDirPath, 'draft_info.json')
    if (await exists(rootDraftInfoPath)) {
      const rootJson = safeJsonParse(await readTextFile(rootDraftInfoPath))
      const fromRootMaterials = extractSegmentsFromMaterialsWords(rootJson)
      if (fromRootMaterials.length > 0) {
        sourceFile = rootDraftInfoPath
        segments = fromRootMaterials
      }
    }

    if (segments.length === 0) {
      const timelinesDir = await join(draftDirPath, 'Timelines')
      if (await exists(timelinesDir)) {
        const timelineEntries = await readDir(timelinesDir)
        let bestSegments: InternalSegment[] = []
        let bestSourceFile = ''
        for (const entry of timelineEntries) {
          if (!entry.isDirectory || !entry.name) continue
          const timelineDraftPath = await join(timelinesDir, entry.name, 'draft_info.json')
          if (!(await exists(timelineDraftPath))) continue
          const json = safeJsonParse(await readTextFile(timelineDraftPath))
          const fromMaterials = extractSegmentsFromMaterialsWords(json)
          if (fromMaterials.length > bestSegments.length) {
            bestSegments = fromMaterials
            bestSourceFile = timelineDraftPath
          }
        }
        if (bestSegments.length > 0) {
          sourceFile = bestSourceFile
          segments = bestSegments
        }
      }
    }
  }

  if (segments.length === 0) {
    throw new Error('Draft CapCut không có word timing ở cả subtitle_cache_info và materials.texts.words')
  }

  const wordCount = segments.reduce((sum, seg) => sum + seg.words.length, 0)

  return {
    transcript: {
      segments,
      originalSegments: segments,
      speakers: [],
      processing_time_sec: 0,
      source: 'capcut_subtitle_cache',
    },
    stats: {
      sourceFile,
      sentenceCount: segments.length,
      wordCount,
    },
  }
}

/**
 * Quét danh sách draft CapCut để hiện vào UI:
 * - Trả cả draft có subtitle và không có subtitle (để user nhìn toàn cảnh).
 * - UI có thể ưu tiên chọn draft có sentenceCount > 0.
 */
export async function listCapCutDraftsWithSubtitle(limit = 30): Promise<CapCutDraftSubtitleOption[]> {
  const discovery = await discoverCapCutDraftsFast()
  const draftsRoot = discovery.usedDraftsRoot
  if (!draftsRoot || discovery.drafts.length === 0) return []

  const entries = await readDir(draftsRoot)
  const draftNames = entries
    .filter((e) => e.isDirectory && Boolean(e.name))
    .map((e) => e.name as string)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .slice(0, Math.max(1, limit))

  const results: CapCutDraftSubtitleOption[] = []

  for (const draftName of draftNames) {
    const draftPath = await join(draftsRoot, draftName)
    const found = await resolveDraftInfoWithSubtitle(draftPath)
    const sentenceCount = found?.sentenceList?.length ?? 0
    results.push({
      name: draftName,
      path: draftPath,
      hasSubtitleCache: sentenceCount > 0,
      sentenceCount,
    })
  }

  return results
}

/**
 * Quét NHANH toàn bộ draft để đổ dropdown:
 * - Chỉ đọc tên thư mục, KHÔNG parse draft_info.json.
 * - Mục tiêu: mở dropdown tức thì, không bị lag.
 */
export async function listCapCutDraftsFast(): Promise<CapCutDraftSubtitleOption[]> {
  const discovery = await discoverCapCutDraftsFast()
  return discovery.drafts
}

/**
 * Discovery nhanh root + danh sách draft.
 *
 * Flow:
 * 1) Ưu tiên root user chọn (nếu có).
 * 2) Nếu không có, dùng root mặc định com.lveditor.draft.
 * 3) Nếu root mặc định mất, fallback quét quanh Projects/ để tìm root tên gần giống draft.
 */
export async function discoverCapCutDraftsFast(customDraftsRoot?: string): Promise<CapCutDraftDiscoveryResult> {
  const home = await homeDir()
  const projectsRoot = await join(home, 'Movies', 'CapCut', 'User Data', 'Projects')
  const defaultDraftsRoot = await join(projectsRoot, 'com.lveditor.draft')

  const normalizePath = (path: string) => path.replace(/\/+$/, '')
  const customRoot = (customDraftsRoot || '').trim()
  const customRootExists = customRoot ? await exists(customRoot) : false
  const defaultRootExists = await exists(defaultDraftsRoot)

  // Quy tắc ưu tiên root:
  // - Có custom hợp lệ: dùng custom.
  // - Không có custom: dùng mặc định.
  // - Nếu mặc định không có: thử auto-discover trong Projects.
  let draftsRootToUse = ''
  let isUsingCustomRoot = false
  if (customRootExists) {
    draftsRootToUse = customRoot
    isUsingCustomRoot = true
  } else if (defaultRootExists) {
    draftsRootToUse = defaultDraftsRoot
  } else {
    const guessedRoot = await guessDraftsRootFromProjects(projectsRoot)
    draftsRootToUse = guessedRoot || ''
  }

  if (!draftsRootToUse || !(await exists(draftsRootToUse))) {
    return {
      drafts: [],
      defaultDraftsRoot,
      projectsRoot,
      usedDraftsRoot: draftsRootToUse || defaultDraftsRoot,
      isDefaultDraftsRootMissing: !defaultRootExists,
      isUsingCustomRoot,
    }
  }

  // Trường hợp user chọn thẳng vào 1 draft folder (có draft_info.json) thay vì root:
  // vẫn cho phép chạy, trả 1 option duy nhất để không làm hỏng UX.
  const directDraftInfoPath = await join(draftsRootToUse, 'draft_info.json')
  if (await exists(directDraftInfoPath)) {
    const folderName = normalizePath(draftsRootToUse).split('/').pop() || 'draft'
    return {
      drafts: [{ name: folderName, path: draftsRootToUse }],
      defaultDraftsRoot,
      projectsRoot,
      usedDraftsRoot: draftsRootToUse,
      isDefaultDraftsRootMissing: !defaultRootExists,
      isUsingCustomRoot,
    }
  }

  const entries = await readDir(draftsRootToUse)
  const draftNames = entries
    .filter((e) => e.isDirectory && Boolean(e.name))
    .map((e) => e.name as string)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))

  const drafts = await Promise.all(
    draftNames.map(async (name) => ({
      name,
      path: await join(draftsRootToUse, name),
    }))
  )

  return {
    drafts,
    defaultDraftsRoot,
    projectsRoot,
    usedDraftsRoot: draftsRootToUse,
    isDefaultDraftsRootMissing: !defaultRootExists,
    isUsingCustomRoot,
  }
}

/**
 * Fallback finder:
 * - Quét trong ~/Movies/CapCut/User Data/Projects/
 * - Ưu tiên folder có tên chứa "draft" và có nhiều draft con nhất.
 */
async function guessDraftsRootFromProjects(projectsRoot: string): Promise<string> {
  if (!(await exists(projectsRoot))) return ''

  const entries = await readDir(projectsRoot)
  const directories = entries
    .filter((e) => e.isDirectory && Boolean(e.name))
    .map((e) => e.name as string)

  const likelyNames = directories.filter((name) => /draft/i.test(name))
  const candidates = likelyNames.length > 0 ? likelyNames : directories

  let bestRoot = ''
  let bestScore = -1

  for (const folderName of candidates) {
    const candidateRoot = await join(projectsRoot, folderName)
    const score = await scoreDraftsRoot(candidateRoot)
    if (score > bestScore) {
      bestScore = score
      bestRoot = candidateRoot
    }
  }

  return bestScore > 0 ? bestRoot : ''
}

/**
 * Chấm điểm 1 candidate root theo số thư mục con có file draft_info.json.
 * Score > 0 nghĩa là có thể dùng làm drafts root.
 */
async function scoreDraftsRoot(candidateRoot: string): Promise<number> {
  if (!(await exists(candidateRoot))) return 0

  const entries = await readDir(candidateRoot)
  const childDirs = entries.filter((e) => e.isDirectory && Boolean(e.name))
  if (childDirs.length === 0) return 0

  let score = 0
  for (const child of childDirs) {
    const draftInfoPath = await join(candidateRoot, child.name as string, 'draft_info.json')
    if (await exists(draftInfoPath)) score += 1
  }
  return score
}
