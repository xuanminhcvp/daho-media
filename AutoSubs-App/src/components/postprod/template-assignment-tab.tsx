// template-assignment-tab.tsx
// Tab Text On Screen — gán Template hiệu ứng chữ vào phim tài liệu
//
// Flow MỚI (đơn giản hơn):
//   1. Khi kết nối DaVinci → TỰ ĐỘNG đọc transcript hiện tại (timelineId.json)
//      → Không cần chọn file, không cần autosubs_matching.json
//   2. Bấm "AI Phân Tích" → AI đọc word timestamps → tìm ~22% cụm cần title
//   3. Xem kết quả → Áp dụng vào DaVinci Resolve

import * as React from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
    Sparkles,
    Loader2,
    FileText,
    ChevronDown,
    ChevronRight,
    Send,
    CheckCircle2,
    AudioLines,
    Save,
    RefreshCw,
    Clock,
} from "lucide-react"
import { open } from "@tauri-apps/plugin-dialog"
import { readTextFile } from "@tauri-apps/plugin-fs"
import { desktopDir } from "@tauri-apps/api/path"
import { useResolve } from "@/contexts/ResolveContext"
import { useProject } from "@/contexts/ProjectContext"
import { addTemplateSubtitlesToTimeline } from "@/api/resolve-api"
import { readTranscript, generateTranscriptFilename } from "@/utils/file-utils"
import { extractWhisperWords } from "@/utils/media-matcher"
import {
    TextTemplate,
    DEFAULT_TEMPLATES,
    loadTemplatesConfig,
    analyzeWhisperWordsForTitles,
} from "@/services/template-assignment-service"
import { CreateMatchingSection } from "@/components/common/create-matching-section"

// ======================== BADGE MÀU TEMPLATE ========================

/** Badge màu nhỏ hiển thị tên template */
function TemplateBadge({ template }: { template: TextTemplate }) {
    return (
        <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0"
            style={{
                backgroundColor: template.badgeColor + "30",
                color: template.badgeColor,
                border: `1px solid ${template.badgeColor}50`
            }}
        >
            {template.displayName}
        </span>
    )
}

// ======================== FORMAT THỜI GIAN ========================

/** Format giây → M:SS.s */
function formatTime(sec: number): string {
    const m = Math.floor(sec / 60)
    const s = (sec % 60).toFixed(1)
    return `${m}:${parseFloat(s) < 10 ? "0" : ""}${s}`
}

// ======================== MAIN COMPONENT ========================

