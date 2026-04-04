// auto-media-service.ts
// CORE PIPELINE — Orchestrator cho Auto Media
// 
// Kiến trúc: Core Pipeline + Adapter Pattern
// - Core Pipeline (file này): Whisper → AI Match → tạo dữ liệu UniversalTimeline
// - DaVinci Adapter: nhận UniversalTimeline → gọi Lua API import lên timeline
// - CapCut Adapter: nhận UniversalTimeline → tạo CapCut Draft JSON
// - (Tương lai) Premiere Adapter, FinalCut Adapter...
//
// Core Pipeline KHÔNG gọi bất kỳ API engine nào trực tiếp.
// Mọi sub-pipeline chỉ RETURN dữ liệu → Adapter lo việc "đổ ra đích".
//
// Track layout cố định 7V+5A (chỉ DaVinci dùng, CapCut tự quản lý tracks)

import type {
    AutoMediaConfig,
    OnStepUpdate,
    PrerequisiteCheck,
    UniversalTimeline,
    TimelineImageClip,
    TimelineSubtitleLine,
    TimelineSfxClip,
    TimelineFootageClip,
    TimelineBgmResult,
} from '@/types/auto-media-types'
import { MIN_SCANNED_FILES, TRACK_LAYOUT } from '@/types/auto-media-types'

// ======================== IMPORTS TỪ SERVICES HIỆN CÓ ========================

import { aiMatchScriptToTimeline, saveMatchingResults } from '@/services/ai-matcher'
import { analyzeScriptForMusic, analyzeScriptForSFX } from '@/services/audio-director-service'
import { matchFootageToScript } from '@/services/footage-matcher-service'
// NOTE: addSfxClipsToTimeline, addMediaToTimeline đã chuyển sang davinci-adapter.ts
import { normalizeSfxVolume } from '@/services/audio-ffmpeg-service'
import { readTranscript } from '@/utils/file-utils'
import { matchWordsToTimestamps } from '@/utils/whisper-words-matcher'
// NOTE: tauriFetch đã chuyển sang davinci-adapter.ts — Core Pipeline không gọi API engine
import { join } from '@tauri-apps/api/path'
import { writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import {
    isStillImage,
    convertImagesToVideo,
    getVideoOutputPath,
    ensureTempDir,
} from '@/services/image-converter'

import type { ScriptSentence } from '@/utils/media-matcher'
import type { AudioLibraryItem } from '@/types/audio-types'
import type { ImageMatchResult } from '@/utils/image-matcher'
import type { Subtitle } from '@/types/interfaces'
import type { MatchingSentence } from '@/services/audio-director-service'
import type { FootageItem } from '@/types/footage-types'

// ======================== INTERFACE CHO DEPENDENCIES ========================

/**
 * Dependencies truyền vào từ React component
 * (vì service không dùng hooks, cần nhận data + callbacks)
 */
export interface AutoMediaDependencies {
    // === Data từ contexts ===
    /** Timeline ID từ DaVinci */
    timelineId: string
    /** Transcript ID — dùng để đọc file transcript đã lưu (CapCut: tên file VO, DaVinci: timelineId) */
    transcriptId?: string
    /** Subtitles từ TranscriptContext (chứa whisper word-level timestamps) */
    subtitles: Subtitle[]
    /** Master SRT từ ProjectContext — ưu tiên dùng để tạo phụ đề chuẩn và làm nguồn map time */
    masterSrt?: any[]

    // === Data từ ProjectContext ===
    /** Folder ảnh */
    imageFolder: string
    /** Script text đã đánh số (user paste) */
    scriptText: string
    /** Danh sách file ảnh đã quét */
    imageFiles: string[]

    /** Folder nhạc nền + items đã scan */
    musicFolder: string
    musicItems: AudioLibraryItem[]

    /** Folder SFX + items đã scan */
    sfxFolder: string
    sfxItems: AudioLibraryItem[]

    /** Folder footage + items đã scan */
    footageFolder: string
    footageItems: FootageItem[]

    /** Matching folder (shared) */
    matchingFolder: string

    // === Callbacks để cập nhật contexts ===
    /** Cập nhật matchingSentences trong ProjectContext */
    setMatchingSentences: (data: ScriptSentence[] | null) => void
    /** Cập nhật matchingFolder trong ProjectContext */
    setMatchingFolder: (folder: string) => void
    /** Cập nhật Master SRT vào ProjectContext */
    setMasterSrt: (words: any[], createdAt: string) => void
    /** Cập nhật image import data */
    updateImageImport: (data: any) => void
    /** Cập nhật subtitle data */
    updateSubtitleData: (data: any) => void

    // === Subtitle settings từ ProjectContext ===
    /** Template phụ đề (từ subtitleData.selectedTemplate) */
    subtitleTemplate: string
    /** Font size phụ đề (từ subtitleData.fontSize) */
    subtitleFontSize: number

    /** Cập nhật music library data */
    updateMusicLibrary: (data: any) => void
    /** Cập nhật SFX library data */
    updateSfxLibrary: (data: any) => void

    // === Hàm transcribe (cần gọi từ component vì dùng hooks) ===
    /** Hàm gọi transcribe — nhận onStepUpdate để báo sub-step progress */
    runTranscribe: (onStepUpdate: OnStepUpdate) => Promise<void>
    /** Kiểm tra đã transcribe chưa (subtitles.length > 0) */
    hasTranscript: boolean

    // === Debug mode ===
    /** Callback chờ user nhấn "Tiếp tục" — chỉ dùng khi debugMode = true */
    waitForContinue?: () => Promise<void>

    // === CapCut mode (chỉ cần khi targetEngine = 'capcut') ===
    /** Đường dẫn file Voice Over (dùng cho CapCut Draft) */
    voFilePath?: string
    /** Tên project (dùng cho CapCut Draft) */
    projectName?: string
    /** Nếu có: ghi đè trực tiếp vào draft CapCut này (không tạo draft mới) */
    capcutTargetDraftPath?: string
    /** Effects settings từ CapCutEffectsSettingsPanel */
    capCutEffectsSettings?: any
    /** Branding theo kênh cho CapCut (logo + vị trí) */
    capcutChannelBranding?: {
        channelId: string
        channelName: string
        logoPath: string
        position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
        /** Toạ độ transform custom theo hệ normalized của CapCut */
        x?: number
        y?: number
        /** Scale custom của logo (1.0 = 100%) */
        scale?: number
    }
}

// ======================== ABORT CONTROLLER ========================

/** AbortController để dừng pipeline giữa chừng */
let abortController: AbortController | null = null

/** Kiểm tra đã bị abort chưa — gọi trước mỗi bước */
function checkAbort() {
    if (abortController?.signal.aborted) {
        throw new Error('Pipeline đã bị dừng bởi user')
    }
}

/** Dừng pipeline */
export function stopAutoMedia() {
    abortController?.abort()
}

// ======================== KIỂM TRA ĐIỀU KIỆN ========================

/**
 * Kiểm tra điều kiện tiên quyết cho từng bước
 * Trả về danh sách kết quả — bước nào thiếu thì báo rõ lý do
 */
export function checkPrerequisites(
    deps: AutoMediaDependencies,
    config: AutoMediaConfig
): PrerequisiteCheck[] {
    const checks: PrerequisiteCheck[] = []

    // Image Import: cần imageFolder + scriptText + imageFiles
    if (config.enableImage) {
        if (!deps.imageFolder) {
            checks.push({ step: 'image', ready: false, reason: 'Chưa chọn folder ảnh' })
        } else if (deps.imageFiles.length === 0) {
            checks.push({ step: 'image', ready: false, reason: 'Folder ảnh trống — không có file ảnh nào' })
        } else if (!deps.scriptText.trim()) {
            checks.push({ step: 'image', ready: false, reason: 'Chưa paste script kịch bản' })
        } else {
            checks.push({ step: 'image', ready: true })
        }
    }

    // Subtitle: cần scriptText
    if (config.enableSubtitle) {
        if (!deps.scriptText.trim()) {
            checks.push({ step: 'subtitle', ready: false, reason: 'Chưa paste script kịch bản' })
        } else {
            checks.push({ step: 'subtitle', ready: true })
        }
    }

    // Music: cần musicFolder + musicItems đã scan >= MIN_SCANNED_FILES
    if (config.enableMusic) {
        const scannedCount = deps.musicItems.filter(i => i.aiMetadata).length
        if (!deps.musicFolder) {
            checks.push({ step: 'music', ready: false, reason: 'Chưa chọn folder nhạc nền' })
        } else if (scannedCount < MIN_SCANNED_FILES) {
            checks.push({
                step: 'music', ready: false,
                reason: `Nhạc nền: chỉ có ${scannedCount}/${MIN_SCANNED_FILES} file đã scan AI — cần scan thêm`
            })
        } else {
            checks.push({ step: 'music', ready: true })
        }
    }

    // SFX: cần sfxFolder + sfxItems đã scan >= MIN_SCANNED_FILES
    if (config.enableSfx) {
        const scannedCount = deps.sfxItems.filter(i => i.aiMetadata).length
        if (!deps.sfxFolder) {
            checks.push({ step: 'sfx', ready: false, reason: 'Chưa chọn folder SFX' })
        } else if (scannedCount < MIN_SCANNED_FILES) {
            checks.push({
                step: 'sfx', ready: false,
                reason: `SFX: chỉ có ${scannedCount}/${MIN_SCANNED_FILES} file đã scan AI — cần scan thêm`
            })
        } else {
            checks.push({ step: 'sfx', ready: true })
        }
    }

    // Footage: cần footageFolder + footageItems đã scan >= MIN_SCANNED_FILES
    if (config.enableFootage) {
        const scannedCount = deps.footageItems.filter(i => i.aiDescription).length
        if (!deps.footageFolder) {
            checks.push({ step: 'footage', ready: false, reason: 'Chưa chọn folder footage' })
        } else if (scannedCount < MIN_SCANNED_FILES) {
            checks.push({
                step: 'footage', ready: false,
                reason: `Footage: chỉ có ${scannedCount}/${MIN_SCANNED_FILES} file đã scan AI — cần scan thêm`
            })
        } else {
            checks.push({ step: 'footage', ready: true })
        }
    }

    // Effects: luôn ready (chỉ cần ảnh trên timeline — chạy sau image)
    if (config.enableEffects) {
        checks.push({ step: 'effects', ready: true })
    }

    return checks
}

// ======================== PARSE SCRIPT ========================

/** Parse script text thành danh sách câu có số thứ tự */
function parseScript(scriptText: string): { num: number; text: string }[] {
    const sentences: { num: number; text: string }[] = []
    const lines = scriptText.split('\n')
    for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const match = trimmed.match(/^(\d+)[.):\s]+\s*(.*)/)
        if (match) {
            const text = match[2].trim()
            if (text.length > 0) {
                sentences.push({ num: parseInt(match[1]), text })
            }
        }
    }
    return sentences
}

