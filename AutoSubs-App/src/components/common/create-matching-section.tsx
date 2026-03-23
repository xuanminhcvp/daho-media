// create-matching-section.tsx
// Section UI độc lập để tạo autosubs_matching.json
// Người dùng chọn:
//   1. File kịch bản đã đánh số (.txt)  — format: "1. Câu đầu tiên..."
//   2. File Whisper transcript (.json)   — từ tab Subtitles
//   3. Thư mục output                   — nơi lưu autosubs_matching.json
// Sau đó bấm nút → AI Match Pipeline chạy → tạo file hoàn chỉnh

import * as React from "react"
import { Button } from "@/components/ui/button"
import {
    FileText,
    FolderOpen,
    Sparkles,
    Loader2,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    Cpu,
} from "lucide-react"
import { open } from "@tauri-apps/plugin-dialog"
import { desktopDir } from "@tauri-apps/api/path"
import { readTextFile } from "@tauri-apps/plugin-fs"
import { parseScript } from "@/utils/media-matcher"
import { aiMatchScriptToTimeline } from "@/services/ai-matcher"

// ======================== COMPONENT ========================

export function CreateMatchingSection() {
    // ======================== LOCAL STATE ========================

    // File kịch bản đánh số (.txt)
    const [scriptFilePath, setScriptFilePath] = React.useState<string>("")
    // File Whisper transcript (.json) — từ tab Subtitles
    const [transcriptFilePath, setTranscriptFilePath] = React.useState<string>("")
    // Thư mục output — nơi lưu autosubs_matching.json
    const [outputFolder, setOutputFolder] = React.useState<string>("")

    // Trạng thái UI
    const [isRunning, setIsRunning] = React.useState(false)
    const [progress, setProgress] = React.useState<string>("")
    const [error, setError] = React.useState<string>("")
    const [successMsg, setSuccessMsg] = React.useState<string>("")
    const [expanded, setExpanded] = React.useState(false)

    // ======================== HANDLERS ========================

    /** Chọn file kịch bản (.txt có đánh số) */
    const handleSelectScript = async () => {
        const desktop = await desktopDir()
        const file = await open({
            title: "Chọn file kịch bản đã đánh số câu (.txt)",
            defaultPath: desktop,
            filters: [{ name: "Script Text", extensions: ["txt"] }],
        })
        if (file) setScriptFilePath(file as string)
    }

    /** Chọn file Whisper transcript (.json) — từ tab Subtitles */
    const handleSelectTranscript = async () => {
        const desktop = await desktopDir()
        const file = await open({
            title: "Chọn file Whisper transcript (.json) — từ tab Subtitles",
            defaultPath: desktop,
            filters: [{ name: "Whisper Transcript", extensions: ["json"] }],
        })
        if (file) setTranscriptFilePath(file as string)
    }

    /** Chọn thư mục output — nơi lưu autosubs_matching.json */
    const handleSelectOutput = async () => {
        const desktop = await desktopDir()
        const folder = await open({
            directory: true,
            title: "Chọn thư mục lưu autosubs_matching.json",
            defaultPath: desktop,
        })
        if (folder) setOutputFolder(folder as string)
    }

    /** Bấm nút Tạo → chạy AI Match Pipeline */
    const handleCreate = async () => {
        // Validate đủ 3 input
        if (!scriptFilePath) {
            setError("Vui lòng chọn file kịch bản (.txt)")
            return
        }
        if (!transcriptFilePath) {
            setError("Vui lòng chọn file Whisper transcript (.json)")
            return
        }
        if (!outputFolder) {
            setError("Vui lòng chọn thư mục output")
            return
        }

        setIsRunning(true)
        setError("")
        setSuccessMsg("")
        setProgress("Đang đọc file kịch bản...")

        try {
            // Bước 1: Đọc và parse file kịch bản
            const scriptText = await readTextFile(scriptFilePath)
            const scriptSentences = parseScript(scriptText)

            if (scriptSentences.length === 0) {
                throw new Error(
                    "Không parse được câu nào từ file kịch bản.\n" +
                    "Format hợp lệ: mỗi dòng bắt đầu bằng số thứ tự, ví dụ:\n" +
                    "  1. Câu đầu tiên.\n  2. Câu thứ hai."
                )
            }

            setProgress(`✅ Đã đọc ${scriptSentences.length} câu từ kịch bản`)

            // Bước 2: Đọc Whisper transcript JSON
            setProgress("Đang đọc Whisper transcript...")
            const transcriptText = await readTextFile(transcriptFilePath)
            const transcript = JSON.parse(transcriptText)

            // Kiểm tra transcript có đúng format không
            const segments = transcript.originalSegments || transcript.segments || []
            if (segments.length === 0) {
                throw new Error(
                    "File transcript không hợp lệ hoặc không có segments.\n" +
                    "Hãy dùng file .json từ thư mục transcripts của AutoSubs."
                )
            }

            setProgress(`✅ Đã đọc transcript (${segments.length} segments)`)

            // Bước 3: Chạy AI Match Pipeline
            setProgress("🤖 AI đang matching kịch bản với Whisper transcript...")

            const results = await aiMatchScriptToTimeline(
                scriptSentences,
                transcript,
                // Callback progress
                (prog) => {
                    setProgress(`🤖 ${prog.message} (batch ${prog.current}/${prog.total})`)
                },
                // Output folder → service tự lưu autosubs_matching.json vào đây
                outputFolder
            )

            // Hoàn tất
            const high = results.filter(r => r.quality === "high").length
            const none = results.filter(r => r.quality === "none").length
            setSuccessMsg(
                `✅ Đã tạo autosubs_matching.json!\n` +
                `   • ${results.length} câu tổng cộng\n` +
                `   • ✅ ${high} câu matched tốt | ❌ ${none} câu thiếu\n` +
                `   • Đã lưu vào: ${outputFolder}`
            )
            setProgress("")
        } catch (err: any) {
            setError(String(err))
            setProgress("")
        } finally {
            setIsRunning(false)
        }
    }

    // ======================== HELPERS ========================

    /** Lấy tên file từ đường dẫn đầy đủ */
    const basename = (path: string) => path.split(/[/\\]/).pop() || path

    /** Kiểm tra đủ điều kiện để chạy */
    const canRun = scriptFilePath && transcriptFilePath && outputFolder && !isRunning

    // ======================== RENDER ========================

    return (
        <div className="border rounded-lg overflow-hidden">
            {/* Header — toggle expand */}
            <button
                className="w-full flex items-center gap-2 px-4 py-3 text-sm font-medium bg-muted/30 hover:bg-muted/50 transition-colors text-left"
                onClick={() => setExpanded(!expanded)}
            >
                <Cpu className="h-4 w-4 text-orange-400 shrink-0" />
                <span className="flex-1">Tạo autosubs_matching.json (AI Match)</span>
                {expanded
                    ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                }
            </button>

            {/* Body */}
            {expanded && (
                <div className="px-4 py-3 space-y-3 border-t bg-card/20">
                    {/* Mô tả ngắn */}
                    <p className="text-xs text-muted-foreground leading-relaxed">
                        AI sẽ map từng câu kịch bản (đánh số) vào đúng vị trí trong Whisper transcript
                        → tạo file <code className="text-orange-400">autosubs_matching.json</code> dùng được ở mọi tab.
                    </p>

                    {/* Input 1: File kịch bản */}
                    <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            1. File kịch bản (.txt)
                        </label>
                        <Button
                            variant="outline"
                            size="sm"
                            className="w-full justify-start gap-2 h-9 text-xs font-normal"
                            onClick={handleSelectScript}
                            disabled={isRunning}
                        >
                            <FileText className="h-3.5 w-3.5 shrink-0 text-blue-400" />
                            <span className="truncate">
                                {scriptFilePath
                                    ? basename(scriptFilePath)
                                    : "Chọn file kịch bản đã đánh số câu..."}
                            </span>
                        </Button>
                        <p className="text-[10px] text-muted-foreground pl-1">
                            Format: mỗi dòng "1. Câu đầu tiên." — "2. Câu thứ hai." ...
                        </p>
                    </div>

                    {/* Input 2: Whisper transcript */}
                    <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            2. Whisper Transcript (.json)
                        </label>
                        <Button
                            variant="outline"
                            size="sm"
                            className="w-full justify-start gap-2 h-9 text-xs font-normal"
                            onClick={handleSelectTranscript}
                            disabled={isRunning}
                        >
                            <FileText className="h-3.5 w-3.5 shrink-0 text-green-400" />
                            <span className="truncate">
                                {transcriptFilePath
                                    ? basename(transcriptFilePath)
                                    : "Chọn file transcript từ tab Subtitles..."}
                            </span>
                        </Button>
                        <p className="text-[10px] text-muted-foreground pl-1">
                            File JSON trong thư mục transcripts của AutoSubs
                        </p>
                    </div>

                    {/* Input 3: Output folder */}
                    <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            3. Thư mục output
                        </label>
                        <Button
                            variant="outline"
                            size="sm"
                            className="w-full justify-start gap-2 h-9 text-xs font-normal"
                            onClick={handleSelectOutput}
                            disabled={isRunning}
                        >
                            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-yellow-400" />
                            <span className="truncate">
                                {outputFolder
                                    ? basename(outputFolder)
                                    : "Chọn thư mục lưu autosubs_matching.json..."}
                            </span>
                        </Button>
                        <p className="text-[10px] text-muted-foreground pl-1">
                            File sẽ được lưu tại: {outputFolder || "..."}/autosubs_matching.json
                        </p>
                    </div>

                    {/* Nút chạy */}
                    <Button
                        className="w-full gap-2 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white border-0 shadow-md"
                        onClick={handleCreate}
                        disabled={!canRun}
                    >
                        {isRunning
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Sparkles className="h-4 w-4" />
                        }
                        {isRunning ? "AI đang matching..." : "Tạo autosubs_matching.json"}
                    </Button>

                    {/* Progress */}
                    {isRunning && progress && (
                        <p className="text-xs text-orange-400 animate-pulse text-center leading-relaxed">
                            {progress}
                        </p>
                    )}

                    {/* Lỗi */}
                    {error && (
                        <div className="bg-red-500/10 border border-red-500/20 rounded p-2">
                            <p className="text-xs text-red-400 leading-relaxed whitespace-pre-wrap">
                                ❌ {error}
                            </p>
                        </div>
                    )}

                    {/* Thành công */}
                    {successMsg && (
                        <div className="bg-green-500/10 border border-green-500/20 rounded p-2 flex items-start gap-2">
                            <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0 mt-0.5" />
                            <p className="text-xs text-green-400 leading-relaxed whitespace-pre-wrap">
                                {successMsg}
                            </p>
                        </div>
                    )}

                    {/* Gợi ý sau khi tạo xong */}
                    {successMsg && (
                        <p className="text-[10px] text-muted-foreground text-center italic">
                            💡 Dùng file này ở tab Music, SFX, Highlight, Templates, v.v.
                        </p>
                    )}
                </div>
            )}
        </div>
    )
}
