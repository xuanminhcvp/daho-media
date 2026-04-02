// auto-media-panel.tsx
// UI cho tính năng Auto Media — popup nhập liệu + dashboard tiến trình
// Hiển thị dạng Dialog khi bấm nút "🚀 Auto Media" ở header hậu kỳ

import * as React from "react"
import {
    Rocket, Square, Loader2,
    Image, Subtitles, Music, Zap, Film, Sparkles,
    Mic, Brain, CheckCircle2, XCircle, AlertTriangle,
    SkipForward, Clock, FolderOpen, Info, Play
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"

import { useProject } from "@/contexts/ProjectContext"
import { useResolve } from "@/contexts/ResolveContext"
import { useTranscript } from "@/contexts/TranscriptContext"
import { useSettings } from "@/contexts/SettingsContext"

import type {
    AutoMediaConfig,
    AutoMediaStep,
    AutoMediaState,
    StepStatus,
} from "@/types/auto-media-types"
import {
    DEFAULT_AUTO_MEDIA_CONFIG,
    INITIAL_AUTO_MEDIA_STATE,
    TRACK_LAYOUT,
} from "@/types/auto-media-types"

import {
    runAutoMedia,
    stopAutoMedia,
    checkPrerequisites,
} from "@/services/auto-media-service"
import type { AutoMediaDependencies } from "@/services/auto-media-service"

import { getActiveProfileId } from "@/config/activeProfile"

import { open } from "@tauri-apps/plugin-dialog"
import { readDir } from "@tauri-apps/plugin-fs"

// ======================== STEP CONFIG — icon, label, mô tả cho từng bước ========================

const STEP_INFO: Record<AutoMediaStep, { icon: React.ReactNode; label: string; desc: string }> = {
    transcribe: {
        icon: <Mic className="h-4 w-4" />,
        label: "Transcribe",
        desc: "Whisper tạo timing từng từ",
    },
    aiMatch: {
        icon: <Brain className="h-4 w-4" />,
        label: "AI So Chiếu",
        desc: "Script ↔ Voice timing",
    },
    image: {
        icon: <Image className="h-4 w-4" />,
        label: "Import Ảnh",
        desc: `Track V${TRACK_LAYOUT.VIDEO_AI_TRACK}`,
    },
    subtitle: {
        icon: <Subtitles className="h-4 w-4" />,
        label: "Phụ Đề",
        desc: `Track V${TRACK_LAYOUT.TEXT_ONSCREEN_TRACK}`,
    },
    music: {
        icon: <Music className="h-4 w-4" />,
        label: "Nhạc Nền",
        desc: `Track A${TRACK_LAYOUT.MUSIC_TRACK}`,
    },
    sfx: {
        icon: <Zap className="h-4 w-4" />,
        label: "SFX",
        desc: `Track A${TRACK_LAYOUT.SFX_VIDEO_TRACK}`,
    },
    footage: {
        icon: <Film className="h-4 w-4" />,
        label: "Footage",
        desc: `Track V${TRACK_LAYOUT.FOOTAGE_TRACK}`,
    },
    effects: {
        icon: <Sparkles className="h-4 w-4" />,
        label: "Hiệu Ứng",
        desc: "Ken Burns / Shake",
    },
}

// ======================== STATUS → icon + màu ========================

function getStatusIcon(status: StepStatus) {
    switch (status) {
        case 'idle': return <Clock className="h-4 w-4 text-muted-foreground" />
        case 'waiting': return <Clock className="h-4 w-4 text-yellow-500 animate-pulse" />
        case 'running': return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />
        case 'paused': return <Play className="h-4 w-4 text-orange-500 animate-pulse" />
        case 'done': return <CheckCircle2 className="h-4 w-4 text-green-500" />
        case 'error': return <XCircle className="h-4 w-4 text-red-500" />
        case 'skipped': return <SkipForward className="h-4 w-4 text-muted-foreground" />
    }
}

function getStatusColor(status: StepStatus) {
    switch (status) {
        case 'running': return 'bg-blue-500/10 border-blue-500/30'
        case 'paused': return 'bg-orange-500/10 border-orange-500/30'
        case 'done': return 'bg-green-500/10 border-green-500/30'
        case 'error': return 'bg-red-500/10 border-red-500/30'
        default: return 'bg-card border-border'
    }
}

// ======================== COMPONENT CHÍNH ========================

interface AutoMediaPanelProps {
    open: boolean
    onOpenChange: (open: boolean) => void
}

export function AutoMediaPanel({ open: isOpen, onOpenChange }: AutoMediaPanelProps) {
    // ======================== CONTEXTS ========================
    const {
        project,
        setMatchingSentences: setSharedMatchingSentences,
        setMatchingFolder: setSharedMatchingFolder,
        updateImageImport,
        updateSubtitleData,
        updateMusicLibrary,
        updateSfxLibrary,
        setMasterSrt,
    } = useProject()
    const { timelineInfo, getSourceAudio } = useResolve()
    const { subtitles, processTranscriptionResults } = useTranscript()
    const { settings } = useSettings()

    // ======================== LOCAL STATE ========================

    // Config bật/tắt từng bước
    const [config, setConfig] = React.useState<AutoMediaConfig>(() => {
        const profileId = getActiveProfileId();
        
        // Đọc full cấu hình Auto Media đã lưu của profile hiện tại
        const savedConfigStr = localStorage.getItem(`auto-media-config-${profileId}`);
        if (savedConfigStr) {
            try {
                const parsed = JSON.parse(savedConfigStr);
                return { ...DEFAULT_AUTO_MEDIA_CONFIG, ...parsed };
            } catch (err) {
                console.warn("Lỗi parse config Auto Media:", err);
            }
        }
        
        // Migrate Master SRT toggle cũ (nếu có)
        const oldMasterSrt = localStorage.getItem(`auto-media-master-srt-${profileId}`);
        let baseConfig = { ...DEFAULT_AUTO_MEDIA_CONFIG };
        if (oldMasterSrt) {
            baseConfig.enableMasterSrt = oldMasterSrt === 'true';
        }
        return baseConfig;
    })

    // Lưu lại toàn bộ cài đặt config khi có thay đổi (kể cả hiệu ứng)
    React.useEffect(() => {
        const profileId = getActiveProfileId();
        localStorage.setItem(`auto-media-config-${profileId}`, JSON.stringify(config));
    }, [config]);

    // Script text (user paste vào popup)
    const [scriptText, setScriptText] = React.useState(
        project.imageImport.scriptText || ''
    )

    // Folder ảnh
    const [imageFolder, setImageFolder] = React.useState(
        project.imageImport.imageFolder || ''
    )
    const [imageFiles, setImageFiles] = React.useState<string[]>(
        project.imageImport.imageFiles || []
    )

    // Folders — load từ settings.json khi popup mở
    const [footageFolder, setFootageFolder] = React.useState('')
    const [footageItems, setFootageItems] = React.useState<any[]>([])
    const [musicFolder, setMusicFolder] = React.useState(project.musicLibrary.musicFolder || '')
    const [musicItems, setMusicItems] = React.useState<any[]>(project.musicLibrary.musicItems || [])
    const [sfxFolder, setSfxFolder] = React.useState(project.sfxLibrary.sfxFolder || '')
    const [sfxItems, setSfxItems] = React.useState<any[]>(project.sfxLibrary.sfxItems || [])

    // Auto-load tất cả folders đã lưu từ settings.json khi popup mở
    React.useEffect(() => {
        if (isOpen) {
            import('@/services/saved-folders-service').then(async ({ getSavedFolder }) => {
                const { getFootageFolderPath, getMusicFolderPath, getSfxFolderPath } = await import('@/services/auto-media-storage');
                
                // Load footage folder + metadata
                let savedFootage = await getSavedFolder('footageFolder')
                if (!savedFootage) savedFootage = await getFootageFolderPath()
                
                if (savedFootage) {
                    setFootageFolder(savedFootage)
                    try {
                        const { loadFootageMetadata } = await import('@/services/footage-library-service')
                        const items = await loadFootageMetadata(savedFootage)
                        setFootageItems(items)
                    } catch (err) {
                        console.warn('[AutoMedia] Lỗi load footage metadata:', err)
                    }
                }

                // Load music folder + metadata (nếu chưa có items từ project)
                let savedMusic = await getSavedFolder('musicFolder')
                if (!savedMusic) savedMusic = await getMusicFolderPath()
                
                if (savedMusic) {
                    setMusicFolder(savedMusic)
                    if (musicItems.length === 0) {
                        try {
                            const { loadAudioItemsFromFolder } = await import('@/services/audio-library-service')
                            const items = await loadAudioItemsFromFolder(savedMusic)
                            setMusicItems(items)
                        } catch (err) {
                            console.warn('[AutoMedia] Lỗi load music metadata:', err)
                        }
                    }
                }

                // Load SFX folder + metadata (nếu chưa có items từ project)
                let savedSfx = await getSavedFolder('sfxFolder')
                if (!savedSfx) savedSfx = await getSfxFolderPath()
                
                if (savedSfx) {
                    setSfxFolder(savedSfx)
                    if (sfxItems.length === 0) {
                        try {
                            const { loadAudioItemsFromFolder } = await import('@/services/audio-library-service')
                            const items = await loadAudioItemsFromFolder(savedSfx)
                            setSfxItems(items)
                        } catch (err) {
                            console.warn('[AutoMedia] Lỗi load sfx metadata:', err)
                        }
                    }
                }
            })
        }
    }, [isOpen])

    // State pipeline
    const [pipelineState, setPipelineState] = React.useState<AutoMediaState>(
        INITIAL_AUTO_MEDIA_STATE
    )

    // Đã bấm "Bắt đầu" chưa? (mode: input → running → summary)
    const [mode, setMode] = React.useState<'input' | 'running' | 'summary'>('input')

    // ======================== HANDLERS ========================

    // Chọn folder ảnh
    const handleSelectImageFolder = async () => {
        const selected = await open({ directory: true, multiple: false })
        if (!selected) return
        const folderPath = selected as string
        setImageFolder(folderPath)

        // Quét danh sách file ảnh
        try {
            const entries = await readDir(folderPath)
            const imgExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff']
            const files = entries
                .filter(e => {
                    const name = e.name?.toLowerCase() || ''
                    return imgExtensions.some(ext => name.endsWith(ext))
                })
                .map(e => `${folderPath}/${e.name}`)
                .sort()
            setImageFiles(files)
            console.log(`[AutoMedia] Folder: ${folderPath}, ${files.length} ảnh`)
        } catch (err) {
            console.error('[AutoMedia] Lỗi đọc folder ảnh:', err)
            setImageFiles([])
        }
    }

    // Toggle config
    const toggleStep = (key: keyof AutoMediaConfig) => {
        setConfig(prev => ({ ...prev, [key]: !prev[key] }))
    }

    // ======================== DEBUG MODE: NÚT TIẾP TỤC ========================
    // Ref lưu resolve function — khi user nhấn "Tiếp tục", gọi resolve() để tiếp pipeline
    const continueResolverRef = React.useRef<(() => void) | null>(null)

    // Callback truyền vào service — tạo Promise chờ user nhấn continue
    const waitForContinue = React.useCallback((): Promise<void> => {
        return new Promise<void>((resolve) => {
            continueResolverRef.current = resolve
        })
    }, [])

    // Handler khi user nhấn "Tiếp tục"
    const handleContinue = React.useCallback(() => {
        if (continueResolverRef.current) {
            continueResolverRef.current()
            continueResolverRef.current = null
        }
    }, [])

    // Cập nhật state pipeline khi nhận callback từ service
    const handleStepUpdate = React.useCallback((
        step: AutoMediaStep,
        status: StepStatus,
        message: string,
        error?: string,
        debugDetails?: string
    ) => {
        setPipelineState(prev => ({
            ...prev,
            steps: {
                ...prev.steps,
                [step]: {
                    status,
                    message,
                    error,
                    debugDetails,
                    startedAt: status === 'running' ? Date.now() : prev.steps[step].startedAt,
                    finishedAt: status === 'done' || status === 'error' || status === 'skipped'
                        ? Date.now()
                        : undefined,
                },
            },
        }))
    }, [])

    // BẮT ĐẦU PIPELINE
    const handleStart = async () => {
        if (!scriptText.trim()) {
            alert('Chưa paste script kịch bản!')
            return
        }
        if (!timelineInfo?.timelineId) {
            alert('Chưa kết nối DaVinci Resolve! Hãy kết nối trước.')
            return
        }

        // Reset state
        setPipelineState({
            ...INITIAL_AUTO_MEDIA_STATE,
            isRunning: true,
            startedAt: Date.now(),
        })
        setMode('running')

        // Build dependencies
        const deps: AutoMediaDependencies = {
            timelineId: timelineInfo.timelineId,
            subtitles,
            masterSrt: project.masterSrt,
            imageFolder,
            scriptText,
            imageFiles,
            musicFolder: musicFolder || project.musicLibrary.musicFolder,
            musicItems: musicItems.length > 0 ? musicItems : project.musicLibrary.musicItems,
            sfxFolder: sfxFolder || project.sfxLibrary.sfxFolder,
            sfxItems: sfxItems.length > 0 ? sfxItems : project.sfxLibrary.sfxItems,
            footageFolder: footageFolder,
            footageItems: footageItems,
            matchingFolder: project.matchingFolder || imageFolder,
            setMatchingSentences: setSharedMatchingSentences,
            setMatchingFolder: setSharedMatchingFolder,
            setMasterSrt: setMasterSrt,
            updateImageImport,
            updateSubtitleData,
            // ★ ĐỒNG BỘ TAB: dùng template + fontSize từ ProjectContext
            subtitleTemplate: project.subtitleData.selectedTemplate || 'Subtitle Default',
            subtitleFontSize: project.subtitleData.fontSize || 0.04,
            updateMusicLibrary,
            updateSfxLibrary,
            runTranscribe: async (onStepUpdate) => {
                // ========== CHẠY WHISPER THẬT ==========

                // ★ FIX ROOT CAUSE: nếu selectedInputTracks rỗng (user bỏ chọn tất cả)
                // → fallback về ["2"] (track mặc định chứa giọng đọc)
                // Tránh gửi inputTracks:[] → DaVinci disable hết track → WAV silent
                const inputTracks = (settings.selectedInputTracks && settings.selectedInputTracks.length > 0)
                    ? settings.selectedInputTracks
                    : ['2']  // fallback mặc định

                console.log('[AutoMedia] inputTracks để export:', inputTracks, '| settings.selectedInputTracks:', settings.selectedInputTracks)

                // Sub-step 1: Export audio từ DaVinci
                onStepUpdate('transcribe', 'running', `🎧 Exporting audio từ DaVinci (Track A${inputTracks.join(', A')})...`)
                console.log('[AutoMedia] Bắt đầu export audio từ DaVinci...')
                const audioInfo = await getSourceAudio(
                    false, // Resolve mode (không phải standalone)
                    null,
                    inputTracks  // ★ Dùng inputTracks đã fallback, không phải settings trực tiếp
                )
                if (!audioInfo) {
                    throw new Error('Không export được audio từ DaVinci. Kiểm tra kết nối.')
                }

                // Debug: hiện audio info chi tiết
                onStepUpdate('transcribe', 'running', `🎧 Audio OK: ${audioInfo.path?.split('/').pop()} | offset: ${audioInfo.offset}s | tracks: ${JSON.stringify(settings.selectedInputTracks)}`, undefined, `audioPath: ${audioInfo.path}\noffset: ${audioInfo.offset}\nselectedInputTracks: ${JSON.stringify(settings.selectedInputTracks)}\nmodel: ${settings.model} | lang: ${settings.language} | DTW: ${settings.enableDTW} | GPU: ${settings.enableGpu}`)

                // Sub-step 2: Gọi Whisper transcribe
                onStepUpdate('transcribe', 'running', '🤖 Whisper đang phân tích audio → word-level timestamps...')
                console.log('[AutoMedia] Audio path:', audioInfo.path, '| Offset:', audioInfo.offset)
                const { invoke } = await import('@tauri-apps/api/core')
                const { models } = await import('@/lib/models')

                const transcript = await invoke('transcribe_audio', {
                    options: {
                        audioPath: audioInfo.path,
                        offset: Math.round(audioInfo.offset * 1000) / 1000,
                        model: models[settings.model]?.value || 'ggml-large-v3-turbo-q5_0.bin',
                        lang: settings.language,
                        translate: settings.translate,
                        targetLanguage: settings.targetLanguage,
                        enableDtw: settings.enableDTW,
                        enableGpu: settings.enableGpu,
                        enableDiarize: settings.enableDiarize,
                        maxSpeakers: settings.maxSpeakers,
                        density: settings.textDensity,
                    },
                })
                console.log('[AutoMedia] Whisper raw result:', transcript)
                console.log('[AutoMedia] Whisper raw keys:', Object.keys(transcript as any))

                // Debug: hiện whisper raw result trước khi process
                const rawT = transcript as any
                const rawSegCount = rawT?.segments?.length ?? rawT?.originalSegments?.length ?? '?'
                const rawKeys = Object.keys(rawT || {}).join(', ')
                onStepUpdate('transcribe', 'running', `💾 Whisper xong → ${rawSegCount} segments (raw keys: ${rawKeys})`, undefined, `raw keys: ${rawKeys}\nraw segments count: ${rawSegCount}\nprocessing_time_sec: ${rawT?.processing_time_sec ?? '?'}\nraw first segment: ${JSON.stringify(rawT?.segments?.[0] || rawT?.originalSegments?.[0] || '(empty)').substring(0, 200)}`)

                // Sub-step 3: Save transcript + cập nhật context
                onStepUpdate('transcribe', 'running', '💾 Đang lưu transcript + cập nhật context...')
                const filename = await processTranscriptionResults(
                    transcript as any,
                    settings,
                    null, // không có file input (Resolve mode)
                    timelineInfo.timelineId
                )
                console.log('[AutoMedia] Transcript saved:', filename)

                // ===== Build debug details: preview whisper data =====
                const t = transcript as any
                const segments = t?.segments || t?.originalSegments || []
                const totalSegments = segments.length
                // Đếm tổng words
                let totalWords = 0
                for (const seg of segments) {
                    if (seg.words) totalWords += seg.words.length
                }
                // Sample 3 words đầu tiên
                const sampleWords: string[] = []
                for (const seg of segments) {
                    if (seg.words && sampleWords.length < 5) {
                        for (const w of seg.words) {
                            if (sampleWords.length >= 5) break
                            sampleWords.push(`[${(w.start ?? w.t ?? 0).toFixed(2)}s] "${w.word || w.w || ''}"`)
                        }
                    }
                }
                // Sample 2 segments
                const sampleSegs = segments.slice(0, 2).map((s: any) =>
                    `[${(s.start ?? 0).toFixed(1)}-${(s.end ?? 0).toFixed(1)}s] "${(s.text ?? '').substring(0, 40)}..."`
                ).join(' | ')

                const debugTranscribe = `file: ${filename} | segments: ${totalSegments} | words: ${totalWords}\nSample words: ${sampleWords.join(' ')}\nSample segs: ${sampleSegs}`
                onStepUpdate('transcribe', 'done', 'Transcribe hoàn tất ✅', undefined, debugTranscribe)
            },
            hasTranscript: subtitles && subtitles.length > 0,
            // Debug mode: truyền callback chờ user nhấn "Tiếp tục"
            waitForContinue: config.debugMode ? waitForContinue : undefined,
        }

        // Chạy pipeline
        await runAutoMedia(config, deps, handleStepUpdate)

        // Pipeline xong
        setPipelineState(prev => ({
            ...prev,
            isRunning: false,
            finishedAt: Date.now(),
        }))
        setMode('summary')
    }

    // DỪNG PIPELINE
    const handleStop = () => {
        stopAutoMedia()
        setPipelineState(prev => ({
            ...prev,
            isRunning: false,
            finishedAt: Date.now(),
        }))
        setMode('summary')
    }

    // Quay lại màn nhập liệu
    const handleReset = () => {
        setMode('input')
        setPipelineState(INITIAL_AUTO_MEDIA_STATE)
    }

    // ======================== TÍNH TOÁN SUMMARY ========================

    const stepEntries = Object.entries(pipelineState.steps) as [AutoMediaStep, typeof pipelineState.steps[AutoMediaStep]][]
    const doneCount = stepEntries.filter(([, s]) => s.status === 'done').length
    const errorCount = stepEntries.filter(([, s]) => s.status === 'error').length
    const skippedCount = stepEntries.filter(([, s]) => s.status === 'skipped').length
    const totalActive = stepEntries.filter(([, s]) => s.status !== 'idle').length

    // Kiểm tra prerequisites
    const prereqChecks = React.useMemo(() => {
        if (mode !== 'input') return []
        const deps: AutoMediaDependencies = {
            timelineId: timelineInfo?.timelineId || '',
            subtitles,
            masterSrt: project.masterSrt,
            imageFolder,
            scriptText,
            imageFiles,
            // Dùng local state (đã load từ settings.json qua useEffect)
            // KHÔNG dùng project.musicLibrary.musicFolder vì context chưa được update khi popup mới mở
            musicFolder: musicFolder || project.musicLibrary.musicFolder,
            musicItems: musicItems.length > 0 ? musicItems : project.musicLibrary.musicItems,
            sfxFolder: sfxFolder || project.sfxLibrary.sfxFolder,
            sfxItems: sfxItems.length > 0 ? sfxItems : project.sfxLibrary.sfxItems,
            footageFolder: footageFolder,
            footageItems: footageItems,
            matchingFolder: project.matchingFolder || imageFolder,
            setMatchingSentences: () => {},
            setMatchingFolder: () => {},
            setMasterSrt: () => {},
            updateImageImport: () => {},
            updateSubtitleData: () => {},
            subtitleTemplate: project.subtitleData.selectedTemplate || 'Subtitle Default',
            subtitleFontSize: project.subtitleData.fontSize || 0.04,
            updateMusicLibrary: () => {},
            updateSfxLibrary: () => {},
            runTranscribe: async (_onStepUpdate) => {},
            hasTranscript: subtitles && subtitles.length > 0,
        }
        return checkPrerequisites(deps, config)
    // musicFolder, sfxFolder là local state — phải có trong deps để re-check sau khi useEffect load xong
    }, [mode, config, imageFolder, scriptText, imageFiles, subtitles, project, timelineInfo, footageFolder, footageItems, musicFolder, sfxFolder, musicItems, sfxItems])

    const notReadyItems = prereqChecks.filter(c => !c.ready)

    // ======================== RENDER ========================

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Rocket className="h-5 w-5 text-purple-500" />
                        Auto Media
                    </DialogTitle>
                    <DialogDescription>
                        Tự động hoá toàn bộ hậu kỳ — 1 click, timeline đầy đủ
                    </DialogDescription>
                </DialogHeader>

                {/* ====== NOTE: Track layout 7V+5A ====== */}
                <div className="rounded-lg bg-blue-500/10 border border-blue-500/20 p-3 text-xs space-y-1.5">
                    <div className="flex items-center gap-1.5 font-medium text-blue-400">
                        <Info className="h-3.5 w-3.5" />
                        Track Layout Chuẩn (24fps)
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground">
                        <span>V1: 📹 Video AI</span>
                        <span>A1: 🔊 SFX Video</span>
                        <span>V2: 🖼️ Ảnh Thực Tế</span>
                        <span>A2: 🎙️ VO (Voice)</span>
                        <span>V3: 🎚️ Adjustment</span>
                        <span>A3: 🔔 SFX Text</span>
                        <span>V4: 💬 Text Onscreen</span>
                        <span>A4: 📸 SFX Ảnh Ref</span>
                        <span>V5: #️⃣ Số Chương</span>
                        <span>A5: 🎵 Nhạc Nền</span>
                        <span>V6: 🔤 Tên Chương</span>
                        <span></span>
                    </div>
                </div>

                {/* ====== MODE: INPUT — Nhập liệu ====== */}
                {mode === 'input' && (
                    <div className="space-y-4">
                        {/* Script Text */}
                        <div className="space-y-1.5">
                            <label className="text-sm font-medium">Kịch bản chia câu</label>
                            <Textarea
                                value={scriptText}
                                onChange={(e) => setScriptText(e.target.value)}
                                onPaste={(e) => {
                                    // Khi paste: tự đánh số mỗi dòng nếu chưa có
                                    e.preventDefault()
                                    const pastedText = e.clipboardData.getData('text')
                                    const lines = pastedText.split('\n').filter(l => l.trim().length > 0)
                                    // Kiểm tra xem đã có số chưa (VD: "1. ...", "1) ...")
                                    const alreadyNumbered = lines.every(l => /^\d+[\.\)]\s/.test(l.trim()))
                                    if (alreadyNumbered) {
                                        // Đã có số → giữ nguyên
                                        setScriptText(lines.join('\n'))
                                    } else {
                                        // Chưa có số → tự đánh số
                                        const numbered = lines.map((line, i) => {
                                            const clean = line.trim().replace(/^\d+[\.\)]\s*/, '')
                                            return `${i + 1}. ${clean}`
                                        })
                                        setScriptText(numbered.join('\n'))
                                    }
                                }}
                                placeholder={`Paste kịch bản vào đây — sẽ tự đánh số\n\nVí dụ:\nCâu đầu tiên trong kịch bản\nCâu thứ hai...\nCâu thứ ba...\n\n→ Tự chuyển thành:\n1. Câu đầu tiên\n2. Câu thứ hai...`}
                                className="h-28 text-xs font-mono resize-none"
                            />
                            <p className="text-[10px] text-muted-foreground">
                                📋 Paste kịch bản → tự đánh số. Hoặc nhập thủ công: 1. ..., 2. ..., 3. ...
                            </p>
                        </div>

                        {/* Folder ảnh */}
                        <div className="space-y-1.5">
                            <label className="text-sm font-medium">Folder Ảnh</label>
                            <div className="flex items-center gap-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="gap-1.5"
                                    onClick={handleSelectImageFolder}
                                >
                                    <FolderOpen className="h-3.5 w-3.5" />
                                    Chọn Folder
                                </Button>
                                {imageFolder && (
                                    <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                                        {imageFolder.split('/').pop()} ({imageFiles.length} ảnh)
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Toggle từng bước */}
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Bước tự động</label>
                            <div className="grid grid-cols-2 gap-2">
                                {([
                                    ['enableMasterSrt', 'Tạo Master SRT', <Brain key="msrt" className="h-3.5 w-3.5" />],
                                    ['enableImage', 'Import Ảnh', <Image key="img" className="h-3.5 w-3.5" />],
                                    ['enableSubtitle', 'Phụ Đề', <Subtitles key="sub" className="h-3.5 w-3.5" />],
                                    ['enableMusic', 'Nhạc Nền', <Music key="mus" className="h-3.5 w-3.5" />],
                                    ['enableSfx', 'SFX', <Zap key="sfx" className="h-3.5 w-3.5" />],
                                    ['enableFootage', 'Footage', <Film key="ft" className="h-3.5 w-3.5" />],
                                    ['enableEffects', 'Hiệu Ứng', <Sparkles key="fx" className="h-3.5 w-3.5" />],
                                ] as [keyof AutoMediaConfig, string, React.ReactNode][]).map(([key, label, icon]) => (
                                    <div key={key} className="flex items-center justify-between gap-2 rounded-md border p-2">
                                        <div className="flex items-center gap-1.5 text-xs">
                                            {icon}
                                            {label}
                                        </div>
                                        <Switch
                                            checked={config[key] as boolean}
                                            onCheckedChange={() => toggleStep(key)}
                                        />
                                    </div>
                                ))}
                            </div>

                            {/* Tùy chọn Phụ Đề */}
                            {config.enableSubtitle && (
                                <div className="mt-2 rounded-md border p-2 bg-muted/30">
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-[11px] font-medium text-muted-foreground uppercase">Chế độ Phụ Đề</span>
                                    </div>
                                    <div className="grid grid-cols-2 gap-1.5 bg-background border rounded-md p-1">
                                        <button 
                                            onClick={() => setConfig(prev => ({...prev, subtitleMode: 'srt'}))}
                                            className={`text-xs py-1.5 rounded-sm font-medium transition-colors ${config.subtitleMode === 'srt' ? 'bg-primary text-primary-foreground shadow' : 'hover:bg-muted text-muted-foreground'}`}
                                        >
                                            📝 File .srt (Nhẹ/Chuẩn)
                                        </button>
                                        <button 
                                            onClick={() => setConfig(prev => ({...prev, subtitleMode: 'fusion'}))}
                                            className={`text-xs py-1.5 rounded-sm font-medium transition-colors ${config.subtitleMode === 'fusion' ? 'bg-primary text-primary-foreground shadow' : 'hover:bg-muted text-muted-foreground'}`}
                                        >
                                            ✨ Fusion Text+ (Nặng/Đẹp)
                                        </button>
                                    </div>
                                    <p className="text-[9.5px] text-muted-foreground mt-1.5 leading-tight px-1 text-center">
                                        {config.subtitleMode === 'srt' 
                                            ? "Khuyên dùng cho Phim Tài Liệu. Rất nhẹ, không ăn RAM, tự import vào Native Subtitle Track." 
                                            : "Khuyên dùng cho Short/Stories. Ăn nhiều RAM vì render từng hiệu ứng chuyển động."}
                                    </p>
                                </div>
                            )}

                            {/* Debug Mode toggle */}
                            <div className="flex items-center justify-between rounded-md border border-orange-500/20 bg-orange-500/5 p-2 mt-2">
                                <div className="flex items-center gap-1.5 text-xs text-orange-400">
                                    🐛 Debug Mode (tuần tự + nút Tiếp tục)
                                </div>
                                <Switch
                                    checked={config.debugMode}
                                    onCheckedChange={() => setConfig(prev => ({ ...prev, debugMode: !prev.debugMode }))}
                                />
                            </div>
                        </div>

                        {/* Cảnh báo thiếu điều kiện */}
                        {notReadyItems.length > 0 && (
                            <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/20 p-2.5 space-y-1">
                                <div className="flex items-center gap-1 text-xs font-medium text-yellow-500">
                                    <AlertTriangle className="h-3.5 w-3.5" />
                                    Chưa đủ điều kiện:
                                </div>
                                {notReadyItems.map((item, i) => (
                                    <p key={i} className="text-[10px] text-yellow-500/70 pl-5">
                                        • {item.reason}
                                    </p>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* ====== MODE: RUNNING + SUMMARY — Dashboard tiến trình ====== */}
                {(mode === 'running' || mode === 'summary') && (
                    <div className="space-y-2">
                        {/* Danh sách 8 bước */}
                        {stepEntries
                            .filter(([, s]) => s.status !== 'idle')
                            .map(([step, stepState]) => {
                                const info = STEP_INFO[step]
                                return (
                                    <div
                                        key={step}
                                        className={`flex items-start gap-2.5 rounded-lg border p-2.5 transition-colors ${getStatusColor(stepState.status)}`}
                                    >
                                        {/* Icon trạng thái */}
                                        <div className="mt-0.5 shrink-0">
                                            {getStatusIcon(stepState.status)}
                                        </div>

                                        {/* Nội dung */}
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-1.5">
                                                <span className="text-xs font-medium">{info.label}</span>
                                                <span className="text-[10px] text-muted-foreground">{info.desc}</span>
                                            </div>
                                            {/* Message chính — KHÔNG truncate để hiện full chi tiết */}
                                            {stepState.message && (
                                                <p className="text-[10px] text-muted-foreground mt-0.5 break-words">
                                                    {stepState.message}
                                                </p>
                                            )}
                                            {/* Error message */}
                                            {stepState.error && (
                                                <p className="text-[10px] text-red-400 mt-0.5 break-words">
                                                    ❌ {stepState.error}
                                                </p>
                                            )}
                                            {/* Debug details — hiện chi tiết, multi-line */}
                                            {stepState.debugDetails && (
                                                <pre className="text-[9px] text-muted-foreground/70 mt-1 break-words font-mono bg-black/20 rounded p-1.5 whitespace-pre-wrap border border-white/5 max-h-[120px] overflow-y-auto">
                                                    📋 {stepState.debugDetails}
                                                </pre>
                                            )}
                                        </div>
                                    </div>
                                )
                            })}

                        {/* Summary khi xong */}
                        {mode === 'summary' && (
                            <div className="rounded-lg bg-card border p-3 text-center space-y-1">
                                <p className="text-sm font-medium">
                                    {errorCount === 0
                                        ? '✅ Hoàn tất!'
                                        : `⚠️ ${doneCount}/${totalActive} bước thành công`}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    ✅ {doneCount} xong
                                    {errorCount > 0 && ` • ❌ ${errorCount} lỗi`}
                                    {skippedCount > 0 && ` • ⏭️ ${skippedCount} bỏ qua`}
                                </p>
                                {pipelineState.startedAt && pipelineState.finishedAt && (
                                    <p className="text-[10px] text-muted-foreground">
                                        Thời gian: {((pipelineState.finishedAt - pipelineState.startedAt) / 1000).toFixed(0)}s
                                    </p>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {/* ====== FOOTER — Nút hành động ====== */}
                <DialogFooter className="flex items-center gap-2">
                    {mode === 'input' && (() => {
                        const btnDisabled = !scriptText.trim() || !timelineInfo?.timelineId
                        if (btnDisabled) {
                            console.log('[AutoMedia] ⚠️ Nút disabled:', {
                                scriptEmpty: !scriptText.trim(),
                                scriptLen: scriptText.length,
                                timelineId: timelineInfo?.timelineId || '(null)',
                                timelineInfo: timelineInfo || '(null)',
                            })
                        }
                        return (
                            <Button
                                className="w-full gap-2 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700"
                                onClick={handleStart}
                                disabled={btnDisabled}
                            >
                                <Rocket className="h-4 w-4" />
                                🚀 Bắt Đầu Auto Media
                            </Button>
                        )
                    })()}

                    {mode === 'running' && (
                        <div className="flex gap-2 w-full">
                            {/* Nút Tiếp tục — chỉ hiện trong debug mode */}
                            {config.debugMode && (
                                <Button
                                    className="flex-1 gap-2 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700"
                                    onClick={handleContinue}
                                >
                                    <Play className="h-4 w-4" />
                                    ▶ Tiếp tục
                                </Button>
                            )}
                            <Button
                                variant="destructive"
                                className={config.debugMode ? "gap-2" : "w-full gap-2"}
                                onClick={handleStop}
                            >
                                <Square className="h-4 w-4" />
                                ⏸ Dừng
                            </Button>
                        </div>
                    )}

                    {mode === 'summary' && (
                        <div className="flex gap-2 w-full">
                            <Button
                                variant="outline"
                                className="flex-1"
                                onClick={handleReset}
                            >
                                ← Quay lại
                            </Button>
                            <Button
                                className="flex-1"
                                onClick={() => onOpenChange(false)}
                            >
                                Đóng
                            </Button>
                        </div>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