// ======================== PIPELINE CHÍNH ========================

/**
 * Chạy toàn bộ Auto Media Pipeline
 * 
 * @param config - Config bật/tắt từng bước
 * @param deps - Dependencies từ React contexts
 * @param onStepUpdate - Callback cập nhật UI
 */
export async function runAutoMedia(
    config: AutoMediaConfig,
    deps: AutoMediaDependencies,
    onStepUpdate: OnStepUpdate
): Promise<void> {
    // ⚠️ Bug fix #14: abort controller cũ nếu đang tồn tại (tránh race condition khi double-click)
    // Trước đây ghi đè trực tiếp → pipeline cũ vẫn chạy ngầm
    abortController?.abort()
    abortController = new AbortController()
    incrementalConvertedSet.clear() // Reset tracking cho lần chạy mới

    console.log('[AutoMedia] 🚀 Bắt đầu pipeline...')

    try {
        // ====== BƯỚC 0: SETUP TIMELINE TRACKS (chỉ DaVinci mode) ======
        const isDaVinciTarget = !config.targetEngine || config.targetEngine === 'davinci'
        if (isDaVinciTarget) {
            onStepUpdate('transcribe', 'running', '🛠️ Đang khởi tạo cấu trúc 7 Video + 5 Audio Tracks...')
            try {
                const { setupTimelineTracks } = await import('@/api/resolve-api')
                await setupTimelineTracks(TRACK_LAYOUT)
                console.log('[AutoMedia] ✅ Tự động Setup Timeline Tracks OK')
            } catch (err) {
                console.warn('[AutoMedia] ⚠️ Lỗi khi setup tracks DaVinci:', err)
                onStepUpdate('transcribe', 'running', '⚠️ Không thể khởi tạo track động, bỏ qua bước Setup...')
            }
        } else {
            console.log('[AutoMedia] CapCut mode — bỏ qua setupTimelineTracks')
        }

        // ====== BƯỚC 1: TRANSCRIBE ======
        onStepUpdate('transcribe', 'running', 'Đang kiểm tra transcript...')

        if (deps.hasTranscript) {
            // Đã có transcript → bỏ qua — nhưng debug xem có tốt không
            const subCount = deps.subtitles?.length || 0
            const sampleSubs = (deps.subtitles || []).slice(0, 3).map((s: any) => `"${s.text?.substring(0, 25)}..." ${s.start?.toFixed(1)}-${s.end?.toFixed(1)}s`).join(' | ')
            const debugSkip = `subtitles: ${subCount} đã có trong context\nSample: ${sampleSubs}\n⚠️ Dùng transcript cũ, KHÔNG chạy Whisper mới`
            onStepUpdate('transcribe', 'done', `Transcript đã có sẵn (${subCount} segments) ✅`, undefined, debugSkip)
            console.log('[AutoMedia] Transcript đã có, bỏ qua Transcribe')
        } else {
            // Chạy Transcribe — truyền onStepUpdate để báo sub-step
            onStepUpdate('transcribe', 'running', '🎧 Đang export audio từ DaVinci...')
            try {
                await deps.runTranscribe(onStepUpdate)
                // done được gọi trong callback runTranscribe (panel) với debugDetails
            } catch (err) {
                onStepUpdate('transcribe', 'error', 'Transcribe lỗi', String(err))
                throw new Error('Transcribe thất bại — không thể tiếp tục pipeline')
            }
        }

        checkAbort()

        // Debug mode: dừng chờ user nhấn Tiếp tục sau Transcribe
        if (config.debugMode && deps.waitForContinue) {
            console.log('[AutoMedia] 🐛 Debug: chờ user nhấn Tiếp tục sau Transcribe...')
            await deps.waitForContinue()
        }

        // ====== BƯỚC 2: AI SO CHIẾU SCRIPT ↔ VOICE TIMING ======
        // ======================== TẠO MASTER SRT TỰ ĐỘNG CỦA AUTO MEDIA ========================
        let verifiedMasterSrt = deps.masterSrt

        if (config.enableMasterSrt && (!verifiedMasterSrt || verifiedMasterSrt.length === 0)) {
            onStepUpdate('aiMatch', 'running', '🌟 Đang tự động tạo Master SRT từ Whisper...')
            // Dùng transcriptId (CapCut: tên VO) hoặc timelineId (DaVinci)
            const tId = deps.transcriptId || deps.timelineId
            const transcript = await readTranscript(`${tId}.json`)
            if (!transcript) {
                throw new Error('Không tìm thấy transcript file để tạo Master SRT')
            }

            const segments = transcript.originalSegments || transcript.segments || []
            const { extractWhisperWords } = await import('@/utils/media-matcher')
            const whisperWords = extractWhisperWords({ segments } as any)
            
            if (whisperWords.length > 0) {
                const wordsText = whisperWords.map(w => `[${parseFloat(w.start as any).toFixed(2)}] ${w.word}`).join(" ")
                
                const { createMasterSrt } = await import('@/services/master-srt-service')
                const result = await createMasterSrt(
                    wordsText,
                    deps.scriptText,
                    (msg) => onStepUpdate('aiMatch', 'running', `🌟 Đang tự động tạo Master SRT: ${msg}`)
                )

                verifiedMasterSrt = result.words
                deps.masterSrt = verifiedMasterSrt // ✅ Dùng Master SRT mới tạo cho các bước sau
                
                // Cập nhật lại context project
                if (deps.setMasterSrt) {
                    deps.setMasterSrt(result.words, result.createdAt)
                }

                onStepUpdate('aiMatch', 'running', `✅ Đã tạo Master SRT tự động (${result.totalWords} từ)`)
            } else {
                onStepUpdate('aiMatch', 'running', '⚠️ Transcript không có word-level timing, bỏ qua khâu tạo Master SRT.')
            }
        } else if (!config.enableMasterSrt) {
            onStepUpdate('aiMatch', 'running', '⏭️ Bỏ qua tạo Master SRT do đã tắt trong cài đặt.')
        }

        // Sub-step 2a: Parse script
        onStepUpdate('aiMatch', 'running', '📝 Đang parse script text...')

        const sentences = parseScript(deps.scriptText)
        if (sentences.length === 0) {
            onStepUpdate('aiMatch', 'error', 'Script không có câu nào', 'Kiểm tra lại script đã paste')
            throw new Error('Script không có câu nào')
        }
        onStepUpdate('aiMatch', 'running', `📝 ${sentences.length} câu script → đọc transcript...`)

        // Sub-step 2b: Đọc transcript (dùng Master SRT nếu có)
        let transcript: any = null
        if (verifiedMasterSrt && verifiedMasterSrt.length > 0) {
            onStepUpdate('aiMatch', 'running', '🌟 Xác định Master SRT → dùng làm nguồn timing chuẩn...')
            const { masterSrtToTranscript } = await import('@/utils/master-srt-utils')
            transcript = masterSrtToTranscript(verifiedMasterSrt)
        } else {
            const tId2 = deps.transcriptId || deps.timelineId
            transcript = await readTranscript(`${tId2}.json`)
        }
        
        if (!transcript) {
            onStepUpdate('aiMatch', 'error', 'Không tìm thấy transcript file', `${deps.transcriptId || deps.timelineId}.json`)
            throw new Error('Không tìm thấy transcript file')
        }
        
        onStepUpdate('aiMatch', 'running', `📝 ${sentences.length} câu script + transcript → gọi AI matching...`)

        
        // ======================== CHIẾN LƯỢC DYNAMIC QUEUE ========================
        // Không đợi tuần tự như xưa nữa, ta triển khai Bể chứa Sự kiện (Event-driven Queue)!
        
        onStepUpdate('aiMatch', 'running', '🚀 Kích hoạt Tác vụ Lũy tiến (Dynamic Queue)...');

        // Khởi tạo Promise để giải phóng Làn sóng 2
        let resolveMatchedSentences!: (val: ScriptSentence[]) => void;
        let rejectMatchedSentences!: (err: Error) => void;
        const matchedSentencesReady = new Promise<ScriptSentence[]>((resolve, reject) => {
            resolveMatchedSentences = resolve;
            rejectMatchedSentences = reject;
        });

        // ★ EARLY MATCH GATE: Mở khoá cho Music/SFX/Footage ngay khi batch chính xong
        // TRƯỚC retry loop + save → tiết kiệm 5-15 giây
        // Music/SFX/Footage chỉ cần timing ước lượng (batch chính đã đủ tốt)
        // Image Pipeline vẫn chờ matchedSentencesReady (cần timing chính xác sau retry)
        let resolveEarlyMatch!: (val: ScriptSentence[]) => void;
        let rejectEarlyMatch!: (err: Error) => void;
        const earlyMatchReady = new Promise<ScriptSentence[]>((resolve, reject) => {
            resolveEarlyMatch = resolve;
            rejectEarlyMatch = reject;
        });

        // Hàng đợi Task
        const activeQueueTasks: Promise<void>[] = [];

        // Helper: chạy 1 step + pause nếu debug mode
        const runStepWithDebugPause = async (_stepName: string, stepFn: () => Promise<void>) => {
            await stepFn()
            if (config.debugMode && deps.waitForContinue) {
                await deps.waitForContinue()
            }
        }

        // ======================== LÀN SÓNG 1: CHẠY SONG SONG VỚI AI MATCH ========================

        // 🟢 TASK 1: AI Match (Rường cột) + Incremental Unlock
        // Khi mỗi batch xong → bắt đầu convert ảnh cho batch đó ngay (không chờ hết)
        const incrementalImageJobs: Promise<void>[] = [] // Collect convert jobs đang chạy
        
        const taskAIMatch = async () => {
            try {
                let matchedSentences: ScriptSentence[];
                matchedSentences = await aiMatchScriptToTimeline(
                    sentences,
                    transcript,
                    (progress) => onStepUpdate('aiMatch', 'running', `🤖 AI match: ${progress.message}`),
                    deps.imageFolder || undefined,
                    'video', // importType
                    // ★ INCREMENTAL UNLOCK: Callback khi mỗi batch hoàn tất → convert ảnh ngay
                    (batchEvent) => {
                        console.log(`[AutoMedia] 🔓 Batch ${batchEvent.batchNum}/${batchEvent.totalBatches} xong (${batchEvent.partialResults.length} results) → ${batchEvent.timeRange}`)
                        onStepUpdate('aiMatch', 'running', `🤖 Batch ${batchEvent.batchNum}/${batchEvent.totalBatches} ✅ (${batchEvent.partialResults.length} câu) — mở khoá sub-tasks...`)
                        
                        // Nếu Image Pipeline được bật → bắt đầu convert ảnh cho batch này ngay
                        // ★ CapCut KHÔNG cần convert ảnh → video (dùng ảnh gốc type="photo")
                        const isCapCutTarget = config.targetEngine === 'capcut'
                        if (config.enableImage && deps.imageFolder && deps.imageFiles.length > 0 && !isCapCutTarget) {
                            const job = startIncrementalImageConvert(
                                batchEvent.partialResults,
                                deps.imageFiles,
                                onStepUpdate,
                                batchEvent.batchNum,
                                batchEvent.totalBatches
                            )
                            incrementalImageJobs.push(job)
                        }
                    },
                    // ★ EARLY UNLOCK: Mở khoá Music/SFX/Footage ngay khi batch chính xong
                    // TRƯỚC retry loop → tiết kiệm 5-15 giây
                    (earlyResults) => {
                        console.log(`[AutoMedia] ⚡ EARLY UNLOCK: ${earlyResults.length} scenes → mở khoá Music/SFX/Footage`)
                        onStepUpdate('aiMatch', 'running', `⚡ Batch chính xong — mở khoá Music/SFX/Footage sớm!`)
                        resolveEarlyMatch(earlyResults)
                    }
                );

                // Lưu kết quả
                onStepUpdate('aiMatch', 'running', '💾 Đang lưu matching results...')
                deps.setMatchingSentences(matchedSentences)
                if (deps.imageFolder) {
                    deps.setMatchingFolder(deps.imageFolder)
                    await saveMatchingResults(deps.imageFolder, matchedSentences)
                }

                // Cập nhật UI
                const highCount = matchedSentences.filter(s => s.quality === 'high').length
                const mediumCount = matchedSentences.filter(s => s.quality === 'medium').length
                const lowCount = matchedSentences.filter(s => s.quality === 'low').length
                const totalMatched = matchedSentences.filter(s => s.start > 0 || s.end > 0).length
                
                const debugAiMatch = `total=${matchedSentences.length} | high=${highCount} medium=${mediumCount} low=${lowCount} | withTiming=${totalMatched}`
                onStepUpdate('aiMatch', 'done', `✅ ${totalMatched}/${sentences.length} câu matched (high: ${highCount})`, undefined, debugAiMatch)

                checkAbort();

                if (config.debugMode && deps.waitForContinue) {
                    await deps.waitForContinue()
                }

                // Chờ tất cả incremental image convert jobs hoàn tất
                if (incrementalImageJobs.length > 0) {
                    console.log(`[AutoMedia] ⏳ Chờ ${incrementalImageJobs.length} incremental image convert jobs...`)
                    await Promise.allSettled(incrementalImageJobs)
                }

                // MỞ KHÓA LUỸ TIẾN (Làn sóng 2) — Image Pipeline + kết quả cuối cùng!
                resolveMatchedSentences(matchedSentences);

            } catch (err) {
                onStepUpdate('aiMatch', 'error', 'AI match lỗi', String(err));
                rejectMatchedSentences(new Error('AI match thất bại'));
                rejectEarlyMatch(new Error('AI match thất bại')); // Ngưng Music/SFX/Footage đang chờ
            }
        };

        // Đẩy Task 1 vào Queue lập tức
        activeQueueTasks.push(taskAIMatch());

        // ====== Thu thập kết quả từ sub-pipelines để đóng gói UniversalTimeline ======
        let timelineImageClips: TimelineImageClip[] = []
        let timelineSubtitleData: { subtitleLines: TimelineSubtitleLine[]; srtContent?: string; srtFilePath?: string } = { subtitleLines: [] }
        let timelineBgm: TimelineBgmResult | null = null
        let timelineSfxClips: TimelineSfxClip[] = []
        let timelineFootageClips: TimelineFootageClip[] = []
        let timelineMatchedSentences: any[] = []
        // ======================== SRT THÔ SENTENCES ========================
        // Ước lượng timing cho script sentences từ Whisper transcript
        // SFX + Footage chỉ cần text + timing "đủ tốt" → KHÔNG cần chờ AI Match
        const segments = transcript.originalSegments || transcript.segments || []
        const totalDurationRaw = segments.length > 0 ? segments[segments.length - 1].end : 300
        const avgDurationPerSentence = totalDurationRaw / Math.max(1, sentences.length)
        // Word timing thật (ưu tiên) để Footage dùng cụm [timestamp] word theo yêu cầu.
        // Nguồn này hỗ trợ cả transcript từ Whisper và transcript build từ CapCut draft subtitle.
        const footageWordTimingTokens: Array<{ timestamp: number; word: string }> = []
        for (const seg of segments) {
            const segWords = Array.isArray(seg.words) ? seg.words : []
            if (segWords.length > 0) {
                for (const w of segWords) {
                    const token = String(w.word ?? w.w ?? '').trim()
                    const ts = Number(w.start ?? w.t ?? seg.start ?? 0)
                    if (!token || !Number.isFinite(ts)) continue
                    footageWordTimingTokens.push({ timestamp: ts, word: token })
                }
                continue
            }

            // Fallback khi segment không có words[]: tách text theo từ và nội suy tuyến tính.
            const rawText = String(seg.text || '').trim()
            if (!rawText) continue
            const tokens = rawText.split(/\s+/).map(t => t.trim()).filter(Boolean)
            if (!tokens.length) continue
            const s = Number(seg.start ?? 0)
            const e = Number(seg.end ?? s)
            const dur = Math.max(0.01, e - s)
            const step = dur / tokens.length
            for (let i = 0; i < tokens.length; i++) {
                footageWordTimingTokens.push({
                    timestamp: s + (i * step),
                    word: tokens[i],
                })
            }
        }

        const srtRawSentences: ScriptSentence[] = sentences.map((s, i) => ({
            num: s.num,
            text: s.text,
            start: i * avgDurationPerSentence,
            end: (i + 1) * avgDurationPerSentence,
            quality: 'srt-raw' as any, // Timing ước lượng từ SRT thô
            matchRate: '',
            matchedWhisper: '(srt-raw estimate)',
        }))
        console.log(`[AutoMedia] 📋 SRT thô: ${srtRawSentences.length} câu, duration ${totalDurationRaw.toFixed(0)}s, avg ${avgDurationPerSentence.toFixed(1)}s/câu`)

        // ======================== LÀN SÓNG 1: CHẠY SONG SONG VỚI AI MATCH ========================

        // 🟢 TASK 2: SUBTITLE PIPELINE (Chạy Độc lập, không đợi Câu)
        if (config.enableSubtitle && !!deps.scriptText.trim()) {
            activeQueueTasks.push(runStepWithDebugPause('subtitle', async () => {
                onStepUpdate('subtitle', 'running', '📝 Đang chạy Subtitle độc lập từ SRT Thô...');
                timelineSubtitleData = await runSubtitlePipeline(deps, [], onStepUpdate, config);
            }));
        } else {
            onStepUpdate('subtitle', 'skipped', 'Bỏ qua — thiếu script');
        }

        // 🟢 TASK 3: SFX PIPELINE (★ Chạy song song — dùng SRT thô, KHÔNG chờ AI Match)
        // SFX AI Planner chỉ cần script text → tìm trigger words
        // Auto-assign dùng whisperWords riêng → timing chính xác word-level
        if (config.enableSfx && deps.sfxItems.filter(i => i.aiMetadata).length >= MIN_SCANNED_FILES) {
            activeQueueTasks.push(runStepWithDebugPause('sfx', async () => {
                onStepUpdate('sfx', 'running', '🔊 SFX: chạy song song dùng SRT thô...');
                timelineSfxClips = await runSfxPipeline(deps, srtRawSentences, onStepUpdate);
            }));
        } else {
            onStepUpdate('sfx', 'skipped', 'Bỏ qua — thiếu folder SFX hoặc chưa scan đủ');
        }

        // 🟢 TASK 4: FOOTAGE PIPELINE (★ Chạy song song — dùng SRT thô, KHÔNG chờ AI Match)
        // Footage AI chỉ cần script text + timing ước lượng → match footage
        // Footage clip rộng (5-10s) → timing ước lượng đủ tốt
        if (config.enableFootage && deps.footageItems.filter(i => i.aiDescription).length >= MIN_SCANNED_FILES) {
            activeQueueTasks.push(runStepWithDebugPause('footage', async () => {
                onStepUpdate('footage', 'running', '🎬 Footage: chạy song song dùng SRT thô...');
                timelineFootageClips = await runFootagePipeline(
                    deps,
                    srtRawSentences,
                    footageWordTimingTokens,
                    onStepUpdate
                );
            }));
        } else {
            onStepUpdate('footage', 'skipped', 'Bỏ qua — thiếu folder footage');
        }

        // ======================== LÀN SÓNG 2: PHỤ THUỘC TIMING ========================

        // 🟢 TASK 5: MUSIC PIPELINE (Chờ Early Match — cần context emotion chính xác)
        if (config.enableMusic && deps.musicItems.filter(i => i.aiMetadata).length >= MIN_SCANNED_FILES) {
            activeQueueTasks.push(runStepWithDebugPause('music', async () => {
                onStepUpdate('music', 'running', '⏳ Đợi batch chính xong...');
                const matched = await earlyMatchReady;
                timelineBgm = await runMusicPipeline(deps, matched, onStepUpdate);
            }));
        } else {
            onStepUpdate('music', 'skipped', 'Bỏ qua — thiếu folder nhạc nền');
        }

        // 🟢 TASK 6: IMAGE PIPELINE (Chờ AI Match hoàn tất — cần timing chính xác)
        if (config.enableImage && !!deps.imageFolder && deps.imageFiles.length > 0) {
            activeQueueTasks.push(runStepWithDebugPause('image', async () => {
                onStepUpdate('image', 'running', '⏳ Đợi AI Match hoàn tất...');
                const matched = await matchedSentencesReady;
                timelineImageClips = await runImagePipeline(deps, matched, onStepUpdate, config);
                timelineMatchedSentences = matched; // Lưu lại cho UniversalTimeline
            }));
        } else {
            onStepUpdate('image', 'skipped', 'Bỏ qua — thiếu folder ảnh');
        }

        // ========== ĐƯA CHO QUẢN ĐỐC NODE.JS THI HÀNH (PROMISE.ALL) ==========
        await Promise.allSettled(activeQueueTasks);

        // ======================== ĐÓNG GÓI UNIVERSAL TIMELINE ========================
        const universalTimeline: UniversalTimeline = {
            imageClips: timelineImageClips,
            subtitleLines: timelineSubtitleData.subtitleLines,
            bgm: timelineBgm,
            sfxClips: timelineSfxClips,
            footageClips: timelineFootageClips,
            matchedSentences: timelineMatchedSentences,
            srtContent: timelineSubtitleData.srtContent,
            srtFilePath: timelineSubtitleData.srtFilePath,
            config,
            trackLayout: TRACK_LAYOUT,
            startedAt: Date.now(),
        }

        console.log('[AutoMedia] 📦 UniversalTimeline đóng gói xong:', {
            images: universalTimeline.imageClips.length,
            subtitles: universalTimeline.subtitleLines.length,
            bgm: !!universalTimeline.bgm,
            sfx: universalTimeline.sfxClips.length,
            footage: universalTimeline.footageClips.length,
        })

        // ======================== GỌI ADAPTER THEO ENGINE ========================
        const targetEngine = config.targetEngine || 'davinci'

        if (targetEngine === 'davinci') {
            // DaVinci Adapter: Gọi Lua API, import lên timeline
            onStepUpdate('effects', 'running', '📤 DaVinci: đang đổ dữ liệu lên timeline...')
            const { exportToDaVinci } = await import('@/adapters/davinci-adapter')
            await exportToDaVinci(universalTimeline, onStepUpdate, config, {
                subtitleTemplate: deps.subtitleTemplate || 'Subtitle Default',
                subtitleFontSize: deps.subtitleFontSize || 0.04,
            })
        } else if (targetEngine === 'capcut') {
            // CapCut Adapter: Tạo CapCut Draft JSON
            onStepUpdate('effects', 'running', '📤 CapCut: đang tạo Draft project...')
            const { exportToCapCut } = await import('@/adapters/capcut-adapter')
            await exportToCapCut(universalTimeline, onStepUpdate, config, {
                voFilePath: deps.voFilePath,
                projectName: deps.projectName,
                targetDraftPath: deps.capcutTargetDraftPath,
                effectsSettings: deps.capCutEffectsSettings,
                channelBranding: deps.capcutChannelBranding,
            })
        } else {
            console.warn(`[AutoMedia] ⚠️ Engine "${targetEngine}" chưa có adapter — bỏ qua export`)
            onStepUpdate('effects', 'done', `⚠️ Chưa có adapter cho "${targetEngine}" — dữ liệu đã sẵn sàng nhưng chưa xuất`)
        }

        universalTimeline.finishedAt = Date.now()
        console.log('[AutoMedia] ✅ Pipeline hoàn tất!')

    } catch (err) {
        console.error('[AutoMedia] ❌ Pipeline lỗi:', err)
        // Lỗi đã được báo qua onStepUpdate ở từng bước
    } finally {
        abortController = null
    }
}

