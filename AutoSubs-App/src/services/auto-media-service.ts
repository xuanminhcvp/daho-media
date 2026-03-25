// auto-media-service.ts
// Service orchestrator cho Auto Media Pipeline
// KHÔNG viết logic mới — chỉ GỌI LẠI các hàm hiện có theo đúng thứ tự
//
// 4 bước:
//   Bước 1: Transcribe (nếu chưa có)
//   Bước 2: AI so chiếu script ↔ voice timing → matchingSentences
//   Bước 3: 5 việc song song (Image, Subtitle, Music, SFX, Footage)
//   Bước 4: Effects (sau khi Image xong)
//
// Track cố định: V1=ảnh, V2=footage, V3=phụ đề, A1=SFX, A2=voice, A3=nhạc nền
// 24fps mặc định

import type {
    AutoMediaConfig,
    OnStepUpdate,
    PrerequisiteCheck,
} from '@/types/auto-media-types'
import { MIN_SCANNED_FILES, TRACK_LAYOUT } from '@/types/auto-media-types'

// ======================== IMPORTS TỪ SERVICES HIỆN CÓ ========================

import { aiMatchScriptToTimeline, saveMatchingResults } from '@/services/ai-matcher'
import { aiSubtitleMatch } from '@/services/subtitle-matcher-service'
import { analyzeScriptForMusic, analyzeScriptForSFX } from '@/services/audio-director-service'
import { matchFootageToScript } from '@/services/footage-matcher-service'
import { addSfxClipsToTimeline, addMediaToTimeline } from '@/api/resolve-api'
import { normalizeSfxVolume } from '@/services/audio-ffmpeg-service'
import { readTranscript } from '@/utils/file-utils'
import { matchWordsToTimestamps } from '@/utils/whisper-words-matcher'
import { getAudioScanApiKey } from '@/services/saved-folders-service'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { join } from '@tauri-apps/api/path'
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
    /** Subtitles từ TranscriptContext (chứa whisper word-level timestamps) */
    subtitles: Subtitle[]

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
    abortController = new AbortController()

    console.log('[AutoMedia] 🚀 Bắt đầu pipeline...')

    try {
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
        // Sub-step 2a: Parse script
        onStepUpdate('aiMatch', 'running', '📝 Đang parse script text...')

        const sentences = parseScript(deps.scriptText)
        if (sentences.length === 0) {
            onStepUpdate('aiMatch', 'error', 'Script không có câu nào', 'Kiểm tra lại script đã paste')
            throw new Error('Script không có câu nào')
        }
        onStepUpdate('aiMatch', 'running', `📝 ${sentences.length} câu script → đọc transcript...`)

        // Sub-step 2b: Đọc transcript
        const transcript = await readTranscript(`${deps.timelineId}.json`)
        if (!transcript) {
            onStepUpdate('aiMatch', 'error', 'Không tìm thấy transcript file', `${deps.timelineId}.json`)
            throw new Error('Không tìm thấy transcript file')
        }
        onStepUpdate('aiMatch', 'running', `📝 ${sentences.length} câu script + transcript → gọi AI matching...`)

        // Sub-step 2c: Gọi AI match (logic hiện có — có retry 2 vòng)
        let matchedSentences: ScriptSentence[]
        try {
            matchedSentences = await aiMatchScriptToTimeline(
                sentences,
                transcript,
                (progress) => {
                    // Hiển thị chi tiết progress từ AI matcher (batch 1/5, retry...)
                    onStepUpdate('aiMatch', 'running', `🤖 AI match: ${progress.message}`)
                },
                deps.imageFolder || undefined
            )
        } catch (err) {
            onStepUpdate('aiMatch', 'error', 'AI match lỗi', String(err))
            throw new Error('AI match thất bại')
        }

        // Sub-step 2d: Lưu kết quả
        onStepUpdate('aiMatch', 'running', '💾 Đang lưu matching results...')
        deps.setMatchingSentences(matchedSentences)
        if (deps.imageFolder) {
            deps.setMatchingFolder(deps.imageFolder)
            await saveMatchingResults(deps.imageFolder, matchedSentences)
        }

        // Debug: đếm chi tiết quality
        const highCount = matchedSentences.filter(s => s.quality === 'high').length
        const mediumCount = matchedSentences.filter(s => s.quality === 'medium').length
        const lowCount = matchedSentences.filter(s => s.quality === 'low').length
        const totalMatched = matchedSentences.filter(s => s.start > 0 || s.end > 0).length
        console.log(`[AutoMedia] AI match: high=${highCount}, medium=${mediumCount}, low=${lowCount}, total matched=${totalMatched}`)
        // Debug details cho AI match
        const debugAiMatch = `total=${matchedSentences.length} | high=${highCount} medium=${mediumCount} low=${lowCount} | withTiming=${totalMatched} | sample: ${matchedSentences.slice(0, 2).map(s => `[${s.num}] ${s.text.substring(0, 30)}... start=${s.start.toFixed(1)} quality=${s.quality}`).join(' | ')}`
        onStepUpdate('aiMatch', 'done', `✅ ${totalMatched}/${sentences.length} câu matched (high: ${highCount}, medium: ${mediumCount})`, undefined, debugAiMatch)
        console.log('[AutoMedia] AI match hoàn tất:', matchedSentences.length, 'câu')

        checkAbort()

        // Debug mode: dừng chờ user nhấn Tiếp tục sau AI Match
        if (config.debugMode && deps.waitForContinue) {
            console.log('[AutoMedia] 🐛 Debug: chờ user nhấn Tiếp tục...')
            await deps.waitForContinue()
        }

        // ====== BƯỚC 3: CÁC BƯỚC CON ======
        // Debug mode: chạy tuần tự + dừng chờ user nhấn "Tiếp tục"
        // Normal mode: chạy song song (Promise.allSettled)

        // Helper: chạy 1 step + pause nếu debug mode
        const runStepWithDebugPause = async (
            _stepName: string,
            stepFn: () => Promise<void>
        ) => {
            await stepFn()
            // Nếu debug mode → pause chờ user nhấn Tiếp tục
            if (config.debugMode && deps.waitForContinue) {
                await deps.waitForContinue()
            }
        }

        // Build danh sách steps cần chạy
        interface StepTask {
            name: string
            enabled: boolean
            skipReason?: string
            run: () => Promise<void>
        }

        const steps: StepTask[] = [
            {
                name: 'image',
                enabled: config.enableImage && !!deps.imageFolder && deps.imageFiles.length > 0,
                skipReason: 'Bỏ qua — thiếu folder ảnh hoặc file ảnh',
                run: () => runImagePipeline(deps, matchedSentences, onStepUpdate, config),
            },
            {
                name: 'subtitle',
                enabled: config.enableSubtitle && !!deps.scriptText.trim(),
                skipReason: 'Bỏ qua — thiếu script',
                run: () => runSubtitlePipeline(deps, onStepUpdate),
            },
            {
                name: 'music',
                enabled: config.enableMusic && deps.musicItems.filter(i => i.aiMetadata).length >= MIN_SCANNED_FILES,
                skipReason: 'Bỏ qua — thiếu folder nhạc hoặc chưa scan đủ',
                run: () => runMusicPipeline(deps, matchedSentences, onStepUpdate),
            },
            {
                name: 'sfx',
                enabled: config.enableSfx && deps.sfxItems.filter(i => i.aiMetadata).length >= MIN_SCANNED_FILES,
                skipReason: 'Bỏ qua — thiếu folder SFX hoặc chưa scan đủ',
                run: () => runSfxPipeline(deps, matchedSentences, onStepUpdate),
            },
            {
                name: 'footage',
                enabled: config.enableFootage && deps.footageItems.filter(i => i.aiDescription).length >= MIN_SCANNED_FILES,
                skipReason: 'Bỏ qua — thiếu folder footage hoặc chưa scan đủ',
                run: () => runFootagePipeline(deps, matchedSentences, onStepUpdate),
            },
        ]

        if (config.debugMode) {
            // ========== DEBUG MODE: TUẦN TỰ ==========
            console.log('[AutoMedia] 🐛 Debug mode: chạy tuần tự từng bước')
            for (const step of steps) {
                if (!step.enabled) {
                    if (step.skipReason) onStepUpdate(step.name as any, 'skipped', step.skipReason)
                    continue
                }
                await runStepWithDebugPause(step.name, step.run)
                checkAbort()
            }
        } else {
            // ========== NORMAL MODE: SONG SONG ==========
            const parallelTasks: Promise<void>[] = []
            for (const step of steps) {
                if (step.enabled) {
                    parallelTasks.push(step.run())
                } else if (step.skipReason) {
                    onStepUpdate(step.name as any, 'skipped', step.skipReason)
                }
            }
            await Promise.allSettled(parallelTasks)
        }

        console.log('[AutoMedia] ✅ Pipeline hoàn tất!')

    } catch (err) {
        console.error('[AutoMedia] ❌ Pipeline lỗi:', err)
        // Lỗi đã được báo qua onStepUpdate ở từng bước
    } finally {
        abortController = null
    }
}

