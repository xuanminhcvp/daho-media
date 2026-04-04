// auto-media-panel.tsx
// UI cho tính năng Auto Media — popup nhập liệu + dashboard tiến trình
// Hiển thị dạng Dialog khi bấm nút "🚀 Auto Media" ở header hậu kỳ

import * as React from "react"
import {
    Rocket, Square, Loader2,
    Image, Subtitles, Music, Zap, Film, Sparkles,
    Mic, Brain, CheckCircle2, XCircle, AlertTriangle,
    SkipForward, Clock, FolderOpen, Info, Play, FileAudio, RefreshCw, Copy
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
import {
    logTranscribePhaseTimingToDebug,
    startTranscribePhaseDebugLog,
    updateTranscribePhasePendingProgress,
} from "@/services/transcribe-phase-debug-service"
import {
    buildTranscriptFromCapCutDraftSubtitle,
    listCapCutDraftsFast,
    type CapCutDraftSubtitleOption,
} from "@/services/capcut-subtitle-source-service"
import { addDebugLog, generateLogId } from "@/services/debug-logger"

import { getActiveProfileId } from "@/config/activeProfile"

import { open } from "@tauri-apps/plugin-dialog"
import { readDir } from "@tauri-apps/plugin-fs"

import { CapCutEffectsSettingsPanel } from "./capcut-effects-settings"

type ChannelLogoPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

interface CapCutChannelProfile {
    id: string
    name: string
    logoPath: string
    position: ChannelLogoPosition
    /** Offset ngang custom theo hệ transform CapCut (normalized). */
    x: number
    /** Offset dọc custom theo hệ transform CapCut (normalized). */
    y: number
    /** Scale logo (1.0 = 100%). */
    scale: number
}

function getDefaultLogoTransform(position: ChannelLogoPosition): { x: number; y: number } {
    // Y dương trong CapCut đi lên phía trên.
    // Default theo yêu cầu user: X=0.87, Y=0.75 (top-right) và đối xứng cho các góc còn lại.
    const presetMap: Record<ChannelLogoPosition, { x: number; y: number }> = {
        'top-left': { x: -0.87, y: 0.75 },
        'top-right': { x: 0.87, y: 0.75 },
        'bottom-left': { x: -0.87, y: -0.75 },
        'bottom-right': { x: 0.87, y: -0.75 },
    }
    return presetMap[position]
}

function getDefaultLogoScale(): number {
    // 17% theo yêu cầu user.
    return 0.17
}

/**
 * Copy logo kênh vào thư mục nội bộ Auto_media để tránh lỗi CapCut Unsupported media
 * do quyền truy cập file ở Desktop/Downloads không ổn định.
 */
async function ensureCapCutSafeLogoPath(rawLogoPath: string, channelId: string): Promise<string> {
    if (!rawLogoPath) return rawLogoPath
    // Nếu đã nằm trong thư mục an toàn thì dùng luôn.
    if (rawLogoPath.includes('/Auto_media/channel_logos/')) {
        return rawLogoPath
    }

    const { getChannelLogosFolderPath } = await import('@/services/auto-media-storage')
    const { join } = await import('@tauri-apps/api/path')
    const { exists, mkdir, copyFile, remove } = await import('@tauri-apps/plugin-fs')

    const logosDir = await getChannelLogosFolderPath()
    if (!(await exists(logosDir))) {
        await mkdir(logosDir, { recursive: true })
    }

    const extRaw = (rawLogoPath.split('.').pop() || 'png').toLowerCase()
    const ext = ['png', 'jpg', 'jpeg', 'webp'].includes(extRaw) ? extRaw : 'png'
    const destPath = await join(logosDir, `${channelId}_${Date.now()}.${ext}`)
    // Dọn file logo cũ của channel để thư mục gọn, chỉ giữ bản mới nhất.
    // Không xóa ảnh user ở nơi khác, chỉ xóa file đã copy trước đó trong channel_logos.
    try {
        const { readDir } = await import('@tauri-apps/plugin-fs')
        const entries = await readDir(logosDir)
        for (const entry of entries) {
            const name = (entry.name || '').toLowerCase()
            if (!name.startsWith(`${channelId.toLowerCase()}_`)) continue
            const oldPath = await join(logosDir, entry.name || '')
            await remove(oldPath)
        }
    } catch (cleanupErr) {
        console.warn('[AutoMedia] Không dọn được logo cũ của channel:', cleanupErr)
    }
    await copyFile(rawLogoPath, destPath)
    return destPath
}

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

    // File VO (Voice Over) — chỉ dùng cho CapCut mode (không có DaVinci export)
    const [voFile, setVoFile] = React.useState('')
    // Settings effect CapCut hiện tại (nhận từ CapCutEffectsSettingsPanel)
    const [capCutEffectsSettings, setCapCutEffectsSettings] = React.useState<any>({})
    // Danh sách kênh CapCut (mỗi kênh: tên + logo + vị trí).
    const [capcutChannelProfiles, setCapcutChannelProfiles] = React.useState<CapCutChannelProfile[]>([])
    // Kênh đang chọn cho lần export hiện tại.
    const [selectedCapcutChannelId, setSelectedCapcutChannelId] = React.useState('')
    // Chỉ save localStorage sau khi đã load xong dữ liệu cũ.
    const [isCapcutChannelHydrated, setIsCapcutChannelHydrated] = React.useState(false)
    // UI tạo kênh mới (thay cho window.prompt để chạy ổn định trong Tauri WebView).
    const [isCreatingCapcutChannel, setIsCreatingCapcutChannel] = React.useState(false)
    const [newCapcutChannelName, setNewCapcutChannelName] = React.useState('')
    // Đường dẫn draft CapCut mà user muốn tận dụng subtitle có sẵn (word timing).
    const [capcutDraftPath, setCapcutDraftPath] = React.useState('')
    // Toggle: bật thì ưu tiên lấy timing từ subtitle CapCut, tắt thì luôn chạy Whisper như cũ.
    const [useCapcutSubtitleTiming, setUseCapcutSubtitleTiming] = React.useState(true)
    // Danh sách draft CapCut để user chọn nhanh trực tiếp trên UI.
    const [capcutDraftOptions, setCapcutDraftOptions] = React.useState<CapCutDraftSubtitleOption[]>([])
    const [isLoadingCapcutDrafts, setIsLoadingCapcutDrafts] = React.useState(false)
    const [capcutDraftLoadError, setCapcutDraftLoadError] = React.useState('')
    // Preview word timing để user kiểm tra trực quan trước khi chạy pipeline.
    const [capcutWordTimingPreview, setCapcutWordTimingPreview] = React.useState('')
    const [capcutWordTimingStats, setCapcutWordTimingStats] = React.useState<{ sentences: number; words: number } | null>(null)
    const [isLoadingWordTimingPreview, setIsLoadingWordTimingPreview] = React.useState(false)
    const [wordTimingPreviewError, setWordTimingPreviewError] = React.useState('')

    // Chọn file VO
    const handleSelectVoFile = async () => {
        const selected = await open({
            multiple: false,
            filters: [{
                name: 'Audio',
                extensions: ['wav', 'mp3', 'aac', 'flac', 'ogg', 'm4a'],
            }],
        })
        if (!selected) return
        setVoFile(selected as string)
        console.log('[AutoMedia] VO file:', selected)
    }

    // ======================== CHANNEL PROFILE (CAPCUT) ========================
    React.useEffect(() => {
        setIsCapcutChannelHydrated(false)
        const profileId = getActiveProfileId()
        const channelsKey = `capcut-channel-profiles-${profileId}`
        const selectedKey = `capcut-selected-channel-${profileId}`
        const legacyChannelsKey = 'capcut-channel-profiles'
        const legacySelectedKey = 'capcut-selected-channel'

        try {
            // Fallback theo thứ tự:
            // 1) key profile hiện tại
            // 2) key legacy (chưa theo profile)
            // 3) key profile khác (nếu user đổi profile rồi quay lại)
            const storageKeysToTry = [
                channelsKey,
                legacyChannelsKey,
                ...Object.keys(localStorage).filter((k) =>
                    k.startsWith('capcut-channel-profiles-') && k !== channelsKey
                ),
            ]

            let loadedProfiles: CapCutChannelProfile[] = []
            for (const key of storageKeysToTry) {
                const raw = localStorage.getItem(key)
                if (!raw) continue
                const parsed = JSON.parse(raw) as CapCutChannelProfile[]
                if (!Array.isArray(parsed) || parsed.length === 0) continue

                // Backward-compatible migrate cho dữ liệu cũ chưa có x/y/scale.
                const migrated = parsed.map((item: any) => {
                    const pos: ChannelLogoPosition = item?.position || 'top-right'
                    const defaults = getDefaultLogoTransform(pos)
                    return {
                        id: String(item?.id || ''),
                        name: String(item?.name || ''),
                        logoPath: String(item?.logoPath || ''),
                        position: pos,
                        x: typeof item?.x === 'number' ? item.x : defaults.x,
                        y: typeof item?.y === 'number' ? item.y : defaults.y,
                        scale: typeof item?.scale === 'number' ? item.scale : getDefaultLogoScale(),
                    } as CapCutChannelProfile
                }).filter(ch => !!ch.id && !!ch.name)

                if (migrated.length > 0) {
                    loadedProfiles = migrated
                    // Migrate về key profile hiện tại để lần sau load nhanh.
                    localStorage.setItem(channelsKey, JSON.stringify(migrated))
                    break
                }
            }

            setCapcutChannelProfiles(loadedProfiles)

            const selectedCandidates = [
                localStorage.getItem(selectedKey) || '',
                localStorage.getItem(legacySelectedKey) || '',
            ]
            const selected = selectedCandidates.find(Boolean) || ''
            const selectedExists = loadedProfiles.some(ch => ch.id === selected)
            if (selectedExists) {
                setSelectedCapcutChannelId(selected)
            } else if (loadedProfiles.length > 0) {
                setSelectedCapcutChannelId(loadedProfiles[0].id)
            } else {
                setSelectedCapcutChannelId('')
            }
        } catch (err) {
            console.warn('[AutoMedia] Không đọc được channel profiles:', err)
            setCapcutChannelProfiles([])
            setSelectedCapcutChannelId('')
        } finally {
            setIsCapcutChannelHydrated(true)
        }
    }, [isOpen])

    React.useEffect(() => {
        if (!isCapcutChannelHydrated) return
        const profileId = getActiveProfileId()
        localStorage.setItem(`capcut-channel-profiles-${profileId}`, JSON.stringify(capcutChannelProfiles))
    }, [capcutChannelProfiles, isCapcutChannelHydrated])

    React.useEffect(() => {
        if (!isCapcutChannelHydrated) return
        const profileId = getActiveProfileId()
        localStorage.setItem(`capcut-selected-channel-${profileId}`, selectedCapcutChannelId)
    }, [selectedCapcutChannelId, isCapcutChannelHydrated])

    const handleCreateCapCutChannel = async () => {
        const channelName = newCapcutChannelName.trim()
        if (!channelName) return

        const selected = await open({
            multiple: false,
            filters: [{
                name: 'Logo Image',
                extensions: ['png', 'jpg', 'jpeg', 'webp'],
            }],
        })
        if (!selected) return

        const channelId = `channel_${Date.now()}`
        let safeLogoPath = selected as string
        try {
            safeLogoPath = await ensureCapCutSafeLogoPath(selected as string, channelId)
        } catch (err) {
            // Fallback vẫn dùng path gốc để không chặn UX tạo kênh.
            console.warn('[AutoMedia] ⚠️ Không copy được logo về thư mục an toàn, dùng path gốc:', err)
        }

        const newChannel: CapCutChannelProfile = {
            id: channelId,
            name: channelName,
            logoPath: safeLogoPath,
            // Mặc định đặt góc phải trên — user có thể đổi ngay sau khi tạo.
            position: 'top-right',
            x: getDefaultLogoTransform('top-right').x,
            y: getDefaultLogoTransform('top-right').y,
            scale: getDefaultLogoScale(),
        }

        setCapcutChannelProfiles(prev => [...prev, newChannel])
        setSelectedCapcutChannelId(newChannel.id)
        setNewCapcutChannelName('')
        setIsCreatingCapcutChannel(false)
        console.log('[AutoMedia] ✅ Tạo channel mới:', newChannel)
    }

    const handleUpdateCapCutChannelLogo = async () => {
        if (!selectedCapcutChannelId) {
            alert('Chưa chọn kênh để cập nhật logo.')
            return
        }
        const selected = await open({
            multiple: false,
            filters: [{
                name: 'Logo Image',
                extensions: ['png', 'jpg', 'jpeg', 'webp'],
            }],
        })
        if (!selected) return

        let safeLogoPath = selected as string
        try {
            safeLogoPath = await ensureCapCutSafeLogoPath(selected as string, selectedCapcutChannelId)
        } catch (err) {
            console.warn('[AutoMedia] ⚠️ Không copy được logo về thư mục an toàn, dùng path gốc:', err)
        }

        setCapcutChannelProfiles(prev =>
            prev.map(ch => ch.id === selectedCapcutChannelId ? { ...ch, logoPath: safeLogoPath } : ch)
        )
    }

    const handleDeleteCapCutChannel = React.useCallback(() => {
        if (!selectedCapcutChannelId) {
            alert('Chưa chọn kênh để xoá.')
            return
        }

        const channel = capcutChannelProfiles.find(ch => ch.id === selectedCapcutChannelId)
        if (!channel) return

        const ok = window.confirm(`Xoá kênh "${channel.name}" khỏi danh sách logo?`)
        if (!ok) return

        const nextProfiles = capcutChannelProfiles.filter(ch => ch.id !== selectedCapcutChannelId)
        setCapcutChannelProfiles(nextProfiles)

        if (nextProfiles.length > 0) {
            setSelectedCapcutChannelId(nextProfiles[0].id)
        } else {
            setSelectedCapcutChannelId('')
        }
    }, [capcutChannelProfiles, selectedCapcutChannelId])

    // Chọn thư mục draft CapCut (thường là: ~/Movies/CapCut/User Data/Projects/com.lveditor.draft/<ProjectName>)
    const handleSelectCapCutDraftFolder = async () => {
        const selected = await open({ directory: true, multiple: false })
        if (!selected) return
        setCapcutDraftPath(selected as string)
        console.log('[AutoMedia] CapCut draft folder:', selected)
    }

    /**
     * Quét NHANH danh sách draft CapCut để đổ vào dropdown.
     * Request gửi đi: không có HTTP, chỉ đọc local file system.
     * Response nhận về: mảng {name, path}.
     */
    const loadCapCutDraftOptions = React.useCallback(async () => {
        setIsLoadingCapcutDrafts(true)
        setCapcutDraftLoadError('')
        try {
            const drafts = await listCapCutDraftsFast()
            setCapcutDraftOptions(drafts)

            // Nếu chưa có draft nào được chọn, tự chọn draft mới nhất.
            if (!capcutDraftPath) {
                if (drafts.length > 0) {
                    setCapcutDraftPath(drafts[0].path)
                }
            }
        } catch (err) {
            setCapcutDraftLoadError(String(err))
            setCapcutDraftOptions([])
        } finally {
            setIsLoadingCapcutDrafts(false)
        }
    }, [capcutDraftPath])

    // Khi mở panel ở chế độ CapCut thì tự load danh sách draft.
    React.useEffect(() => {
        if (!isOpen) return
        if (config.targetEngine !== 'capcut') return
        loadCapCutDraftOptions()
    }, [isOpen, config.targetEngine, loadCapCutDraftOptions])

    /**
     * Tải preview word timing từ draft CapCut đã chọn.
     * Request: draft path local.
     * Response: transcript.segments[].words[] -> format string "[0.15] Excuse [0.47] me ..."
     */
    const handlePreviewCapCutWordTiming = React.useCallback(async () => {
        if (!capcutDraftPath) {
            setWordTimingPreviewError('Chưa chọn draft CapCut')
            setCapcutWordTimingPreview('')
            return
        }

        setIsLoadingWordTimingPreview(true)
        setWordTimingPreviewError('')
        setCapcutWordTimingPreview('')
        setCapcutWordTimingStats(null)

        try {
            const result = await buildTranscriptFromCapCutDraftSubtitle(capcutDraftPath)
            const segments = result.transcript.segments || []

            const parts: string[] = []
            let wordsCount = 0
            for (const seg of segments) {
                const words = Array.isArray(seg.words) ? seg.words : []
                for (const w of words) {
                    const stamp = Number(w.start || 0).toFixed(2)
                    const token = String(w.word || '').trim()
                    if (!token) continue
                    parts.push(`[${stamp}] ${token}`)
                    wordsCount++
                }
            }

            setCapcutWordTimingPreview(parts.join(' '))
            setCapcutWordTimingStats({
                sentences: result.stats.sentenceCount,
                words: wordsCount,
            })
        } catch (err) {
            setWordTimingPreviewError(String(err))
        } finally {
            setIsLoadingWordTimingPreview(false)
        }
    }, [capcutDraftPath])

    /** Copy preview word timing để user mang đi đối chiếu nhanh */
    const handleCopyWordTimingPreview = React.useCallback(async () => {
        if (!capcutWordTimingPreview) return
        try {
            await navigator.clipboard.writeText(capcutWordTimingPreview)
        } catch (err) {
            console.error('[AutoMedia] Copy word timing preview lỗi:', err)
        }
    }, [capcutWordTimingPreview])

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
        // Chỉ yêu cầu kết nối DaVinci khi targetEngine là 'davinci'
        const isDaVinci = !config.targetEngine || config.targetEngine === 'davinci'
        if (isDaVinci && !timelineInfo?.timelineId) {
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

        // ======================== XÁC ĐỊNH NGUỒN TIMING CHO CAPCUT ========================
        // Khi bật reuse + đã chọn draft:
        // - Không cần VO để transcribe (lấy trực tiếp word timing từ CapCut draft)
        // - Không import VO vào CapCut draft output
        const isCapCutEngine = config.targetEngine === 'capcut'
        const shouldUseCapCutDraftTiming = isCapCutEngine && useCapcutSubtitleTiming && !!capcutDraftPath

        // Transcript ID:
        // - Nếu có VO: dùng tên file VO để giữ tương thích cũ
        // - Nếu không có VO nhưng đang reuse CapCut draft: dùng tên draft để dễ phân biệt cache
        // - Fallback cuối: capcut_vo
        const capcutTranscriptId = voFile
            ? (voFile.split('/').pop()?.replace(/\.[^.]+$/, '') || 'capcut_vo')
            : (capcutDraftPath.split('/').filter(Boolean).pop() || 'capcut_vo')

        // Quan trọng:
        // - Nếu đang dùng timing từ draft CapCut thì KHÔNG được dùng transcript cũ trong context
        //   (vì có thể là transcript của project khác, gây lệch/tìm sai file .json ở bước AI Match).
        // - Khi đó ép pipeline chạy runTranscribe() để đọc draft hiện tại và ghi transcript file mới.
        const hasTranscriptInContext = subtitles && subtitles.length > 0
        const shouldReuseContextTranscript = !shouldUseCapCutDraftTiming && hasTranscriptInContext

        // Build dependencies
        const selectedChannelForExport = config.targetEngine === 'capcut' && selectedCapcutChannelId
            ? capcutChannelProfiles.find(ch => ch.id === selectedCapcutChannelId)
            : undefined
        let normalizedChannelLogoPath = selectedChannelForExport?.logoPath || ''
        if (selectedChannelForExport?.logoPath) {
            try {
                // Chuẩn hoá lại logo path trước khi chạy pipeline để xử lý cả dữ liệu kênh cũ.
                normalizedChannelLogoPath = await ensureCapCutSafeLogoPath(
                    selectedChannelForExport.logoPath,
                    selectedChannelForExport.id
                )
                if (normalizedChannelLogoPath !== selectedChannelForExport.logoPath) {
                    setCapcutChannelProfiles(prev =>
                        prev.map(ch =>
                            ch.id === selectedChannelForExport.id
                                ? { ...ch, logoPath: normalizedChannelLogoPath }
                                : ch
                        )
                    )
                }
            } catch (err) {
                console.warn('[AutoMedia] ⚠️ Không chuẩn hoá được logo path trước export:', err)
            }
        }

        const deps: AutoMediaDependencies = {
            // CapCut mode: không cần timelineId, DaVinci mode: bắt buộc
            timelineId: timelineInfo?.timelineId || '',
            // Transcript ID: CapCut dùng tên file VO (không ext), DaVinci dùng timelineId
            transcriptId: config.targetEngine === 'capcut'
                ? capcutTranscriptId
                : (timelineInfo?.timelineId || ''),
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
            // CapCut mode: truyền file Voice Over + project name
            // Nếu đang reuse timing từ draft CapCut -> bỏ VO track hoàn toàn
            voFilePath: config.targetEngine === 'capcut'
                ? (shouldUseCapCutDraftTiming ? undefined : voFile)
                : undefined,
            projectName: config.targetEngine === 'capcut' ? `AutoMedia_${new Date().toISOString().slice(0, 10)}` : undefined,
            // Nếu user đã chọn draft nguồn thì ưu tiên ghi đè trực tiếp vào draft đó.
            capcutTargetDraftPath: config.targetEngine === 'capcut' && capcutDraftPath
                ? capcutDraftPath
                : undefined,
            capCutEffectsSettings: config.targetEngine === 'capcut' ? capCutEffectsSettings : undefined,
            capcutChannelBranding: (() => {
                if (!selectedChannelForExport || !normalizedChannelLogoPath) return undefined
                return {
                    channelId: selectedChannelForExport.id,
                    channelName: selectedChannelForExport.name,
                    logoPath: normalizedChannelLogoPath,
                    position: selectedChannelForExport.position,
                    x: selectedChannelForExport.x,
                    y: selectedChannelForExport.y,
                    scale: selectedChannelForExport.scale,
                }
            })(),
            runTranscribe: async (onStepUpdate) => {
                // ========== CHẠY WHISPER ==========
                // Phân nhánh: DaVinci mode → export audio từ Resolve | CapCut mode → dùng file VO
                const isCapCut = config.targetEngine === 'capcut'

                let audioPath = ''
                let audioOffset = 0

                // ===== CAPCUT SUBTITLE REUSE MODE =====
                // Nếu user bật reuse + đã chọn draft path -> đọc word timing trực tiếp từ CapCut.
                if (isCapCut && useCapcutSubtitleTiming && capcutDraftPath) {
                    onStepUpdate('transcribe', 'running', '📚 CapCut mode — đọc subtitle_cache_info (word timing) từ draft...')

                    // Log request/response vào Debug Panel để user kiểm tra rõ nguồn dữ liệu.
                    const logId = generateLogId()
                    const startedAt = Date.now()
                    addDebugLog({
                        id: logId,
                        timestamp: new Date(),
                        method: 'LOCAL_READ',
                        url: 'local://capcut/subtitle-cache',
                        requestHeaders: { 'Content-Type': 'application/json' },
                        requestBody: JSON.stringify({
                            draftDirPath: capcutDraftPath,
                            mode: 'capcut_subtitle_reuse',
                        }, null, 2),
                        status: null,
                        responseHeaders: {},
                        responseBody: '',
                        duration: 0,
                        error: null,
                        label: 'CapCut Subtitle Reuse',
                    })

                    let result: Awaited<ReturnType<typeof buildTranscriptFromCapCutDraftSubtitle>> | null = null
                    try {
                        result = await buildTranscriptFromCapCutDraftSubtitle(capcutDraftPath)
                    } catch (capcutSubtitleError) {
                        // Không crash pipeline ngay: fallback về Whisper để vẫn chạy được.
                        onStepUpdate(
                            'transcribe',
                            'running',
                            '⚠️ Không đọc được subtitle CapCut, fallback sang Whisper...',
                            undefined,
                            String(capcutSubtitleError)
                        )
                        addDebugLog({
                            id: `${logId}-error`,
                            timestamp: new Date(),
                            method: 'LOCAL_READ',
                            url: 'local://capcut/subtitle-cache/result',
                            requestHeaders: {},
                            requestBody: '',
                            status: 500,
                            responseHeaders: {},
                            responseBody: '',
                            duration: Date.now() - startedAt,
                            error: String(capcutSubtitleError),
                            label: 'CapCut Subtitle Reuse Result',
                        })
                    }

                    if (result) {
                        const transcript = result.transcript as any

                        addDebugLog({
                            id: `${logId}-done`,
                            timestamp: new Date(),
                            method: 'LOCAL_READ',
                            url: 'local://capcut/subtitle-cache/result',
                            requestHeaders: {},
                            requestBody: '',
                            status: 200,
                            responseHeaders: {},
                            responseBody: JSON.stringify({
                                sentenceCount: result.stats.sentenceCount,
                                wordCount: result.stats.wordCount,
                                sourceFile: result.stats.sourceFile,
                            }, null, 2),
                            duration: Date.now() - startedAt,
                            error: null,
                            label: 'CapCut Subtitle Reuse Result',
                        })

                        onStepUpdate('transcribe', 'running', `💾 Dùng subtitle CapCut: ${result.stats.sentenceCount} câu / ${result.stats.wordCount} từ`, undefined, `source: ${result.stats.sourceFile}`)

                        const filename = await processTranscriptionResults(
                            transcript,
                            settings,
                            voFile || null,
                            capcutTranscriptId
                        )

                        const debugTranscribe = `source: CapCut subtitle_cache_info\nfile: ${filename}\nsegments: ${result.stats.sentenceCount}\nwords: ${result.stats.wordCount}\nsourceFile: ${result.stats.sourceFile}`
                        onStepUpdate('transcribe', 'done', 'Transcribe hoàn tất ✅ (dùng subtitle CapCut)', undefined, debugTranscribe)
                        return
                    }
                }

                if (isCapCut) {
                    // ===== CAPCUT MODE: dùng file VO trực tiếp =====
                    if (!voFile) {
                        // Nếu user chọn reuse CapCut timing mà đọc draft lỗi, và cũng không có VO fallback:
                        // báo lỗi rõ ràng để user biết cần làm gì tiếp theo.
                        if (shouldUseCapCutDraftTiming) {
                            throw new Error('CapCut mode: Không đọc được word timing từ draft đã chọn, và bạn chưa chọn VO để fallback Whisper.')
                        }
                        throw new Error('CapCut mode: Chưa chọn file Voice Over (VO)! Hãy chọn file VO trước khi bắt đầu.')
                    }
                    onStepUpdate('transcribe', 'running', `🎙️ CapCut mode — dùng file VO: ${voFile.split('/').pop()}`)
                    audioPath = voFile
                    audioOffset = 0 // VO file bắt đầu từ 0s
                    console.log('[AutoMedia] CapCut mode — VO file:', voFile)
                } else {
                    // ===== DAVINCI MODE: export audio từ Resolve =====
                    // FIX ROOT CAUSE: nếu selectedInputTracks rỗng → fallback ["2"]
                    const inputTracks = (settings.selectedInputTracks && settings.selectedInputTracks.length > 0)
                        ? settings.selectedInputTracks
                        : ['2']  // fallback mặc định

                    console.log('[AutoMedia] inputTracks để export:', inputTracks, '| settings.selectedInputTracks:', settings.selectedInputTracks)

                    onStepUpdate('transcribe', 'running', `🎧 Exporting audio từ DaVinci (Track A${inputTracks.join(', A')})...`)
                    console.log('[AutoMedia] Bắt đầu export audio từ DaVinci...')
                    const audioInfo = await getSourceAudio(
                        false, // Resolve mode
                        null,
                        inputTracks
                    )
                    if (!audioInfo) {
                        throw new Error('Không export được audio từ DaVinci. Kiểm tra kết nối.')
                    }
                    audioPath = audioInfo.path
                    audioOffset = audioInfo.offset
                }

                // Debug: hiện audio info chi tiết
                onStepUpdate('transcribe', 'running', `🎧 Audio OK: ${audioPath?.split('/').pop()} | offset: ${audioOffset}s | mode: ${isCapCut ? 'CapCut' : 'DaVinci'}`, undefined, `audioPath: ${audioPath}\noffset: ${audioOffset}\nmode: ${isCapCut ? 'CapCut (VO file)' : 'DaVinci (Resolve export)'}\nmodel: ${settings.model} | lang: ${settings.language} | DTW: ${settings.enableDTW} | GPU: ${settings.enableGpu}`)

                // Sub-step 2: Gọi Whisper transcribe
                onStepUpdate('transcribe', 'running', '🤖 Whisper đang phân tích audio → word-level timestamps...')
                console.log('[AutoMedia] Audio path:', audioPath, '| Offset:', audioOffset)
                const { invoke } = await import('@tauri-apps/api/core')
                const { models } = await import('@/lib/models')
                const transcribeOptions = {
                    audioPath: audioPath,
                    offset: Math.round(audioOffset * 1000) / 1000,
                    model: models[settings.model]?.value || 'ggml-large-v3-turbo-q5_0.bin',
                    lang: settings.language,
                    translate: settings.translate,
                    targetLanguage: settings.targetLanguage,
                    enableDtw: settings.enableDTW,
                    enableGpu: settings.enableGpu,
                    enableDiarize: settings.enableDiarize,
                    maxSpeakers: settings.maxSpeakers,
                    density: settings.textDensity,
                }
                // Tạo log pending ngay khi bắt đầu gọi transcribe để Debug Panel hiển thị tức thì.
                const transcribeDebugLogId = startTranscribePhaseDebugLog({
                    label: 'Auto Media Pipeline',
                    options: transcribeOptions,
                })
                // Listen progress realtime từ backend để update log pending trong Debug Panel.
                const { listen } = await import('@tauri-apps/api/event')
                let unlistenTranscribeProgress: (() => void) | null = null
                try {
                    unlistenTranscribeProgress = await listen<any>('labeled-progress', (event) => {
                        const payload = event.payload || {}
                        const pType = String(payload?.type || '').toLowerCase()
                        // Chỉ bắt progress transcribe để tránh spam từ phase khác.
                        if (!pType.includes('transcribe')) return
                        updateTranscribePhasePendingProgress({
                            logId: transcribeDebugLogId,
                            progress: typeof payload?.progress === 'number' ? payload.progress : undefined,
                            type: payload?.type,
                            label: payload?.label,
                        })
                    })
                } catch (listenError) {
                    console.warn('[AutoMedia] Không listen được labeled-progress:', listenError)
                }
                let transcript: unknown
                try {
                    transcript = await invoke('transcribe_audio', {
                        options: transcribeOptions,
                    })
                } finally {
                    if (unlistenTranscribeProgress) {
                        try { unlistenTranscribeProgress() } catch { /* noop */ }
                    }
                }
                // Ghi log timing chi tiết từng pha để xem bottleneck trong DEBUG Panel.
                logTranscribePhaseTimingToDebug({
                    logId: transcribeDebugLogId,
                    label: 'Auto Media Pipeline',
                    options: transcribeOptions,
                    transcript,
                })
                console.log('[AutoMedia] Whisper raw result:', transcript)
                console.log('[AutoMedia] Whisper raw keys:', Object.keys(transcript as any))

                // Debug: hiện whisper raw result trước khi process
                const rawT = transcript as any
                const rawSegCount = rawT?.segments?.length ?? rawT?.originalSegments?.length ?? '?'
                const rawKeys = Object.keys(rawT || {}).join(', ')
                onStepUpdate('transcribe', 'running', `💾 Whisper xong → ${rawSegCount} segments (raw keys: ${rawKeys})`, undefined, `raw keys: ${rawKeys}\nraw segments count: ${rawSegCount}\nprocessing_time_sec: ${rawT?.processing_time_sec ?? '?'}\nraw first segment: ${JSON.stringify(rawT?.segments?.[0] || rawT?.originalSegments?.[0] || '(empty)').substring(0, 200)}`)

                // Sub-step 3: Save transcript + cập nhật context
                // CapCut mode: dùng tên file VO làm ID, DaVinci mode: dùng timelineId
                const transcriptId = isCapCut
                    ? capcutTranscriptId
                    : (timelineInfo?.timelineId || 'unknown')

                onStepUpdate('transcribe', 'running', '💾 Đang lưu transcript + cập nhật context...')
                const filename = await processTranscriptionResults(
                    transcript as any,
                    settings,
                    // CapCut: có thể null khi dùng reuse timing từ draft, DaVinci luôn null
                    isCapCut ? (voFile || null) : null,
                    transcriptId
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
                // Sample 5 words đầu tiên
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
            hasTranscript: shouldReuseContextTranscript,
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
            capcutChannelBranding: undefined,
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

                        {/* Chọn file VO — chỉ hiện khi CapCut mode */}
                        {config.targetEngine === 'capcut' && (
                            <div className="space-y-1.5">
                                <label className="text-sm font-medium flex items-center gap-1.5">
                                    <FileAudio className="h-3.5 w-3.5 text-blue-400" />
                                    File Voice Over (VO)
                                </label>
                                <div className="flex items-center gap-2">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="gap-1.5"
                                        onClick={handleSelectVoFile}
                                    >
                                        <Mic className="h-3.5 w-3.5" />
                                        Chọn File VO
                                    </Button>
                                    {voFile ? (
                                        <span className="text-xs text-muted-foreground truncate max-w-[200px]" title={voFile}>
                                            🎙️ {voFile.split('/').pop()}
                                        </span>
                                    ) : (
                                        <span className="text-xs text-yellow-500/70">
                                            {useCapcutSubtitleTiming && capcutDraftPath
                                                ? 'ℹ️ Chưa chọn VO (không sao — đang dùng word timing từ draft)'
                                                : '⚠️ Chưa chọn file VO'}
                                        </span>
                                    )}
                                </div>
                                <p className="text-[10px] text-muted-foreground">
                                    {useCapcutSubtitleTiming && capcutDraftPath
                                        ? 'Đang ưu tiên word timing từ draft CapCut: VO là tuỳ chọn, không bắt buộc import vào draft mới.'
                                        : 'File giọng đọc (.wav/.mp3) sẽ được đặt vào track Voice Over trong CapCut Draft.'}
                                </p>

                                <div className="mt-2 rounded-md border p-2 bg-muted/30 space-y-2">
                                    <div className="flex items-center justify-between">
                                        <span className="text-[11px] font-medium text-muted-foreground uppercase">
                                            Nguồn Timing Ưu Tiên
                                        </span>
                                        <Switch
                                            checked={useCapcutSubtitleTiming}
                                            onCheckedChange={() => setUseCapcutSubtitleTiming(prev => !prev)}
                                        />
                                    </div>
                                    <p className="text-[10px] text-muted-foreground">
                                        Bật: lấy trực tiếp word timing từ subtitle_cache_info trong draft CapCut (nếu có), bỏ qua Whisper.
                                    </p>
                                    <div className="flex items-center gap-2">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="gap-1.5"
                                            onClick={loadCapCutDraftOptions}
                                            disabled={isLoadingCapcutDrafts}
                                        >
                                            <RefreshCw className={`h-3.5 w-3.5 ${isLoadingCapcutDrafts ? 'animate-spin' : ''}`} />
                                            Quét Draft
                                        </Button>
                                    </div>

                                    <div className="space-y-1">
                                        <label className="text-[11px] text-muted-foreground">Danh sách Draft CapCut gần đây</label>
                                        <select
                                            className="w-full rounded border bg-background px-2 py-1.5 text-xs"
                                            value={capcutDraftPath}
                                            onChange={(e) => setCapcutDraftPath(e.target.value)}
                                            disabled={isLoadingCapcutDrafts || capcutDraftOptions.length === 0}
                                        >
                                            <option value="">-- Chọn draft --</option>
                                            {capcutDraftOptions.map((d) => (
                                                <option key={d.path} value={d.path}>
                                                    {d.name}
                                                </option>
                                            ))}
                                        </select>
                                        {capcutDraftLoadError && (
                                            <p className="text-[10px] text-red-400 break-words">
                                                ❌ Lỗi quét draft: {capcutDraftLoadError}
                                            </p>
                                        )}
                                    </div>

                                    <div className="flex items-center gap-2">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="gap-1.5"
                                            onClick={handlePreviewCapCutWordTiming}
                                            disabled={isLoadingWordTimingPreview || !capcutDraftPath}
                                        >
                                            {isLoadingWordTimingPreview ? (
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            ) : (
                                                <FileAudio className="h-3.5 w-3.5" />
                                            )}
                                            Xem Word Timing
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="gap-1.5"
                                            onClick={handleCopyWordTimingPreview}
                                            disabled={!capcutWordTimingPreview}
                                        >
                                            <Copy className="h-3.5 w-3.5" />
                                            Copy
                                        </Button>
                                    </div>
                                    {capcutWordTimingStats && (
                                        <p className="text-[10px] text-muted-foreground">
                                            ✅ Preview: {capcutWordTimingStats.sentences} câu • {capcutWordTimingStats.words} từ
                                        </p>
                                    )}
                                    {wordTimingPreviewError && (
                                        <p className="text-[10px] text-red-400 break-words">
                                            ❌ Không đọc được word timing: {wordTimingPreviewError}
                                        </p>
                                    )}
                                    {capcutWordTimingPreview && (
                                        <Textarea
                                            value={capcutWordTimingPreview}
                                            readOnly
                                            className="h-32 text-[10px] font-mono resize-y"
                                        />
                                    )}

                                    <div className="flex items-center gap-2">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="gap-1.5"
                                            onClick={handleSelectCapCutDraftFolder}
                                        >
                                            <FolderOpen className="h-3.5 w-3.5" />
                                            Chọn Draft CapCut
                                        </Button>
                                        {capcutDraftPath ? (
                                            <span className="text-xs text-muted-foreground truncate max-w-[210px]" title={capcutDraftPath}>
                                                📁 {capcutDraftPath.split('/').pop()}
                                            </span>
                                        ) : (
                                            <span className="text-xs text-muted-foreground/70">
                                                Chưa chọn draft
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}

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

                            {/* Export Target Toggle */}
                            <div className="mt-4 space-y-2">
                                <label className="text-sm font-medium">Export Target</label>
                                <div className="grid grid-cols-2 gap-1.5 bg-muted/30 border rounded-md p-1.5">
                                    <button 
                                        onClick={() => setConfig(prev => ({...prev, targetEngine: 'davinci'}))}
                                        className={`flex items-center justify-center gap-1.5 text-xs py-2 rounded-sm font-medium transition-colors ${(!config.targetEngine || config.targetEngine === 'davinci') ? 'bg-primary text-primary-foreground shadow' : 'hover:bg-muted text-muted-foreground'}`}
                                    >
                                        <img src="/davinci-resolve-logo.png" className="h-4 w-4 object-contain" alt="DaVinci" />
                                        DaVinci Resolve
                                    </button>
                                    <button 
                                        onClick={() => setConfig(prev => ({...prev, targetEngine: 'capcut'}))}
                                        className={`flex items-center justify-center gap-1.5 text-xs py-2 rounded-sm font-medium transition-colors ${config.targetEngine === 'capcut' ? 'bg-primary text-primary-foreground shadow' : 'hover:bg-muted text-muted-foreground'}`}
                                    >
                                        <span className="font-bold text-[13px] tracking-tight text-white bg-black rounded p-0.5 px-1 leading-none">C</span>
                                        CapCut Draft (v3)
                                    </button>
                                </div>
                            </div>

                            {/* Panel cài đặt hiệu ứng (chỉ hiện cho CapCut) */}
                            {config.targetEngine === 'capcut' && (
                                <div className="mt-2">
                                    <CapCutEffectsSettingsPanel 
                                        onSettingsChange={(effConfig) => {
                                            // Quan trọng: phải đưa settings effect vào deps pipeline.
                                            // Nếu chỉ console.log thì export CapCut sẽ nhận {} và không inject transition/video effect.
                                            setCapCutEffectsSettings(effConfig)
                                            console.log('[AutoMedia] CapCut Effects:', effConfig)
                                        }} 
                                    />
                                </div>
                            )}

                            {/* Channel Branding cho CapCut: chỉ chọn kênh + logo + vị trí */}
                            {config.targetEngine === 'capcut' && (
                                <div className="mt-2 rounded-md border p-2 bg-muted/20 space-y-2">
                                    <div className="flex items-center justify-between">
                                        <span className="text-xs font-medium">Kênh YouTube (Logo Auto Overlay)</span>
                                        <div className="flex items-center gap-1">
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="h-6 text-[10px]"
                                                onClick={() => setIsCreatingCapcutChannel(prev => !prev)}
                                            >
                                                {isCreatingCapcutChannel ? 'Đóng' : '+ Tạo kênh'}
                                            </Button>
                                            <Button type="button" variant="outline" size="sm" className="h-6 text-[10px]" onClick={handleUpdateCapCutChannelLogo} disabled={!selectedCapcutChannelId}>
                                                Cập nhật logo
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="h-6 text-[10px] text-red-500 border-red-200 hover:bg-red-50"
                                                onClick={handleDeleteCapCutChannel}
                                                disabled={!selectedCapcutChannelId}
                                            >
                                                Xoá kênh
                                            </Button>
                                        </div>
                                    </div>

                                    {isCreatingCapcutChannel && (
                                        <div className="flex items-center gap-1.5">
                                            <input
                                                value={newCapcutChannelName}
                                                onChange={(e) => setNewCapcutChannelName(e.target.value)}
                                                placeholder="Nhập tên kênh..."
                                                className="h-8 flex-1 rounded-md border bg-background px-2 text-xs"
                                            />
                                            <Button
                                                type="button"
                                                size="sm"
                                                className="h-8 text-[10px]"
                                                onClick={handleCreateCapCutChannel}
                                                disabled={!newCapcutChannelName.trim()}
                                            >
                                                Lưu + Chọn logo
                                            </Button>
                                        </div>
                                    )}

                                    <div className="grid grid-cols-2 gap-2">
                                        <div className="space-y-1">
                                            <label className="text-[11px] text-muted-foreground">Chọn kênh</label>
                                            <select
                                                value={selectedCapcutChannelId}
                                                onChange={(e) => setSelectedCapcutChannelId(e.target.value)}
                                                className="w-full h-8 rounded-md border bg-background px-2 text-xs"
                                            >
                                                <option value="">Không dùng logo kênh</option>
                                                {capcutChannelProfiles.map(ch => (
                                                    <option key={ch.id} value={ch.id}>{ch.name}</option>
                                                ))}
                                            </select>
                                        </div>

                                        <div className="space-y-1">
                                            <label className="text-[11px] text-muted-foreground">Vị trí logo</label>
                                            <select
                                                value={capcutChannelProfiles.find(ch => ch.id === selectedCapcutChannelId)?.position || 'top-right'}
                                                onChange={(e) => {
                                                    const pos = e.target.value as ChannelLogoPosition
                                                    const defaults = getDefaultLogoTransform(pos)
                                                    setCapcutChannelProfiles(prev =>
                                                        prev.map(ch => ch.id === selectedCapcutChannelId ? {
                                                            ...ch,
                                                            position: pos,
                                                            x: defaults.x,
                                                            y: defaults.y,
                                                        } : ch)
                                                    )
                                                }}
                                                disabled={!selectedCapcutChannelId}
                                                className="w-full h-8 rounded-md border bg-background px-2 text-xs disabled:opacity-60"
                                            >
                                                <option value="top-left">Trên trái</option>
                                                <option value="top-right">Trên phải</option>
                                                <option value="bottom-left">Dưới trái</option>
                                                <option value="bottom-right">Dưới phải</option>
                                            </select>
                                        </div>
                                    </div>

                                    {selectedCapcutChannelId && (
                                        <div className="space-y-2 rounded-md border bg-background/60 p-2">
                                            <div className="flex items-center justify-end">
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    size="sm"
                                                    className="h-6 text-[10px]"
                                                    onClick={() => {
                                                        setCapcutChannelProfiles(prev =>
                                                            prev.map(ch => {
                                                                if (ch.id !== selectedCapcutChannelId) return ch
                                                                const defaults = getDefaultLogoTransform(ch.position)
                                                                return {
                                                                    ...ch,
                                                                    x: defaults.x,
                                                                    y: defaults.y,
                                                                    scale: getDefaultLogoScale(),
                                                                }
                                                            })
                                                        )
                                                    }}
                                                >
                                                    Về mặc định
                                                </Button>
                                            </div>
                                            <div className="grid grid-cols-3 gap-2">
                                                <div className="space-y-1">
                                                    <label className="text-[11px] text-muted-foreground">X (trái/phải)</label>
                                                    <input
                                                        type="range"
                                                        min={-1.2}
                                                        max={1.2}
                                                        step={0.01}
                                                        value={capcutChannelProfiles.find(ch => ch.id === selectedCapcutChannelId)?.x ?? 0.87}
                                                        onChange={(e) => {
                                                            const nextX = Number(e.target.value)
                                                            setCapcutChannelProfiles(prev =>
                                                                prev.map(ch => ch.id === selectedCapcutChannelId ? { ...ch, x: nextX } : ch)
                                                            )
                                                        }}
                                                        className="w-full"
                                                    />
                                                    <div className="text-[10px] text-muted-foreground">
                                                        {(capcutChannelProfiles.find(ch => ch.id === selectedCapcutChannelId)?.x ?? 0.8).toFixed(2)}
                                                    </div>
                                                </div>

                                                <div className="space-y-1">
                                                    <label className="text-[11px] text-muted-foreground">Y (lên/xuống)</label>
                                                    <input
                                                        type="range"
                                                        min={-1.2}
                                                        max={1.2}
                                                        step={0.01}
                                                        value={capcutChannelProfiles.find(ch => ch.id === selectedCapcutChannelId)?.y ?? 0.75}
                                                        onChange={(e) => {
                                                            const nextY = Number(e.target.value)
                                                            setCapcutChannelProfiles(prev =>
                                                                prev.map(ch => ch.id === selectedCapcutChannelId ? { ...ch, y: nextY } : ch)
                                                            )
                                                        }}
                                                        className="w-full"
                                                    />
                                                    <div className="text-[10px] text-muted-foreground">
                                                        {(capcutChannelProfiles.find(ch => ch.id === selectedCapcutChannelId)?.y ?? 0.56).toFixed(2)}
                                                    </div>
                                                </div>

                                                <div className="space-y-1">
                                                    <label className="text-[11px] text-muted-foreground">Scale</label>
                                                    <input
                                                        type="range"
                                                        min={0.05}
                                                        max={1.2}
                                                        step={0.01}
                                                        value={capcutChannelProfiles.find(ch => ch.id === selectedCapcutChannelId)?.scale ?? getDefaultLogoScale()}
                                                        onChange={(e) => {
                                                            const nextScale = Number(e.target.value)
                                                            setCapcutChannelProfiles(prev =>
                                                                prev.map(ch => ch.id === selectedCapcutChannelId ? { ...ch, scale: nextScale } : ch)
                                                            )
                                                        }}
                                                        className="w-full"
                                                    />
                                                    <div className="text-[10px] text-muted-foreground">
                                                        {(((capcutChannelProfiles.find(ch => ch.id === selectedCapcutChannelId)?.scale ?? getDefaultLogoScale()) * 100)).toFixed(0)}%
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )}
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
                        // Chỉ yêu cầu timelineId khi DaVinci mode, CapCut mode không cần
                        const isDaVinci = !config.targetEngine || config.targetEngine === 'davinci'
                        const btnDisabled = !scriptText.trim() || (isDaVinci && !timelineInfo?.timelineId)
                        if (btnDisabled) {
                            console.log('[AutoMedia] ⚠️ Nút disabled:', {
                                scriptEmpty: !scriptText.trim(),
                                scriptLen: scriptText.length,
                                timelineId: timelineInfo?.timelineId || '(null)',
                                timelineInfo: timelineInfo || '(null)',
                                targetEngine: config.targetEngine || 'davinci (default)',
                                isDaVinci,
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
