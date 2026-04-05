// right-panel-tabs.tsx
// Component chứa tabs chuyển đổi giữa Subtitle Viewer, Media Import, Image Import, Voice Pacing, và Hậu Kỳ
// Được sử dụng ở panel bên phải trong layout desktop
// Tích hợp Session Manager: auto-save mỗi 5 phút, Ctrl+S lưu session, khôi phục session

import * as React from "react"
import { FileVideo, Subtitles, Mic, Music, Image as ImageIcon, Save, Bot, PenLine, Network, Rocket } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
    HoverCard,
    HoverCardContent,
    HoverCardTrigger,
} from "@/components/ui/hover-card"
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { TranscriptionWorkspace } from "@/pages/transcription-workspace"
import { MediaImportPanel } from "@/components/media/media-import-panel"
import { ImageImportPanel } from "@/components/media/image-import-panel"
import { VoicePacingPanel } from "@/components/voice/voice-pacing-panel"
import { PostProductionPanel } from "@/components/postprod/post-production-panel"
import { AutoMediaPanel } from "@/components/postprod/auto-media-panel"
import { MasterSrtTab } from "@/components/postprod/master-srt-tab"
import { GeminiScanPanel } from "@/components/gemini-scan/GeminiScanPanel"
import GeminiManualScanPanel from "@/components/gemini-scan/GeminiManualScanPanel"
import { CapcutJsonAnalyzer } from "@/components/debug/capcut-tree-viewer"
// DebugPanel cũ đã được thay bằng BugReporterPanel floating (góc dưới phải)
// import { DebugPanel } from "@/components/debug/debug-panel"
import { useSessionManager } from "@/hooks/useSessionManager"
import { SessionManagerDialog } from "@/components/dialogs/session-manager-dialog"
import { useProject } from "@/contexts/ProjectContext"
import { useTranscript } from "@/contexts/TranscriptContext"

// Các tab có sẵn trong panel bên phải
type RightPanelTab = "auto-media" | "subtitles" | "master-srt" | "media-import" | "image-import" | "voice-pacing" | "post-production" | "gemini-scan" | "manual-scan" | "capcut-analyzer"

/**
 * Cờ bật/tắt tab Nội soi CapCut.
 * false: ẩn tab khỏi UI (giữ nguyên code để có thể bật lại sau).
 * true: hiện lại tab bình thường.
 */
const SHOW_CAPCUT_ANALYZER_TAB = false

// ======================== LIVE DATA SUMMARY ========================
// Hiển thị tổng quan dữ liệu hiện đang có trong app (lấy từ context live)
// Dùng khi hover vào indicator session trên thanh tab

interface LiveDataSummaryProps {
    sessionName: string;
    updatedAt: number;
}

/** Một dòng dữ liệu trong bảng tổng quan */
interface DataLine {
    icon: string;       // Emoji icon
    label: string;      // Tên phần dữ liệu
    hasData: boolean;   // Có dữ liệu hay không
    detail: string;     // Chi tiết (số lượng, tên file...)
}

