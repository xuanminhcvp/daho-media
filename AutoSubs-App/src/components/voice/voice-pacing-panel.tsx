// voice-pacing-panel.tsx
// ═══════════════════════════════════════════════════════════════
// Panel giao diện cho tính năng Voice Pacing (chỉnh nhịp voice)
// Tab riêng biệt, quy trình:
//   1. Chọn folder matching data (chứa autosubs_matching.json)
//   2. Chọn file audio voice gốc
//   3. Phân tích nhịp (Rule-based hoặc AI)
//   4. Bảng review: xem + chỉnh pause từng câu (slider)
//   5. Xuất file audio mới (FFmpeg cắt + chèn silence)
// ═══════════════════════════════════════════════════════════════

import * as React from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
    Mic,
    FileAudio,
    Sparkles,
    Play,
    Download,
    Settings2,
    Loader2,
    ChevronDown,
    ChevronRight,
    RotateCcw,
    FolderOpen,
    CheckCircle2,
    AlertCircle,
} from "lucide-react"
import { open, save } from "@tauri-apps/plugin-dialog"
import { downloadDir } from "@tauri-apps/api/path"
import { join } from "@tauri-apps/api/path"
import { PACING_RULES, PACING_CONFIG } from "@/prompts/voice-pacing-prompt"
import { loadMatchingResults } from "@/services/ai-matcher"
import {
    analyzeByRules,
    analyzeByAI,
    processAudioWithFFmpeg,
    savePacedMatchingData,
} from "@/services/voice-pacing-service"
import { loadSRTFile, mapSentencesToSRT } from "@/utils/srt-parser"
import { runVoicePacingPipeline, runVoicePacingPipelineFromSRT } from "@/services/voice-pipeline-service"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useModels } from "@/contexts/ModelsContext"
import { useSettings } from "@/contexts/SettingsContext"
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs"
import type { PauseResult } from "@/services/voice-pacing-service"
import { useProject } from "@/contexts/ProjectContext"

// ======================== COMPONENT CHÍNH ========================

