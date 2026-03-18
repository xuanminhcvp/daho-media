// right-panel-tabs.tsx
// Component chứa tabs chuyển đổi giữa Subtitle Viewer, Media Import, Image Import, Voice Pacing, và Hậu Kỳ
// Được sử dụng ở panel bên phải trong layout desktop
// Tích hợp Session Manager: auto-save mỗi 5 phút, Ctrl+S lưu session, khôi phục session

import * as React from "react"
import { FileVideo, Subtitles, Mic, Music, Image as ImageIcon, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
    HoverCard,
    HoverCardContent,
    HoverCardTrigger,
} from "@/components/ui/hover-card"
import { TranscriptionWorkspace } from "@/pages/transcription-workspace"
import { MediaImportPanel } from "@/components/media/media-import-panel"
import { ImageImportPanel } from "@/components/media/image-import-panel"
import { VoicePacingPanel } from "@/components/voice/voice-pacing-panel"
import { PostProductionPanel } from "@/components/postprod/post-production-panel"
import { DebugPanel } from "@/components/debug/debug-panel"
import { useSessionManager } from "@/hooks/useSessionManager"
import { SessionManagerDialog } from "@/components/dialogs/session-manager-dialog"
import { useProject } from "@/contexts/ProjectContext"
import { useTranscript } from "@/contexts/TranscriptContext"

// Các tab có sẵn trong panel bên phải
type RightPanelTab = "subtitles" | "media-import" | "image-import" | "voice-pacing" | "post-production"

// ======================== LIVE DATA SUMMARY ========================
// Hiển thị tổng quan dữ liệu hiện đang có trong app (lấy từ context live)
// Dùng khi hover vào indicator session trên thanh tab

interface LiveDataSummaryProps {
    sessionName: string;
    saveType: 'auto' | 'manual';
    updatedAt: number;
}

/** Một dòng dữ liệu trong bảng tổng quan */
interface DataLine {
    icon: string;       // Emoji icon
    label: string;      // Tên phần dữ liệu
    hasData: boolean;   // Có dữ liệu hay không
    detail: string;     // Chi tiết (số lượng, tên file...)
}

function LiveDataSummary({ sessionName, saveType, updatedAt }: LiveDataSummaryProps) {
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

        // 6. Media Import
        const mi = project.mediaImport
        const miMatched = mi?.matchedSentences?.length || 0
        lines.push({
            icon: '🎬', label: 'Media Import',
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
                    {saveType === 'auto' ? '🔄 Auto-save' : '💾 Manual save'}
                    {' • '}
                    {new Date(updatedAt).toLocaleString('vi-VN')}
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
                        className={`flex items-center gap-2 px-2.5 py-1.5 text-[11px] ${
                            line.hasData ? 'bg-card' : 'bg-card/50'
                        }`}
                    >
                        {/* Chấm xanh/xám */}
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                            line.hasData ? 'bg-green-500' : 'bg-muted-foreground/30'
                        }`} />
                        {/* Icon + Label */}
                        <span className={`w-[110px] shrink-0 ${
                            line.hasData ? 'text-foreground' : 'text-muted-foreground'
                        }`}>
                            {line.icon} {line.label}
                        </span>
                        {/* Detail */}
                        <span className={`flex-1 text-right truncate ${
                            line.hasData ? 'text-foreground font-medium' : 'text-muted-foreground/60 italic'
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
    const [activeTab, setActiveTab] = React.useState<RightPanelTab>("subtitles")

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

    return (
        <div className="flex flex-col h-full min-w-0">
            {/* Tab bar - thanh chuyển tab ở trên cùng */}
            <div className="shrink-0 flex items-center gap-1 px-3 pt-2 pb-1 border-b bg-card/50">
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

                {/* Tab Media Import */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={activeTab === "media-import" ? "secondary" : "ghost"}
                            size="sm"
                            className="h-8 px-3 gap-1.5 text-xs"
                            onClick={() => setActiveTab("media-import")}
                        >
                            <FileVideo className="h-3.5 w-3.5" />
                            Media Import
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

                {/* Spacer đẩy indicator session sang phải */}
                <div className="flex-1" />

                {/* === Indicator session đang active + nút mở dialog === */}
                <div className="flex items-center gap-1.5 min-w-0">
                    {/* Hiển thị tên session đang active */}
                    {sessionManager.currentSession ? (
                        <HoverCard openDelay={300}>
                            <HoverCardTrigger asChild>
                                <button
                                    className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs bg-muted/60 hover:bg-muted transition-colors min-w-0 max-w-[220px] border border-border/50"
                                    onClick={() => setSessionDialogOpen(true)}
                                >
                                    {/* Dot xanh = đang active */}
                                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />

                                    {/* Tên session (truncate nếu dài) */}
                                    <span className="truncate text-foreground/80">
                                        {sessionManager.currentSession.name}
                                    </span>

                                    {/* Badge loại save */}
                                    <span className={`shrink-0 text-[9px] px-1 py-px rounded font-medium uppercase tracking-wider
                                        ${sessionManager.currentSession.saveType === 'auto'
                                            ? 'bg-blue-500/15 text-blue-500'
                                            : 'bg-green-500/15 text-green-500'
                                        }`}
                                    >
                                        {sessionManager.currentSession.saveType === 'auto' ? 'A' : 'M'}
                                    </span>
                                </button>
                            </HoverCardTrigger>
                            <HoverCardContent side="bottom" align="end" className="w-[320px] p-0">
                                <LiveDataSummary
                                    sessionName={sessionManager.currentSession.name}
                                    saveType={sessionManager.currentSession.saveType}
                                    updatedAt={sessionManager.currentSession.updatedAt}
                                />
                            </HoverCardContent>
                        </HoverCard>
                    ) : (
                        /* Chưa có session nào */
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs text-muted-foreground hover:bg-muted transition-colors border border-dashed border-border/50"
                                    onClick={() => setSessionDialogOpen(true)}
                                >
                                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 shrink-0" />
                                    <span>Chưa lưu</span>
                                </button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom">
                                Bấm Ctrl+S để lưu session đầu tiên
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
                {activeTab === "subtitles" && <TranscriptionWorkspace />}
                {activeTab === "media-import" && <MediaImportPanel />}
                {activeTab === "image-import" && <ImageImportPanel />}
                {activeTab === "voice-pacing" && <VoicePacingPanel />}
                {activeTab === "post-production" && <PostProductionPanel />}
            </div>
            {/* Debug Panel — nổi ở góc dưới phải */}
            <DebugPanel />

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
                onSaveManual={sessionManager.saveManualSession}
                onRestore={sessionManager.restoreSession}
                onDelete={sessionManager.removeSession}
                onRename={sessionManager.renameSessionById}
                onRefresh={sessionManager.refreshSessions}
            />
        </div>
    )
}
