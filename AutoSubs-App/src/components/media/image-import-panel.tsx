// @ts-nocheck
// image-import-panel.tsx
// Panel giao diện cho tính năng Image Import vào DaVinci Resolve timeline
// Cho phép chọn folder ảnh, paste script vào textarea, so khớp Whisper/SRT lấy timing, import vào timeline
// KHÔNG ảnh hưởng đến Media Import hay bất kỳ tab nào khác
//
// Flow: Chọn folder ảnh → Paste script → Match Whisper (Logic/AI) → Import Timeline

import * as React from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
    FolderOpen,
    Upload,
    Image as ImageIcon,
    CheckCircle2,
    AlertCircle,
    Loader2,
    Copy,
    Check,
    Sparkles,
    ClipboardPaste,
    ListOrdered,
} from "lucide-react"
import { open, save } from "@tauri-apps/plugin-dialog"
import { readDir, writeTextFile, readTextFile } from "@tauri-apps/plugin-fs"
import { addDebugLog, updateDebugLog, generateLogId } from "@/services/debug-logger"
import { join, downloadDir } from "@tauri-apps/api/path"
import { addMediaToTimeline, seekToTime } from "@/api/resolve-api"
import { readTranscript } from "@/utils/file-utils"
import {
    extractWhisperWords,
    matchScriptToTimeline,
    ScriptSentence,
} from "@/utils/media-matcher"
import { aiMatchScriptToTimeline } from "@/services/ai-matcher"
import { saveMatchingResults } from "@/services/ai-matcher"
import { useResolve } from "@/contexts/ResolveContext"
import { useProject } from "@/contexts/ProjectContext"
import {
    sortImagesByScene,
    getImageSceneNumber,
    getImageType,
    formatTime,
    generateImageMatchReport,
    ImageMatchResult,
} from "@/utils/image-matcher"
import {
    isStillImage,
    convertImagesToVideo,
    getVideoOutputPath,
    ensureTempDir,
    ConvertJob,
} from "@/services/image-converter"

// ======================== TYPES ========================

// Trạng thái import
type ImportStatus = "idle" | "matching" | "importing" | "done" | "error"

// ======================== PARSE SRT ========================

/** Parse timestamp SRT (00:01:23,456) thành giây */
function parseSrtTime(timeStr: string): number {
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
    const blocks = content.trim().split(/\n\s*\n/)

    for (const block of blocks) {
        const lines = block.trim().split("\n")
        if (lines.length < 3) continue

        const index = parseInt(lines[0].trim())
        if (isNaN(index)) continue

        const timeLine = lines[1].trim()
        const timeMatch = timeLine.match(/([\d:,.]+)\s*-->\s*([\d:,.]+)/)
        if (!timeMatch) continue

        const start = parseSrtTime(timeMatch[1])
        const end = parseSrtTime(timeMatch[2])

        const text = lines.slice(2).join(" ").trim()
        if (!text) continue

        results.push({ index, start, end, text })
    }

    return results
}

// ======================== MISSING IMAGES SECTION ========================

/**
 * Hiển thị danh sách scene chưa có ảnh trên timeline
 * + Nút copy danh sách số scene thiếu
 * + Bấm vào số scene → nhảy playhead đến vị trí đó
 */
function MissingImagesSection({
    missingScenes,
    matchResults,
    onRemove,
}: {
    missingScenes: number[]
    matchResults: ImageMatchResult[]
    onRemove?: (sceneNum: number) => void
}) {
    const [copied, setCopied] = React.useState(false)
    const [selectedScene, setSelectedScene] = React.useState<number | null>(null)

    // Copy danh sách số scene (mỗi số 1 dòng)
    const handleCopy = () => {
        const text = missingScenes.join("\n")
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    // Bấm vào số scene → nhảy playhead trên timeline DaVinci
    const handleClick = async (sceneNum: number) => {
        setSelectedScene(sceneNum)
        const result = matchResults.find(r => r.sceneNum === sceneNum)
        if (!result || result.startTime <= 0) return
        try {
            await seekToTime(result.startTime)
        } catch (err) {
            console.error("[Image Import] Seek lỗi:", err)
        }
    }

    // Phím Backspace/Delete → xoá scene đang chọn
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if ((e.key === "Backspace" || e.key === "Delete") && selectedScene !== null) {
            e.preventDefault()
            onRemove?.(selectedScene)
            setSelectedScene(null)
        }
    }

    return (
        <div className="space-y-1">
            <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-yellow-500">
                    ⚠️ Thiếu {missingScenes.length} ảnh trên timeline
                </label>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 text-xs text-muted-foreground"
                    onClick={handleCopy}
                >
                    {copied ? (
                        <><Check className="h-3 w-3 text-green-500" /> Đã copy</>
                    ) : (
                        <><Copy className="h-3 w-3" /> Copy số scene</>
                    )}
                </Button>
            </div>
            {/* Danh sách số scene thiếu — bấm chọn, Backspace xoá */}
            <div
                tabIndex={0}
                onKeyDown={handleKeyDown}
                className="flex flex-wrap gap-1 bg-muted/50 rounded px-2 py-1.5 max-h-32 overflow-y-auto outline-none focus:ring-1 focus:ring-yellow-500/30"
            >
                {missingScenes.map((num) => (
                    <button
                        key={num}
                        onClick={() => handleClick(num)}
                        className={`text-xs font-mono px-1.5 py-0.5 rounded cursor-pointer transition-colors border ${selectedScene === num
                            ? "bg-yellow-500/30 text-yellow-500 border-yellow-500/50"
                            : "bg-background hover:bg-yellow-500/20 hover:text-yellow-500 border-transparent hover:border-yellow-500/30"
                            }`}
                        title={`Scene ${num} | Backspace để xoá`}
                    >
                        {num}
                    </button>
                ))}
            </div>
            {selectedScene !== null && (
                <p className="text-xs text-muted-foreground">
                    Đang chọn scene <strong>{selectedScene}</strong> — nhấn <kbd className="px-1 py-0.5 rounded bg-muted border text-[10px]">⌫</kbd> để xoá
                </p>
            )}
        </div>
    )
}

