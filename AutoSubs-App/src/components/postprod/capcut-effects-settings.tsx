/**
 * capcut-effects-settings.tsx
 * 
 * Panel settings cho CapCut effects: Transition, Khung phim, Text Template, Zoom, Mute
 * Hiện khi user chọn CapCut mode trong Auto Media panel.
 * 
 * Features:
 * - Combobox tìm kiếm effect (Popover + Command + Input search)
 * - Canvas text preview (render tên style) cho text template
 * - Slider zoom level
 * - Toggle mute/zoom
 * - Quét cache CapCut (nút Refresh)
 * - Nhớ settings qua plugin-store
 * - Auto Việt hoá tên sau scan
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
    Command,
    CommandInput,
    CommandList,
    CommandEmpty,
    CommandGroup,
    CommandItem,
} from '@/components/ui/command'
import {
    ChevronDown,
    Check,
    X,
    RefreshCw,
    Clapperboard,
    Frame,
    Type,
    ZoomIn,
    VolumeX,
    Loader2,
    Trash2,
} from 'lucide-react'

import type {
    CachedEffect,
    CapCutEffectsSettings,
} from '@/services/capcut-cache-scanner'
import {
    scanCapCutCache,
    loadEffectsSettings,
    saveEffectsSettings,
    generateVietnameseNames,
    saveCustomNames,
    pinSubtitleTemplateBundle,
    loadPinnedSubtitleTemplateBundles,
    removePinnedSubtitleTemplateBundle,
} from '@/services/capcut-cache-scanner'

// ======================== TYPES ========================

interface CapCutEffectsSettingsPanelProps {
    /** Callback khi settings thay đổi — truyền lên parent */
    onSettingsChange?: (settings: CapCutEffectsSettings) => void
}

// ======================== CANVAS TEXT PREVIEW ========================

/**
 * Preview card cho text template — render tên trên canvas dừi dạng style
 * Màu gradient theo hash của effectId → mỗi effect có màu riêng, nhất quán
 */
function CanvasTextPreview({ effectId, displayName }: { effectId: string; displayName: string }) {
    const canvasRef = useRef<HTMLCanvasElement>(null)

    // Hash effectId → index màu (nhất quán, không random lại mỗi render)
    const colorScheme = React.useMemo(() => {
        // Các bộ màu gradient giả lập style CapCut
        const palettes = [
            { bg: '#1a1a2e', text: '#e94560', glow: '#e94560' },   // Đỏ + đỏ
            { bg: '#0f3460', text: '#f5a623', glow: '#f5a623' },   // Xanh + cam
            { bg: '#16213e', text: '#0fd3ff', glow: '#0fd3ff' },   // Dark + cyan
            { bg: '#1b1b2f', text: '#a855f7', glow: '#c084fc' },   // Tím
            { bg: '#1a2f1a', text: '#4ade80', glow: '#22c55e' },   // Xanh lá
            { bg: '#2d1b00', text: '#fb923c', glow: '#f97316' },   // Cam cám
            { bg: '#1f1f1f', text: '#ffffff', glow: '#cccccc' },   // Trắng viên
            { bg: '#0d0d2b', text: '#60a5fa', glow: '#3b82f6' },   // Xanh dương
        ]
        // Hash đơn giản từ effectId
        let hash = 0
        for (const c of effectId) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff
        return palettes[Math.abs(hash) % palettes.length]
    }, [effectId])

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        const W = canvas.width
        const H = canvas.height

        // Nền tối
        ctx.fillStyle = colorScheme.bg
        ctx.fillRect(0, 0, W, H)

        // Glow effect
        ctx.shadowColor = colorScheme.glow
        ctx.shadowBlur = 8

        // Text
        const fontSize = displayName.length > 12 ? 9 : displayName.length > 8 ? 10 : 12
        ctx.font = `bold ${fontSize}px -apple-system, sans-serif`
        ctx.fillStyle = colorScheme.text
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'

        // Truncate nếu quá dài
        let label = displayName
        if (ctx.measureText(label).width > W - 6) {
            while (ctx.measureText(label + '…').width > W - 6 && label.length > 0) {
                label = label.slice(0, -1)
            }
            label += '…'
        }
        ctx.fillText(label, W / 2, H / 2)
        ctx.shadowBlur = 0
    }, [displayName, colorScheme])

    return (
        <canvas
            ref={canvasRef}
            width={64}
            height={36}
            className="rounded shrink-0 border border-white/10"
            title={displayName}
        />
    )
}