// ======================== SUB-PIPELINES ========================

/**
 * Image Pipeline: Convert ảnh → video → import lên Track V1
 * Sau đó nếu bật Effects → chạy Effects luôn
 */
async function runImagePipeline(
    deps: AutoMediaDependencies,
    matchedSentences: ScriptSentence[],
    onStepUpdate: OnStepUpdate,
    config: AutoMediaConfig
): Promise<void> {
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
            selectedTrack: TRACK_LAYOUT.IMAGE_TRACK,
        })

        // Bước 2: Tạo clips để import
        // ★ ĐỒNG BỘ với Image Import Tab: dùng lastValidFilePath để lấp gaps
        // (Tab dùng: result.filePath || lastValidFilePath — tránh khoảng trống timeline)
        const clips: Array<{ filePath: string; startTime: number; endTime: number }> = []
        let lastValidFilePath = '' // Lưu ảnh trước đó để lấp gaps
        for (const result of matchResults) {
            // Import tất cả clips có timing hợp lệ
            if (result.endTime > result.startTime) {
                // Nếu có filePath → dùng, nếu không → dùng ảnh trước đó (giống tab)
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
            return
        }

        // Sort + fill gaps
        clips.sort((a, b) => a.startTime - b.startTime)
        for (let i = 0; i < clips.length - 1; i++) {
            const gap = clips[i + 1].startTime - clips[i].endTime
            if (gap > 0.05) clips[i].endTime = clips[i + 1].startTime
        }

        onStepUpdate('image', 'running', `🎨 Sort + fill gaps xong — ${clips.length} clips là ảnh tĩnh cần convert…`)

        // Bước 3: Convert ảnh tĩnh → video (nếu cần)
        const FPS = TRACK_LAYOUT.DEFAULT_FPS
        const stillJobs: Array<{ inputPath: string; durationFrames: number; outputPath: string }> = []
        for (const clip of clips) {
            if (isStillImage(clip.filePath)) {
                const durationFrames = Math.max(1, Math.round((clip.endTime - clip.startTime) * FPS))
                stillJobs.push({
                    inputPath: clip.filePath,
                    durationFrames,
                    outputPath: await getVideoOutputPath(clip.filePath),
                })
            }
        }

        if (stillJobs.length > 0) {
            await ensureTempDir()
            await convertImagesToVideo(stillJobs, TRACK_LAYOUT.DEFAULT_FPS, (progress) => {
                onStepUpdate('image', 'running', `🎨 Convert ảnh → video: ${progress.current || '?'}/${progress.total || stillJobs.length}`)
            })
            // Thay filePath bằng video đã convert
            for (const clip of clips) {
                if (isStillImage(clip.filePath)) {
                    clip.filePath = await getVideoOutputPath(clip.filePath)
                }
            }
        }

        checkAbort()

        // Bước 4: Import lên DaVinci Track V1
        onStepUpdate('image', 'running', `📥 Đang import ${clips.length} clips lên Track V${TRACK_LAYOUT.IMAGE_TRACK}...`)
        await addMediaToTimeline(clips, TRACK_LAYOUT.IMAGE_TRACK)

        // Debug: chi tiết clips đã import
        const debugImg = `total files: ${deps.imageFiles.length} | matched: ${matchResults.filter(r => r.quality === 'matched').length} | clips: ${clips.length} | still→video: ${stillJobs.length}\nSample: ${clips.slice(0, 3).map(c => `"${c.filePath.split('/').pop()}" ${c.startTime.toFixed(1)}-${c.endTime.toFixed(1)}s`).join(' | ')}\nRange: ${clips[0]?.startTime.toFixed(1)}s → ${clips[clips.length-1]?.endTime.toFixed(1)}s`
        onStepUpdate('image', 'done', `✅ Import ${clips.length} ảnh lên Track V${TRACK_LAYOUT.IMAGE_TRACK}`, undefined, debugImg)

        // Bước 5: Effects (chạy ngay sau import ảnh, không chờ bước khác)
        if (config.enableEffects) {
            await runEffectsPipeline(onStepUpdate, config)
        }

    } catch (err) {
        if (String(err).includes('Pipeline đã bị dừng')) {
            onStepUpdate('image', 'skipped', 'Đã dừng')
        } else {
            onStepUpdate('image', 'error', 'Import ảnh lỗi', String(err))
        }
    }
}