export function VoicePacingPanel() {
    // ======================== PROJECT CONTEXT ========================
    const { project, updateVoicePacing } = useProject()

    // Lấy data từ ProjectContext (thay vì useState)
    const mediaFolder = project.voicePacing.mediaFolder
    const matchedSentences = project.voicePacing.matchedSentences
    const audioFile = project.voicePacing.audioFile
    const srtFile = project.voicePacing.srtFile
    const pauseResults = project.voicePacing.pauseResults
    const srtMappedSentences = project.voicePacing.srtMappedSentences
    const scriptText = project.voicePacing.scriptText

    // ═══ Context từ hệ thống (cho AI Whisper pipeline) ═══
    const { modelsState } = useModels()
    const { settings } = useSettings()

    // ═══ State: Full Pipeline (Của Tab Toàn Trình) ═══
    const [isRunningPipeline, setIsRunningPipeline] = React.useState(false)
    // Lưu lại folder output của Pipeline để trỏ xuất autosubs_matching.json
    const [pipelineOutputFolder, setPipelineOutputFolder] = React.useState("")
    // Chế độ Pipeline: 'srt' = dùng SRT có sẵn (nhanh), 'whisper' = chạy Whisper mới
    const [pipelineMode, setPipelineMode] = React.useState<"srt" | "whisper">("srt")
    // File SRT được chọn trong Tab Toàn Trình (khác với srtFile của Tab WAV Có Sẵn)
    const [srtForPipeline, setSrtForPipeline] = React.useState("")

    // ═══ State: trạng thái xử lý (UI transient) ═══
    const [isAnalyzing, setIsAnalyzing] = React.useState(false)
    const [isProcessing, setIsProcessing] = React.useState(false)
    const [statusMessage, setStatusMessage] = React.useState("")
    const [errorMessage, setErrorMessage] = React.useState("")
    const [isMappingSRT, setIsMappingSRT] = React.useState(false)

    // ═══ State: UI ═══
    const [showRules, setShowRules] = React.useState(false)
    const [mode, setMode] = React.useState<"ai" | "rules">(PACING_CONFIG.mode)
    const [activeTab, setActiveTab] = React.useState<"prepared" | "newFile">("prepared")

    // ======================== HANDLERS ========================

    // Bước 1: Chọn folder chứa matching data
    const handleSelectFolder = async () => {
        try {
            const folderPath = await open({
                directory: true,
                multiple: false,
                title: "Chọn folder chứa autosubs_matching.json",
            })
            if (!folderPath) return

            updateVoicePacing({ mediaFolder: folderPath as string })
            setErrorMessage("")

            // Load matching data từ JSON
            const cached = await loadMatchingResults(folderPath as string)
            if (cached && cached.length > 0) {
                updateVoicePacing({ matchedSentences: cached, pauseResults: [] })
                setStatusMessage(`✅ Đã load ${cached.length} câu từ matching data`)
            } else {
                updateVoicePacing({ matchedSentences: [] })
                setStatusMessage("⚠️ Không tìm thấy autosubs_matching.json trong folder này")
            }
        } catch (error) {
            setErrorMessage("Lỗi chọn folder: " + String(error))
        }
    }

    // Bước 2: Chọn file audio voice gốc
    const handleSelectAudio = async () => {
        try {
            const filePath = await open({
                filters: [{
                    name: "Audio File",
                    extensions: ["wav", "mp3", "m4a", "aac", "flac", "ogg"],
                }],
                multiple: false,
                title: "Chọn file voice audio gốc",
            })
            if (!filePath) return

            updateVoicePacing({ audioFile: filePath as string })
            setStatusMessage(`🎤 Đã chọn: ${(filePath as string).split("/").pop()}`)
            setErrorMessage("")
        } catch (error) {
            setErrorMessage("Lỗi chọn file: " + String(error))
        }
    }

    // Bước 2.5: Chọn file SRT (Whisper output — timing chính xác)
    const handleSelectSRT = async () => {
        try {
            const filePath = await open({
                filters: [{ name: "SRT Subtitle", extensions: ["srt"] }],
                multiple: false,
                title: "Chọn file SRT (Whisper transcript)",
            })
            if (!filePath || matchedSentences.length === 0) return

            const srtPath = filePath as string
            updateVoicePacing({ srtFile: srtPath })
            setIsMappingSRT(true)
            setStatusMessage("⏳ Đang map timing SRT → câu script...")

            try {
                // Parse SRT và map lại timing cho từng câu
                const srtEntries = await loadSRTFile(srtPath)
                const mapped = mapSentencesToSRT(matchedSentences, srtEntries)
                updateVoicePacing({ srtMappedSentences: mapped })
                setStatusMessage(
                    `✅ SRT mapped! ${mapped.length} câu có timing chính xác từ Whisper`
                )
            } catch (srtErr) {
                setErrorMessage("Lỗi đọc SRT: " + String(srtErr))
                updateVoicePacing({ srtFile: "" })
            }

            setIsMappingSRT(false)
        } catch (error) {
            setErrorMessage("Lỗi chọn SRT: " + String(error))
            setIsMappingSRT(false)
        }
    }

    // Pipeline: Chạy toàn trình cho File Mới (WAV + Text)
    const handleRunFullPipeline = async () => {
        if (!audioFile) {
            setErrorMessage("Hãy chọn File audio WAV/MP3 trước!")
            return
        }
        if (!scriptText.trim()) {
            setErrorMessage("Vui lòng dán kịch bản đánh số!")
            return
        }
        // Chế độ SRT: cần chọn file SRT
        if (pipelineMode === "srt" && !srtForPipeline) {
            setErrorMessage("Chế độ SRT: vui lòng chọn file .srt từ tab Subtitles!")
            return
        }

        setIsRunningPipeline(true)
        setErrorMessage("")
        updateVoicePacing({ pauseResults: [], matchedSentences: [], srtMappedSentences: [] })

        try {
            let result
            if (pipelineMode === "srt") {
                // Chế độ nhanh: dùng SRT có sẵn, bỏ qua Whisper
                result = await runVoicePacingPipelineFromSRT(
                    audioFile,
                    srtForPipeline,
                    scriptText,
                    (progress) => setStatusMessage(`⏳ ${progress.message}`),
                )
            } else {
                // Chế độ đầy đủ: chạy Whisper từ đầu
                result = await runVoicePacingPipeline(
                    audioFile,
                    scriptText,
                    (progress) => setStatusMessage(`⏳ ${progress.message}`),
                    modelsState[settings.model].value,
                    settings.language
                )
            }

            updateVoicePacing({ mediaFolder: result.folderPath, matchedSentences: result.matchedSentences })
            setPipelineOutputFolder(result.folderPath)
            setStatusMessage(`✅ ${result.matchedSentences.length} câu sẵn sàng. Cuộn xuống bấm Phân Tích Nhịp!`)
        } catch (err) {
            setErrorMessage("Lỗi Pipeline: " + String(err))
        }

        setIsRunningPipeline(false)
    }

    // Tải về autosubs_matching.json (sau khi Pipeline xong)
    const handleDownloadMatchingJson = async () => {
        if (!pipelineOutputFolder) return

        try {
            // Đọc file đã lưu sẵn trong folder audio
            const srcPath = await join(pipelineOutputFolder, "autosubs_matching.json")
            const content = await readTextFile(srcPath)

            // Hỏi user muốn lưu về đâu
            const destPath = await save({
                defaultPath: srcPath,
                filters: [{ name: "JSON", extensions: ["json"] }],
            })
            if (!destPath) return

            await writeTextFile(destPath, content)
            setStatusMessage(`✅ Đã lưu autosubs_matching.json → ${destPath.split("/").pop()}`)
        } catch (err) {
            setErrorMessage("Lỗi tải file: " + String(err))
        }
    }

    // Bước 3: Phân tích nhịp
    const handleAnalyze = async () => {
        console.log("[VoicePacing] handleAnalyze called:", {
            mode,
            matchedSentences: matchedSentences.length,
            srtMapped: srtMappedSentences.length,
            hasSRT: !!srtFile,
        })

        if (matchedSentences.length === 0) {
            setErrorMessage("Chưa có matching data! Chọn folder trước.")
            return
        }

        // Dùng SRT timing nếu đã có, fallback sang matching.json nếu chưa
        const activeSentences = srtMappedSentences.length > 0 ? srtMappedSentences : matchedSentences
        const timingSource = srtMappedSentences.length > 0 ? "SRT" : "matching.json"
        console.log(`[VoicePacing] Sử dụng timing từ ${timingSource}`)

        setIsAnalyzing(true)
        setErrorMessage("")

        try {
            let results: PauseResult[]

            if (mode === "ai") {
                setStatusMessage("🤖 Đang gửi cho AI phân tích nhịp...")
                console.log("[VoicePacing] analyzeByAI:", activeSentences.length, "câu (", timingSource, ")")
                results = await analyzeByAI(activeSentences, (progress) => {
                    setStatusMessage(`🤖 ${progress.message}`)
                })
            } else {
                setStatusMessage("🔧 Đang phân tích theo quy tắc...")
                results = analyzeByRules(activeSentences)
            }

            updateVoicePacing({ pauseResults: results })
            const totalPause = results.reduce((sum, r) => sum + r.pause, 0)
            setStatusMessage(`✅ Phân tích xong! ${results.length} câu | +${totalPause.toFixed(1)}s | timing: ${timingSource}`)
        } catch (error) {
            console.error("[VoicePacing] LỖI handleAnalyze:", error)
            setErrorMessage("Lỗi phân tích: " + String(error))
        }

        setIsAnalyzing(false)
    }

    // Bước 4: Chỉnh pause cho 1 câu (slider)
    const handlePauseChange = (num: number, newPause: number) => {
        updateVoicePacing({
            pauseResults: pauseResults.map((r: PauseResult) => r.num === num ? { ...r, pause: newPause } : r)
        })
    }

    // Reset pause về giá trị gốc
    const handleResetPause = (num: number) => {
        updateVoicePacing({
            pauseResults: pauseResults.map((r: PauseResult) => r.num === num ? { ...r, pause: r.original } : r)
        })
    }

    // Reset tất cả
    const handleResetAll = () => {
        updateVoicePacing({
            pauseResults: pauseResults.map((r: PauseResult) => ({ ...r, pause: r.original }))
        })
    }

    // Bước 5: Xuất file audio mới (FFmpeg)
    const handleExport = async () => {
        if (!audioFile) {
            setErrorMessage("Chưa chọn file audio!")
            return
        }
        if (pauseResults.length === 0) {
            setErrorMessage("Chưa phân tích nhịp! Bấm 'Phân tích nhịp' trước.")
            return
        }

        setIsProcessing(true)
        setErrorMessage("")

        try {
            // Xác định file output (lấy đúng extension gốc)
            const dlDir = await downloadDir()
            const inputName = audioFile.split("/").pop() || "voice"
            const baseName = inputName.replace(/\.[^.]+$/, "")
            const defaultExt = audioFile.split(".").pop()?.toLowerCase() || "m4a"
            const defaultOutput = await join(dlDir, `${baseName}_paced.${defaultExt}`)

            // Hỏi user chọn nơi lưu
            const outputPath = await save({
                defaultPath: defaultOutput,
                filters: [{ name: "Audio File", extensions: [defaultExt, "m4a", "wav", "mp3"] }],
            })

            if (!outputPath) {
                setIsProcessing(false)
                return
            }

            // Dùng SRT timing nếu có, fallback sang matching.json
            const activeSentences = srtMappedSentences.length > 0 ? srtMappedSentences : matchedSentences

            // Gọi FFmpeg xử lý
            const result = await processAudioWithFFmpeg(
                audioFile,
                activeSentences,
                pauseResults,
                outputPath,
                (progress) => {
                    setStatusMessage(`⚙️ ${progress.message}`)
                },
            )

            if (result.success) {
                // Lưu matching data mới (timing đã cập nhật)
                if (mediaFolder) {
                    await savePacedMatchingData(mediaFolder, result.newSentences)
                }

                setStatusMessage(
                    `✅ Xuất thành công! +${result.totalAdded.toFixed(1)}s | File: ${outputPath.split("/").pop()}`
                )
            } else {
                setErrorMessage(result.error || "Lỗi FFmpeg không xác định")
            }
        } catch (error) {
            setErrorMessage("Lỗi xuất audio: " + String(error))
        }

        setIsProcessing(false)
    }

    // Tính tổng thời gian thêm vào
    const totalAddedTime = pauseResults.reduce((sum, r) => sum + r.pause, 0)

    // ======================== RENDER ========================

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="shrink-0 px-4 pt-4 pb-2 border-b flex justify-between items-center">
                <div>
                    <h3 className="text-lg font-semibold flex items-center gap-2">
                        <Mic className="h-5 w-5 text-primary" />
                        Voice Pacing
                    </h3>
                    <p className="text-xs text-muted-foreground mt-1">
                        Chỉnh nhịp voice — thêm khoảng nghỉ giữa các câu theo ngữ cảnh
                    </p>
                </div>
            </div>

            <ScrollArea className="flex-1 min-h-0">
                <div className="p-4 space-y-4">

                    <Tabs value={activeTab} onValueChange={(v: any) => setActiveTab(v)}>
                        <TabsList className="w-full grid grid-cols-2 mb-4">
                            <TabsTrigger value="prepared">WAV Có Sẵn (Đã Match)</TabsTrigger>
                            <TabsTrigger value="newFile">Toàn Trình (WAV Mới Tinh)</TabsTrigger>
                        </TabsList>

                        <TabsContent value="prepared" className="space-y-4">
                            {/* ═══ 1. Chọn folder matching data ═══ */}
                            <div className="space-y-2 bg-muted/30 p-3 rounded-lg border">
                                <label className="text-sm font-medium">1. Chọn folder matching data</label>
                                <Button
                                    variant="outline"
                                    className="w-full justify-start gap-2 h-10"
                                    onClick={handleSelectFolder}
                                >
                                    <FolderOpen className="h-4 w-4 text-blue-500" />
                                    {mediaFolder
                                        ? mediaFolder.split("/").pop()
                                        : "Nơi chứa autosubs_matching.json..."}
                                </Button>
                                {matchedSentences.length > 0 && (
                                    <p className="text-xs text-green-500">
                                        📝 {matchedSentences.length} câu đã load từ matching data
                                    </p>
                                )}
                            </div>

                            {/* ═══ 2. Chọn file audio voice ═══ */}
                            <div className="space-y-2 bg-muted/30 p-3 rounded-lg border">
                                <label className="text-sm font-medium">2. Chọn file voice audio</label>
                                <Button
                                    variant="outline"
                                    className="w-full justify-start gap-2 h-10"
                                    onClick={handleSelectAudio}
                                >
                                    <FileAudio className="h-4 w-4 text-primary" />
                                    {audioFile
                                        ? audioFile.split("/").pop()
                                        : "Chọn file .WAV / .M4A cũ..."}
                                </Button>
                            </div>

                            {/* ═══ 2.5 Chọn file SRT (timing chính xác từ Whisper) ═══ */}
                            {matchedSentences.length > 0 && (
                                <div className="space-y-2 bg-muted/30 p-3 rounded-lg border">
                                    <label className="text-sm font-medium flex items-center gap-2">
                                        2.5 Chọn file SRT (Tùy Chọn)
                                        <span className={`text-xs px-1.5 py-0.5 rounded font-normal ${srtMappedSentences.length > 0
                                            ? "bg-green-500/15 text-green-500"
                                            : "bg-yellow-500/15 text-yellow-600"
                                            }`}>
                                            {srtMappedSentences.length > 0 ? "✅ SRT mapped" : "⚠️ Quan trọng để đúng Ms"}
                                        </span>
                                    </label>
                                    <Button
                                        variant="outline"
                                        className="w-full justify-start gap-2 h-10"
                                        onClick={handleSelectSRT}
                                        disabled={isMappingSRT}
                                    >
                                        <FileAudio className="h-4 w-4 text-blue-500" />
                                        {isMappingSRT
                                            ? "Đang map timing..."
                                            : srtFile
                                                ? srtFile.split("/").pop()
                                                : "Chọn file .srt (Whisper transcript)..."}
                                    </Button>
                                </div>
                            )}
                        </TabsContent>

                        <TabsContent value="newFile" className="space-y-4">
                            {/* Khu vực Xử lý toàn trình (Full Pipeline) */}
                            <div className="space-y-3 bg-indigo-500/5 p-4 rounded-lg border border-indigo-500/20">

                                <label className="text-sm font-semibold flex items-center gap-2 text-indigo-400">
                                    <Sparkles className="h-4 w-4" />
                                    Xử lý Toàn Trình → AI Match Kịch Bản với Âm Thanh
                                </label>

                                {/* Toggle chọn chế độ xử lý */}
                                <div className="flex gap-1.5 p-1 bg-background rounded-md border">
                                    <button
                                        className={`flex-1 text-xs py-1.5 rounded transition-colors font-medium ${pipelineMode === "srt"
                                                ? "bg-indigo-600 text-white"
                                                : "text-muted-foreground hover:text-foreground"
                                            }`}
                                        onClick={() => setPipelineMode("srt")}
                                        disabled={isRunningPipeline}
                                    >
                                        ⚡ Dùng SRT có sẵn (Nhanh)
                                    </button>
                                    <button
                                        className={`flex-1 text-xs py-1.5 rounded transition-colors font-medium ${pipelineMode === "whisper"
                                                ? "bg-indigo-600 text-white"
                                                : "text-muted-foreground hover:text-foreground"
                                            }`}
                                        onClick={() => setPipelineMode("whisper")}
                                        disabled={isRunningPipeline}
                                    >
                                        🎙️ Chạy Whisper mới
                                    </button>
                                </div>

                                {/* Mô tả mode */}
                                <p className="text-xs text-muted-foreground">
                                    {pipelineMode === "srt"
                                        ? "⚡ Đã có SRT từ tab bên trái → chỉ cần AI Match kịch bản, xong trong vài phút."
                                        : "🎙️ File WAV chưa transcribe → Whisper chạy ngầm rồi AI Match (mất 5-15 phút/30 phút audio)."}
                                </p>

                                {/* Chọn file WAV */}
                                <div className="space-y-1">
                                    <label className="text-xs font-medium">Chọn file Voice (WAV, MP3)</label>
                                    <Button
                                        variant="outline"
                                        className="w-full justify-start gap-2 h-10"
                                        onClick={handleSelectAudio}
                                    >
                                        <FileAudio className="h-4 w-4 text-indigo-400" />
                                        {audioFile ? audioFile.split("/").pop() : "Browse file..."}
                                    </Button>
                                </div>

                                {/* Chọn file SRT (chỉ hiện ở chế độ SRT) */}
                                {pipelineMode === "srt" && (
                                    <div className="space-y-1">
                                        <label className="text-xs font-medium flex items-center gap-2">
                                            Chọn file SRT (từ tab Subtitles bên trái)
                                            {srtForPipeline && <span className="text-green-500 text-[10px]">✅ Đã chọn</span>}
                                        </label>
                                        <Button
                                            variant="outline"
                                            className={`w-full justify-start gap-2 h-10 ${srtForPipeline ? "border-green-500/40" : ""}`}
                                            onClick={async () => {
                                                const f = await open({
                                                    filters: [{ name: "SRT", extensions: ["srt"] }],
                                                    multiple: false,
                                                    title: "Chọn file .srt từ tab Subtitles",
                                                })
                                                if (f) setSrtForPipeline(f as string)
                                            }}
                                            disabled={isRunningPipeline}
                                        >
                                            <FileAudio className="h-4 w-4 text-green-500" />
                                            {srtForPipeline
                                                ? srtForPipeline.split("/").pop()
                                                : "Chọn file .srt đã export từ tab Subtitles..."}
                                        </Button>
                                    </div>
                                )}

                                {/* Dán kịch bản đánh số */}
                                <div className="space-y-1">
                                    <label className="text-xs font-medium">Dán kịch bản đã đánh số</label>
                                    <textarea
                                        className="w-full h-32 px-3 py-2 text-sm bg-background border rounded-md outline-none focus:ring-1 focus:ring-indigo-500"
                                        placeholder={"1. Câu đầu tiên\n2. Câu tiếp theo...\n..."}
                                        value={scriptText}
                                        onChange={(e) => updateVoicePacing({ scriptText: e.target.value })}
                                        disabled={isRunningPipeline}
                                    />
                                </div>

                                {/* Nút chạy */}
                                <Button
                                    className="w-full gap-2 mt-2 bg-indigo-600 hover:bg-indigo-700 text-white"
                                    onClick={handleRunFullPipeline}
                                    disabled={!audioFile || !scriptText.trim() || isRunningPipeline}
                                >
                                    {isRunningPipeline ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                                    {isRunningPipeline
                                        ? "Đang xử lý..."
                                        : pipelineMode === "srt" ? "⚡ Match kịch bản với SRT" : "🎙️ Bắt đầu Toàn Trình (Whisper + Match)"}
                                </Button>
                            </div>


                            {matchedSentences.length > 0 && !isRunningPipeline && (
                                <div className="mt-3 space-y-2">
                                    <p className="text-sm text-green-500 text-center font-medium">
                                        🎉 {matchedSentences.length} câu đã match xong! Cuộn xuống bấm Phân Tích.
                                    </p>
                                    {/* Nút tải về autosubs_matching.json */}
                                    <Button
                                        variant="outline"
                                        className="w-full gap-2 border-green-500/40 text-green-500 hover:bg-green-500/10"
                                        onClick={handleDownloadMatchingJson}
                                        disabled={!pipelineOutputFolder}
                                    >
                                        <Download className="h-4 w-4" />
                                        Tải về autosubs_matching.json
                                    </Button>
                                    <p className="text-xs text-muted-foreground text-center">
                                        File này có thể dùng lại cho lần sau (không cần chạy lại từ đầu)
                                    </p>
                                </div>
                            )}
                        </TabsContent>
                    </Tabs>

                    <div className="h-px w-full bg-border my-4" />

                    {/* ═══ 3. Chế độ phân tích ═══ */}
                    <div className="space-y-2">
                        <label className="text-sm font-medium">3. Chế độ phân tích nhịp</label>
                        <div className="flex gap-2">
                            {/* Mode: Quy tắc (nhanh, không tốn API) */}
                            <Button
                                variant={mode === "rules" ? "default" : "outline"}
                                className="flex-1 gap-2"
                                onClick={() => setMode("rules")}
                            >
                                <Settings2 className="h-4 w-4" />
                                Quy tắc
                            </Button>
                            {/* Mode: AI (thông minh, tốn API) */}
                            <Button
                                variant={mode === "ai" ? "default" : "outline"}
                                className="flex-1 gap-2"
                                onClick={() => setMode("ai")}
                            >
                                <Sparkles className="h-4 w-4" />
                                AI
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {mode === "rules"
                                ? "🔧 Dùng quy tắc dấu câu cố định — nhanh, không tốn API"
                                : "🤖 AI phân tích ngữ cảnh — thông minh hơn, tốn 1 API call"}
                        </p>
                    </div>

                    {/* ═══ Xem / chỉnh quy tắc ═══ */}
                    <div className="space-y-2">
                        <button
                            className="flex items-center gap-1.5 text-sm font-medium hover:text-primary transition-colors"
                            onClick={() => setShowRules(!showRules)}
                        >
                            {showRules ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            Quy tắc nhịp nghỉ
                            <span className="text-xs text-muted-foreground">(sửa trong voice-pacing-prompt.ts)</span>
                        </button>

                        {/* Bảng quy tắc hiện tại (collapse/expand) */}
                        {showRules && (
                            <div className="border rounded-md p-3 space-y-2 bg-muted/30 text-xs">
                                {Object.entries(PACING_RULES).map(([key, rule]) => (
                                    <div key={key} className="flex items-center justify-between gap-2">
                                        <div className="flex-1 min-w-0">
                                            <span className="font-medium">{rule.label}</span>
                                            <span className="text-muted-foreground ml-1.5 hidden sm:inline">{rule.description}</span>
                                        </div>
                                        <span className="shrink-0 font-mono text-primary">
                                            {rule.defaultPause}s
                                        </span>
                                    </div>
                                ))}
                                <p className="text-muted-foreground border-t pt-2 mt-2">
                                    📝 Sửa giá trị: <code className="bg-muted px-1 rounded">src/prompts/voice-pacing-prompt.ts</code>
                                </p>
                            </div>
                        )}
                    </div>

                    {/* ═══ 4. Nút phân tích ═══ */}
                    <div className="space-y-2 pt-1">
                        <Button
                            className="w-full gap-2"
                            onClick={handleAnalyze}
                            disabled={isAnalyzing || matchedSentences.length === 0}
                        >
                            {isAnalyzing ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : mode === "ai" ? (
                                <Sparkles className="h-4 w-4" />
                            ) : (
                                <Play className="h-4 w-4" />
                            )}
                            {isAnalyzing ? "Đang phân tích..." : `Phân tích nhịp (${matchedSentences.length} câu)`}
                        </Button>
                    </div>

                    {/* ═══ 5. Bảng kết quả — slider chỉnh pause từng câu ═══ */}
                    {pauseResults.length > 0 && (
                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <label className="text-sm font-medium">
                                    Kết quả ({pauseResults.length} câu)
                                </label>
                                <div className="flex items-center gap-2">
                                    {/* Tổng thời gian silence thêm vào */}
                                    <span className="text-xs text-muted-foreground font-mono">
                                        +{totalAddedTime.toFixed(1)}s
                                    </span>
                                    {/* Nút reset tất cả */}
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 gap-1 text-xs"
                                        onClick={handleResetAll}
                                    >
                                        <RotateCcw className="h-3 w-3" />
                                        Reset
                                    </Button>
                                </div>
                            </div>

                            {/* Danh sách câu + slider */}
                            <div className="border rounded-md divide-y max-h-72 overflow-y-auto">
                                {pauseResults.map((r) => {
                                    // Tìm text câu tương ứng
                                    const sent = matchedSentences.find(s => s.num === r.num)
                                    const isModified = r.pause !== r.original

                                    return (
                                        <div
                                            key={r.num}
                                            className="px-3 py-2 text-xs"
                                        >
                                            {/* Dòng 1: số câu + text câu */}
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className="font-mono text-primary shrink-0 w-8 text-right font-semibold">
                                                    #{r.num}
                                                </span>
                                                <span
                                                    className="flex-1 min-w-0 text-foreground"
                                                    style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                                    title={sent?.text}
                                                >
                                                    {sent?.text || ""}
                                                </span>
                                            </div>
                                            {/* Dòng 2: lý do + slider + giá trị */}
                                            <div className="flex items-center gap-2 ml-10">
                                                <span className="text-muted-foreground flex-1 min-w-0" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                    {r.reason}
                                                </span>
                                                {/* Slider chỉnh pause */}
                                                <input
                                                    type="range"
                                                    min="0"
                                                    max={PACING_CONFIG.globalMaxPause}
                                                    step="0.1"
                                                    value={r.pause}
                                                    onChange={(e) => handlePauseChange(r.num, parseFloat(e.target.value))}
                                                    className="w-20 shrink-0 accent-primary"
                                                    title={`Pause: ${r.pause}s (gốc: ${r.original}s)`}
                                                />
                                                {/* Giá trị pause (highlight nếu đã chỉnh) */}
                                                <span className={`font-mono shrink-0 w-10 text-right ${isModified ? "text-yellow-500 font-semibold" : "text-muted-foreground"}`}>
                                                    {r.pause.toFixed(1)}s
                                                </span>
                                                {/* Nút reset từng câu (chỉ hiện khi đã chỉnh) */}
                                                {isModified && (
                                                    <button
                                                        className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
                                                        onClick={() => handleResetPause(r.num)}
                                                        title="Reset về giá trị gốc"
                                                    >
                                                        <RotateCcw className="h-3 w-3" />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        </div>
                    )}

                    {/* ═══ 6. Nút xuất file audio mới ═══ */}
                    {pauseResults.length > 0 && (
                        <Button
                            className="w-full gap-2"
                            variant="default"
                            onClick={handleExport}
                            disabled={isProcessing || !audioFile}
                        >
                            {isProcessing ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Download className="h-4 w-4" />
                            )}
                            {isProcessing
                                ? "Đang xử lý audio..."
                                : `Xuất audio mới (+${totalAddedTime.toFixed(1)}s silence)`}
                        </Button>
                    )}

                    {/* Nhắc chọn audio nếu chưa có */}
                    {pauseResults.length > 0 && !audioFile && (
                        <p className="text-xs text-yellow-500">
                            ⚠️ Chưa chọn file audio! Bấm "Chọn file voice audio" ở bước 2.
                        </p>
                    )}

                    {/* ═══ Status message ═══ */}
                    {statusMessage && (
                        <div className={`text-sm p-3 rounded-md ${statusMessage.startsWith("✅")
                            ? "bg-green-500/10 text-green-500 border border-green-500/20"
                            : statusMessage.startsWith("⚠️")
                                ? "bg-yellow-500/10 text-yellow-500 border border-yellow-500/20"
                                : "bg-blue-500/10 text-blue-500 border border-blue-500/20"
                            }`}>
                            {statusMessage.startsWith("✅") && <CheckCircle2 className="h-4 w-4 inline mr-1" />}
                            {statusMessage}
                        </div>
                    )}

                    {/* ═══ Error message ═══ */}
                    {errorMessage && (
                        <div className="text-sm p-3 rounded-md bg-red-500/10 text-red-500 border border-red-500/20">
                            <AlertCircle className="h-4 w-4 inline mr-1" />
                            {errorMessage}
                        </div>
                    )}

                </div>
            </ScrollArea>
        </div>
    )
}