// ======================== EFFECT COMBOBOX ========================

/**
 * Combobox chọn effect — có search, scroll, preview
 * Dùng chung cho Transition / Video Effect / Text Template
 */
function EffectCombobox({
    label,
    icon,
    effects,
    selectedId,
    onSelect,
    showPreview = false,
}: {
    label: string
    icon: React.ReactNode
    effects: CachedEffect[]
    selectedId: string
    onSelect: (effectId: string) => void
    showPreview?: boolean
}) {
    const [open, setOpen] = useState(false)

    // Tìm effect đang chọn
    const selected = effects.find(e => e.effectId === selectedId)

    return (
        <div className="space-y-1">
            {/* Label */}
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                {icon}
                {label}
            </label>

            {/* Combobox trigger */}
            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                    <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={open}
                        className="w-full justify-between h-8 text-xs font-normal"
                    >
                        {selected ? (
                            <span className="truncate flex items-center gap-1.5">
                                {/* Preview thumbnail nếu có */}
                                {showPreview && selected.previewPath && (
                                    <img
                                        src={`asset://localhost/${selected.previewPath}`}
                                        alt=""
                                        className="h-4 w-6 rounded object-cover"
                                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                                    />
                                )}
                                {selected.displayName}
                            </span>
                        ) : (
                            <span className="text-muted-foreground">Không dùng</span>
                        )}
                        {/* Nút X xoá lựa chọn hoặc chevron */}
                        {selected ? (
                            <X
                                className="h-3 w-3 shrink-0 opacity-50 hover:opacity-100 cursor-pointer"
                                onClick={(e) => {
                                    e.stopPropagation()
                                    onSelect('')
                                }}
                            />
                        ) : (
                            <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
                        )}
                    </Button>
                </PopoverTrigger>

                {/* Dropdown content */}
                <PopoverContent className="w-[280px] p-0" align="start">
                    <Command>
                        <CommandInput placeholder="Tìm kiếm..." className="h-8 text-xs" />
                        <CommandList>
                            <CommandEmpty>Không tìm thấy</CommandEmpty>
                            <CommandGroup>
                                {/* Option "Không dùng" */}
                                <CommandItem
                                    value="none"
                                    onSelect={() => {
                                        onSelect('')
                                        setOpen(false)
                                    }}
                                    className="text-xs"
                                >
                                    <span className="text-muted-foreground">Không dùng</span>
                                    {!selectedId && <Check className="ml-auto h-3 w-3" />}
                                </CommandItem>

                                {/* Danh sách effects */}
                                {effects.map((effect) => (
                                    <CommandItem
                                        key={effect.effectId}
                                        value={`${effect.displayName} ${effect.originalName}`}
                                        onSelect={() => {
                                            onSelect(effect.effectId)
                                            setOpen(false)
                                        }}
                                        className="text-xs flex items-center gap-2"
                                    >
                                        {/* Preview thumbnail */}
                                        {showPreview && effect.previewPath ? (
                                            <img
                                                src={`asset://localhost/${effect.previewPath}`}
                                                alt=""
                                                className="h-6 w-8 rounded object-cover shrink-0"
                                                onError={(e) => {
                                                    const target = e.target as HTMLImageElement
                                                    target.style.display = 'none'
                                                }}
                                            />
                                        ) : showPreview ? (
                                            // Canvas preview: render tên + màu gradient theo effectId
                                            <CanvasTextPreview
                                                effectId={effect.effectId}
                                                displayName={effect.displayName}
                                            />
                                        ) : null}

                                        <div className="flex flex-col min-w-0">
                                            <span className="truncate">{effect.displayName}</span>
                                            {/* Hiện tên gốc nếu khác displayName */}
                                            {effect.displayName !== effect.originalName && (
                                                <span className="text-[9px] text-muted-foreground truncate">
                                                    {effect.originalName}
                                                </span>
                                            )}
                                        </div>

                                        {/* Check icon nếu đang chọn */}
                                        {selectedId === effect.effectId && (
                                            <Check className="ml-auto h-3 w-3 shrink-0" />
                                        )}
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        </CommandList>
                    </Command>
                </PopoverContent>
            </Popover>
        </div>
    )
}

// ======================== MAIN PANEL ========================

/**
 * Cờ ẩn/hiện các block UI nâng cao trong panel CapCut Effects.
 * - Chỉ ẩn giao diện, KHÔNG xoá logic nền để sau bật lại nhanh.
 */
const SHOW_SUBTITLE_TEMPLATE_UI = false
const SHOW_PINNED_TEMPLATE_UI = false
const SHOW_AI_NAMING_BUTTON = false

export function CapCutEffectsSettingsPanel({ onSettingsChange }: CapCutEffectsSettingsPanelProps) {
    // ---- State ----
    // Mặc định đóng để UI gọn, user tự mở khi cần custom.
    const [isExpanded, setIsExpanded] = useState(false)
    const [isScanning, setIsScanning] = useState(false)
    const [isNaming, setIsNaming] = useState(false)

    // Danh sách effects từ cache
    const [transitions, setTransitions] = useState<CachedEffect[]>([])
    const [videoEffects, setVideoEffects] = useState<CachedEffect[]>([])
    const [textTemplates, setTextTemplates] = useState<CachedEffect[]>([])
    const [pinnedTemplates, setPinnedTemplates] = useState<Array<{ effectId: string; displayName: string; savedAt: number }>>([])

    // Settings user đang chọn
    const [settings, setSettings] = useState<CapCutEffectsSettings>({
        transitionEffectId: '',
        videoEffectId: '',
        textTemplateEffectId: '',
        zoomEnabled: true,
        zoomLevel: 1.35,
        muteVideo: true,
        customNames: {},
    })

    // ---- Load settings + scan cache khi mount ----
    useEffect(() => {
        const init = async () => {
            // Load settings đã lưu
            const saved = await loadEffectsSettings()
            setSettings(saved)

            // Auto scan cache
            await doScan()
            await refreshPinnedTemplates()
        }
        init()
    }, [])

    /** Load danh sách template đã pin để hiển thị trong UI */
    const refreshPinnedTemplates = useCallback(async () => {
        const bundles = await loadPinnedSubtitleTemplateBundles()
        const list = Object.values(bundles)
            .sort((a, b) => b.savedAt - a.savedAt)
            .map(b => ({ effectId: b.effectId, displayName: b.displayName, savedAt: b.savedAt }))
        setPinnedTemplates(list)
    }, [])

    // ---- Notify parent khi settings thay đổi ----
    // Resolve effectId → full info (cachePath, duration, name) trước khi gửi lên parent
    useEffect(() => {
        // Resolve bất đồng bộ để có thể fallback sang bundle đã pin trong store khi draft nguồn đã bị xoá.
        const resolveAndNotify = async () => {
            const transitionEffect = transitions.find(e => e.effectId === settings.transitionEffectId)
            const videoEffect = videoEffects.find(e => e.effectId === settings.videoEffectId)
            let textTemplate = textTemplates.find(e => e.effectId === settings.textTemplateEffectId)

            // Nếu scan hiện tại không còn template đã chọn (ví dụ user xoá draft nguồn),
            // fallback sang bundle đã pin trước đó.
            if (!textTemplate && settings.textTemplateEffectId) {
                const pinnedBundles = await loadPinnedSubtitleTemplateBundles()
                const pinned = pinnedBundles[settings.textTemplateEffectId]
                if (pinned) {
                    textTemplate = {
                        effectId: pinned.effectId,
                        resourceId: pinned.effectId,
                        originalName: pinned.displayName,
                        displayName: pinned.displayName,
                        cachePath: '',
                        type: 'text_template',
                        rawJson: pinned.textTemplateRawJson,
                        textMaterialRawJson: pinned.textMaterialRawJson,
                        linkedMaterialAnimationsRawJson: pinned.linkedMaterialAnimationsRawJson,
                        linkedEffectsRawJson: pinned.linkedEffectsRawJson,
                    }
                }
            }

            // Auto-heal dữ liệu cũ:
            // Nếu template đã có raw template nhưng thiếu raw text material (bundle pin cũ),
            // force scan lại để lấy đủ dữ liệu style chuẩn (font/border/shadow/content).
            if (
                textTemplate &&
                settings.textTemplateEffectId &&
                textTemplate.rawJson &&
                (!textTemplate.textMaterialRawJson || !Array.isArray(textTemplate.linkedMaterialAnimationsRawJson))
            ) {
                try {
                    const refreshed = await scanCapCutCache(true)
                    setTransitions(refreshed.transitions)
                    setVideoEffects(refreshed.videoEffects)
                    setTextTemplates(refreshed.textTemplates)

                    const upgraded = refreshed.textTemplates.find(t => t.effectId === settings.textTemplateEffectId)
                    if (upgraded) {
                        textTemplate = upgraded
                        console.log('[CapCutEffects] ♻️ Auto-heal template bundle: đã bổ sung textMaterialRawJson cho', settings.textTemplateEffectId)
                    }
                } catch (err) {
                    console.warn('[CapCutEffects] ⚠️ Auto-heal scan lỗi:', err)
                }
            }

            // Nếu có template raw từ scan hiện tại, pin lại vào local store để lần sau không mất tham chiếu.
            if (textTemplate?.rawJson || textTemplate?.textMaterialRawJson) {
                await pinSubtitleTemplateBundle(textTemplate)
                await refreshPinnedTemplates()
            }

            // Gắn thêm resolved info vào settings trước khi notify
            const resolvedSettings: CapCutEffectsSettings = {
                ...settings,
                // @ts-ignore — truyền thêm resolved fields cho parent dùng
                _resolved: {
                    transitionCachePath: transitionEffect?.cachePath || '',
                    transitionDuration: transitionEffect?.defaultDuration || 466666,
                    videoEffectCachePath: videoEffect?.cachePath || '',
                    videoEffectName: videoEffect?.displayName || '',
                    textTemplateCachePath: textTemplate?.cachePath || '',
                    textTemplateName: textTemplate?.displayName || '',
                    textTemplateRawJson: textTemplate?.rawJson || undefined,
                    // Truyền kèm text material gốc của template để draft generator giữ style sát project thật.
                    textTemplateTextMaterialRawJson: textTemplate?.textMaterialRawJson || undefined,
                    // Truyền kèm danh sách material animations gốc mà template tham chiếu.
                    textTemplateLinkedMaterialAnimationsRawJson: textTemplate?.linkedMaterialAnimationsRawJson || undefined,
                    // Truyền kèm danh sách effects gốc mà template tham chiếu qua extra_material_refs.
                    textTemplateLinkedEffectsRawJson: textTemplate?.linkedEffectsRawJson || undefined,
                }
            }
            onSettingsChange?.(resolvedSettings)
        }
        resolveAndNotify()
    }, [settings, transitions, videoEffects, textTemplates, onSettingsChange, refreshPinnedTemplates])

    // Thông báo trạng thái scan cho user
    const [scanMessage, setScanMessage] = useState<string | undefined>()

    // ---- Scan cache ----
    const doScan = useCallback(async (forceRefresh = false) => {
        setIsScanning(true)
        setScanMessage(undefined)
        try {
            const result = await scanCapCutCache(forceRefresh)
            setTransitions(result.transitions)
            setVideoEffects(result.videoEffects)
            setTextTemplates(result.textTemplates)
            // Hiện thông báo nếu có issue
            if (result.scanMessage) setScanMessage(result.scanMessage)
            console.log('[CapCutEffects] ✅ Quét xong:', result.transitions.length, 'transitions,', result.videoEffects.length, 'effects,', result.textTemplates.length, 'templates')

            // ===== AUTO VIỆT HOÁ sau scan: chạy nếu có effects có tên chưa dịch =====
            if (result.scanStatus === 'ok') {
                const allNew = [...result.transitions, ...result.videoEffects, ...result.textTemplates]
                const needTranslate = allNew.filter(e =>
                    e.displayName === e.originalName &&
                    (/[一-鿿]/.test(e.originalName) || /^[a-zA-Z0-9_\s\-ⅡⅢⅣⅤ]+$/.test(e.originalName))
                )
                if (needTranslate.length > 0) {
                    console.log(`[CapCutEffects] 🤖 Auto Việt hoá ${needTranslate.length} effects...`)
                    // Background, không block UI
                    setIsNaming(true)
                    generateVietnameseNames(allNew).then(names => {
                        if (Object.keys(names).length > 0) {
                            saveCustomNames(names)
                            const updateList = (list: CachedEffect[]) =>
                                list.map(e => names[e.effectId] ? { ...e, displayName: names[e.effectId] } : e)
                            setTransitions(prev => updateList(prev))
                            setVideoEffects(prev => updateList(prev))
                            setTextTemplates(prev => updateList(prev))
                        }
                    }).finally(() => setIsNaming(false))
                }
            }
        } catch (err) {
            console.error('[CapCutEffects] ❌ Quét cache lỗi:', err)
            setScanMessage('Quét cache lỗi. Kiểm tra CapCut đã cài chưa.')
        } finally {
            setIsScanning(false)
        }
    }, [])

    // ---- AI naming ----
    const doAINaming = useCallback(async () => {
        // Gom tất cả effects cần đặt tên
        const allEffects = [...transitions, ...videoEffects, ...textTemplates]
        if (allEffects.length === 0) return

        setIsNaming(true)
        try {
            const names = await generateVietnameseNames(allEffects)
            if (Object.keys(names).length > 0) {
                // Lưu vào settings
                await saveCustomNames(names)

                // Cập nhật displayName trong state
                const updateList = (list: CachedEffect[]) =>
                    list.map(e => names[e.effectId] ? { ...e, displayName: names[e.effectId] } : e)

                setTransitions(prev => updateList(prev))
                setVideoEffects(prev => updateList(prev))
                setTextTemplates(prev => updateList(prev))
            }
        } catch (err) {
            console.error('[CapCutEffects] AI naming lỗi:', err)
        } finally {
            setIsNaming(false)
        }
    }, [transitions, videoEffects, textTemplates])

    // ---- Update settings + auto save ----
    const updateSettings = useCallback((patch: Partial<CapCutEffectsSettings>) => {
        setSettings(prev => {
            const next = { ...prev, ...patch }
            // Auto save (fire & forget)
            saveEffectsSettings(next)
            return next
        })
    }, [])

    // ---- Helper: tìm cache path + name cho effect đã chọn ----
    const findEffect = (id: string, list: CachedEffect[]) =>
        list.find(e => e.effectId === id)

    // ---- Render ----
    return (
        <div className="border rounded-lg bg-card/50 overflow-hidden">
            {/* Header — click để mở/đóng */}
            <button
                className="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/50 transition-colors"
                onClick={() => setIsExpanded(!isExpanded)}
            >
                <span className="text-xs font-medium flex items-center gap-1.5">
                    ⚙️ CapCut Effects
                </span>
                <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
            </button>

            {/* Content — chỉ hiện khi expanded */}
            {isExpanded && (
                <div className="px-3 pb-3 space-y-3 border-t pt-3">

                    {/* === Chuyển cảnh === */}
                    <EffectCombobox
                        label="Chuyển cảnh"
                        icon={<Clapperboard className="h-3 w-3" />}
                        effects={transitions}
                        selectedId={settings.transitionEffectId}
                        onSelect={(id) => {
                            const eff = findEffect(id, transitions)
                            updateSettings({
                                transitionEffectId: id,
                            })
                            // Log cho debug
                            if (eff) console.log('[CapCutEffects] Chọn transition:', eff.displayName)
                        }}
                    />

                    {/* === Khung hình (Video Effect) === */}
                    <EffectCombobox
                        label="Khung hình"
                        icon={<Frame className="h-3 w-3" />}
                        effects={videoEffects}
                        selectedId={settings.videoEffectId}
                        onSelect={(id) => {
                            updateSettings({ videoEffectId: id })
                        }}
                    />

                    {/* === Template phụ đề (đang ẩn theo cờ cấu hình) === */}
                    {SHOW_SUBTITLE_TEMPLATE_UI && (
                        <EffectCombobox
                            label="Template phụ đề"
                            icon={<Type className="h-3 w-3" />}
                            effects={textTemplates}
                            selectedId={settings.textTemplateEffectId}
                            onSelect={(id) => {
                                updateSettings({ textTemplateEffectId: id })
                            }}
                            showPreview={true}
                        />
                    )}

                    {/* === Template đã pin (đang ẩn theo cờ cấu hình) === */}
                    {SHOW_PINNED_TEMPLATE_UI && (
                        <div className="space-y-1.5 rounded-md border border-dashed border-muted-foreground/30 p-2">
                            <div className="flex items-center justify-between">
                                <span className="text-[11px] font-medium text-muted-foreground">
                                    Template đã pin ({pinnedTemplates.length})
                                </span>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-2 text-[10px]"
                                    onClick={refreshPinnedTemplates}
                                >
                                    Làm mới
                                </Button>
                            </div>
                            {pinnedTemplates.length === 0 ? (
                                <div className="text-[10px] text-muted-foreground">
                                    Chưa có template pin. Chọn 1 template phụ đề để app tự pin.
                                </div>
                            ) : (
                                <div className="space-y-1 max-h-36 overflow-auto pr-1">
                                    {pinnedTemplates.map((tpl) => {
                                        const isActive = settings.textTemplateEffectId === tpl.effectId
                                        return (
                                            <div
                                                key={tpl.effectId}
                                                className={`flex items-center gap-1.5 rounded border px-1.5 py-1 ${isActive ? 'border-primary/50 bg-primary/10' : 'border-border'}`}
                                            >
                                                <div className="min-w-0 flex-1">
                                                    <div className="truncate text-[10px] font-medium" title={tpl.displayName}>
                                                        {tpl.displayName}
                                                    </div>
                                                    <div className="truncate text-[9px] text-muted-foreground font-mono" title={tpl.effectId}>
                                                        {tpl.effectId}
                                                    </div>
                                                </div>
                                                <Button
                                                    variant={isActive ? 'default' : 'outline'}
                                                    size="sm"
                                                    className="h-6 px-2 text-[10px]"
                                                    onClick={() => updateSettings({ textTemplateEffectId: tpl.effectId })}
                                                    title="Dùng làm template hiện tại"
                                                >
                                                    {isActive ? 'Đang dùng' : 'Dùng'}
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                                                    onClick={async () => {
                                                        await removePinnedSubtitleTemplateBundle(tpl.effectId)
                                                        // Nếu đang dùng đúng template vừa xoá pin, reset selection để tránh trỏ tới bundle không còn.
                                                        if (settings.textTemplateEffectId === tpl.effectId) {
                                                            updateSettings({ textTemplateEffectId: '' })
                                                        }
                                                        await refreshPinnedTemplates()
                                                    }}
                                                    title="Xoá pin template"
                                                >
                                                    <Trash2 className="h-3 w-3" />
                                                </Button>
                                            </div>
                                        )
                                    })}
                                </div>
                            )}
                        </div>
                    )}

                    {/* === Zoom in (Ken Burns) === */}
                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                                <ZoomIn className="h-3 w-3" />
                                Zoom in
                            </label>
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] text-muted-foreground">
                                    {Math.round(settings.zoomLevel * 100)}%
                                </span>
                                <Switch
                                    checked={settings.zoomEnabled}
                                    onCheckedChange={(checked) => updateSettings({ zoomEnabled: checked })}
                                    className="scale-75"
                                />
                            </div>
                        </div>
                        {/* Slider chỉ hiện khi zoom bật */}
                        {settings.zoomEnabled && (
                            <Slider
                                value={[settings.zoomLevel * 100]}
                                min={110}
                                max={150}
                                // Cho phép chỉnh mịn từng 1% thay vì nhảy 5%.
                                step={1}
                                onValueChange={([val]) => updateSettings({ zoomLevel: val / 100 })}
                                className="py-1"
                            />
                        )}
                    </div>

                    {/* === Mute Video === */}
                    <div className="flex items-center justify-between">
                        <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                            <VolumeX className="h-3 w-3" />
                            Tắt tiếng video/footage
                        </label>
                        <Switch
                            checked={settings.muteVideo}
                            onCheckedChange={(checked) => updateSettings({ muteVideo: checked })}
                            className="scale-75"
                        />
                    </div>

                    {/* === Action buttons === */}
                    <div className="flex items-center gap-2 pt-1 border-t">
                        {/* Quét lại cache */}
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-[10px] gap-1"
                            onClick={() => doScan(true)}
                            disabled={isScanning}
                        >
                            {isScanning ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                                <RefreshCw className="h-3 w-3" />
                            )}
                            Quét cache
                        </Button>

                        {/* AI đặt tên Việt (đang ẩn theo cờ cấu hình) */}
                        {SHOW_AI_NAMING_BUTTON && (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-[10px] gap-1"
                                onClick={doAINaming}
                                disabled={isNaming || (transitions.length + videoEffects.length + textTemplates.length === 0)}
                            >
                                {isNaming ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                    <span>🤖</span>
                                )}
                                Việt hoá tên
                            </Button>
                        )}

                        {/* Hiện số effects tìm được */}
                        <span className="text-[9px] text-muted-foreground ml-auto">
                            {transitions.length + videoEffects.length + textTemplates.length} effects
                        </span>
                    </div>

                    {/* Thông báo trạng thái scan (CapCut chưa cài, 0 effects...) */}
                    {scanMessage && (
                        <p className="text-[10px] text-amber-400/80 leading-tight px-1">
                            ⚠️ {scanMessage}
                        </p>
                    )}
                </div>
            )}
        </div>
    )
}