function LiveDataSummary({ sessionName, updatedAt }: LiveDataSummaryProps) {
    // Lấy dữ liệu live từ contexts
    const { project } = useProject()
    const { subtitles, speakers } = useTranscript()

    // Phân tích dữ liệu hiện tại → tạo danh sách dòng
    const dataLines: DataLine[] = React.useMemo(() => {
        const lines: DataLine[] = []

        // 1. Subtitles
        const subCount = subtitles?.length || 0
        lines.push({
            icon: '📝', label: 'Subtitles',
            hasData: subCount > 0,
            detail: subCount > 0 ? `${subCount} câu` : 'Chưa có',
        })

        // 1b. Master SRT
        const msrtCount = project.masterSrt?.length || 0
        lines.push({
            icon: '🎯', label: 'Master SRT',
            hasData: msrtCount > 0,
            detail: msrtCount > 0
                ? `${msrtCount} từ${project.masterSrtCreatedAt ? ' • ' + new Date(project.masterSrtCreatedAt).toLocaleTimeString('vi-VN') : ''}`
                : 'Chưa có',
        })

        // 2. Speakers
        const speakerCount = speakers?.length || 0
        lines.push({
            icon: '👤', label: 'Speakers',
            hasData: speakerCount > 0,
            detail: speakerCount > 0 ? `${speakerCount} speakers` : 'Chưa có',
        })

        // 3. Script text
        const scriptLen = project.scriptText?.trim()?.length || 0
        const scriptLines = scriptLen > 0 ? project.scriptText.split('\n').filter((l: string) => l.trim()).length : 0
        lines.push({
            icon: '📄', label: 'Script',
            hasData: scriptLen > 0,
            detail: scriptLen > 0 ? `${scriptLines} dòng` : 'Chưa có',
        })

        // 4. Matching sentences (shared)
        const matchCount = project.matchingSentences?.length || 0
        lines.push({
            icon: '🔗', label: 'Matching',
            hasData: matchCount > 0,
            detail: matchCount > 0
                ? `${matchCount} câu | ${project.matchingFolder?.split?.(/[/\\]/)?.pop?.() || '—'}`
                : 'Chưa có',
        })

        // 6. Video Import
        const mi = project.mediaImport
        const miMatched = mi?.matchedSentences?.length || 0
        lines.push({
            icon: '🎬', label: 'Video Import',
            hasData: miMatched > 0,
            detail: miMatched > 0 ? `${miMatched} câu | ${mi?.mediaFiles?.length || 0} files` : 'Chưa có',
        })

        // 7. Image Import
        const ii = project.imageImport
        const iiFiles = ii?.imageFiles?.length || 0
        const iiMatched = ii?.matchResults?.filter?.((r: any) => r.quality === 'matched')?.length || 0
        lines.push({
            icon: '🖼️', label: 'Image Import',
            hasData: iiFiles > 0,
            detail: iiFiles > 0 ? `${iiFiles} ảnh | ${iiMatched} matched` : 'Chưa có',
        })

        // 8. Music Library
        const ml = project.musicLibrary
        const mlTracks = ml?.musicItems?.length || 0
        lines.push({
            icon: '🎵', label: 'Music Library',
            hasData: mlTracks > 0 || !!ml?.directorResult,
            detail: mlTracks > 0
                ? `${mlTracks} tracks${ml?.directorResult ? ' | AI ✓' : ''}`
                : ml?.directorResult ? 'Có AI Director' : 'Chưa có',
        })

        // 9. SFX Library
        const sfx = project.sfxLibrary
        const sfxCount = sfx?.sfxItems?.length || 0
        lines.push({
            icon: '🔊', label: 'SFX Library',
            hasData: sfxCount > 0 || !!sfx?.sfxPlan,
            detail: sfxCount > 0
                ? `${sfxCount} items${sfx?.sfxPlan ? ' | AI ✓' : ''}`
                : sfx?.sfxPlan ? 'Có kế hoạch AI' : 'Chưa có',
        })

        // 10. Highlight Text
        const ht = project.highlightText
        lines.push({
            icon: '✨', label: 'Highlight Text',
            hasData: !!ht?.highlightPlan,
            detail: ht?.highlightPlan ? 'Có kế hoạch' : 'Chưa có',
        })

        // 11. Voice Pacing
        const vp = project.voicePacing
        const vpPause = vp?.pauseResults?.length || 0
        lines.push({
            icon: '🎤', label: 'Voice Pacing',
            hasData: vpPause > 0,
            detail: vpPause > 0 ? `${vpPause} pause results` : 'Chưa có',
        })

        // 12. Template Assignment
        const ta = project.templateAssignment
        const taCount = ta?.assignmentResult?.assignments?.length || 0
        lines.push({
            icon: '🏷️', label: 'Template',
            hasData: taCount > 0,
            detail: taCount > 0 ? `${taCount} câu đã gán` : 'Chưa có',
        })

        return lines
    }, [project, subtitles, speakers])

    // Đếm bao nhiêu phần có dữ liệu
    const hasDataCount = dataLines.filter(l => l.hasData).length

    return (
        <div className="p-3 space-y-2.5">
            {/* Header: tên session + thời gian */}
            <div className="space-y-0.5">
                <p className="text-sm font-semibold truncate">{sessionName}</p>
                <p className="text-[11px] text-muted-foreground">
                    💾 Session • {new Date(updatedAt).toLocaleString('vi-VN')}
                </p>
            </div>

            {/* Thanh tiến trình tổng quan */}
            <div className="space-y-1">
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>📦 Dữ liệu hiện có</span>
                    <span className="font-medium text-foreground">{hasDataCount}/{dataLines.length}</span>
                </div>
                <div className="flex h-1.5 rounded-full overflow-hidden bg-muted">
                    <div
                        className="bg-green-500 transition-all duration-300 rounded-full"
                        style={{ width: `${(hasDataCount / dataLines.length) * 100}%` }}
                    />
                </div>
            </div>

            {/* Bảng dữ liệu chi tiết */}
            <div className="grid grid-cols-1 gap-px bg-border rounded-md overflow-hidden">
                {dataLines.map((line, idx) => (
                    <div
                        key={idx}
                        className={`flex items-center gap-2 px-2.5 py-1.5 text-[11px] ${line.hasData ? 'bg-card' : 'bg-card/50'
                            }`}
                    >
                        {/* Chấm xanh/xám */}
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${line.hasData ? 'bg-green-500' : 'bg-muted-foreground/30'
                            }`} />
                        {/* Icon + Label */}
                        <span className={`w-[110px] shrink-0 ${line.hasData ? 'text-foreground' : 'text-muted-foreground'
                            }`}>
                            {line.icon} {line.label}
                        </span>
                        {/* Detail */}
                        <span className={`flex-1 text-right truncate ${line.hasData ? 'text-foreground font-medium' : 'text-muted-foreground/60 italic'
                            }`}>
                            {line.detail}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    )
}

export function RightPanelTabs() {
    // Mặc định mở app vào Auto Media để user thao tác ngay, không cần popup overlay.
    const [activeTab, setActiveTab] = React.useState<RightPanelTab>("auto-media")

    // === Session Manager: auto-save, Ctrl+S, restore ===
    const [sessionDialogOpen, setSessionDialogOpen] = React.useState(false)
    const sessionManager = useSessionManager({
        // Callback để restore active tab từ session
        setActiveTab: (tab) => setActiveTab(tab as RightPanelTab),
    })

    // Mở dialog bằng Ctrl+Shift+S
    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') {
                e.preventDefault()
                setSessionDialogOpen(true)
            }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [])

    // === Session Name Prompt: hiện khi Ctrl+S lần đầu ===
    const [sessionNameInput, setSessionNameInput] = React.useState('')

    // Khi hook yêu cầu đặt tên → mở prompt
    React.useEffect(() => {
        if (sessionManager.needsNameInput) {
            setSessionNameInput('') // Reset input mỗi lần mở
        }
    }, [sessionManager.needsNameInput])

    /**
     * Fallback an toàn:
     * Nếu session cũ từng lưu activeTab = "capcut-analyzer" nhưng hiện đang ẩn tab này,
     * tự chuyển về "subtitles" để tránh UI rơi vào trạng thái không có content.
     */
    React.useEffect(() => {
        if (!SHOW_CAPCUT_ANALYZER_TAB && activeTab === "capcut-analyzer") {
            setActiveTab("subtitles")
        }
    }, [activeTab])

    // Cho phép Titlebar bắn event để chuyển nhanh về tab Auto Media.
    React.useEffect(() => {
        const handleOpenAutoMedia = () => setActiveTab("auto-media")
        window.addEventListener("autosubs:open-auto-media", handleOpenAutoMedia)
        return () => window.removeEventListener("autosubs:open-auto-media", handleOpenAutoMedia)
    }, [])

    // Xử lý submit tên session
    const handleCreateSession = async () => {
        if (sessionNameInput.trim()) {
            await sessionManager.createNamedSession(sessionNameInput.trim())
        }
    }

    return (
        <div className="flex flex-col h-full min-w-0">
            {/* Tab bar - thanh chuyển tab ở trên cùng */}
            <div className="shrink-0 flex items-center gap-1 px-3 pt-2 pb-1 border-b bg-card/50">
                {/* Tab Auto Media */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={activeTab === "auto-media" ? "default" : "ghost"}
                            size="sm"
                            className="h-8 px-3 gap-1.5 text-xs"
                            onClick={() => setActiveTab("auto-media")}
                        >
                            <Rocket className="h-3.5 w-3.5" />
                            Auto Media
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Màn hình chính: chạy pipeline Auto Media</TooltipContent>
                </Tooltip>

                {/* Tab Subtitles */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={activeTab === "subtitles" ? "secondary" : "ghost"}
                            size="sm"
                            className="h-8 px-3 gap-1.5 text-xs"
                            onClick={() => setActiveTab("subtitles")}
                        >
                            <Subtitles className="h-3.5 w-3.5" />
                            Subtitles
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Xem và chỉnh sửa subtitle</TooltipContent>
                </Tooltip>

                {/* Tab Master SRT */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={activeTab === "master-srt" ? "secondary" : "ghost"}
                            size="sm"
                            className="h-8 px-3 gap-1.5 text-xs"
                            onClick={() => setActiveTab("master-srt")}
                        >
                            <Subtitles className="h-3.5 w-3.5" />
                            Master SRT
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">So khớp kịch bản → Whisper → Master SRT chuẩn</TooltipContent>
                </Tooltip>

                {/* Tab Video Import */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={activeTab === "media-import" ? "default" : "ghost"}
                            size="sm"
                            className="h-8 shadow-none border items-center justify-start gap-2 tabular-nums"
                            onClick={() => setActiveTab("media-import")}
                        >
                            <FileVideo className="h-3.5 w-3.5" />
                            Video Import
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Import video files vào timeline</TooltipContent>
                </Tooltip>

                {/* Tab Image Import */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={activeTab === "image-import" ? "secondary" : "ghost"}
                            size="sm"
                            className="h-8 px-3 gap-1.5 text-xs"
                            onClick={() => setActiveTab("image-import")}
                        >
                            <ImageIcon className="h-3.5 w-3.5" />
                            Image Import
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Import ảnh vào timeline — paste script + match Whisper</TooltipContent>
                </Tooltip>

                {/* Tab Voice Pacing — chỉnh nhịp voice */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={activeTab === "voice-pacing" ? "secondary" : "ghost"}
                            size="sm"
                            className="h-8 px-3 gap-1.5 text-xs"
                            onClick={() => setActiveTab("voice-pacing")}
                        >
                            <Mic className="h-3.5 w-3.5" />
                            Voice Pacing
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Chỉnh nhịp voice — thêm khoảng nghỉ giữa các câu</TooltipContent>
                </Tooltip>

                {/* Tab Hậu Kỳ — Post-Production (nhạc nền, SFX, ducking) */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={activeTab === "post-production" ? "secondary" : "ghost"}
                            size="sm"
                            className="h-8 px-3 gap-1.5 text-xs"
                            onClick={() => setActiveTab("post-production")}
                        >
                            <Music className="h-3.5 w-3.5" />
                            Hậu Kỳ
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Nhạc nền, SFX, auto ducking — AI tự động</TooltipContent>
                </Tooltip>

                {/* Tab Gemini Scan — scan ảnh/audio qua Gemini browser (không cần API key) */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={activeTab === "gemini-scan" ? "secondary" : "ghost"}
                            size="sm"
                            className="h-8 px-3 gap-1.5 text-xs"
                            onClick={() => setActiveTab("gemini-scan")}
                            style={activeTab === "gemini-scan" ? { color: '#a855f7' } : undefined}
                        >
                            <Bot className="h-3.5 w-3.5" />
                            Gemini Scan
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Scan ảnh/audio qua Gemini browser — không cần API key</TooltipContent>
                </Tooltip>

                {/* Tab Scan Thủ Công — tự upload Gemini, paste JSON về */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={activeTab === "manual-scan" ? "secondary" : "ghost"}
                            size="sm"
                            className="h-8 px-3 gap-1.5 text-xs"
                            onClick={() => setActiveTab("manual-scan")}
                            style={activeTab === "manual-scan" ? { color: '#fbbf24' } : undefined}
                        >
                            <PenLine className="h-3.5 w-3.5" />
                            Scan Thủ Công
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Tự upload lên Gemini → paste JSON về → lưu metadata</TooltipContent>
                </Tooltip>

                {/* Tab JSON Analyzer — soi CapCut (đang ẩn theo cờ cấu hình) */}
                {SHOW_CAPCUT_ANALYZER_TAB && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant={activeTab === "capcut-analyzer" ? "secondary" : "ghost"}
                                size="sm"
                                className="h-8 px-3 gap-1.5 text-xs text-blue-500 font-bold"
                                onClick={() => setActiveTab("capcut-analyzer")}
                            >
                                <Network className="h-3.5 w-3.5" />
                                Nội Soi CapCut Tree
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">Công cụ debug trực quan Database của CapCut Draft (JSON)</TooltipContent>
                    </Tooltip>
                )}

                {/* Spacer đẩy indicator session sang phải */}
                <div className="flex-1" />

                {/* === Indicator session đang active + nút mở dialog === */}
                <div className="flex items-center gap-1.5 min-w-0">
                    {/* Hiển thị tên session đang active */}
                    {sessionManager.currentSession ? (
                        <HoverCard openDelay={300}>
                            <HoverCardTrigger asChild>
                                <button
                                    className="group/sess flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs bg-muted/60 hover:bg-muted transition-all min-w-0 max-w-[260px] border border-border/50"
                                    onClick={() => setSessionDialogOpen(true)}
                                >
                                    {/* Dot xanh — pulse ngắn khi vừa save (trong 3 giây gần nhất) */}
                                    <span className={`w-1.5 h-1.5 rounded-full bg-green-500 shrink-0 transition-all ${sessionManager.lastSavedAt && (Date.now() - sessionManager.lastSavedAt < 3000)
                                            ? 'ring-2 ring-green-400/50 animate-pulse' : ''
                                        }`} />

                                    {/* Tên session (truncate nếu dài) */}
                                    <span className="truncate text-foreground/80 font-medium">
                                        {sessionManager.currentSession.name}
                                    </span>

                                    {/* Mini timestamp — hiện thời gian save cuối */}
                                    {sessionManager.lastSavedAt && (
                                        <span className="hidden group-hover/sess:inline shrink-0 text-[10px] text-muted-foreground">
                                            {(() => {
                                                const diff = Math.floor((Date.now() - sessionManager.lastSavedAt) / 60000)
                                                if (diff < 1) return '✓ vừa lưu'
                                                if (diff < 60) return `${diff}′ trước`
                                                return `${Math.floor(diff / 60)}h trước`
                                            })()}
                                        </span>
                                    )}
                                </button>
                            </HoverCardTrigger>
                            <HoverCardContent side="bottom" align="end" className="w-[320px] p-0">
                                <LiveDataSummary
                                    sessionName={sessionManager.currentSession.name}
                                    updatedAt={sessionManager.currentSession.updatedAt}
                                />
                            </HoverCardContent>
                        </HoverCard>
                    ) : (
                        /* Chưa có session nào — mời gọi rõ ràng hơn */
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 transition-colors border border-dashed border-amber-400/40"
                                    onClick={() => sessionManager.saveSession()}
                                >
                                    <Save className="h-3 w-3 shrink-0" />
                                    <span>Lưu session</span>
                                </button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom">
                                <p className="font-medium">Ctrl+S để lưu session</p>
                                <p className="text-muted-foreground text-[11px]">Đặt tên → auto-save mỗi 5 phút</p>
                            </TooltipContent>
                        </Tooltip>
                    )}

                    {/* Nút mở Session Manager Dialog */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                className="h-7 w-7 shrink-0"
                                onClick={() => setSessionDialogOpen(true)}
                            >
                                <Save className="h-3.5 w-3.5" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">
                            Quản lý sessions (Ctrl+Shift+S)
                        </TooltipContent>
                    </Tooltip>
                </div>
            </div>

            {/* Tab content */}
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                {activeTab === "auto-media" && (
                    <AutoMediaPanel mode="embedded" />
                )}
                {activeTab === "subtitles" && <TranscriptionWorkspace />}
                {activeTab === "master-srt" && <MasterSrtTab />}
                {activeTab === "media-import" && <MediaImportPanel />}
                {activeTab === "image-import" && <ImageImportPanel />}
                {activeTab === "voice-pacing" && <VoicePacingPanel />}
                {activeTab === "post-production" && <PostProductionPanel />}
                {/* Tab Gemini Scan (auto) */}
                {activeTab === "gemini-scan" && <GeminiScanPanel />}
                {/* Tab Scan Thủ Công — user tự upload Gemini, paste JSON */}
                {activeTab === "manual-scan" && (
                    <div style={{
                        height: '100%', overflowY: 'auto',
                        padding: '12px 16px',
                    }}>
                        <GeminiManualScanPanel />
                    </div>
                )}
                {/* Tab CapCut Analyzer (đang ẩn theo cờ cấu hình) */}
                {SHOW_CAPCUT_ANALYZER_TAB && activeTab === "capcut-analyzer" && <CapcutJsonAnalyzer />}
            </div>
            {/* Debug Panel cũ đã được tích hợp vào BugReporterPanel floating (App.tsx) */}
            {/* Bao gồm: tab Bugs, tab API (request/response), Insights, Timeline, Annotation Mode */}

            {/* Session Manager Dialog */}
            <SessionManagerDialog
                open={sessionDialogOpen}
                onOpenChange={setSessionDialogOpen}
                sessions={sessionManager.sessions}
                currentSessionId={sessionManager.currentSession?.id || null}
                isLoading={sessionManager.isLoading}
                lastSavedAt={sessionManager.lastSavedAt}
                autoSaveEnabled={sessionManager.autoSaveEnabled}
                onAutoSaveChange={sessionManager.setAutoSaveEnabled}
                onSave={sessionManager.saveSession}
                onRestore={sessionManager.restoreSession}
                onDelete={sessionManager.removeSession}
                onRename={sessionManager.renameSessionById}
                onRefresh={sessionManager.refreshSessions}
            />

            {/* === Prompt đặt tên session (hiện khi Ctrl+S lần đầu) === */}
            <Dialog
                open={sessionManager.needsNameInput}
                onOpenChange={(open) => {
                    if (!open) sessionManager.cancelNameInput()
                }}
            >
                <DialogContent className="sm:max-w-[420px]">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-base">
                            <div className="w-8 h-8 rounded-full bg-green-500/10 flex items-center justify-center">
                                <Save className="h-4 w-4 text-green-500" />
                            </div>
                            Lưu Session Làm Việc
                        </DialogTitle>
                        <DialogDescription className="text-[13px]">
                            Đặt tên cho session. Sau này <kbd className="px-1.5 py-0.5 rounded bg-muted text-[11px] font-mono border">⌘S</kbd> sẽ tự cập nhật lên session này.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-3 pt-1">
                        {/* Input chính */}
                        <Input
                            placeholder="Nhập tên session..."
                            value={sessionNameInput}
                            onChange={(e) => setSessionNameInput(e.target.value)}
                            autoFocus
                            className="h-10"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && sessionNameInput.trim()) {
                                    handleCreateSession()
                                }
                                if (e.key === 'Escape') {
                                    sessionManager.cancelNameInput()
                                }
                            }}
                        />

                        {/* Gợi ý tên nhanh — bấm chọn luôn */}
                        <div className="space-y-1.5">
                            <p className="text-[11px] text-muted-foreground font-medium">💡 Gợi ý nhanh:</p>
                            <div className="flex flex-wrap gap-1.5">
                                {[
                                    // Gợi ý dựa trên ngày
                                    `Session ${new Date().toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })}`,
                                    // Gợi ý chung
                                    'Documentary',
                                    'Phóng sự',
                                    'Review',
                                    'Tutorial',
                                ].map((suggestion) => (
                                    <button
                                        key={suggestion}
                                        className="px-2.5 py-1 rounded-full text-[11px] bg-muted hover:bg-accent border border-border/50 transition-colors"
                                        onClick={() => setSessionNameInput(suggestion)}
                                    >
                                        {suggestion}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Actions */}
                        <div className="flex justify-end gap-2 pt-1">
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => sessionManager.cancelNameInput()}
                            >
                                Hủy
                            </Button>
                            <Button
                                size="sm"
                                onClick={handleCreateSession}
                                disabled={!sessionNameInput.trim()}
                                className="gap-1.5 bg-green-600 hover:bg-green-700 text-white"
                            >
                                <Save className="h-3.5 w-3.5" />
                                Tạo & Lưu
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    )
}