// ======================== MAIN COMPONENT ========================

export function ImageImportPanel() {
    // ======================== CONTEXTS ========================

    // ProjectContext — dữ liệu persist (lưu session, chia sẻ giữa các tab)
    const {
        project,
        updateImageImport,
        setMatchingFolder: setSharedMatchingFolder,
        setMatchingSentences: setSharedMatchingSentences,
    } = useProject()
    // Destructure với giá trị mặc định — đề phòng session cũ không có field mới
    const {
        imageFolder = '',
        imageFiles = [],
        scriptText = '',
        matchedSentences = [],
        matchResults = [],
        selectedTrack = '1',
        importedScenes = [],
    } = project.imageImport || {}

    // Resolve Context
    const { timelineInfo } = useResolve()

    // ======================== LOCAL STATE (chỉ UI transient) ========================

    // Trạng thái import/matching (không cần persist)
    const [importStatus, setImportStatus] = React.useState<ImportStatus>("idle")
    const [statusMessage, setStatusMessage] = React.useState<string>("")
    const [errorMessage, setErrorMessage] = React.useState<string>("")
    const [aiProgress, setAiProgress] = React.useState<string>("")
    const [timelineMissing, setTimelineMissing] = React.useState<number[] | null>(null)
    const [isScanning, setIsScanning] = React.useState(false)

    // ======================== HELPER: setter cho ProjectContext ========================
    // Gói gọn để code cũ không cần thay đổi nhiều
    const setImageFolder = (v: string) => updateImageImport({ imageFolder: v })
    const setImageFiles = (v: string[]) => updateImageImport({ imageFiles: v })
    const setScriptText = (v: string) => updateImageImport({ scriptText: v })
    const setMatchedSentences = (v: ScriptSentence[]) => updateImageImport({ matchedSentences: v })
    const setMatchResults = (v: ImageMatchResult[]) => updateImageImport({ matchResults: v })
    const setSelectedTrack = (v: string) => updateImageImport({ selectedTrack: v })
    const setImportedScenes = (v: number[]) => updateImageImport({ importedScenes: v })

    // ======================== CHỌN FOLDER ẢNH ========================

    /**
     * Chọn folder chứa ảnh
     * Quét tất cả file .jpg, .png, .webp, .jpeg trong folder
     */
    const handleSelectFolder = async () => {
        try {
            const folderPath = await open({
                directory: true,
                multiple: false,
                title: "Chọn folder chứa ảnh (images)",
            })

            if (!folderPath) return

            setImageFolder(folderPath as string)

            // Quét folder để tìm file ảnh
            const entries = await readDir(folderPath as string)
            const imageExtensions = [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"]
            const imgFiles: string[] = []

            for (const entry of entries) {
                if (entry.name) {
                    const ext = entry.name.toLowerCase().slice(entry.name.lastIndexOf("."))
                    if (imageExtensions.includes(ext)) {
                        const fullPath = await join(folderPath as string, entry.name)
                        imgFiles.push(fullPath)
                    }
                }
            }

            // Sắp xếp theo scene number
            const sorted = sortImagesByScene(imgFiles)
            setImageFiles(sorted)
            setStatusMessage(`Tìm thấy ${sorted.length} file ảnh`)

            // Reset kết quả cũ
            setMatchResults([])
            setMatchedSentences([])
            setImportStatus("idle")
        } catch (error) {
            console.error("[Image Import] Lỗi chọn folder:", error)
            setErrorMessage("Không thể đọc folder: " + String(error))
        }
    }

    // (Excel đã bỏ — user paste script trực tiếp vào textarea)

    // ======================== AUTO-NUMBER SCRIPT ========================

    /**
     * Kiểm tra xem text đã có số thứ tự chưa.
     * Đếm bao nhiêu dòng bắt đầu bằng số (vd: "1. text", "2) text").
     * Nếu < 30% dòng có số → coi như chưa đánh số.
     */
    const isScriptNumbered = (text: string): boolean => {
        const lines = text.split("\n").filter(l => l.trim().length > 0)
        if (lines.length === 0) return true // text rỗng
        const numberedCount = lines.filter(l => l.trim().match(/^\d+[.):\s]+/)).length
        return numberedCount / lines.length > 0.3 // >30% dòng có số → đã đánh số
    }

    /**
     * Tự đánh số cho script: mỗi dòng không rỗng → "N. text"
     * Nếu dòng đã có số rồi → giữ nguyên (không đánh lại)
     */
    const autoNumberScript = (text: string): string => {
        const lines = text.split("\n")
        let counter = 0
        const numbered = lines.map(line => {
            const trimmed = line.trim()
            if (!trimmed) return "" // Giữ dòng trống
            // Nếu dòng đã có số → giữ nguyên
            if (trimmed.match(/^\d+[.):\s]+/)) return trimmed
            // Chưa có số → tự thêm
            counter++
            return `${counter}. ${trimmed}`
        })
        return numbered.filter(l => l.length > 0).join("\n")
    }

    /**
     * Handler khi paste text vào textarea.
     * Nếu text không có số → tự đánh số và hiển thị ngay.
     */
    const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const pastedText = e.clipboardData.getData("text")
        if (!pastedText.trim()) return

        // Nếu text chưa được đánh số → tự đánh số
        if (!isScriptNumbered(pastedText)) {
            e.preventDefault() // Chặn paste mặc định
            const numbered = autoNumberScript(pastedText)
            setScriptText(numbered)
            // Reset matching
            setMatchedSentences([])
            setMatchResults([])
            setStatusMessage(`✅ Đã tự đánh số: ${numbered.split("\n").filter(l => l.trim().match(/^\d+[.):\s]/)).length} beats`)
        }
        // Nếu đã có số → để paste bình thường (onChange sẽ xử lý)
    }

    /**
     * Nút bấm thủ công: đánh số lại toàn bộ script
     */
    const handleAutoNumber = () => {
        if (!scriptText.trim()) return
        const numbered = autoNumberScript(scriptText)
        setScriptText(numbered)
        setMatchedSentences([])
        setMatchResults([])
        setStatusMessage(`✅ Đã đánh số lại: ${numbered.split("\n").filter(l => l.trim().match(/^\d+[.):\s]/)).length} beats`)
    }

    // ======================== WHISPER MATCHING (LOGIC) ========================

    /**
     * Logic Match: so khớp script (từ Excel) với Whisper word timings
     * Giống hệt Media Import → lấy timing chính xác từ audio transcript
     * Sau đó kết hợp với scene number ảnh
     */
    const handleLogicMatch = async () => {
        try {
            setImportStatus("matching")
            setErrorMessage("")
            setStatusMessage("Đang matching text với Whisper...")

            // Bước 1: Parse script text thành câu có số thứ tự
            const lines = scriptText.split("\n")
            const sentences: { num: number; text: string }[] = []
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

            if (sentences.length === 0) {
                setErrorMessage("Không tìm thấy câu nào trong script. Hãy paste script vào ô text phía trên!")
                setImportStatus("error")
                return
            }

            // Bước 2: Đọc transcript JSON (Whisper) từ DaVinci timeline
            const timelineId = timelineInfo?.timelineId || ""
            if (!timelineId) {
                setErrorMessage("Không tìm thấy timelineId. Hãy kết nối DaVinci Resolve và transcribe audio trước!")
                setImportStatus("error")
                return
            }

            const transcript = await readTranscript(`${timelineId}.json`)
            if (!transcript) {
                setErrorMessage(`Không tìm thấy transcript file: ${timelineId}.json. Hãy transcribe audio trước!`)
                setImportStatus("error")
                return
            }

            // Bước 3: Trích xuất Whisper words
            const whisperWords = extractWhisperWords(transcript)
            if (whisperWords.length === 0) {
                setErrorMessage("Transcript không có word timings. Cần transcribe lại với word-level timestamps.")
                setImportStatus("error")
                return
            }

            // Bước 4: Chạy text matching (giống Media Import)
            const matched = matchScriptToTimeline(sentences, whisperWords)
            setMatchedSentences(matched)

            // Bước 5: Kết hợp timing Whisper với scene number ảnh
            const imageResults = buildImageResults(matched)
            setMatchResults(imageResults)

            // Thống kê
            const highCount = matched.filter(s => s.quality === "high").length
            const medCount = matched.filter(s => s.quality === "medium").length
            const lowCount = matched.filter(s => s.quality === "low").length
            const noneCount = matched.filter(s => s.quality === "none").length

            setStatusMessage(
                `✅ ${highCount} high, 🟡 ${medCount} med, 🟠 ${lowCount} low, ❌ ${noneCount} none | ${imageFiles.length} ảnh`
            )
            setImportStatus("done")

            // ⭐ Lưu autosubs_matching.json vào folder ảnh
            if (imageFolder) {
                await saveMatchingResults(imageFolder, matched)
                console.log(`[Image Import] ✅ Đã lưu autosubs_matching.json vào ${imageFolder}`)
            }

            // ⭐ Đồng bộ sang shared context (để Music/SFX/Highlight tabs dùng)
            setSharedMatchingSentences(matched)
            if (imageFolder) setSharedMatchingFolder(imageFolder)
        } catch (error) {
            console.error("[Image Import] Lỗi Logic Match:", error)
            setErrorMessage("Lỗi matching: " + String(error))
            setImportStatus("error")
        }
    }

    // ======================== AI MATCHING ========================

    /**
     * AI Match: dùng AI (Claude/Gemini) để matching chính xác hơn
     * Giống hệt Media Import → gửi transcript + script cho AI
     */
    const handleAIMatch = async () => {
        try {
            setImportStatus("matching")
            setErrorMessage("")
            setAiProgress("Đang chuẩn bị...")
            setStatusMessage("🤖 AI đang matching...")

            // Parse script
            const lines = scriptText.split("\n")
            const sentences: { num: number; text: string }[] = []
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

            // Gọi AI matcher với progress callback
            // Truyền imageFolder để AI lưu cache (nếu có)
            const matched = await aiMatchScriptToTimeline(
                sentences,
                transcript,
                (progress) => {
                    setAiProgress(progress.message)
                    setStatusMessage(`🤖 ${progress.message}`)
                },
                imageFolder || undefined
            )

            setMatchedSentences(matched)

            // Kết hợp timing AI với scene number ảnh
            const imageResults = buildImageResults(matched)
            setMatchResults(imageResults)

            // Thống kê
            const highCount = matched.filter(s => s.quality === "high").length
            const noneCount = matched.filter(s => s.quality === "none").length

            setStatusMessage(
                `🤖 AI: ✅ ${highCount} matched, ❌ ${noneCount} failed | ${imageFiles.length} ảnh`
            )
            setAiProgress("")

            // ⭐ Lưu autosubs_matching.json vào folder ảnh
            if (imageFolder) {
                await saveMatchingResults(imageFolder, matched)
                console.log(`[Image Import] ✅ Đã lưu autosubs_matching.json vào ${imageFolder}`)
            }

            // ⭐ Đồng bộ sang shared context (để Music/SFX/Highlight tabs dùng)
            setSharedMatchingSentences(matched)
            if (imageFolder) setSharedMatchingFolder(imageFolder)

            // ======================== AUTO IMPORT ========================
            // Tự động convert + import vào DaVinci sau khi match xong
            console.log(`[Image Import] 🚀 Auto import: bắt đầu convert + import...`)
            setStatusMessage(`🚀 Tự động import ${imageResults.filter(r => r.quality === "matched").length} ảnh...`)

            try {
                await handleImport()
                console.log(`[Image Import] ✅ Auto import hoàn tất!`)
            } catch (importError) {
                console.error("[Image Import] ❌ Auto import lỗi:", importError)
                const errMsg = String(importError)
                if (errMsg.includes("kết nối") || errMsg.includes("connect") || errMsg.includes("ECONNREFUSED")) {
                    setErrorMessage("⚠️ Mất kết nối DaVinci Resolve — vào Settings → Reconnect rồi bấm Import lại")
                } else {
                    setErrorMessage("❌ Auto import lỗi: " + errMsg)
                }
                setImportStatus("error")
            }
        } catch (error) {
            console.error("[Image Import] Lỗi AI matching:", error)
            setErrorMessage("Lỗi AI matching: " + String(error))
            setAiProgress("")
            setImportStatus("error")
        }
    }

    // ======================== KẾT HỢP ẢNH + TIMING ========================

    /**
     * Kết hợp kết quả Whisper matching (timing) với file ảnh (scene number)
     *
     * Logic MỚI (không dùng Excel):
     * 1. Với mỗi file ảnh → lấy scene number từ tên file (vd: SCENE_05 → 5)
     * 2. Tìm trực tiếp sentence có num === sceneNum trong matchedSentences
     * 3. Timing ảnh = start/end của sentence đó
     *    (Nếu nhiều sentence cùng sceneNum thì lấy min(start) → max(end))
     */
    const buildImageResults = (whisperMatched: ScriptSentence[]): ImageMatchResult[] => {
        // Nhóm whisper matched sentences theo sentence number (= scene number)
        const sentenceByNum = new Map<number, ScriptSentence[]>()
        for (const s of whisperMatched) {
            if (!sentenceByNum.has(s.num)) {
                sentenceByNum.set(s.num, [])
            }
            sentenceByNum.get(s.num)!.push(s)
        }

        const results: ImageMatchResult[] = []

        for (const filePath of imageFiles) {
            const fileName = filePath.split(/[/\\]/).pop() || ""
            const sceneNum = getImageSceneNumber(filePath)
            const type = getImageType(filePath)

            // Tìm sentence(s) có num === sceneNum
            const matchedForScene = sentenceByNum.get(sceneNum) || []

            if (matchedForScene.length > 0) {
                // Có timing → dùng timing từ Whisper/AI
                const startTime = Math.min(...matchedForScene.map(s => s.start))
                const endTime = Math.max(...matchedForScene.map(s => s.end))
                const dialogues = matchedForScene.map(s => s.text)

                results.push({
                    filePath, fileName, sceneNum,
                    dialogues,
                    startTime, endTime,
                    rowCount: matchedForScene.length, type,
                    quality: "matched",
                })
            } else {
                // Không tìm thấy sentence tương ứng → chưa match
                results.push({
                    filePath, fileName, sceneNum,
                    dialogues: [],
                    startTime: 0, endTime: 0,
                    rowCount: 0, type,
                    quality: "no-excel",
                })
                console.warn(`[Image Import] ⚠️ Scene ${sceneNum} (${fileName}): không tìm thấy câu tương ứng trong script`)
            }
        }

        // Thống kê
        const matched = results.filter(r => r.quality === "matched").length
        const noMatch = results.filter(r => r.quality === "no-excel").length
        console.log(`[Image Import] Kết hợp: ${matched} matched, ${noMatch} no-match | Tổng ${results.length} ảnh`)

        return results
    }

    // ======================== IMPORT SRT (TÙY CHỌN) ========================

    /**
     * Import file SRT có sẵn (do user export từ tab Subtitles)
     * Parse SRT → lấy timing → kết hợp với scene number ảnh từ Excel
     */
    const handleImportSRT = async () => {
        try {
            const filePath = await open({
                filters: [{ name: "SRT File", extensions: ["srt", "txt"] }],
                multiple: false,
                title: "Chọn file SRT (đã export từ Subtitles)",
            })

            if (!filePath) return

            // Đọc nội dung file SRT
            const content = await readTextFile(filePath as string)

            // Parse SRT
            const parsed = parseSrtContent(content)

            if (parsed.length === 0) {
                setErrorMessage("Không tìm thấy subtitle nào trong file SRT!")
                return
            }

            // Chuyển thành ScriptSentence
            const sentences: ScriptSentence[] = parsed.map((entry) => ({
                num: entry.index,
                text: entry.text,
                start: entry.start,
                end: entry.end,
                quality: "high" as const,
                matchRate: "srt-import",
                matchedWhisper: "(imported from SRT)",
            }))

            setMatchedSentences(sentences)

            // Kết hợp SRT timing với scene number ảnh
            if (imageFiles.length > 0) {
                const imageResults = buildImageResults(sentences)
                setMatchResults(imageResults)

                const matched = imageResults.filter(r => r.quality === "matched").length
                setStatusMessage(`✅ SRT: ${parsed.length} câu → ${matched} ảnh matched`)
            } else {
                setStatusMessage(`✅ SRT: ${parsed.length} câu. Cần chọn folder ảnh để match scene.`)
            }

            setImportStatus("done")
            setErrorMessage("")

            // ⭐ Lưu autosubs_matching.json vào folder ảnh
            if (imageFolder) {
                await saveMatchingResults(imageFolder, sentences)
                console.log(`[Image Import] ✅ Đã lưu autosubs_matching.json từ SRT vào ${imageFolder}`)
            }

            // ⭐ Đồng bộ sang shared context (để Music/SFX/Highlight tabs dùng)
            setSharedMatchingSentences(sentences)
            if (imageFolder) setSharedMatchingFolder(imageFolder)
        } catch (error) {
            console.error("[Image Import] Lỗi import SRT:", error)
            setErrorMessage("Lỗi import SRT: " + String(error))
        }
    }

    // ======================== EXPORT REPORT ========================

    /**
     * Xuất report matching thành file text
     */
    const handleExportReport = async () => {
        try {
            const report = generateImageMatchReport(matchResults)
            const dlDir = await downloadDir()
            const defaultPath = await join(dlDir, "image_matching_report.txt")

            const filePath = await save({
                defaultPath,
                filters: [{ name: "Text File", extensions: ["txt"] }],
            })

            if (filePath) {
                await writeTextFile(filePath, report)
                setStatusMessage(`Report đã lưu: ${filePath}`)
            }
        } catch (error) {
            console.error("[Image Import] Lỗi xuất report:", error)
            setErrorMessage("Lỗi xuất report: " + String(error))
        }
    }

    // ======================== IMPORT VÀO TIMELINE ========================

    /**
     * Import ảnh vào DaVinci Resolve timeline
     * Đặt mỗi ảnh đúng vị trí thời gian từ Whisper matching
     */
    const handleImport = async () => {
        const logId = generateLogId()
        const startTime = Date.now()

        try {
            setImportStatus("importing")
            setErrorMessage("")
            setStatusMessage("Đang import ảnh vào DaVinci Resolve...")

            // Tạo danh sách clips từ match results
            const clips: Array<{ filePath: string; startTime: number; endTime: number }> = []
            let lastValidFilePath = "" // Lưu ảnh trước đó để lấp gaps

            for (const result of matchResults) {
                // Import tất cả clips có timing hợp lệ
                if (result.endTime > result.startTime) {
                    // Nếu có filePath → dùng, nếu không → dùng ảnh trước đó
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
                setErrorMessage("Không có ảnh nào để import! Kiểm tra lại matching.")
                setImportStatus("error")
                return
            }

            // Sort theo startTime
            clips.sort((a, b) => a.startTime - b.startTime)

            // ======================== LẤP KÍN GAPS TRÊN TIMELINE ========================
            // Nếu có khoảng trống giữa 2 clips → mở rộng clip trước để lấp
            for (let i = 0; i < clips.length - 1; i++) {
                const gap = clips[i + 1].startTime - clips[i].endTime
                if (gap > 0.05) { // gap > 50ms
                    console.log(`[Image Import] 🔧 Lấp gap: clip ${i} end ${clips[i].endTime.toFixed(2)}s → ${clips[i + 1].startTime.toFixed(2)}s`)
                    clips[i].endTime = clips[i + 1].startTime
                }
            }

            console.log(`[Image Import] ${clips.length} clips, sort theo startTime, gaps filled`)

            // ======================== CONVERT ẢNH TĨNH → VIDEO ========================
            // DaVinci Resolve API không hỗ trợ resize still image sau import
            // (luôn dùng "Standard still duration" = 5 giây mặc định)
            // → Convert ảnh → video MP4 với đúng duration trước, rồi import video

            // Tìm các clip là ảnh tĩnh cần convert
            const FPS = 24
            const stillImageJobs: ConvertJob[] = []
            for (const clip of clips) {
                if (isStillImage(clip.filePath)) {
                    // Tính frame count chính xác (tránh lệch do float)
                    const durationFrames = Math.max(1, Math.round((clip.endTime - clip.startTime) * FPS))
                    stillImageJobs.push({
                        inputPath: clip.filePath,
                        durationFrames,
                        outputPath: getVideoOutputPath(clip.filePath),
                    })
                }
            }

            if (stillImageJobs.length > 0) {
                // Tạo thư mục /tmp/autosubs-convert/ nếu chưa có
                await ensureTempDir()
                setStatusMessage(`🎨 Đang convert ${stillImageJobs.length} ảnh → video (60 song song)...`)

                const convertResults = await convertImagesToVideo(
                    stillImageJobs,
                    FPS,
                    (progress) => {
                        setStatusMessage(`🎨 Convert ảnh → video: ${progress.current}/${progress.total}`)
                    }
                )

                // Thay filePath ảnh bằng video output
                const successMap = new Map<string, string>()
                for (const r of convertResults) {
                    if (r.success) {
                        successMap.set(r.inputPath, r.outputPath)
                    }
                }

                // Cập nhật clips: thay ảnh → video
                for (const clip of clips) {
                    const videoPath = successMap.get(clip.filePath)
                    if (videoPath) {
                        clip.filePath = videoPath
                    }
                }

                const failCount = convertResults.filter(r => !r.success).length
                if (failCount > 0) {
                    console.warn(`[Image Import] ⚠️ ${failCount} ảnh convert lỗi, sẽ dùng ảnh gốc (duration 5s)`)
                }

                setStatusMessage(`✅ Convert xong ${stillImageJobs.length - failCount}/${stillImageJobs.length} ảnh. Đang import...`)
            }

            // Log request vào Debug panel
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
                label: `Image Import ${clips.length} clips → track ${selectedTrack}`,
            })

            // Gọi API import (cùng API như Media Import)
            const result = await addMediaToTimeline(clips, selectedTrack)
            const duration = Date.now() - startTime

            // Log response vào Debug panel
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

            const addedCount = result.clipsAdded || clips.length
            setStatusMessage(`Import thành công ${addedCount} ảnh vào track ${selectedTrack}!`)
            setImportStatus("done")

            // Lưu danh sách scene đã import
            const importedSceneNums = clips
                .map(c => {
                    const match = matchResults.find(r => r.filePath === c.filePath)
                    return match?.sceneNum ?? 0
                })
                .filter(n => n > 0)
                .sort((a, b) => a - b)
            setImportedScenes(importedSceneNums)
        } catch (error) {
            const duration = Date.now() - startTime
            console.error("[Image Import] Lỗi import:", error)

            // Log lỗi vào Debug panel
            updateDebugLog(logId, {
                duration,
                error: String(error),
                responseBody: `(Lỗi: ${String(error)})`,
            })

            setErrorMessage("Lỗi import: " + String(error))
            setImportStatus("error")
        }
    }

    // Kiểm tra có thể match Whisper không (cần có script + ảnh)
    // Cho phép match khi có script (có thể chưa có ảnh — match timing trước)
    const canWhisperMatch = scriptText.trim().length > 0
    // Kiểm tra có thể import không
    const canImport = matchResults.filter(r => r.quality === "matched").length > 0

    // ======================== RENDER ========================

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="shrink-0 px-4 pt-4 pb-2 border-b">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                    <ImageIcon className="h-5 w-5 text-primary" />
                    Image Import
                </h3>
                <p className="text-xs text-muted-foreground mt-1">
                    Import ảnh vào timeline — paste script + match Whisper/AI
                </p>
            </div>

            <ScrollArea className="flex-1 min-h-0">
                <div className="p-4 space-y-4">

                    {/* 1. Chọn folder ảnh */}
                    <div className="space-y-2">
                        <label className="text-sm font-medium">1. Chọn folder chứa ảnh</label>
                        <Button
                            variant="outline"
                            className="w-full justify-start gap-2 h-10"
                            onClick={handleSelectFolder}
                        >
                            <FolderOpen className="h-4 w-4" />
                            {imageFolder
                                ? imageFolder.split(/[/\\]/).pop()
                                : "Chọn folder..."}
                        </Button>
                        {imageFiles.length > 0 && (
                            <p className="text-xs text-muted-foreground">
                                📁 {imageFiles.length} ảnh (scene_{getImageSceneNumber(imageFiles[0])} → scene_{getImageSceneNumber(imageFiles[imageFiles.length - 1])})
                            </p>
                        )}
                    </div>

                    {/* 2. Paste script (luôn hiện — user paste trực tiếp) */}
                    <div className="space-y-2">
                        <label className="text-sm font-medium flex items-center gap-2">
                            2. Paste script
                            <ClipboardPaste className="h-3.5 w-3.5 text-muted-foreground" />
                        </label>
                        <textarea
                            className="w-full h-40 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y font-mono leading-relaxed"
                            placeholder={`Paste script vào đây (có hoặc không có số)...\n\nNếu KHÔNG có số → tự đánh số 1, 2, 3...\nNếu CÓ số (1. text) → giữ nguyên.\n\nVí dụ paste:\nBlack Girl Pulled Pregnant...\nHer arms were sliced open...\n\n→ Tự động thành:\n1. Black Girl Pulled Pregnant...\n2. Her arms were sliced open...`}
                            value={scriptText}
                            onPaste={handlePaste}
                            onChange={(e) => {
                                setScriptText(e.target.value)
                                // Reset matching khi sửa script
                                setMatchedSentences([])
                                setMatchResults([])
                            }}
                        />
                        {/* Thanh thông tin + nút đánh số */}
                        <div className="flex items-center justify-between">
                            <p className="text-xs text-muted-foreground">
                                📝 {scriptText.split("\n").filter(l => l.trim().match(/^\d+[.):\s]/)).length} beats
                                {imageFiles.length > 0 && ` | 📁 ${imageFiles.length} ảnh`}
                            </p>
                            {/* Nút đánh số tự động (thủ công) */}
                            {scriptText.trim().length > 0 && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 gap-1 text-xs text-muted-foreground hover:text-foreground"
                                    onClick={handleAutoNumber}
                                    title="Đánh số lại toàn bộ script (1, 2, 3...)"
                                >
                                    <ListOrdered className="h-3 w-3" />
                                    Đánh số lại
                                </Button>
                            )}
                        </div>
                    </div>

                    {/* 4. Chọn track */}
                    <div className="space-y-2">
                        <label className="text-sm font-medium">3. Track video đích</label>
                        <select
                            className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                            value={selectedTrack}
                            onChange={(e) => setSelectedTrack(e.target.value)}
                        >
                            {timelineInfo?.outputTracks?.map((track) => (
                                <option key={track.value} value={track.value}>
                                    {track.label}
                                </option>
                            )) || (
                                    <>
                                        <option value="1">Video Track 1</option>
                                        <option value="2">Video Track 2</option>
                                        <option value="3">Video Track 3</option>
                                        <option value="4">Video Track 4</option>
                                        <option value="5">Video Track 5</option>
                                    </>
                                )}
                        </select>
                    </div>

                    {/* 5. Nút hành động */}
                    <div className="space-y-2 pt-2">
                        {/* Nút AI Match */}
                        <Button
                            variant="default"
                            className="w-full gap-2"
                            onClick={handleAIMatch}
                            disabled={!canWhisperMatch || importStatus === "matching" || importStatus === "importing"}
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
                            {importStatus === "importing"
                                ? "Đang import..."
                                : `Import ${matchResults.filter(r => r.quality === "matched").length || ""} Ảnh vào Timeline`}
                        </Button>

                    </div>

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

                    {/* Danh sách scene đã import — click để jump */}
                    {importedScenes.length > 0 && (
                        <div className="space-y-1">
                            <label className="text-sm font-medium text-green-500">
                                ✅ Đã import {importedScenes.length} ảnh
                            </label>
                            <div className="flex flex-wrap gap-1 bg-muted/50 rounded px-2 py-1.5 max-h-32 overflow-y-auto">
                                {importedScenes.map((num) => (
                                    <button
                                        key={num}
                                        onClick={async () => {
                                            const match = matchResults.find(r => r.sceneNum === num)
                                            if (match) {
                                                try { await seekToTime(match.startTime) } catch { }
                                            }
                                        }}
                                        className="text-xs font-mono px-1.5 py-0.5 rounded bg-background hover:bg-green-500/20 hover:text-green-500 cursor-pointer transition-colors border border-transparent hover:border-green-500/30"
                                        title={`Nhảy đến scene ${num}`}
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

                    {/* 6. Preview kết quả matching */}
                    {matchResults.length > 0 && (
                        <div className="space-y-2">
                            <label className="text-sm font-medium">
                                Kết quả matching ({matchResults.length} ảnh, {matchResults.reduce((s, r) => s + r.rowCount, 0)} câu)
                            </label>
                            <div className="border rounded-md divide-y max-h-60 overflow-y-auto" style={{ overflowX: 'hidden' }}>
                                {matchResults.map((result) => {
                                    const duration = (result.endTime - result.startTime).toFixed(1)
                                    const qualityIcon = result.quality === "matched" ? "✅" : "⚠️"
                                    const typeLabel = result.type === "environment" ? "🏞️" : "🎬"
                                    const qualityBg = result.quality === "no-excel" ? "bg-red-500/5" : ""

                                    return (
                                        <div
                                            key={result.sceneNum}
                                            className={`px-3 py-2 text-xs ${qualityBg}`}
                                            style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', overflow: 'hidden' }}
                                        >
                                            {/* Quality icon + Scene number */}
                                            <span className="font-mono text-muted-foreground shrink-0 text-right" style={{ width: '60px' }}>
                                                {qualityIcon}{typeLabel} #{result.sceneNum}
                                            </span>

                                            {/* Nội dung — w-0 + flex-1 trick */}
                                            <div style={{ flex: '1 1 0', minWidth: 0, width: 0, overflow: 'hidden' }}>
                                                {/* Tên file ảnh */}
                                                <p style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className="text-foreground font-medium" title={result.fileName}>
                                                    {result.fileName}
                                                </p>
                                                {/* Câu thoại đầu tiên */}
                                                <p style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className="text-muted-foreground mt-0.5" title={result.dialogues.join(" | ")}>
                                                    📝 {result.dialogues.length > 0
                                                        ? `${result.dialogues[0].slice(0, 80)}${result.dialogues[0].length > 80 ? "..." : ""}`
                                                        : "(không có câu thoại)"
                                                    }
                                                    {result.rowCount > 1 && ` (+${result.rowCount - 1} câu)`}
                                                </p>
                                                {/* Timing */}
                                                <p style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className="text-muted-foreground mt-0.5">
                                                    ⏱️ {formatTime(result.startTime)} → {formatTime(result.endTime)} ({duration}s) | {result.rowCount} câu
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