/**
 * Subtitle Pipeline: AI match → import lên Track V3
 */
async function runSubtitlePipeline(
    deps: AutoMediaDependencies,
    onStepUpdate: OnStepUpdate
): Promise<void> {
    onStepUpdate('subtitle', 'running', '📝 Đang đọc transcript file...')

    try {
        checkAbort()

        // Đọc transcript
        const transcriptData = await readTranscript(`${deps.timelineId}.json`)
        if (!transcriptData) {
            onStepUpdate('subtitle', 'error', 'Không tìm thấy transcript', `${deps.timelineId}.json`)
            return
        }

        onStepUpdate('subtitle', 'running', '🤖 AI đang so khớp phụ đề với whisper...')
        const subtitleLines = await aiSubtitleMatch(
            deps.scriptText,
            transcriptData,
            (progress) => {
                onStepUpdate('subtitle', 'running', `🤖 Phụ đề: ${progress.message} (${progress.current}/${progress.total})`)
            }
        )

        // Cập nhật ProjectContext
        onStepUpdate('subtitle', 'running', `💾 Lưu ${subtitleLines.length} dòng phụ đề...`)
        deps.updateSubtitleData({
            subtitleLines,
            selectedTrack: TRACK_LAYOUT.SUBTITLE_TRACK,
        })

        checkAbort()

        // Import lên DaVinci — giống hệt tab Subtitle
        // Track fallback: nếu selectedTrack = "0" → dùng track 3 (giống tab)
        const trackToUse = TRACK_LAYOUT.SUBTITLE_TRACK
        onStepUpdate('subtitle', 'running', `📥 Đang import ${subtitleLines.length} phụ đề lên Track V${trackToUse}...`)

        const response = await tauriFetch('http://127.0.0.1:56003/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                func: 'AddSimpleSubtitles',
                clips: subtitleLines.map(line => ({
                    text: line.text,
                    start: line.start,
                    end: line.end,
                })),
                // ★ ĐỒNG BỘ TAB: dùng template + fontSize từ ProjectContext
                templateName: deps.subtitleTemplate || 'Subtitle Default',
                trackIndex: trackToUse,
                fontSize: deps.subtitleFontSize || 0.04,
            }),
        })

        // ★ ĐỒNG BỘ TAB: Check response lỗi (tab có check, auto trước đây không)
        const result = await response.json() as any
        if (result.error) {
            throw new Error(result.message || 'Lỗi import phụ đề từ DaVinci')
        }

        const debugSub = `subtitleLines=${subtitleLines.length} | template=${deps.subtitleTemplate} | fontSize=${deps.subtitleFontSize} | scriptLen=${deps.scriptText?.length || 0} | sample: ${subtitleLines.slice(0, 2).map(l => `"${l.text?.substring(0, 25)}..." ${l.start?.toFixed(1)}-${l.end?.toFixed(1)}`).join(' | ')}`
        onStepUpdate('subtitle', 'done', `✅ Import ${subtitleLines.length} phụ đề lên V${trackToUse}`, undefined, debugSub)

    } catch (err) {
        if (String(err).includes('Pipeline đã bị dừng')) {
            onStepUpdate('subtitle', 'skipped', 'Đã dừng')
        } else {
            onStepUpdate('subtitle', 'error', 'Phụ đề lỗi', String(err))
        }
    }
}