// ======================== INCREMENTAL IMAGE CONVERT ========================

/**
 * Incremental Image Convert: Khi AI Match batch N xong, tìm ảnh nào
 * match với kết quả batch đó → convert ảnh tĩnh → video ngay.
 * 
 * ★ Chạy SONG SONG với AI Match — không chờ toàn bộ Match xong mới bắt đầu convert.
 * Kết quả: khi AI Match xong hết, phần lớn ảnh đã convert xong → tiết kiệm đáng kể thời gian.
 * 
 * Set để theo dõi ảnh đã convert (tránh convert trùng lặp giữa các batch overlap)
 */
const incrementalConvertedSet = new Set<string>()

async function startIncrementalImageConvert(
    partialResults: { num: number; start: number; end: number; whisper: string }[],
    imageFiles: string[],
    onStepUpdate: OnStepUpdate,
    batchNum: number,
    totalBatches: number
): Promise<void> {
    try {
        const { getImageSceneNumber } = await import('@/utils/image-matcher')
        const FPS = TRACK_LAYOUT.DEFAULT_FPS

        // Tìm ảnh nào match với partial results
        const matchedNums = new Set(partialResults.map(r => r.num))
        const matchedImages = imageFiles.filter(filePath => {
            const sceneNum = getImageSceneNumber(filePath)
            return matchedNums.has(sceneNum)
        })

        // Lọc ảnh tĩnh chưa convert
        const stillImages = matchedImages.filter(filePath => {
            if (!isStillImage(filePath)) return false
            if (incrementalConvertedSet.has(filePath)) return false // Đã convert ở batch trước
            return true
        })

        if (stillImages.length === 0) return // Không có ảnh tĩnh cần convert

        console.log(`[AutoMedia] 🎨 Incremental B${batchNum}/${totalBatches}: convert ${stillImages.length} ảnh tĩnh → video`)
        onStepUpdate('image', 'running', `🎨 B${batchNum}/${totalBatches}: convert ${stillImages.length} ảnh tĩnh...`)

        await ensureTempDir()

        // Tạo convert jobs — dùng duration ước lượng từ partial results
        const stillJobs: Array<{ inputPath: string; durationFrames: number; outputPath: string }> = []
        for (const filePath of stillImages) {
            const sceneNum = getImageSceneNumber(filePath)
            const matchResult = partialResults.find(r => r.num === sceneNum)
            const duration = matchResult ? Math.max(0.5, matchResult.end - matchResult.start) : 3 // Fallback 3s
            const durationFrames = Math.max(1, Math.round(duration * FPS))

            stillJobs.push({
                inputPath: filePath,
                durationFrames,
                outputPath: await getVideoOutputPath(filePath),
            })

            // Đánh dấu đã convert để batch sau không trùng
            incrementalConvertedSet.add(filePath)
        }

        // Convert tất cả ảnh trong batch này
        await convertImagesToVideo(stillJobs, FPS, (progress) => {
            onStepUpdate('image', 'running', `🎨 B${batchNum}: convert ảnh ${progress.current || '?'}/${progress.total || stillJobs.length}`)
        })

        console.log(`[AutoMedia] ✅ Incremental B${batchNum}: ${stillJobs.length} ảnh đã convert xong`)

    } catch (err) {
        console.warn(`[AutoMedia] ⚠️ Incremental B${batchNum} convert lỗi:`, err)
        // Không throw — cho phép pipeline tiếp tục
    }
}