export function TemplateAssignmentTab() {
    // ======================== CONTEXTS ========================
    const { timelineInfo } = useResolve()
    const { project, updateTemplateAssignment } = useProject()

    // Đã kết nối DaVinci nếu timelineInfo có dữ liệu
    const isConnected = !!(timelineInfo?.timelineId)

    const {
        whisperWordsPath = "",
        titleCueResult = null,
    } = project.templateAssignment || {}

    // ======================== LOCAL STATE ========================

    const [templates, setTemplates] = React.useState<TextTemplate[]>(DEFAULT_TEMPLATES)
    const [isAnalyzing, setIsAnalyzing] = React.useState(false)
    const [isApplying, setIsApplying] = React.useState(false)
    const [progress, setProgress] = React.useState<string>("")
    const [error, setError] = React.useState<string>("")
    const [showTemplateConfig, setShowTemplateConfig] = React.useState(false)
    // Transcript đã được auto-detect và load sẵn (không cần chọn file)
    const [autoTranscriptLoaded, setAutoTranscriptLoaded] = React.useState(false)
    // Cache nội dung whisper words text (từ auto hoặc file thủ công)
    const [wordsTextCache, setWordsTextCache] = React.useState<string>("")
    // Tên hiển thị nguồn dữ liệu
    const [sourceLabel, setSourceLabel] = React.useState<string>("")

    // ======================== EFFECTS ========================

    React.useEffect(() => {
        loadTemplatesConfig().then(setTemplates)
    }, [])

    // Khi kết nối DaVinci → auto-detect transcript
    React.useEffect(() => {
        if (isConnected) {
            autoLoadTranscript()
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isConnected])

    // ======================== HANDLERS ========================

    /**
     * Tự động đọc transcript từ DaVinci timeline hiện tại
     * File transcript nằm tại: ~/Desktop/Auto_media/data/transcripts/{timelineId}.json
     * Chứa originalSegments với word-level timestamps từ Whisper
     */
    const autoLoadTranscript = async () => {
        if (!timelineInfo?.timelineId) return
        try {
            setProgress("🔍 Đang tự động tìm transcript từ DaVinci...")

            // Đọc transcript file theo timelineId hiện tại
            const filename = generateTranscriptFilename(false, null, timelineInfo.timelineId)
            const transcript = await readTranscript(filename)

            if (!transcript) {
                setProgress("")
                return // Không tìm thấy → im lặng, user tự chọn file
            }

            // Trích xuất word-level data từ originalSegments
            const whisperWords = extractWhisperWords(transcript)
            if (whisperWords.length === 0) {
                setProgress("")
                return
            }

            // Format thành text "[time] word [time] word ..." để AI đọc
            const wordsText = whisperWords
                .map(w => `[${w.start.toFixed(2)}] ${w.rawWord}`)
                .join(" ")

            // Lưu vào cache
            setWordsTextCache(wordsText)
            setAutoTranscriptLoaded(true)
            setSourceLabel(`Auto: ${filename} (${whisperWords.length} words)`)

            // Lưu label vào context để persist sau khi đổi tab
            updateTemplateAssignment({
                whisperWordsPath: `[Auto] ${filename}`,
            })

            setProgress(`✅ Đã tìm thấy transcript: ${whisperWords.length} words`)
            setTimeout(() => setProgress(""), 2500)
        } catch (err) {
            console.warn("[AddTitle] Auto-load transcript thất bại:", err)
            setProgress("")
        }
    }

    /** Chọn file Whisper Words thủ công (.txt hoặc .json) */
    const handleSelectWhisperFile = async () => {
        const desktop = await desktopDir()
        const file = await open({
            title: "Chọn file Whisper Words (autosubs_whisper_words.txt / .json)",
            defaultPath: desktop,
            filters: [{ name: "Whisper Words", extensions: ["txt", "json"] }],
        })
        if (file) {
            const text = await readTextFile(file as string)
            setWordsTextCache(text)
            setAutoTranscriptLoaded(false)
            setSourceLabel(file as string)
            updateTemplateAssignment({
                whisperWordsPath: file as string,
                titleCueResult: null,
            })
            setError("")
        }
    }

    /** AI phân tích Master SRT → tìm Title cues */
    const handleAnalyze = async () => {
        // ⭐ BẮT BUỘC Master SRT — không fallback Whisper thô
        const masterSrt = project.masterSrt
        if (!masterSrt || masterSrt.length === 0) {
            setError(
                '⚠️ Bắt buộc phải có Master SRT!\n\n' +
                'Vui lòng vào tab "Master SRT" để tạo trước.\n' +
                'Master SRT chứa text chuẩn (khớp kịch bản) + timing chính xác từ Whisper.'
            )
            return
        }

        setIsAnalyzing(true)
        setError("")

        try {
            // ★ LUÔN dùng Master SRT — text chuẩn, timing chính xác
            const inputWordsText = masterSrt.map(w => `[${w.start.toFixed(2)}] ${w.word}`).join(" ")
            setProgress("🟢 Dùng Master SRT — text chuẩn, timing chính xác")
            console.log("[AddTitle] Dùng Master SRT:", masterSrt.length, "từ")

            setProgress("🟢 AI đang phân tích Master SRT → tìm Title cues...")

            const result = await analyzeWhisperWordsForTitles(
                inputWordsText,
                templates,
                inputWordsText, // Master SRT đã chuẩn → trùng
                (msg) => setProgress(msg)
            )
            updateTemplateAssignment({ titleCueResult: result })
            setProgress("")
        } catch (err: any) {
            setError(String(err))
            setProgress("")
        } finally {
            setIsAnalyzing(false)
        }
    }

    /** Áp dụng Title cues vào DaVinci Resolve */
    const handleApplyToResolve = async () => {
        if (!titleCueResult?.cues?.length) {
            setError("Chưa có Title cues. Hãy chạy AI phân tích trước.")
            return
        }

        setIsApplying(true)
        setError("")
        setProgress("Đang chuẩn bị clips...")

        try {
            // Track cố định V4 — Text Onscreen (không còn dropdown)
            const trackNum = 4

            const clipsToApply = titleCueResult.cues.map(cue => {
                const tpl = templates.find(t => t.id === cue.templateId)
                // resolveTemplateName giờ là tên Fusion Composition trong Power Bin
                const tplName = tpl?.resolveTemplateName || tpl?.displayName || "vàng to xuất hiện"
                // sfxName để Lua chọn đúng SFX
                const sfxName = tpl?.sfxName || ""
                return { start: cue.start, end: cue.end, text: cue.displayText, template: tplName, sfxName }
            })

            setProgress(`Đang thêm ${clipsToApply.length} Title clips vào Video Track ${trackNum}...`)
            await addTemplateSubtitlesToTimeline(clipsToApply, String(trackNum))
            setProgress(`✅ Đã thêm ${clipsToApply.length} Titles vào Video Track ${trackNum}!`)


        } catch (err: any) {
            setError(`Lỗi khi apply vào DaVinci: ${err}`)
            setProgress("")
        } finally {
            setIsApplying(false)
        }
    }

    // ======================== COMPUTED ========================

    const getCountByTemplate = (): Record<string, number> => {
        if (!titleCueResult?.cues) return {}
        return titleCueResult.cues.reduce((acc, cue) => {
            acc[cue.templateId] = (acc[cue.templateId] || 0) + 1
            return acc
        }, {} as Record<string, number>)
    }

    const counts = getCountByTemplate()
    const basename = (path: string) => path.split(/[/\\]/).pop() || path

    // ======================== RENDER ========================

    return (
        <ScrollArea className="flex-1 min-h-0 min-w-0 h-full w-full overflow-hidden">
            <div className="p-4 space-y-4 overflow-hidden">

                {/* ===== SECTION 0: Tạo matching.json (utility) ===== */}
                <CreateMatchingSection />

                {/* ===== SECTION 1: Trạng thái Whisper Words ===== */}
                <div className="space-y-2 border-t pt-3">
                    <label className="text-sm font-medium flex items-center gap-2">
                        <AudioLines className="h-4 w-4 text-blue-400" />
                        🎤 Whisper Words
                    </label>

                    {/* Badge Master SRT — ưu tiên hơn Whisper thô */}
                    {project.masterSrt?.length > 0 && (
                        <div className="flex items-center gap-2 p-2.5 rounded bg-green-500/10 border border-green-500/20">
                            <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0" />
                            <div className="flex-1 min-w-0">
                                <p className="text-xs text-green-400 font-medium">
                                    🟢 Dùng Master SRT — {project.masterSrt.length} từ (text chuẩn)
                                </p>
                                <p className="text-[10px] text-muted-foreground">
                                    AI Title sẽ dùng Master SRT thay Whisper thô → chính xác hơn
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Auto-loaded thành công từ DaVinci */}
                    {autoTranscriptLoaded ? (
                        <div className="flex items-center gap-2 p-2.5 rounded bg-green-500/10 border border-green-500/20">
                            <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0" />
                            <div className="flex-1 min-w-0">
                                <p className="text-xs text-green-400 font-medium">
                                    ✅ Tự động lấy từ DaVinci transcript
                                </p>
                                <p className="text-[10px] text-muted-foreground truncate" title={sourceLabel}>
                                    {sourceLabel}
                                </p>
                            </div>
                            <button
                                className="flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300 shrink-0 transition-colors"
                                onClick={autoLoadTranscript}
                                disabled={isAnalyzing}
                                title="Tải lại từ DaVinci"
                            >
                                <RefreshCw className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    ) : wordsTextCache ? (
                        /* File thủ công đã được chọn */
                        <div className="flex items-center gap-2 p-2.5 rounded bg-blue-500/10 border border-blue-500/20">
                            <FileText className="h-4 w-4 text-blue-400 shrink-0" />
                            <div className="flex-1 min-w-0">
                                <p className="text-xs text-blue-400 font-medium">File thủ công</p>
                                <p className="text-[10px] text-muted-foreground truncate">
                                    {basename(sourceLabel || whisperWordsPath)}
                                </p>
                            </div>
                        </div>
                    ) : (
                        /* Chưa có dữ liệu */
                        <div className="space-y-2">
                            <div className="flex items-center gap-2 p-2.5 rounded bg-amber-500/10 border border-amber-500/20">
                                <p className="text-xs text-amber-400">
                                    ⚠️ Kết nối DaVinci để tự động lấy transcript, hoặc chọn file thủ công.
                                </p>
                            </div>
                            <Button
                                variant="outline"
                                size="sm"
                                className="w-full gap-2 justify-start"
                                onClick={handleSelectWhisperFile}
                            >
                                <FileText className="h-3.5 w-3.5 text-blue-400" />
                                Chọn file Whisper Words thủ công...
                            </Button>
                        </div>
                    )}

                    {/* Luôn có nút chọn file thủ công (fallback) khi đã auto-load */}
                    {(autoTranscriptLoaded || wordsTextCache) && (
                        <button
                            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                            onClick={handleSelectWhisperFile}
                        >
                            Chọn file khác thủ công →
                        </button>
                    )}

                    {/* Progress auto-detect */}
                    {!isAnalyzing && progress && !progress.startsWith("✅ Đã thêm") && (
                        <p className="text-xs text-blue-400 animate-pulse">{progress}</p>
                    )}
                </div>

                {/* ===== SECTION 2: Nút AI Phân Tích ===== */}
                <div className="space-y-2">
                    {/* ⚠️ Cảnh báo khi chưa có Master SRT */}
                    {!(project.masterSrt?.length > 0) && (
                        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
                            <span className="text-amber-400 text-lg">⚠️</span>
                            <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium text-amber-400">
                                    Cần tạo Master SRT trước khi phân tích
                                </p>
                                <p className="text-[10px] text-muted-foreground">
                                    Vào tab &quot;Master SRT&quot; → tạo Master SRT từ Whisper + kịch bản
                                </p>
                            </div>
                        </div>
                    )}

                    <Button
                        className="w-full gap-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white border-0 shadow-md h-11"
                        onClick={handleAnalyze}
                        disabled={!(project.masterSrt?.length > 0) || isAnalyzing}
                    >
                        {isAnalyzing
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Sparkles className="h-4 w-4" />
                        }
                        {isAnalyzing ? "AI đang phân tích..." : "AI Phân Tích → Tìm Title Cues"}
                    </Button>

                    {/* Progress AI */}
                    {isAnalyzing && progress && (
                        <p className="text-xs text-purple-400 animate-pulse text-center leading-relaxed">
                            {progress}
                        </p>
                    )}

                    {/* Lỗi */}
                    {error && (
                        <div className="bg-red-500/10 border border-red-500/20 rounded p-2">
                            <p className="text-xs text-red-400 leading-relaxed whitespace-pre-wrap">❌ {error}</p>
                        </div>
                    )}
                </div>

                {/* ===== SECTION 3: Kết Quả AI ===== */}
                {titleCueResult && titleCueResult.cues.length > 0 && (
                    <div className="space-y-3 border-t pt-3">
                        {/* Header tổng kết */}
                        <div className="flex items-center gap-2 flex-wrap">
                            <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0" />
                            <span className="text-sm font-medium text-green-400">
                                {titleCueResult.cues.length} Title Cues
                            </span>
                            {templates.filter(t => t.enabled).map(tpl => {
                                const count = counts[tpl.id] || 0
                                if (count === 0) return null
                                return (
                                    <span
                                        key={tpl.id}
                                        className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                                        style={{ backgroundColor: tpl.badgeColor + "25", color: tpl.badgeColor }}
                                    >
                                        {tpl.displayName}: {count}
                                    </span>
                                )
                            })}
                        </div>

                        {/* Danh sách cues */}
                        <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
                            {titleCueResult.cues.map((cue, idx) => {
                                const tpl = templates.find(t => t.id === cue.templateId)
                                return (
                                    <div
                                        key={idx}
                                        className="flex items-start gap-2 p-2 rounded bg-muted/20 border border-border/40 hover:bg-muted/30 transition-colors"
                                    >
                                        {tpl && <TemplateBadge template={tpl} />}
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs font-semibold truncate" title={cue.displayText}>
                                                {cue.displayText}
                                            </p>
                                            <p className="text-[10px] text-muted-foreground truncate" title={cue.reason}>
                                                {cue.reason}
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-1 shrink-0 text-[10px] text-muted-foreground">
                                            <Clock className="h-3 w-3" />
                                            <span>{formatTime(cue.start)} – {formatTime(cue.end)}</span>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>

                        {/* Nút chạy lại */}
                        <Button
                            variant="outline"
                            size="sm"
                            className="w-full gap-2 text-xs"
                            onClick={handleAnalyze}
                            disabled={isAnalyzing}
                        >
                            <RefreshCw className="h-3.5 w-3.5" />
                            Chạy lại AI
                        </Button>
                    </div>
                )}

                {/* ===== SECTION 4: Apply vào DaVinci ===== */}
                {titleCueResult && titleCueResult.cues.length > 0 && (
                    <div className="space-y-3 border-t pt-3">
                        <label className="text-sm font-medium flex items-center gap-2">
                            <Send className="h-4 w-4 text-orange-400" />
                            Áp dụng vào DaVinci Resolve
                        </label>

                        {/* Track — cố định V4 (Text Onscreen) */}
                        <div className="space-y-1">
                            <div className="flex items-center gap-2">
                                <label className="text-xs text-muted-foreground shrink-0">Video Track:</label>
                            </div>
                            <div className="flex items-center gap-2 px-3 py-2 rounded-md border bg-muted/30 text-xs text-muted-foreground">
                                💬 Track V4 — Text Onscreen (cố định)
                            </div>
                            <p className="text-[10px] text-muted-foreground pl-1">
                                Titles sẽ được thêm vào Video Track 4 + Adjustment Layer tự tạo ở V3
                            </p>
                        </div>

                        {!isConnected && (
                            <p className="text-xs text-amber-400">
                                ⚠️ Chưa kết nối DaVinci Resolve. Mở DaVinci và bật AutoSubs script.
                            </p>
                        )}

                        <Button
                            className="w-full gap-2 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white border-0 shadow-md h-11"
                            onClick={handleApplyToResolve}
                            disabled={!isConnected || isApplying || !titleCueResult?.cues?.length}
                        >
                            {isApplying
                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                : <Send className="h-4 w-4" />
                            }
                            {isApplying
                                ? "Đang thêm vào DaVinci..."
                                : `Thêm ${titleCueResult.cues.length} Titles vào Track V4`
                            }
                        </Button>

                        {!isApplying && progress.startsWith("✅ Đã thêm") && (
                            <p className="text-xs text-green-400 text-center">{progress}</p>
                        )}

                        {isApplying && progress && (
                            <p className="text-xs text-orange-400 animate-pulse text-center">{progress}</p>
                        )}
                    </div>
                )}

                {/* ===== SECTION 5: Cấu hình Templates ===== */}
                <div className="border-t pt-3 space-y-2">
                    <button
                        className="w-full flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => setShowTemplateConfig(!showTemplateConfig)}
                    >
                        <Save className="h-3.5 w-3.5" />
                        <span className="flex-1 text-left">
                            Cấu hình Template DaVinci ({templates.filter(t => t.enabled).length} đang bật)
                        </span>
                        {showTemplateConfig
                            ? <ChevronDown className="h-3.5 w-3.5" />
                            : <ChevronRight className="h-3.5 w-3.5" />
                        }
                    </button>

                    {showTemplateConfig && (
                        <div className="space-y-2">
                            <p className="text-[10px] text-muted-foreground">
                                Tên template trong DaVinci Media Pool. AI chọn đúng template tương ứng.
                            </p>
                            {templates.map(tpl => (
                                <div
                                    key={tpl.id}
                                    className="flex items-center gap-2 p-2 rounded border border-border/40 bg-muted/10"
                                >
                                    <button
                                        className={`w-7 h-4 rounded-full transition-colors relative shrink-0 ${tpl.enabled ? "bg-green-500" : "bg-muted"}`}
                                        onClick={() => {
                                            setTemplates(prev => prev.map(t =>
                                                t.id === tpl.id ? { ...t, enabled: !t.enabled } : t
                                            ))
                                        }}
                                    >
                                        <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${tpl.enabled ? "left-3.5" : "left-0.5"}`} />
                                    </button>
                                    <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: tpl.badgeColor }} />
                                    <span className="text-xs font-medium flex-1 truncate">{tpl.displayName}</span>
                                    <input
                                        type="text"
                                        className="text-xs bg-background border border-input rounded px-2 py-0.5 w-24 h-6"
                                        value={tpl.resolveTemplateName}
                                        placeholder="Title 1"
                                        onChange={e => {
                                            setTemplates(prev => prev.map(t =>
                                                t.id === tpl.id ? { ...t, resolveTemplateName: e.target.value } : t
                                            ))
                                        }}
                                    />
                                </div>
                            ))}
                        </div>
                    )}
                </div>

            </div>
        </ScrollArea>
    )
}