/**
 * Music Pipeline: AI phân tích → chọn nhạc từ thư viện → render + import
 */
async function runMusicPipeline(
    deps: AutoMediaDependencies,
    matchedSentences: ScriptSentence[],
    onStepUpdate: OnStepUpdate
): Promise<void> {
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
                duckingVolume: 0.15, // Đồng bộ tab Music — nhạc nền nhỏ nhẹ khi có giọng nói
                onProgress: (p) => onStepUpdate('music', 'running', `🎶 FFmpeg: ${p}`)
            })

            checkAbort()

            // Import vào DaVinci Audio Track
            onStepUpdate('music', 'running', '📥 Đang thêm nhạc nền vào DaVinci timeline...')
            try {
                const { addAudioToTimeline } = await import('@/api/resolve-api')
                const resolveResult = await addAudioToTimeline(
                    resFFmpeg.outputPath,
                    'BGM - AutoSubs'
                )
            // Debug: chi tiết scenes
            const debugMusicOk = `scenes: ${directorResult.scenes.length} | output: ${resFFmpeg.outputPath?.split('/').pop() || '?'}\n${directorResult.scenes.slice(0, 5).map((s: any) => `[Scene${s.sceneId}] ${s.startTime?.toFixed(0)}-${s.endTime?.toFixed(0)}s "${s.assignedMusicFileName || 'null'}" ${s.emotion || ''} (${s.transition || ''})`).join('\n')}${directorResult.scenes.length > 5 ? `\n... +${directorResult.scenes.length - 5} scenes nữa` : ''}`

                if (resolveResult.error) {
                    onStepUpdate('music', 'done', `✅ Render xong (${directorResult.scenes.length} scenes) — ⚠️ Import DaVinci lỗi: ${resolveResult.message}`, undefined, debugMusicOk)
                } else {
                    onStepUpdate('music', 'done', `✅ Nhạc nền: ${directorResult.scenes.length} scenes → Track A${resolveResult.audioTrack}`, undefined, debugMusicOk)
                }
            } catch (resolveErr) {
                // DaVinci không kết nối — vẫn báo render thành công
                const debugMusicNoResolve = `scenes: ${directorResult.scenes.length} | output: ${resFFmpeg.outputPath?.split('/').pop() || '?'}`
                onStepUpdate('music', 'done', `✅ Render xong (${directorResult.scenes.length} scenes) — ⚠️ Không kết nối DaVinci`, undefined, debugMusicNoResolve)
            }
        } else {
            onStepUpdate('music', 'done', '✅ Phân tích nhạc nền xong (không có scene nào)', undefined, `directorResult.scenes: ${directorResult?.scenes?.length || 0}`)
        }

    } catch (err) {
        if (String(err).includes('Pipeline đã bị dừng')) {
            onStepUpdate('music', 'skipped', 'Đã dừng')
        } else {
            const errStr = String(err)
            console.error('[AutoMedia] Music pipeline error:', errStr)
            // Hiện chi tiết lỗi + debug info trong UI
            const debugMusic = `matchingSentences=${matchedSentences.length} | musicItems=${deps.musicItems.length} | analyzed=${deps.musicItems.filter(i => i.aiMetadata).length} | scriptPreview="${deps.scriptText?.substring(0, 80) || '(empty)'}..."`
            onStepUpdate('music', 'error', 'Nhạc nền lỗi', `❌ ${errStr}`, debugMusic)
        }
    }
}