// ======================== SUB-PIPELINES ========================

/**
 * Image Pipeline: Convert ảnh → video → trả về TimelineImageClip[]
 * KHÔNG gọi DaVinci API — Adapter sẽ import dữ liệu lên đích
 */
async function runImagePipeline(
    deps: AutoMediaDependencies,
    matchedSentences: ScriptSentence[],
    onStepUpdate: OnStepUpdate,
    _config: AutoMediaConfig
): Promise<TimelineImageClip[]> {
    onStepUpdate('image', 'running', '🖼️ Đang kết hợp ảnh + timing từ AI match...')

    try {
        checkAbort()

        // Bước 1: Kết hợp ảnh + timing (buildImageResults logic)
        const { getImageSceneNumber, getImageType } = await import('@/utils/image-matcher')
        
        // Nhóm sentences theo num
        const sentenceByNum = new Map<number, ScriptSentence[]>()
        for (const s of matchedSentences) {
            if (!sentenceByNum.has(s.num)) sentenceByNum.set(s.num, [])
            sentenceByNum.get(s.num)!.push(s)
        }

        const matchResults: ImageMatchResult[] = []
        for (const filePath of deps.imageFiles) {
            const fileName = filePath.split(/[/\\]/).pop() || ''
            const sceneNum = getImageSceneNumber(filePath)
            const type = getImageType(filePath)
            const matchedForScene = sentenceByNum.get(sceneNum) || []

            if (matchedForScene.length > 0) {
                const startTime = Math.min(...matchedForScene.map(s => s.start))
                const endTime = Math.max(...matchedForScene.map(s => s.end))
                matchResults.push({
                    filePath, fileName, sceneNum,
                    dialogues: matchedForScene.map(s => s.text),
                    startTime, endTime,
                    rowCount: matchedForScene.length, type,
                    quality: 'matched',
                })
            } else {
                matchResults.push({
                    filePath, fileName, sceneNum,
                    dialogues: [], startTime: 0, endTime: 0,
                    rowCount: 0, type, quality: 'no-excel',
                })
            }
        }

        // Cập nhật ProjectContext
        onStepUpdate('image', 'running', `🖼️ ${matchResults.filter(r => r.quality === 'matched').length}/${deps.imageFiles.length} ảnh match — đang tạo clips...`)
        deps.updateImageImport({
            matchedSentences,
            matchResults,
            selectedTrack: TRACK_LAYOUT.VIDEO_AI_TRACK,
        })

        // Bước 2: Tạo clips để import
        // ★ ĐỒNG BỘ với Image Import Tab: dùng lastValidFilePath để lấp gaps
        const clips: Array<{ filePath: string; startTime: number; endTime: number }> = []
        let lastValidFilePath = ''
        for (const result of matchResults) {
            if (result.endTime > result.startTime) {
                const filePath = result.filePath || lastValidFilePath
                if (filePath) {
                    clips.push({
                        filePath,
                        startTime: result.startTime,
                        endTime: result.endTime,
                    })
                    lastValidFilePath = filePath
                }
            }
        }

        if (clips.length === 0) {
            onStepUpdate('image', 'error', 'Không có ảnh nào match được', 'Kiểm tra lại script ↔ file ảnh')
            return []
        }

        // ======================== SANITIZE TIMELINE ẢNH (KHÔNG CHO KHOẢNG TRẮNG) ========================
        // Mục tiêu:
        // 1) Không overlap giữa 2 clip ảnh.
        // 2) Không gap trắng giữa các clip ảnh.
        // 3) Nếu thiếu ảnh cuối timeline, kéo clip cuối tới hết VO (voiceEnd).
        // 4) Nếu thiếu ảnh đầu timeline, dùng ảnh đầu để lấp từ 0s.
        // 5) Nếu có clip trùng cùng khoảng thời gian, giữ 1 clip để tránh chồng hình.

        clips.sort((a, b) => {
            if (a.startTime !== b.startTime) return a.startTime - b.startTime
            if (a.endTime !== b.endTime) return a.endTime - b.endTime
            return a.filePath.localeCompare(b.filePath)
        })

        // Tính voiceEnd từ matchedSentences (source-of-truth cho phần ảnh phủ timeline VO).
        const voiceEndTime = Math.max(...matchedSentences.map(s => s.end), 0)
        const MIN_CLIP_SEC = 1 / TRACK_LAYOUT.DEFAULT_FPS
        const EPS = 0.000001

        // Bước A: Dedupe clip có cùng time range tuyệt đối.
        // Tránh trường hợp 2 ảnh trùng thời điểm gây chồng hình khi import.
        const dedupedClips: Array<{ filePath: string; startTime: number; endTime: number }> = []
        let duplicateTimeRangeDropped = 0
        for (const clip of clips) {
            const prev = dedupedClips[dedupedClips.length - 1]
            if (
                prev &&
                Math.abs(prev.startTime - clip.startTime) < EPS &&
                Math.abs(prev.endTime - clip.endTime) < EPS
            ) {
                duplicateTimeRangeDropped++
                continue
            }
            dedupedClips.push({ ...clip })
        }

        // Bước B: Lấp đầu timeline (nếu clip đầu bắt đầu > 0s).
        // Dùng chính ảnh đầu để phủ đoạn đầu tránh khung trắng.
        if (dedupedClips.length > 0 && dedupedClips[0].startTime > EPS) {
            dedupedClips.unshift({
                filePath: dedupedClips[0].filePath,
                startTime: 0,
                endTime: dedupedClips[0].startTime,
            })
        } else if (dedupedClips.length > 0 && dedupedClips[0].startTime < 0) {
            dedupedClips[0].startTime = 0
        }

        let gapsFilled = 0
        let overlapsFixed = 0

        // Bước C: Ép timeline liên tục 100% theo thứ tự clip.
        for (let i = 0; i < dedupedClips.length - 1; i++) {
            const curr = dedupedClips[i]
            const next = dedupedClips[i + 1]

            // Nếu overlap: đẩy clip sau bắt đầu tại end clip trước.
            if (next.startTime + EPS < curr.endTime) {
                overlapsFixed++
                next.startTime = curr.endTime
            }

            // Nếu gap: kéo end clip trước chạm start clip sau.
            if (curr.endTime + EPS < next.startTime) {
                gapsFilled++
                curr.endTime = next.startTime
            }

            // Safety: clip sau luôn phải có duration dương.
            if (next.endTime <= next.startTime + EPS) {
                next.endTime = next.startTime + MIN_CLIP_SEC
            }
        }

        // Bước D: Lấp đuôi timeline tới hết VO nếu còn thiếu.
        if (dedupedClips.length > 0 && voiceEndTime > 0) {
            const last = dedupedClips[dedupedClips.length - 1]
            if (last.endTime + EPS < voiceEndTime) {
                gapsFilled++
                last.endTime = voiceEndTime
            } else if (last.endTime > voiceEndTime + EPS) {
                // Không để ảnh vượt quá VO.
                last.endTime = voiceEndTime
            }
            // Safety sau clamp tail.
            if (last.endTime <= last.startTime + EPS) {
                last.endTime = last.startTime + MIN_CLIP_SEC
            }
        }

        // Ghi đè lại mảng clips để phần convert dùng dữ liệu đã sanitize.
        clips.length = 0
        clips.push(...dedupedClips)

        onStepUpdate(
            'image',
            'running',
            `🎨 Timeline ảnh đã sanitize — clips=${clips.length}, gapFilled=${gapsFilled}, overlapFixed=${overlapsFixed}, dropDup=${duplicateTimeRangeDropped}`
        )

        // Bước 3: Convert ảnh tĩnh → video (nếu cần)
        // ★ CapCut KHÔNG cần convert ảnh → video: CapCut dùng ảnh gốc (type="photo"),
        //   tự set duration qua source_timerange. Chỉ DaVinci mới cần video.
        const isCapCutTarget = _config.targetEngine === 'capcut'
        
        if (isCapCutTarget) {
            // CapCut: giữ nguyên ảnh gốc, KHÔNG convert
            console.log(`[AutoMedia] 🖼️ CapCut mode: bỏ qua convert ảnh → video (${clips.length} clips dùng ảnh gốc)`)
            onStepUpdate('image', 'running', `🖼️ CapCut: dùng ảnh gốc (không cần convert) — ${clips.length} clips`)
        } else {
            // DaVinci: convert ảnh tĩnh → video bằng ffmpeg
            // ★ Skip ảnh đã convert bởi Incremental Unlock (Pha 2) → tránh convert 2 lần
            const FPS = TRACK_LAYOUT.DEFAULT_FPS
            const stillJobs: Array<{ inputPath: string; durationFrames: number; outputPath: string }> = []
            let skippedByIncremental = 0
            for (const clip of clips) {
                if (isStillImage(clip.filePath)) {
                    // Kiểm tra đã convert bởi Incremental chưa
                    if (incrementalConvertedSet.has(clip.filePath)) {
                        skippedByIncremental++
                        // Ảnh đã convert → chỉ cần update filePath sang output path
                        clip.filePath = await getVideoOutputPath(clip.filePath)
                        continue
                    }
                    const durationFrames = Math.max(1, Math.round((clip.endTime - clip.startTime) * FPS))
                    stillJobs.push({
                        inputPath: clip.filePath,
                        durationFrames,
                        outputPath: await getVideoOutputPath(clip.filePath),
                    })
                }
            }

            if (skippedByIncremental > 0) {
                console.log(`[AutoMedia] ⚡ Image Pipeline: ${skippedByIncremental} ảnh đã convert bởi Incremental, chỉ cần convert thêm ${stillJobs.length}`)
            }

            if (stillJobs.length > 0) {
                await ensureTempDir()
                await convertImagesToVideo(stillJobs, TRACK_LAYOUT.DEFAULT_FPS, (progress) => {
                    onStepUpdate('image', 'running', `🎨 Convert ảnh → video: ${progress.current || '?'}/${progress.total || stillJobs.length} (${skippedByIncremental} đã sẵn sàng)`)
                })
                // Thay filePath bằng video đã convert (chỉ cho ảnh mới convert)
                for (const clip of clips) {
                    if (isStillImage(clip.filePath)) {
                        clip.filePath = await getVideoOutputPath(clip.filePath)
                    }
                }
            }
        }

        checkAbort()

        // ★ CORE PIPELINE: Return dữ liệu cho Adapter (KHÔNG gọi DaVinci API)
        const convertInfo = isCapCutTarget ? 'skip (CapCut dùng ảnh gốc)' : 'done'
        const debugImg = `total files: ${deps.imageFiles.length} | matched: ${matchResults.filter(r => r.quality === 'matched').length} | clips: ${clips.length} | convert: ${convertInfo}\nvoiceEnd: ${voiceEndTime.toFixed(1)}s | gapFilled: ${gapsFilled} | overlapFixed: ${overlapsFixed} | dropDup: ${duplicateTimeRangeDropped}\nSample: ${clips.slice(0, 3).map(c => `"${c.filePath.split('/').pop()}" ${c.startTime.toFixed(1)}-${c.endTime.toFixed(1)}s`).join(' | ')}\nRange: ${clips[0]?.startTime.toFixed(1)}s → ${clips[clips.length-1]?.endTime.toFixed(1)}s`
        onStepUpdate('image', 'done', `✅ Image: ${clips.length} clips sẵn sàng`, undefined, debugImg)

        return clips as TimelineImageClip[]

    } catch (err) {
        if (String(err).includes('Pipeline đã bị dừng')) {
            onStepUpdate('image', 'skipped', 'Đã dừng')
        } else {
            onStepUpdate('image', 'error', 'Image pipeline lỗi', String(err))
        }
        return []
    }
}

