// @ts-nocheck
// media-import-panel.tsx
// Panel giao diện cho tính năng Video Import vào DaVinci Resolve timeline
// Cho phép chọn folder chứa video, paste script, và import tự động
// Hỗ trợ 2 mode matching: Logic (nhanh) và AI (chính xác hơn)

import * as React from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { FolderOpen, Upload, FileVideo, CheckCircle2, AlertCircle, Loader2, FileText, Sparkles, Download, FileUp, Copy, Check, Search } from "lucide-react"
import { open, save } from "@tauri-apps/plugin-dialog"
import { readDir, writeTextFile, readTextFile } from "@tauri-apps/plugin-fs"
import { addDebugLog, updateDebugLog, generateLogId } from "@/services/debug-logger"
import { join, downloadDir } from "@tauri-apps/api/path"
import { addMediaToTimeline, getTrackClipNumbers, seekToTime } from "@/api/resolve-api"
import { readTranscript } from "@/utils/file-utils"
import {
    parseScript,
    extractWhisperWords,
    matchScriptToTimeline,
    sortFilesByNumber,
    getFileNumber,
    generateMatchReport,
    ScriptSentence,
} from "@/utils/media-matcher"
import { aiMatchScriptToTimeline, loadMatchingResults } from "@/services/ai-matcher"
import { useResolve } from "@/contexts/ResolveContext"
import { SentenceSearch } from "@/components/media/sentence-search"
import { useProject } from "@/contexts/ProjectContext"


// Trạng thái import
type ImportStatus = "idle" | "matching" | "importing" | "done" | "error"