/**
 * SFX Pipeline: AI plan → auto assign → normalize → import Track A1
 * 3 bước tự động liền
 */
async function runSfxPipeline(
    deps: AutoMediaDependencies,
    matchedSentences: ScriptSentence[],
    onStepUpdate: OnStepUpdate
): Promise<void> {
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

        // Tạo whisper words từ subtitles (giống logic trong sfx-library-tab)
        let whisperWords: Array<{ t: number; w: string; e: number }> | undefined
        if (deps.subtitles && deps.subtitles.length > 0) {
            const allWords: Array<{ t: number; w: string; e: number }> = []
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
            return
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
            return
        }

        onStepUpdate('sfx', 'running', `📥 Đang import ${normalizedClips.length} SFX clips lên Track A${TRACK_LAYOUT.SFX_TRACK}...`)
        const sfxResult2 = await addSfxClipsToTimeline(normalizedClips, 'SFX - AutoSubs')

        // Tạo thông tin skipped để hiển thị
        const skipInfo = skippedCount > 0 ? ` (⚠️ ${skippedCount} file bị bỏ qua)` : ''

        if (sfxResult2.error) {
            onStepUpdate('sfx', 'error', `Import SFX lỗi${skipInfo}`, sfxResult2.message || 'Không rõ')
        } else {
            // Debug: chi tiết SFX cues đã import + skipped
            const debugSfxOk = `totalCues: ${sfxResult.cues.length} | assigned: ${assignedCues.length} | imported: ${sfxResult2.clipsAdded || normalizedClips.length} | skipped: ${skippedCount}\n${assignedCues.slice(0, 5).map(c => `[Câu${c.sentenceNum}] "${c.triggerWord}" @${c.exactStartTime?.toFixed(1)}s → "${c.assignedSfxName}" (${c.sfxCategory})`).join('\n')}${assignedCues.length > 5 ? `\n... +${assignedCues.length - 5} cues nữa` : ''}`
            onStepUpdate('sfx', 'done', `✅ Import ${sfxResult2.clipsAdded || normalizedClips.length} SFX clips (${sfxTargetLufs} LUFS)${skipInfo}`, undefined, debugSfxOk)
        }

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
    }
}