/**
 * Subtitle Pipeline: AI match → trả về subtitle data + SRT
 * KHÔNG gọi DaVinci API — Adapter sẽ import lên đích
 */
async function runSubtitlePipeline(
    deps: AutoMediaDependencies,
    matchedSentences: MatchingSentence[],
    onStepUpdate: OnStepUpdate,
    config: AutoMediaConfig
): Promise<{ subtitleLines: TimelineSubtitleLine[]; srtContent?: string; srtFilePath?: string }> {
    onStepUpdate('subtitle', 'running', '📝 Đang đọc transcript / sentence data...')

    try {
        checkAbort()

        let subtitleLines: any[] = [];
        
        if (matchedSentences && matchedSentences.length > 0) {
            onStepUpdate('subtitle', 'running', '🤖 AI đang chia nhỏ phụ đề từ danh sách câu (MatchingSentences)...')
            const { aiSubtitleMatchFromSentences } = await import('@/services/subtitle-matcher-service')
            subtitleLines = await aiSubtitleMatchFromSentences(
                matchedSentences,
                deps.masterSrt || null,
                (progress: any) => {
                    onStepUpdate('subtitle', 'running', `🤖 Phụ đề: ${progress.message}`)
                }
            )
        } else {
            // Đọc transcript
            let transcriptData: any = null
            if (deps.masterSrt && deps.masterSrt.length > 0) {
                onStepUpdate('subtitle', 'running', '🌟 Dùng Master SRT cho phụ đề...')
                const { masterSrtToTranscript } = await import('@/utils/master-srt-utils')
                transcriptData = masterSrtToTranscript(deps.masterSrt)
            } else {
                transcriptData = await readTranscript(`${deps.transcriptId || deps.timelineId}.json`)
            }

            if (!transcriptData) {
                onStepUpdate('subtitle', 'error', 'Không tìm thấy transcript', `${deps.transcriptId || deps.timelineId}.json`)
                return { subtitleLines: [] }
            }

            onStepUpdate('subtitle', 'running', '🤖 AI đang so khớp phụ đề với whisper...')
            const { aiSubtitleMatch } = await import('@/services/subtitle-matcher-service')
            subtitleLines = await aiSubtitleMatch(
                deps.scriptText,
                transcriptData,
                (progress) => {
                    onStepUpdate('subtitle', 'running', `🤖 Phụ đề: ${progress.message}`)
                }
            )
        }

        // Cập nhật ProjectContext
        onStepUpdate('subtitle', 'running', `💾 Lưu ${subtitleLines.length} dòng phụ đề...`)
        deps.updateSubtitleData({
            subtitleLines,
            selectedTrack: TRACK_LAYOUT.TEXT_ONSCREEN_TRACK,
        })

        checkAbort()

        // Tạo SRT content (dùng chung cho cả DaVinci SRT và CapCut)
        let srtContent = ''
        subtitleLines.forEach((line: any, index: number) => {
            const formatTime = (secs: number) => {
                const h = Math.floor(secs / 3600).toString().padStart(2, '0')
                const m = Math.floor((secs % 3600) / 60).toString().padStart(2, '0')
                const s = Math.floor(secs % 60).toString().padStart(2, '0')
                const ms = Math.floor((secs % 1) * 1000).toString().padStart(3, '0')
                return `${h}:${m}:${s},${ms}`
            }
            const startTc = formatTime(line.start)
            const endTc = formatTime(line.end)
            const text = (line.text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
            if (text && line.end > line.start) {
                srtContent += `${index + 1}\n`
                srtContent += `${startTc} --> ${endTc}\n`
                srtContent += `${text}\n\n`
            }
        })

        // Lưu file SRT (cả 2 engine đều cần file SRT)
        let srtFilePath = ''
        if (srtContent.trim()) {
            const { desktopDir } = await import('@tauri-apps/api/path')
            const pDesktop = await desktopDir()
            const autoMediaDir = await join(pDesktop, 'Auto_media')
            if (!(await exists(autoMediaDir))) {
                await mkdir(autoMediaDir, { recursive: true })
            }
            srtFilePath = await join(autoMediaDir, `Autosubs_${deps.transcriptId || deps.timelineId || 'phude'}.srt`)
            await writeTextFile(srtFilePath, srtContent)
        }

        // Chuyển sang TimelineSubtitleLine[]
        const result: TimelineSubtitleLine[] = subtitleLines
            .filter((l: any) => l.text && l.end > l.start)
            .map((l: any) => ({ text: l.text, start: l.start, end: l.end }))

        const debugSub = `subtitleLines: ${result.length} | srtFile: ${srtFilePath?.split('/').pop() || '(none)'} | mode: ${config.subtitleMode}`
        onStepUpdate('subtitle', 'done', `✅ Subtitle: ${result.length} dòng sẵn sàng`, undefined, debugSub)

        return { subtitleLines: result, srtContent, srtFilePath }

    } catch (err) {
        if (String(err).includes('Pipeline đã bị dừng')) {
            onStepUpdate('subtitle', 'skipped', 'Đã dừng')
        } else {
            onStepUpdate('subtitle', 'error', 'Phụ đề lỗi', String(err))
        }
        return { subtitleLines: [] }
    }
}

/**
 * Music Pipeline: AI phân tích → chọn nhạc từ thư viện → render + import
 */
async function runMusicPipeline(
    deps: AutoMediaDependencies,
    matchedSentences: ScriptSentence[],
    onStepUpdate: OnStepUpdate
): Promise<TimelineBgmResult | null> {
    onStepUpdate('music', 'running', '🎥 Chuẩn bị dữ liệu cho AI Đạo Diễn...')

    try {
        checkAbort()

        // Chuyển matchedSentences sang MatchingSentence format
        const matchingSentences: MatchingSentence[] = matchedSentences.map(s => ({
            num: s.num,
            text: s.text,
            start: s.start,
            end: s.end,
            quality: s.quality,
            matchRate: s.matchRate || '',
            matchedWhisper: s.matchedWhisper || '',
        }))

        // Gọi AI Director (logic hiện có — chọn nhạc từ thư viện)
        const analyzedItems = deps.musicItems.filter(i => i.aiMetadata)
        onStepUpdate('music', 'running', `🤖 AI Đạo Diễn đang phân tích ${matchingSentences.length} câu + ${analyzedItems.length} bài nhạc...`)
        const directorResult = await analyzeScriptForMusic(
            deps.matchingFolder || deps.imageFolder,
            matchingSentences,
            analyzedItems,
            (msg) => onStepUpdate('music', 'running', `🎵 Nhạc nền: ${msg}`)
        )

        // Cập nhật ProjectContext
        onStepUpdate('music', 'running', '💾 Lưu kết quả AI Đạo Diễn...')
        deps.updateMusicLibrary({ directorResult })

        checkAbort()

        // Render nhạc nền (mix + ducking) — GIỐNG TAB MUSIC
        if (directorResult && directorResult.scenes && directorResult.scenes.length > 0) {
            onStepUpdate('music', 'running', `🎶 Đang render nhạc nền: ${directorResult.scenes.length} scenes (Crossfade + Auto Ducking)...`)

            // Chuẩn bị scenes cho FFmpeg (giống music-library-tab.tsx)
            const ffmpegScenes = directorResult.scenes.map(s => ({
                filePath: s.assignedMusic?.filePath || null,
                startTime: s.startTime,
                endTime: s.endTime,
                startOffset: s.assignedMusicStartTime ?? 0
            }))

            // Import lazy để tránh circular
            const { mixAudioScenesAndDuck } = await import('@/services/audio-ffmpeg-service')

            const resFFmpeg = await mixAudioScenesAndDuck({
                outputFolder: deps.matchingFolder || deps.imageFolder,
                scenes: ffmpegScenes,
                sentences: matchingSentences,
                duckingVolume: 0.30, // Đồng bộ tab Music — nhạc nền không bị nhỏ quá sâu khi có giọng nói
                onProgress: (p) => onStepUpdate('music', 'running', `🎶 FFmpeg: ${p}`)
            })

            checkAbort()

            // ★ CORE PIPELINE: Return dữ liệu cho Adapter (KHÔNG gọi DaVinci API)
            const debugMusicOk = `scenes: ${directorResult.scenes.length} | output: ${resFFmpeg.outputPath?.split('/').pop() || '?'}\n${directorResult.scenes.slice(0, 5).map((s: any) => `[Scene${s.sceneId}] ${s.startTime?.toFixed(0)}-${s.endTime?.toFixed(0)}s "${s.assignedMusicFileName || 'null'}" ${s.emotion || ''} (${s.transition || ''})`).join('\n')}${directorResult.scenes.length > 5 ? `\n... +${directorResult.scenes.length - 5} scenes nữa` : ''}`
            onStepUpdate('music', 'done', `✅ Music: ${directorResult.scenes.length} scenes đã mix`, undefined, debugMusicOk)

            return {
                mixedAudioPath: resFFmpeg.outputPath,
                sceneCount: directorResult.scenes.length,
                directorResult,
            } as TimelineBgmResult
        } else {
            onStepUpdate('music', 'done', '✅ Phân tích nhạc nền xong (không có scene nào)', undefined, `directorResult.scenes: ${directorResult?.scenes?.length || 0}`)
            return null
        }

    } catch (err) {
        if (String(err).includes('Pipeline đã bị dừng')) {
            onStepUpdate('music', 'skipped', 'Đã dừng')
        } else {
            const errStr = String(err)
            console.error('[AutoMedia] Music pipeline error:', errStr)
            const debugMusic = `matchingSentences=${matchedSentences.length} | musicItems=${deps.musicItems.length} | analyzed=${deps.musicItems.filter(i => i.aiMetadata).length} | scriptPreview="${deps.scriptText?.substring(0, 80) || '(empty)'}..."`
            onStepUpdate('music', 'error', 'Nhạc nền lỗi', `❌ ${errStr}`, debugMusic)
        }
        return null
    }
}

/**
 * SFX Pipeline: AI plan → auto assign → normalize → trả về TimelineSfxClip[]
 * KHÔNG gọi DaVinci API — Adapter sẽ import lên đích
 */
async function runSfxPipeline(
    deps: AutoMediaDependencies,
    matchedSentences: ScriptSentence[],
    onStepUpdate: OnStepUpdate
): Promise<TimelineSfxClip[]> {
    onStepUpdate('sfx', 'running', '🔊 Chuẩn bị dữ liệu + Whisper words cho AI SFX...')

    try {
        checkAbort()

        // Chuyển format
        const matchingSentences: MatchingSentence[] = matchedSentences.map(s => ({
            num: s.num,
            text: s.text,
            start: s.start,
            end: s.end,
            quality: s.quality,
            matchRate: s.matchRate || '',
            matchedWhisper: s.matchedWhisper || '',
        }))

        // Tạo whisper words từ Master SRT (hoặc subtitles nếu thiếu) (giống logic trong sfx-library-tab)
        let whisperWords: Array<{ t: number; w: string; e: number }> | undefined
        const allWords: Array<{ t: number; w: string; e: number }> = []

        if (deps.masterSrt && deps.masterSrt.length > 0) {
            for (const mw of deps.masterSrt) {
                allWords.push({
                    t: Math.round(mw.start * 100) / 100,
                    w: mw.word || '',
                    e: Math.round(mw.end * 100) / 100,
                })
            }
        } else if (deps.subtitles && deps.subtitles.length > 0) {
            for (const seg of deps.subtitles) {
                if (!(seg as any).words || (seg as any).words.length === 0) continue
                for (const word of (seg as any).words) {
                    const wordText = (word.word || '').trim()
                    if (!wordText) continue
                    const start = typeof word.start === 'string' ? parseFloat(word.start) : word.start
                    const end = typeof word.end === 'string' ? parseFloat(word.end) : word.end
                    if (!isNaN(start)) {
                        allWords.push({
                            t: Math.round(start * 100) / 100,
                            w: wordText,
                            e: !isNaN(end) ? Math.round(end * 100) / 100 : 0,
                        })
                    }
                }
            }
        }

        if (allWords.length > 0) {
            allWords.sort((a, b) => a.t - b.t)
            // Fill end times
            for (let i = 0; i < allWords.length; i++) {
                if (allWords[i].e === 0) {
                    allWords[i].e = i < allWords.length - 1 ? allWords[i + 1].t : allWords[i].t + 0.3
                }
            }
            if (allWords.length > 0) whisperWords = allWords
        }

        onStepUpdate('sfx', 'running', `🤖 AI SFX Planner: ${matchingSentences.length} câu, ${whisperWords?.length || 0} words, ${deps.sfxItems.length} SFX files...`)

        // Bước A: AI plan SFX cues (logic hiện có — 5 batch song song)
        const sfxResult = await analyzeScriptForSFX(
            deps.matchingFolder || deps.imageFolder,
            matchingSentences,
            deps.sfxItems,
            whisperWords,
            (msg) => onStepUpdate('sfx', 'running', `🤖 SFX: ${msg}`)
        )

        // Cập nhật ProjectContext
        onStepUpdate('sfx', 'running', `💾 Lưu kết quả AI SFX: ${sfxResult.cues.length} cues...`)
        deps.updateSfxLibrary({ sfxPlan: sfxResult })

        checkAbort()

        // Bước B: Auto assign (khớp file SFX + whisper timing)
        onStepUpdate('sfx', 'running', `🔗 Auto-assign: khớp ${sfxResult.cues.length} cues với file SFX + whisper timing...`)

        const assignedCues = sfxResult.cues
            .map(cue => {
                // Whisper timing chính xác
                let exactStartTime: number | undefined
                if (whisperWords && matchingSentences) {
                    const sentence = matchingSentences.find(s => s.num === cue.sentenceNum)
                    if (sentence) {
                        // Nếu câu quá ngắn (nhiều câu trùng timestamp) → mở rộng phạm vi tìm
                        const sentenceDur = sentence.end - sentence.start
                        const expandedStart = sentenceDur < 3 ? sentence.start - 5 : sentence.start
                        const expandedEnd = sentenceDur < 3 ? sentence.end + 10 : sentence.end

                        const wordMatch = matchWordsToTimestamps(
                            cue.triggerWord,
                            whisperWords,
                            expandedStart,
                            expandedEnd
                        )
                        if (wordMatch.success) {
                            exactStartTime = wordMatch.start
                        }
                    }
                }

                // Fallback: nếu whisper fail → dùng sentence.start + timeOffset (ước lượng)
                // KHÔNG loại bỏ cue — SFX vẫn được import dù timing không chính xác từng từ
                if (exactStartTime === undefined) {
                    const sentence = matchingSentences?.find(s => s.num === cue.sentenceNum)
                    if (sentence) {
                        exactStartTime = sentence.start + (cue.timeOffset || 0)
                        console.warn(`[SFX Auto] ⚠️ Câu ${cue.sentenceNum}: whisper fail → fallback ${exactStartTime.toFixed(1)}s`)
                    } else {
                        return null // Không tìm được câu → loại
                    }
                }

                // Smart match file SFX (inline logic — ưu tiên metadata tags → tên file → random)
                const matchedItem = smartMatchSfxFileInline(cue, deps.sfxItems)

                return {
                    ...cue,
                    assignedSfxPath: matchedItem?.filePath,
                    assignedSfxName: matchedItem?.fileName,
                    exactStartTime,
                }
            })
            .filter((cue): cue is NonNullable<typeof cue> => cue !== null)
            .filter(cue => cue.assignedSfxPath) // Chỉ giữ cue có file

        deps.updateSfxLibrary({ sfxPlan: { ...sfxResult, cues: assignedCues } })

        checkAbort()

        // Bước C: Normalize + Import vào DaVinci Audio Track
        if (assignedCues.length === 0) {
            onStepUpdate('sfx', 'done', '✅ Không có SFX cue nào khớp whisper timing')
            return []
        }

        onStepUpdate('sfx', 'running', `🎧 Normalize ${assignedCues.length} SFX clips (-30 LUFS)...`)

        const sfxTargetLufs = -30 // Giảm 30% so với -26 LUFS, nhỏ nhẹ không lấn át giọng nói
        const normalizedClips: Array<{ filePath: string; startTime: number; trimStartSec?: number; trimEndSec?: number }> = []
        const processedPaths = new Map<string, string>()
        const outputFolder = deps.matchingFolder || deps.imageFolder

        // Biến đếm file bị lỗi (encoding lạ, không tồn tại, FFmpeg fail...)
        let skippedCount = 0

        for (let i = 0; i < assignedCues.length; i++) {
            const c = assignedCues[i]
            const originalPath = c.assignedSfxPath!
            const sfxFileName = originalPath.split(/[/\\]/).pop() || 'sfx.wav'

            // Sub-step: progress normalize từng file
            onStepUpdate('sfx', 'running', `🎧 Normalize SFX ${i + 1}/${assignedCues.length}: ${sfxFileName}`)

            // ★ Try/catch từng file — 1 file lỗi KHÔNG crash cả pipeline
            // Nguyên nhân thường gặp: file không tồn tại, tên file encoding lạ (non-UTF-8),
            // FFmpeg không đọc được file (corrupted)
            try {
                // Kiểm tra file nguồn tồn tại trước khi gọi FFmpeg
                const { exists: fileExists } = await import('@tauri-apps/plugin-fs')
                const sourceExists = await fileExists(originalPath)
                if (!sourceExists) {
                    console.warn(`[SFX Auto] ⚠️ File không tồn tại, bỏ qua: ${originalPath}`)
                    skippedCount++
                    continue
                }

                let normalizedPath: string
                if (processedPaths.has(originalPath)) {
                    normalizedPath = processedPaths.get(originalPath)!
                } else {
                    const baseName = sfxFileName.replace(/\.[^.]+$/, '')
                    normalizedPath = await join(outputFolder, `${baseName}_${sfxTargetLufs}lufs.wav`)
                    await normalizeSfxVolume(originalPath, normalizedPath, sfxTargetLufs)
                    processedPaths.set(originalPath, normalizedPath)
                }

                normalizedClips.push({
                    filePath: normalizedPath,
                    startTime: c.exactStartTime!,
                    trimStartSec: c.trimStartSec,
                    trimEndSec: c.trimEndSec,
                })
            } catch (sfxErr) {
                // Bỏ qua file lỗi, tiếp tục file tiếp theo
                console.warn(`[SFX Auto] ⚠️ Lỗi normalize "${sfxFileName}", bỏ qua:`, sfxErr)
                skippedCount++
            }
        }

        // Log số file bị bỏ qua (nếu có)
        if (skippedCount > 0) {
            console.warn(`[SFX Auto] ⚠️ ${skippedCount}/${assignedCues.length} file SFX bị bỏ qua do lỗi`)
        }

        // Import vào DaVinci — chỉ import nếu còn clips sau khi bỏ lỗi
        if (normalizedClips.length === 0) {
            const skipMsg = skippedCount > 0
                ? `✅ Tất cả ${skippedCount} SFX file đều lỗi (không tồn tại hoặc encoding lạ)`
                : '✅ Không có SFX clip nào để import'
            onStepUpdate('sfx', 'done', skipMsg)
            return []
        }

        // ★ CORE PIPELINE: Return dữ liệu cho Adapter (KHÔNG gọi DaVinci API)
        const skipInfo = skippedCount > 0 ? ` (⚠️ ${skippedCount} file bị bỏ qua)` : ''
        const debugSfxOk = `totalCues: ${sfxResult.cues.length} | assigned: ${assignedCues.length} | normalized: ${normalizedClips.length} | skipped: ${skippedCount}\n${assignedCues.slice(0, 5).map(c => `[Câu${c.sentenceNum}] "${c.triggerWord}" @${c.exactStartTime?.toFixed(1)}s → "${c.assignedSfxName}" (${c.sfxCategory})`).join('\n')}${assignedCues.length > 5 ? `\n... +${assignedCues.length - 5} cues nữa` : ''}`
        onStepUpdate('sfx', 'done', `✅ SFX: ${normalizedClips.length} clips sẵn sàng${skipInfo}`, undefined, debugSfxOk)

        return normalizedClips as TimelineSfxClip[]

    } catch (err) {
        if (String(err).includes('Pipeline đã bị dừng')) {
            onStepUpdate('sfx', 'skipped', 'Đã dừng')
        } else {
            const errStr = String(err)
            console.error('[AutoMedia] SFX pipeline error:', errStr)
            // Debug details: input data summary
            const debugSfx = `sentences=${matchedSentences.length} | sfxItems=${deps.sfxItems.length} | analyzed=${deps.sfxItems.filter(i => i.aiMetadata).length} | whisperSegments=${deps.subtitles?.length || 0} | scriptLen=${deps.scriptText?.length || 0}`
            onStepUpdate('sfx', 'error', 'SFX lỗi', `❌ ${errStr}`, debugSfx)
        }
        return []
    }
}

/**
 * Footage Pipeline: AI match → trả về TimelineFootageClip[]
 * KHÔNG gọi DaVinci API — Adapter sẽ import lên đích
 */
async function runFootagePipeline(
    deps: AutoMediaDependencies,
    matchedSentences: ScriptSentence[],
    wordTimingTokens: Array<{ timestamp: number; word: string }>,
    onStepUpdate: OnStepUpdate
): Promise<TimelineFootageClip[]> {
    onStepUpdate('footage', 'running', '🎬 Chuẩn bị dữ liệu footage + kiểm tra API key...')

    try {
        checkAbort()

        // Format sentences
        const sentences = matchedSentences.map((s, i) => ({
            text: s.text,
            start: s.start,
            end: s.end,
            index: i,
        }))

        const totalDuration = sentences.length > 0 ? sentences[sentences.length - 1].end : 60

        onStepUpdate('footage', 'running', `🤖 AI đang match ${deps.footageItems.length} footage với ${sentences.length} câu script...`)

        // AI match footage (logic hiện có)
        const suggestions = await matchFootageToScript(
            sentences,
            deps.footageItems,
            "", // apiKey đã được deprecate
            totalDuration,
            wordTimingTokens
        )

        checkAbort()

        if (suggestions.length === 0) {
            onStepUpdate('footage', 'done', '✅ AI không gợi ý footage nào')
            return []
        }

        // ★ CORE PIPELINE: Return dữ liệu cho Adapter (KHÔNG gọi DaVinci API)
        const footageClips: TimelineFootageClip[] = suggestions.map(s => ({
            filePath: s.footagePath,
            startTime: s.startTime,
            endTime: s.endTime,
            trimStart: s.trimStart,
            trimEnd: s.trimEnd,
        }))

        const debugFootage = `footageItems: ${deps.footageItems.length} | suggestions: ${suggestions.length}\n${suggestions.slice(0, 5).map((s: any) => `"${s.footagePath?.split('/').pop()}" ${s.startTime?.toFixed(1)}-${s.endTime?.toFixed(1)}s trim=${s.trimStart?.toFixed(1)}-${s.trimEnd?.toFixed(1)}`).join('\n')}${suggestions.length > 5 ? `\n... +${suggestions.length - 5} nữa` : ''}`
        onStepUpdate('footage', 'done', `✅ Footage: ${footageClips.length} clips sẵn sàng`, undefined, debugFootage)

        return footageClips

    } catch (err) {
        if (String(err).includes('Pipeline đã bị dừng')) {
            onStepUpdate('footage', 'skipped', 'Đã dừng')
        } else {
            onStepUpdate('footage', 'error', 'Footage lỗi', String(err))
        }
        return []
    }
}
// NOTE: runEffectsPipeline đã chuyển sang davinci-adapter.ts
// Core Pipeline không gọi API engine nào trực tiếp

// ======================== HELPER: SMART MATCH SFX FILE ========================
// Copy logic từ sfx-library-tab.tsx — inline để không cần module riêng

/**
 * Smart match SFX file từ thư viện dựa trên AI cue
 * Ưu tiên: metadata tags → tên file → description → random
 */
function smartMatchSfxFileInline(
    cue: { searchKeywords?: string[]; sfxCategory?: string },
    sfxItems: AudioLibraryItem[]
): AudioLibraryItem | null {
    if (sfxItems.length === 0) return null

    // ★ FIX: AI có thể không trả về searchKeywords/sfxCategory → fallback
    const keywords = (cue.searchKeywords || []).map(kw => kw.toLowerCase())
    const category = (cue.sfxCategory || '').toLowerCase()

    // Ưu tiên 1: AI metadata tags/emotion khớp searchKeywords hoặc category
    const byMetadata = sfxItems.filter(item => {
        if (!item.aiMetadata) return false
        const tags = item.aiMetadata.tags.map(t => t.toLowerCase())
        const emotions = item.aiMetadata.emotion.map(e => e.toLowerCase())
        const allMeta = [...tags, ...emotions]
        return keywords.some(kw => allMeta.some(m => m.includes(kw) || kw.includes(m)))
            || allMeta.some(m => m.includes(category))
    })
    if (byMetadata.length > 0) {
        return byMetadata[Math.floor(Math.random() * byMetadata.length)]
    }

    // Ưu tiên 2: Tên file chứa keyword hoặc category
    const byName = sfxItems.filter(item => {
        const name = item.fileName.toLowerCase()
        return keywords.some(kw => name.includes(kw)) || name.includes(category)
    })
    if (byName.length > 0) {
        return byName[Math.floor(Math.random() * byName.length)]
    }

    // Ưu tiên 3: Description chứa keyword
    const byDesc = sfxItems.filter(item => {
        if (!item.aiMetadata) return false
        const desc = item.aiMetadata.description.toLowerCase()
        return keywords.some(kw => desc.includes(kw))
    })
    if (byDesc.length > 0) {
        return byDesc[Math.floor(Math.random() * byDesc.length)]
    }

    // Fallback: random
    return sfxItems[Math.floor(Math.random() * sfxItems.length)]
}