/** Chuyển giây thành timestamp SRT: 00:01:23,456 */
function secondsToSrt(totalSec: number): string {
    const h = Math.floor(totalSec / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = Math.floor(totalSec % 60)
    const ms = Math.round((totalSec % 1) * 1000)
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`
}

/** Parse timestamp SRT (00:01:23,456) thành giây */
function parseSrtTime(timeStr: string): number {
    // Format: 00:01:23,456 hoặc 00:01:23.456
    const parts = timeStr.trim().replace(",", ".").split(":")
    if (parts.length !== 3) return 0
    const h = parseInt(parts[0]) || 0
    const m = parseInt(parts[1]) || 0
    const s = parseFloat(parts[2]) || 0
    return h * 3600 + m * 60 + s
}

/** Parse nội dung file SRT thành danh sách entries */
function parseSrtContent(content: string): { index: number; start: number; end: number; text: string }[] {
    const results: { index: number; start: number; end: number; text: string }[] = []
    // Tách theo block (ngăn cách bởi dòng trống)
    const blocks = content.trim().split(/\n\s*\n/)

    for (const block of blocks) {
        const lines = block.trim().split("\n")
        if (lines.length < 3) continue

        // Dòng 1: số thứ tự
        const index = parseInt(lines[0].trim())
        if (isNaN(index)) continue

        // Dòng 2: timestamp (00:00:01,000 --> 00:00:04,500)
        const timeLine = lines[1].trim()
        const timeMatch = timeLine.match(/([\d:,.]+)\s*-->\s*([\d:,.]+)/)
        if (!timeMatch) continue

        const start = parseSrtTime(timeMatch[1])
        const end = parseSrtTime(timeMatch[2])

        // Dòng 3+: text (có thể nhiều dòng)
        const text = lines.slice(2).join(" ").trim()
        if (!text) continue

        results.push({ index, start, end, text })
    }

    return results
}

/**
 * Component hiển thị danh sách câu chưa có media file
 * + Nút copy danh sách số câu thiếu
 * + Bấm vào số câu → nhảy playhead đến vị trí đó trên timeline
 * + Bấm chọn → Backspace xoá khỏi danh sách
 */
function MissingMediaSection({ missingNums, matchedSentences, onRemove }: {
    missingNums: number[];
    matchedSentences: ScriptSentence[];
    onRemove?: (num: number) => void;
}) {
    const [copied, setCopied] = React.useState(false)
    const [selectedNum, setSelectedNum] = React.useState<number | null>(null)
    const containerRef = React.useRef<HTMLDivElement>(null)

    // Copy danh sách số câu (mỗi số 1 dòng)
    const handleCopy = () => {
        const text = missingNums.join("\n")
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    // Bấm vào số câu → chọn + nhảy playhead trên timeline DaVinci
    const handleClick = async (num: number) => {
        setSelectedNum(num)
        const sent = matchedSentences.find(s => s.num === num)
        if (!sent) return
        try {
            await seekToTime(sent.start)
        } catch (err) {
            console.error("[Seek] Lỗi:", err)
        }
    }

    // Bắt phím Backspace/Delete → xoá số đang chọn
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if ((e.key === "Backspace" || e.key === "Delete") && selectedNum !== null) {
            e.preventDefault()
            onRemove?.(selectedNum)
            setSelectedNum(null)
        }
    }

    return (
        <div className="space-y-1">
            <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-yellow-500">
                    ⚠️ Thiếu {missingNums.length} media files
                </label>
                {/* Nút copy danh sách số câu */}
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 text-xs text-muted-foreground"
                    onClick={handleCopy}
                >
                    {copied ? (
                        <><Check className="h-3 w-3 text-green-500" /> Đã copy</>
                    ) : (
                        <><Copy className="h-3 w-3" /> Copy số câu</>
                    )}
                </Button>
            </div>
            {/* Hiển thị danh sách số câu thiếu — bấm chọn, Backspace xoá */}
            <div
                ref={containerRef}
                tabIndex={0}
                onKeyDown={handleKeyDown}
                className="flex flex-wrap gap-1 bg-muted/50 rounded px-2 py-1.5 max-h-32 overflow-y-auto outline-none focus:ring-1 focus:ring-yellow-500/30"
            >
                {missingNums.map((num) => (
                    <button
                        key={num}
                        onClick={() => handleClick(num)}
                        className={`text-xs font-mono px-1.5 py-0.5 rounded cursor-pointer transition-colors border ${selectedNum === num
                            ? "bg-yellow-500/30 text-yellow-500 border-yellow-500/50"
                            : "bg-background hover:bg-yellow-500/20 hover:text-yellow-500 border-transparent hover:border-yellow-500/30"
                            }`}
                        title={`Câu ${num} | Backspace để xoá`}
                    >
                        {num}
                    </button>
                ))}
            </div>
            {selectedNum !== null && (
                <p className="text-xs text-muted-foreground">
                    Đang chọn câu <strong>{selectedNum}</strong> — nhấn <kbd className="px-1 py-0.5 rounded bg-muted border text-[10px]">⌫</kbd> để xoá
                </p>
            )}
        </div>
    )
}

export function MediaImportPanel() {
    // ======================== PROJECT CONTEXT ========================
    // Dùng ProjectContext để chia sẻ data với các tab khác + lưu vào session
    const {
        project,
        updateMediaImport,
        setScriptText: setSharedScriptText,
        setMatchingFolder: setSharedMatchingFolder,
        setMatchingSentences: setSharedMatchingSentences,
    } = useProject()

    // Lấy data từ context (thay vì useState)
    const mediaFolder = project.mediaImport.mediaFolder
    const mediaFiles = project.mediaImport.mediaFiles
    const matchedSentences = project.mediaImport.matchedSentences
    const selectedTrack = "1" // V1 — Video AI (cố định, không cần context)
    const scriptText = project.scriptText

    // ======================== LOCAL STATE (UI transient) ========================
    const [importStatus, setImportStatus] = React.useState<ImportStatus>("idle")
    const [statusMessage, setStatusMessage] = React.useState<string>("")
    const [errorMessage, setErrorMessage] = React.useState<string>("")
    const [aiProgress, setAiProgress] = React.useState<string>("")
    const [timelineMissing, setTimelineMissing] = React.useState<number[] | null>(null)
    const [isScanning, setIsScanning] = React.useState(false)
    const [importedNums, setImportedNums] = React.useState<number[]>([])

    // Context
    const { timelineInfo } = useResolve()


    /**
     * Chọn folder chứa video files
     * Quét tất cả file .mp4, .mov, .avi, .mkv trong folder
     */
    const handleSelectFolder = async () => {
        try {
            const folderPath = await open({
                directory: true,
                multiple: false,
                title: "Chọn folder chứa video files",
            })

            if (!folderPath) return

            updateMediaImport({ mediaFolder: folderPath as string })

            // Quét folder để tìm file video
            const entries = await readDir(folderPath as string)
            const videoExtensions = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".mxf"]
            const videoFiles: string[] = []

            for (const entry of entries) {
                if (entry.name) {
                    const ext = entry.name.toLowerCase().slice(entry.name.lastIndexOf("."))
                    if (videoExtensions.includes(ext)) {
                        const fullPath = await join(folderPath as string, entry.name)
                        videoFiles.push(fullPath)
                    }
                }
            }

            // Sắp xếp theo số trong tên file
            const sorted = sortFilesByNumber(videoFiles)
            updateMediaImport({ mediaFiles: sorted })
            setStatusMessage(`Tìm thấy ${sorted.length} file video`)

            // ⭐ Tự động load kết quả matching đã lưu (nếu có)
            const cached = await loadMatchingResults(folderPath as string)
            if (cached && cached.length > 0) {
                updateMediaImport({ matchedSentences: cached })
                setImportStatus("done")
                setStatusMessage(`Tìm thấy ${sorted.length} file video | ♻️ Đã load ${cached.length} kết quả matching từ cache`)
            } else {
                updateMediaImport({ matchedSentences: [] })
                setImportStatus("idle")
            }
        } catch (error) {
            console.error("Lỗi chọn folder:", error)
            setErrorMessage("Không thể đọc folder: " + String(error))
        }
    }

    /**
     * Chạy text matching: so khớp script với Whisper word timings
     * Đọc transcript JSON → trích xuất words → match với script
     */
    const handleMatch = async () => {
        try {
            setImportStatus("matching")
            setErrorMessage("")
            setStatusMessage("Đang matching text...")

            // Parse script text thành danh sách câu
            const sentences = parseScript(scriptText)
            if (sentences.length === 0) {
                setErrorMessage("Không tìm thấy câu nào trong script. Đảm bảo format: '1. Text câu 1'")
                setImportStatus("error")
                return
            }

            // Kiểm tra số file video vs số câu script
            if (mediaFiles.length === 0) {
                setErrorMessage("Chưa chọn folder chứa video files!")
                setImportStatus("error")
                return
            }

            // Đọc transcript JSON để lấy word timings
            // Ưu tiên dùng timelineId, nếu không có thì tìm file gần nhất
            const timelineId = timelineInfo?.timelineId || ""
            let filename = ""
            if (timelineId) {
                filename = `${timelineId}.json`
            } else {
                // Không có timelineId — thử scan folder TranscriptS
                setErrorMessage("Không tìm thấy timelineId. Hãy kết nối DaVinci Resolve và transcribe audio trước!")
                setImportStatus("error")
                return
            }

            const transcript = await readTranscript(filename)
            if (!transcript) {
                setErrorMessage(`Không tìm thấy transcript file: ${filename}. Hãy transcribe audio trước bằng AutoSubs gốc!`)
                setImportStatus("error")
                return
            }

            // Trích xuất Whisper words
            const whisperWords = extractWhisperWords(transcript)
            if (whisperWords.length === 0) {
                setErrorMessage("Transcript không có word timings. Cần transcribe lại với word-level timestamps.")
                setImportStatus("error")
                return
            }

            // Chạy text matching
            const matched = matchScriptToTimeline(sentences, whisperWords)
            updateMediaImport({ matchedSentences: matched })

            // Thống kê quality
            const highCount = matched.filter(s => s.quality === "high").length
            const medCount = matched.filter(s => s.quality === "medium").length
            const lowCount = matched.filter(s => s.quality === "low").length
            const noneCount = matched.filter(s => s.quality === "none").length

            setStatusMessage(
                `✅ ${highCount} high, 🟡 ${medCount} med, 🟠 ${lowCount} low, ❌ ${noneCount} none | ${mediaFiles.length} files`
            )
            setImportStatus("idle")

            // ⭐ Đồng bộ sang shared context (để Music/SFX/Highlight tabs dùng)
            setSharedMatchingSentences(matched)
            if (mediaFolder) setSharedMatchingFolder(mediaFolder)
        } catch (error) {
            console.error("Lỗi matching:", error)
            setErrorMessage("Lỗi matching: " + String(error))
            setImportStatus("error")
        }
    }

    /**
     * AI Match: dùng Claude local để matching chính xác hơn
     * Chia script thành 10 batch, mỗi batch gọi AI 1 lần
     */
    const handleAIMatch = async () => {
        try {
            setImportStatus("matching")
            setErrorMessage("")
            setAiProgress("Đang chuẩn bị...")
            setStatusMessage("🤖 AI đang matching...")

            // Parse script
            const sentences = parseScript(scriptText)
            if (sentences.length === 0) {
                setErrorMessage("Không tìm thấy câu nào trong script!")
                setImportStatus("error")
                return
            }

            // Đọc transcript
            const timelineId = timelineInfo?.timelineId || ""
            if (!timelineId) {
                setErrorMessage("Không tìm thấy timelineId!")
                setImportStatus("error")
                return
            }

            const transcript = await readTranscript(`${timelineId}.json`)
            if (!transcript) {
                setErrorMessage("Không tìm thấy transcript file!")
                setImportStatus("error")
                return
            }

            // Gọi AI matcher với progress callback + truyền mediaFolder để lưu cache
            const matched = await aiMatchScriptToTimeline(
                sentences,
                transcript,
                (progress) => {
                    setAiProgress(progress.message)
                    setStatusMessage(`🤖 ${progress.message}`)
                },
                mediaFolder // ⭐ Truyền folder để AI tự lưu kết quả
            )

            updateMediaImport({ matchedSentences: matched })

            // Thống kê
            const highCount = matched.filter(s => s.quality === "high").length
            const noneCount = matched.filter(s => s.quality === "none").length

            setStatusMessage(
                `🤖 AI: ✅ ${highCount} matched, ❌ ${noneCount} failed | ${mediaFiles.length} files`
            )
            setAiProgress("")
            setImportStatus("idle")

            // ⭐ Đồng bộ sang shared context (để Music/SFX/Highlight tabs dùng)
            setSharedMatchingSentences(matched)
            if (mediaFolder) setSharedMatchingFolder(mediaFolder)
        } catch (error) {
            console.error("Lỗi AI matching:", error)
            setErrorMessage("Lỗi AI matching: " + String(error))
            setAiProgress("")
            setImportStatus("error")
        }
    }

    /**
     * Xuất report matching thành file text để review
     */
    const handleExportReport = async () => {
        try {
            const report = generateMatchReport(matchedSentences, mediaFiles)
            const dlDir = await downloadDir()
            const defaultPath = await join(dlDir, "matching_report.txt")

            const filePath = await save({
                defaultPath: defaultPath,
                filters: [{ name: "Text File", extensions: ["txt"] }],
            })

            if (filePath) {
                await writeTextFile(filePath, report)
                setStatusMessage(`Report đã lưu: ${filePath}`)
            }
        } catch (error) {
            console.error("Lỗi xuất report:", error)
            setErrorMessage("Lỗi xuất report: " + String(error))
        }
    }

    /**
     * Xuất file SRT dạng text dễ đọc (.txt)
     * Format: #1 | 00:00:00 → 00:00:02 | Text
     */
    const handleExportSRT = async () => {
        try {
            // Tạo nội dung dễ đọc
            const lines = matchedSentences.map((s, i) => {
                const startSrt = secondsToSrt(s.start)
                const endSrt = secondsToSrt(s.end)
                const quality = s.quality || "unknown"
                return `#${i + 1} | ${startSrt} → ${endSrt} | [${quality}]\n${s.text}\n---`
            })

            // Header thống kê
            const header = [
                "═══ MATCHING REVIEW (SRT) ═══",
                `Tổng: ${matchedSentences.length} câu`,
                `Thời gian: ${new Date().toLocaleString("vi-VN")}`,
                "═══════════════════════════════",
                ""
            ].join("\n")

            const srtContent = header + lines.join("\n")

            const dlDir = await downloadDir()
            const defaultPath = await join(dlDir, "matching_review.txt")

            const filePath = await save({
                defaultPath: defaultPath,
                filters: [{ name: "Text File", extensions: ["txt"] }],
            })

            if (filePath) {
                await writeTextFile(filePath, srtContent)
                setStatusMessage(`✅ Đã lưu: ${filePath}`)
            }
        } catch (error) {
            console.error("Lỗi xuất SRT:", error)
            setErrorMessage("Lỗi xuất SRT: " + String(error))
        }
    }

    /**
     * Import file SRT từ bên ngoài (CapCut, v.v.)
     * Parse file .srt → tạo matchedSentences với timing chính xác
     */
    const handleImportSRT = async () => {
        try {
            // Mở dialog chọn file SRT
            const filePath = await open({
                filters: [{ name: "SRT File", extensions: ["srt", "txt"] }],
                multiple: false,
            })

            if (!filePath) return

            // Đọc nội dung file
            const content = await readTextFile(filePath as string)

            // Parse SRT
            const parsed = parseSrtContent(content)

            if (parsed.length === 0) {
                setErrorMessage("Không tìm thấy subtitle nào trong file!")
                return
            }

            // Chuyển thành matchedSentences
            const sentences: ScriptSentence[] = parsed.map((entry) => ({
                num: entry.index,
                text: entry.text,
                start: entry.start,
                end: entry.end,
                quality: "high" as const,
                matchRate: "srt-import",
                matchedWhisper: "(imported from SRT)",
            }))

            updateMediaImport({ matchedSentences: sentences })
            setImportStatus("done")
            setStatusMessage(`✅ Đã import ${sentences.length} subtitle từ SRT`)
            setErrorMessage("")
        } catch (error) {
            console.error("Lỗi import SRT:", error)
            setErrorMessage("Lỗi import SRT: " + String(error))
        }
    }

    /**
     * Import media vào DaVinci Resolve timeline
     * Đặt clips ĐÚNG vị trí thời gian từ matching
     * Đoạn nào chưa có video / AI chưa nhận diện → để trống
     * Log request/response vào Debug panel để dễ debug
     */
    const handleImport = async () => {
        const logId = generateLogId()
        const startTime = Date.now()

        try {
            setImportStatus("importing")
            setErrorMessage("")
            setStatusMessage("Đang import media vào DaVinci Resolve...")

            // Tạo danh sách clips với thời gian thật từ matching
            const clips: Array<{ filePath: string; startTime: number; endTime: number }> = []

            for (const file of mediaFiles) {
                const fileNum = getFileNumber(file)

                // Tìm câu script tương ứng với số file
                const sentence = matchedSentences.find(s => s.num === fileNum)
                if (sentence && sentence.end > sentence.start) {
                    clips.push({
                        filePath: file,
                        // ⭐ Dùng thời gian thật từ matching
                        // Đặt đúng vị trí trên timeline
                        startTime: sentence.start,
                        endTime: sentence.end,
                    })
                }
            }

            if (clips.length === 0) {
                setErrorMessage("Không có clip nào để import! Kiểm tra lại matching.")
                setImportStatus("error")
                return
            }

            // ⭐ Sort theo startTime (sớm nhất trước)
            clips.sort((a, b) => a.startTime - b.startTime)

            console.log(`[Import] ${clips.length} clips, sort theo startTime`)

            // ⭐ Log request vào Debug panel
            const requestBody = JSON.stringify({
                func: "AddMediaToTimeline",
                clips,
                trackIndex: selectedTrack,
            })
            addDebugLog({
                id: logId,
                timestamp: new Date(),
                method: "POST",
                url: "http://localhost:56003/",
                requestHeaders: { "Content-Type": "application/json" },
                requestBody,
                status: null,
                responseHeaders: {},
                responseBody: "(đang gửi...)",
                duration: 0,
                error: null,
                label: `Import ${clips.length} clips → track ${selectedTrack}`,
            })

            // Gọi API import
            const result = await addMediaToTimeline(clips, selectedTrack)
            const duration = Date.now() - startTime

            // ⭐ Log response vào Debug panel
            updateDebugLog(logId, {
                status: result.error ? 500 : 200,
                responseBody: JSON.stringify(result, null, 2),
                duration,
                error: result.error ? (result.message || "Lỗi không rõ") : null,
            })

            if (result.error) {
                setErrorMessage("Lỗi từ DaVinci Resolve: " + result.message)
                setImportStatus("error")
                return
            }

            // Hiển thị kết quả chi tiết hơn
            const addedCount = result.clipsAdded || clips.length
            setStatusMessage(`Import thành công ${addedCount} clips vào track ${selectedTrack}!`)
            setImportStatus("done")

            // ⭐ Lưu danh sách số câu đã import để click xem
            const importedSentenceNums = clips.map(c => {
                const sentence = matchedSentences.find(s => s.start === c.startTime && s.end === c.endTime)
                return sentence?.num ?? 0
            }).filter(n => n > 0).sort((a, b) => a - b)
            setImportedNums(importedSentenceNums)
        } catch (error) {
            const duration = Date.now() - startTime
            console.error("Lỗi import:", error)

            // ⭐ Log lỗi vào Debug panel
            updateDebugLog(logId, {
                duration,
                error: String(error),
                responseBody: `(Lỗi: ${String(error)})`,
            })

            setErrorMessage("Lỗi import: " + String(error))
            setImportStatus("error")
        }
    }

    // Kiểm tra có thể match không
    const canMatch = scriptText.trim().length > 0 && mediaFiles.length > 0
    // Kiểm tra có thể import không
    const canImport = matchedSentences.length > 0 && mediaFiles.length > 0

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="shrink-0 px-4 pt-4 pb-2 border-b">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                    <FileVideo className="h-5 w-5 text-primary" />
                    Video Import
                </h3>
                <p className="text-xs text-muted-foreground mt-1">
                    Import video files vào timeline, tự động căn khớp với thời gian từng câu script
                </p>
            </div>

            <ScrollArea className="flex-1 min-h-0">
                <div className="p-4 space-y-4">

                    {/* 1. Chọn folder video */}
                    <div className="space-y-2">
                        <label className="text-sm font-medium">1. Chọn folder chứa video</label>
                        <Button
                            variant="outline"
                            className="w-full justify-start gap-2 h-10"
                            onClick={handleSelectFolder}
                        >
                            <FolderOpen className="h-4 w-4" />
                            {mediaFolder
                                ? mediaFolder.split(/[/\\]/).pop()
                                : "Chọn folder..."}
                        </Button>
                        {mediaFiles.length > 0 && (
                            <p className="text-xs text-muted-foreground">
                                📁 {mediaFiles.length} video files (scene_{getFileNumber(mediaFiles[0])} → scene_{getFileNumber(mediaFiles[mediaFiles.length - 1])})
                            </p>
                        )}
                    </div>

                    {/* 2. Paste script */}
                    <div className="space-y-2">
                        <label className="text-sm font-medium">2. Dán kịch bản (đánh số câu)</label>
                        <textarea
                            className="w-full h-40 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
                            placeholder={`Paste script vào đây, ví dụ:\n1. February twenty-second, two thousand twenty-six.\n2. Pre-dawn.\n3. The mountains of Tapalpa...`}
                            value={scriptText}
                            onChange={(e) => {
                                setSharedScriptText(e.target.value)
                                updateMediaImport({ matchedSentences: [] }) // Reset khi sửa script
                            }}
                        />
                        {scriptText && (
                            <p className="text-xs text-muted-foreground">
                                📝 {parseScript(scriptText).length} câu trong script
                            </p>
                        )}
                    </div>

                    {/* 3. Track — cố định V1 (Video AI) */}
                    <div className="space-y-2">
                        <label className="text-sm font-medium">3. Track video đích</label>
                        <div className="flex items-center gap-2 px-3 py-2 rounded-md border bg-muted/30 text-sm text-muted-foreground">
                            📹 Track V1 — Video AI (cố định)
                        </div>
                    </div>

                    {/* 4. Nút hành động */}
                    <div className="space-y-2 pt-2">
                        {/* Nút AI Match */}
                        <Button
                            variant="default"
                            className="w-full gap-2"
                            onClick={handleAIMatch}
                            disabled={!canMatch || importStatus === "matching" || importStatus === "importing"}
                        >
                            {importStatus === "matching" && aiProgress ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Sparkles className="h-4 w-4" />
                            )}
                            AI Match
                        </Button>

                        {/* Hiển thị AI progress */}
                        {aiProgress && (
                            <p className="text-xs text-blue-400 animate-pulse">
                                🤖 {aiProgress}
                            </p>
                        )}



                        {/* Nút Import */}
                        <Button
                            className="w-full gap-2"
                            onClick={handleImport}
                            disabled={!canImport || importStatus === "importing"}
                        >
                            {importStatus === "importing" ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Upload className="h-4 w-4" />
                            )}
                            {importStatus === "importing" ? "Đang import..." : `Import ${matchedSentences.length > 0 ? matchedSentences.length : ""} Clips vào Timeline`}
                        </Button>

                        {/* Nút quét timeline để tìm câu thiếu */}
                        {matchedSentences.length > 0 && (
                            <Button
                                variant="outline"
                                className="w-full gap-2"
                                onClick={async () => {
                                    setIsScanning(true)
                                    try {
                                        const result = await getTrackClipNumbers(selectedTrack)
                                        if (result.error) {
                                            setErrorMessage(result.message || "Lỗi quét timeline")
                                            setTimelineMissing(null)
                                        } else {
                                            // So khớp bằng TIME RANGE (hoạt động với mọi tên file)
                                            // Câu nào không có clip nào phủ khoảng thời gian = thiếu
                                            const ranges = result.clipRanges || []
                                            const missing = matchedSentences
                                                .filter(s => {
                                                    // Kiểm tra: có clip nào trên timeline phủ >= 50% thời gian câu này?
                                                    const sentMid = (s.start + s.end) / 2
                                                    return !ranges.some(r =>
                                                        r.start <= sentMid && r.endTime >= sentMid
                                                    )
                                                })
                                                .map(s => s.num)
                                            setTimelineMissing(missing)
                                            setStatusMessage(`Track V1: ${result.totalClips} clips | Thiếu ${missing.length}/${matchedSentences.length} câu`)
                                        }
                                    } catch (err) {
                                        setErrorMessage("Không kết nối được DaVinci: " + String(err))
                                        setTimelineMissing(null)
                                    }
                                    setIsScanning(false)
                                }}
                                disabled={isScanning}
                            >
                                {isScanning ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Search className="h-4 w-4" />
                                )}
                                {isScanning ? "Đang quét..." : `Quét Timeline V1 → Tìm câu thiếu`}
                            </Button>
                        )}
                    </div>

                    {/* Kết quả quét timeline: câu thiếu */}
                    {timelineMissing !== null && (
                        <MissingMediaSection
                            missingNums={timelineMissing}
                            matchedSentences={matchedSentences}
                            onRemove={(num) => setTimelineMissing(prev => prev ? prev.filter(n => n !== num) : null)}
                        />
                    )}

                    {/* Status message */}
                    {statusMessage && (
                        <div className={`text-sm p-3 rounded-md ${importStatus === "done"
                            ? "bg-green-500/10 text-green-500 border border-green-500/20"
                            : importStatus === "error"
                                ? "bg-red-500/10 text-red-500 border border-red-500/20"
                                : "bg-blue-500/10 text-blue-500 border border-blue-500/20"
                            }`}>
                            {importStatus === "done" && <CheckCircle2 className="h-4 w-4 inline mr-1" />}
                            {importStatus === "error" && <AlertCircle className="h-4 w-4 inline mr-1" />}
                            {statusMessage}
                        </div>
                    )}

                    {/* Danh sách câu đã import — click để jump */}
                    {importedNums.length > 0 && (
                        <div className="space-y-1">
                            <label className="text-sm font-medium text-green-500">
                                ✅ Đã import {importedNums.length} clips
                            </label>
                            <div className="flex flex-wrap gap-1 bg-muted/50 rounded px-2 py-1.5 max-h-32 overflow-y-auto">
                                {importedNums.map((num) => (
                                    <button
                                        key={num}
                                        onClick={async () => {
                                            const sent = matchedSentences.find(s => s.num === num)
                                            if (sent) {
                                                try { await seekToTime(sent.start) } catch { }
                                            }
                                        }}
                                        className="text-xs font-mono px-1.5 py-0.5 rounded bg-background hover:bg-green-500/20 hover:text-green-500 cursor-pointer transition-colors border border-transparent hover:border-green-500/30"
                                        title={`Nhảy đến câu ${num}`}
                                    >
                                        {num}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Error message */}
                    {errorMessage && (
                        <div className="text-sm p-3 rounded-md bg-red-500/10 text-red-500 border border-red-500/20">
                            <AlertCircle className="h-4 w-4 inline mr-1" />
                            {errorMessage}
                        </div>
                    )}

                    {/* Tìm kiếm câu theo số hoặc text → nhảy timeline */}
                    <SentenceSearch matchedSentences={matchedSentences} />

                    {/* 6. Preview kết quả matching */}
                    {matchedSentences.length > 0 && (
                        <div className="space-y-2">
                            <label className="text-sm font-medium">
                                Kết quả matching ({matchedSentences.length} câu)
                            </label>
                            <div className="border rounded-md divide-y max-h-60 overflow-y-auto" style={{ overflowX: 'hidden' }}>
                                {matchedSentences.map((sent) => {
                                    // Tìm file tương ứng
                                    const hasFile = mediaFiles.some(f => getFileNumber(f) === sent.num)
                                    const duration = (sent.end - sent.start).toFixed(1)
                                    const qualityIcon = sent.quality === "high" ? "✅" : sent.quality === "medium" ? "🟡" : sent.quality === "low" ? "🟠" : "❌"
                                    const qualityBg = sent.quality === "none" ? "bg-red-500/5" : sent.quality === "low" ? "bg-yellow-500/5" : ""

                                    return (
                                        <div
                                            key={sent.num}
                                            className={`px-3 py-2 text-xs ${qualityBg} ${hasFile ? "" : "opacity-50"}`}
                                            style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', overflow: 'hidden' }}
                                        >
                                            {/* Quality icon + Số thứ tự */}
                                            <span className="font-mono text-muted-foreground shrink-0 text-right" style={{ width: '48px' }}>
                                                {qualityIcon} #{sent.num}
                                            </span>

                                            {/* Nội dung — w-0 + flex-1 trick để truncate hoạt động đúng trong flex */}
                                            <div style={{ flex: '1 1 0', minWidth: 0, width: 0, overflow: 'hidden' }}>
                                                {/* Dòng script text */}
                                                <p style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className="text-foreground" title={sent.text}>
                                                    {sent.text}
                                                </p>
                                                {/* Dòng Whisper matched — text AI trả về thường rất dài */}
                                                <p style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className="text-muted-foreground mt-0.5" title={sent.matchedWhisper}>
                                                    🎤 {sent.matchedWhisper || "(không match)"}
                                                </p>
                                                {/* Dòng timing + quality */}
                                                <p style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className="text-muted-foreground mt-0.5">
                                                    ⏱️ {sent.start.toFixed(2)}s → {sent.end.toFixed(2)}s ({duration}s)
                                                    <span className="ml-2">{sent.matchRate}</span>
                                                    {!hasFile && <span className="ml-2 text-yellow-500">⚠️ Thiếu file</span>}
                                                </p>
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        </div>
                    )}
                </div>
            </ScrollArea>
        </div>
    )
}