/**
 * Footage Pipeline: AI match → import lên Track V2
 */
async function runFootagePipeline(
    deps: AutoMediaDependencies,
    matchedSentences: ScriptSentence[],
    onStepUpdate: OnStepUpdate
): Promise<void> {
    onStepUpdate('footage', 'running', '🎬 Chuẩn bị dữ liệu footage + kiểm tra API key...')

    try {
        checkAbort()

        const apiKey = await getAudioScanApiKey()
        if (!apiKey) {
            onStepUpdate('footage', 'error', 'Thiếu Gemini API key', 'Cần set API key trong Settings')
            return
        }

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
            apiKey,
            totalDuration
        )

        checkAbort()

        if (suggestions.length === 0) {
            onStepUpdate('footage', 'done', '✅ AI không gợi ý footage nào')
            return
        }

        // Import lên Track V2 (chỉ video, bỏ audio gốc)
        // ⚡ Dùng CHUNG helper addMediaToTimeline (giống import ảnh V1)
        // với videoOnly=true → Lua sẽ chỉ import phần hình, bỏ audio gốc
        onStepUpdate('footage', 'running', `📥 Đang import ${suggestions.length} footage lên Track V${TRACK_LAYOUT.FOOTAGE_TRACK}...`)

        const footageClips = suggestions.map(s => ({
            filePath: s.footagePath,
            startTime: s.startTime,
            endTime: s.endTime,
            trimStart: s.trimStart,
            trimEnd: s.trimEnd,
        }))

        const importResult = await addMediaToTimeline(
            footageClips,
            TRACK_LAYOUT.FOOTAGE_TRACK,
            true  // videoOnly — chỉ lấy hình, bỏ audio
        )

        // Log kết quả import chi tiết
        console.log('[AutoMedia] Footage import result:', JSON.stringify(importResult))

        // Debug: chi tiết footage đã import
        const debugFootage = `footageItems: ${deps.footageItems.length} | suggestions: ${suggestions.length} | result: ${JSON.stringify(importResult).slice(0, 200)}\n${suggestions.slice(0, 5).map((s: any) => `"${s.footagePath?.split('/').pop()}" ${s.startTime?.toFixed(1)}-${s.endTime?.toFixed(1)}s trim=${s.trimStart?.toFixed(1)}-${s.trimEnd?.toFixed(1)}`).join('\n')}${suggestions.length > 5 ? `\n... +${suggestions.length - 5} nữa` : ''}`
        onStepUpdate('footage', 'done', `✅ Import ${suggestions.length} footage lên V${TRACK_LAYOUT.FOOTAGE_TRACK}`, undefined, debugFootage)

    } catch (err) {
        if (String(err).includes('Pipeline đã bị dừng')) {
            onStepUpdate('footage', 'skipped', 'Đã dừng')
        } else {
            onStepUpdate('footage', 'error', 'Footage lỗi', String(err))
        }
    }
}

/**
 * Effects Pipeline: Ken Burns / Shake cho ảnh tĩnh
 * Chạy ngay sau Image Import
 */
async function runEffectsPipeline(
    onStepUpdate: OnStepUpdate,
    config: AutoMediaConfig
): Promise<void> {
    onStepUpdate('effects', 'running', '✨ Đang áp hiệu ứng chuyển động (Ken Burns / Shake)...')

    try {
        checkAbort()

        const response = await tauriFetch('http://127.0.0.1:56003/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                func: 'ApplyMotionEffects',
                trackIndex: TRACK_LAYOUT.IMAGE_TRACK,
                effectType: config.effectType,
                intensity: config.effectIntensity,
                fadeDuration: 0.3, // Fade mặc định 0.3s
            }),
        })

        const data = await response.json() as any

        if (data.error) {
            onStepUpdate('effects', 'error', 'Hiệu ứng lỗi', data.message || 'Không rõ')
        } else {
            const debugFx = `type: ${config.effectType} | intensity: ${config.effectIntensity} | applied: ${data.applied || 0}/${data.total || 0} | fade: 0.3s`
            onStepUpdate('effects', 'done', `✅ Áp dụng ${data.applied || 0}/${data.total || 0} clips`, undefined, debugFx)
        }

    } catch (err) {
        if (String(err).includes('Pipeline đã bị dừng')) {
            onStepUpdate('effects', 'skipped', 'Đã dừng')
        } else {
            onStepUpdate('effects', 'error', 'Hiệu ứng lỗi', String(err))
        }
    }
}

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
