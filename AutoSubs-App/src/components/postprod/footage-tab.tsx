/**
 * footage-tab.tsx — Tab Footage Library
 * 
 * 3 phần:
 * 1. Quản lý thư viện footage (scan folder, hiện danh sách)
 * 2. AI gợi ý footage cho script (matching)
 * 3. Import footage lên DaVinci track V2
 */

import * as React from "react"
import {
    Film, FolderOpen, Sparkles, Loader2,
    CheckCircle2, AlertCircle, X, Upload, Lightbulb, Copy, Save
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { open } from "@tauri-apps/plugin-dialog"
import { fetch as tauriFetch } from "@tauri-apps/plugin-http"
import { useProject } from "@/contexts/ProjectContext"
import { getSavedFolder, saveFolderPath } from "@/services/saved-folders-service"
import { getAudioScanApiKey } from "@/services/saved-folders-service"
import type { FootageItem, FootageSuggestion } from "@/types/footage-types"

// ======================== COMPONENT ========================

export function FootageTab() {
    const { project } = useProject()

    // ===== State: Thư viện =====
    const [footageFolder, setFootageFolder] = React.useState<string>("")
    const [footageItems, setFootageItems] = React.useState<FootageItem[]>([])
    const [isScanning, setIsScanning] = React.useState(false)
    const [scanMessage, setScanMessage] = React.useState("")
    // State: Nút Save đường dẫn folder
    const [folderSaved, setFolderSaved] = React.useState(false)

    // ===== State: AI Matching =====
    const [suggestions, setSuggestions] = React.useState<FootageSuggestion[]>([])
    const [isMatching, setIsMatching] = React.useState(false)
    const [matchMessage, setMatchMessage] = React.useState("")

    // ===== State: Import =====
    const [isImporting, setIsImporting] = React.useState(false)
    const [importResult, setImportResult] = React.useState<{ success: boolean; message: string } | null>(null)

    // ===== State: Gợi ý Keywords =====
    const [footageKeywords, setFootageKeywords] = React.useState<string[]>([])
    const [isSuggestingKw, setIsSuggestingKw] = React.useState(false)
    const [kwMessage, setKwMessage] = React.useState("")

    // ===== Load saved folder on mount =====
    React.useEffect(() => {
        (async () => {
            const saved = await getSavedFolder("footageFolder")
            if (saved) {
                setFootageFolder(saved)
                // Tự load metadata đã có
                const { loadFootageMetadata } = await import("@/services/footage-library-service")
                const items = await loadFootageMetadata(saved)
                setFootageItems(items)
            }
        })()
    }, [])

    // ======================== CHỌN FOLDER ========================
    const handleSelectFolder = React.useCallback(async () => {
        const selected = await open({ directory: true, title: "Chọn folder footage" })
        if (!selected) return

        const folderPath = selected as string
        setFootageFolder(folderPath)
        saveFolderPath("footageFolder", folderPath)

        // Load metadata nếu đã có
        const { loadFootageMetadata } = await import("@/services/footage-library-service")
        const items = await loadFootageMetadata(folderPath)
        setFootageItems(items)
        setScanMessage(items.length > 0 ? `📂 ${items.length} footage đã có metadata` : "")
    }, [])

    // ======================== SCAN AI ========================
    const handleScan = React.useCallback(async () => {
        if (!footageFolder) return
        const apiKey = await getAudioScanApiKey()
        if (!apiKey) {
            setScanMessage("❌ Cần Gemini API key (Settings)")
            return
        }

        setIsScanning(true)
        setScanMessage("Đang quét...")

        try {
            const { scanAndAnalyzeFootageFolder } = await import("@/services/footage-library-service")
            const items = await scanAndAnalyzeFootageFolder(
                footageFolder,
                apiKey,
                (p) => setScanMessage(p.message)
            )
            setFootageItems(items)
        } catch (err) {
            setScanMessage(`❌ Lỗi: ${String(err)}`)
        } finally {
            setIsScanning(false)
        }
    }, [footageFolder])

    // ======================== GỢI Ý KEYWORDS FOOTAGE ========================
    const handleSuggestKeywords = React.useCallback(async () => {
        const matchData = project?.matchingSentences
        if (!matchData || matchData.length === 0) {
            setKwMessage("❌ Cần load matching data trước (bấm Load Script ở tab Nhạc Nền)")
            return
        }

        setIsSuggestingKw(true)
        setKwMessage("Đang phân tích kịch bản...")

        try {
            const { suggestFootageKeywords } = await import("@/services/audio-director-service")
            const keywords = await suggestFootageKeywords(
                matchData,
                (msg) => setKwMessage(msg)
            )
            setFootageKeywords(keywords)
            setKwMessage(`✅ ${keywords.length} từ khóa footage gợi ý`)
        } catch (err) {
            setKwMessage(`❌ Lỗi: ${String(err)}`)
        } finally {
            setIsSuggestingKw(false)
        }
    }, [project?.matchingSentences])

    // ======================== COPY KEYWORDS ========================
    const handleCopyKeywords = React.useCallback(() => {
        const text = footageKeywords.join("\n")
        navigator.clipboard.writeText(text)
        setKwMessage("✅ Đã copy tất cả keywords!")
    }, [footageKeywords])

    // ======================== AI MATCHING ========================
    const handleMatch = React.useCallback(async () => {
        const apiKey = await getAudioScanApiKey()
        if (!apiKey) {
            setMatchMessage("❌ Cần Gemini API key")
            return
        }

        // Lấy sentences từ matchingSentences (dữ liệu shared trong ProjectContext)
        const matchData = project?.matchingSentences
        if (!matchData || matchData.length === 0) {
            setMatchMessage("❌ Cần matching data (chạy Whisper + AI Match trước)")
            return
        }

        const analyzedItems = footageItems.filter(i => i.aiDescription)
        if (analyzedItems.length === 0) {
            setMatchMessage("❌ Chưa có footage nào được scan. Bấm Quét AI trước!")
            return
        }

        setIsMatching(true)
        setMatchMessage("Đang gửi AI matching...")

        try {
            const { matchFootageToScript } = await import("@/services/footage-matcher-service")

            // Chuyển matchData thành format cần
            const sentences = matchData.map((m: any, i: number) => ({
                text: m.text || m.sentence || "",
                start: m.start || m.startTime || 0,
                end: m.end || m.endTime || 0,
                index: i,
            }))

            // Tính tổng duration
            const totalDuration = sentences.length > 0
                ? sentences[sentences.length - 1].end
                : 60

            const results = await matchFootageToScript(
                sentences,
                footageItems,
                apiKey,
                totalDuration
            )

            setSuggestions(results)
            setMatchMessage(`✅ AI gợi ý ${results.length} footage clips`)
        } catch (err) {
            setMatchMessage(`❌ Lỗi: ${String(err)}`)
        } finally {
            setIsMatching(false)
        }
    }, [footageItems, project?.matchingSentences])

    // ======================== REMOVE SUGGESTION ========================
    const removeSuggestion = React.useCallback((idx: number) => {
        setSuggestions(prev => prev.filter((_, i) => i !== idx))
    }, [])

    // ======================== IMPORT DAVINCI ========================
    const handleImport = React.useCallback(async () => {
        if (suggestions.length === 0) return

        setIsImporting(true)
        setImportResult(null)

        try {
            // Gửi từng footage clip lên DaVinci track V2 (chỉ lấy VIDEO, bỏ audio)
            const response = await tauriFetch("http://127.0.0.1:56003/", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    func: "AddMediaToTimeline",
                    clips: suggestions.map(s => ({
                        filePath: s.footagePath,
                        startTime: s.startTime,
                        endTime: s.endTime,
                        trimStart: s.trimStart,
                        trimEnd: s.trimEnd,
                    })),
                    trackIndex: 7,   // Track V7 — Footage B-roll
                    videoOnly: true, // CHỈ LẤY HÌNH — bỏ audio gốc của footage
                }),
            })

            const data = await response.json() as any
            if (data.error) {
                setImportResult({ success: false, message: data.message || "Lỗi import" })
            } else {
                setImportResult({
                    success: true,
                    message: `✅ Đã import ${suggestions.length} footage lên Track V7`
                })
            }
        } catch (err) {
            setImportResult({ success: false, message: String(err) })
        } finally {
            setIsImporting(false)
        }
    }, [suggestions])

    // ======================== RENDER ========================
    const analyzedCount = footageItems.filter(i => i.aiDescription).length

    return (
        <div className="flex flex-col gap-3 p-4 overflow-y-auto h-full">
            {/* Header */}
            <div className="flex items-center gap-2">
                <Film className="h-5 w-5 text-orange-400" />
                <h4 className="text-sm font-semibold">Footage Library</h4>
                {analyzedCount > 0 && (
                    <span className="text-[10px] bg-orange-500/20 text-orange-400 px-1.5 py-0.5 rounded">
                        {analyzedCount} footage
                    </span>
                )}
            </div>

            {/* ===== PHẦN 1: THƯ VIỆN ===== */}
            <div className="space-y-2 p-2 rounded-md bg-muted/20 border border-border">
                <Label className="text-xs font-medium">📂 Thư viện Footage</Label>

                <div className="flex gap-2">
                    <Button
                        variant="outline"
                        className="flex-1 justify-start gap-2 h-9 min-w-0"
                        onClick={handleSelectFolder}
                    >
                        <FolderOpen className="h-4 w-4 shrink-0" />
                        <span className="truncate">
                            {footageFolder ? footageFolder.split(/[/\\]/).pop() : "Chọn thư mục Footage..."}
                        </span>
                    </Button>

                    {/* Nút Save đường dẫn folder */}
                    {footageFolder && (
                        <Button
                            variant={folderSaved ? "secondary" : "outline"}
                            size="icon"
                            className={`h-9 w-9 shrink-0 transition-all ${
                                folderSaved
                                    ? "bg-green-500/20 border-green-500/40 text-green-400"
                                    : "hover:border-green-500/40 hover:text-green-400"
                            }`}
                            onClick={() => {
                                saveFolderPath("footageFolder", footageFolder)
                                setFolderSaved(true)
                                setTimeout(() => setFolderSaved(false), 2000)
                            }}
                            title="Lưu đường dẫn folder để dùng lại"
                        >
                            {folderSaved ? (
                                <span className="text-xs">✓</span>
                            ) : (
                                <Save className="h-3.5 w-3.5" />
                            )}
                        </Button>
                    )}
                </div>

                {/* Thống kê footage + nút Quét AI */}
                {footageItems.length > 0 && (
                    <div className="flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">
                            🎬 {footageItems.length} footage •{" "}
                            {analyzedCount > 0 && (
                                <span className="text-green-500">
                                    {analyzedCount} đã phân tích
                                </span>
                            )}
                        </p>
                    </div>
                )}

                {/* Nút Quét AI — luôn hiện khi đã chọn folder */}
                {footageFolder && (
                    <Button
                        variant="default"
                        size="sm"
                        className="h-8 gap-1.5 text-xs bg-orange-600 hover:bg-orange-700 w-full"
                        onClick={handleScan}
                        disabled={!footageFolder || isScanning}
                    >
                        {isScanning ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Sparkles className="h-3.5 w-3.5" />
                        )}
                        {isScanning ? "Đang quét..." : "Quét AI Footage"}
                    </Button>
                )}

                {/* Progress/Message */}
                {scanMessage && (
                    <p className="text-[10px] text-muted-foreground">{scanMessage}</p>
                )}

                {/* Danh sách footage (compact) */}
                {analyzedCount > 0 && (
                    <div className="max-h-32 overflow-y-auto space-y-0.5">
                        {footageItems.filter(i => i.aiDescription).map((item, idx) => (
                            <div
                                key={idx}
                                className="flex items-center gap-1.5 text-[10px] py-0.5 px-1.5 rounded bg-muted/30"
                                title={item.aiDescription || ""}
                            >
                                <Film className="h-3 w-3 shrink-0 text-orange-400" />
                                <span className="truncate font-medium">{item.fileName}</span>
                                <span className="shrink-0 text-muted-foreground">{item.durationSec}s</span>
                                {item.aiMood && (
                                    <span className="shrink-0 text-orange-400/70">{item.aiMood}</span>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* ===== PHẦN 1.5: GỢI Ý KEYWORDS FOOTAGE ===== */}
            <div className="space-y-2 p-2 rounded-md bg-muted/20 border border-border">
                <Label className="text-xs font-medium">💡 Gợi ý Keywords Footage</Label>

                <Button
                    variant="outline"
                    size="sm"
                    className="w-full h-7 text-xs gap-1"
                    onClick={handleSuggestKeywords}
                    disabled={isSuggestingKw}
                >
                    {isSuggestingKw
                        ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Đang phân tích...</>
                        : <><Lightbulb className="h-3.5 w-3.5" /> AI gợi ý từ khóa tìm footage</>
                    }
                </Button>

                {kwMessage && (
                    <p className="text-[10px] text-muted-foreground">{kwMessage}</p>
                )}

                {/* Danh sách keywords */}
                {footageKeywords.length > 0 && (
                    <>
                        <div className="flex flex-wrap gap-1">
                            {footageKeywords.map((kw, idx) => (
                                <span
                                    key={idx}
                                    className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-400 border border-orange-500/20"
                                >
                                    {kw}
                                </span>
                            ))}
                        </div>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-[10px] gap-1 text-muted-foreground"
                            onClick={handleCopyKeywords}
                        >
                            <Copy className="h-3 w-3" /> Copy tất cả
                        </Button>
                    </>
                )}
            </div>

            {/* ===== PHẦN 2: AI MATCHING ===== */}
            <div className="space-y-2 p-2 rounded-md bg-muted/20 border border-border">
                <Label className="text-xs font-medium">🤖 AI Gợi ý Footage</Label>

                <Button
                    variant="secondary"
                    size="sm"
                    className="w-full h-7 text-xs gap-1"
                    onClick={handleMatch}
                    disabled={isMatching || analyzedCount === 0}
                >
                    {isMatching
                        ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Đang matching...</>
                        : <><Sparkles className="h-3.5 w-3.5" /> AI Gợi ý Footage cho Script</>
                    }
                </Button>

                {matchMessage && (
                    <p className="text-[10px] text-muted-foreground">{matchMessage}</p>
                )}

                {/* Danh sách gợi ý */}
                {suggestions.length > 0 && (
                    <div className="space-y-1">
                        {suggestions.map((s, idx) => (
                            <div
                                key={idx}
                                className="flex items-start gap-1.5 text-[10px] py-1.5 px-2 rounded bg-orange-500/5 border border-orange-500/20"
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1">
                                        <span className="font-mono text-orange-400">
                                            {s.startTime.toFixed(1)}s
                                        </span>
                                        <span className="font-medium truncate">{s.footageFile}</span>
                                        <span className="text-muted-foreground">
                                            ({(s.trimEnd - s.trimStart).toFixed(1)}s)
                                        </span>
                                    </div>
                                    <div className="text-muted-foreground truncate">{s.reason}</div>
                                </div>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-5 w-5 p-0 shrink-0"
                                    onClick={() => removeSuggestion(idx)}
                                >
                                    <X className="h-3 w-3" />
                                </Button>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* ===== PHẦN 3: IMPORT ===== */}
            {suggestions.length > 0 && (
                <Button
                    onClick={handleImport}
                    disabled={isImporting}
                    className="w-full gap-2 bg-orange-600 hover:bg-orange-700 text-white"
                >
                    {isImporting ? (
                        <><Loader2 className="h-4 w-4 animate-spin" /> Đang import...</>
                    ) : (
                        <><Upload className="h-4 w-4" /> Import {suggestions.length} footage lên Track V7</>
                    )}
                </Button>
            )}

            {/* Kết quả import */}
            {importResult && (
                <div className={`flex items-start gap-2 p-2 rounded-md text-xs ${
                    importResult.success
                        ? "bg-green-500/10 text-green-400 border border-green-500/30"
                        : "bg-red-500/10 text-red-400 border border-red-500/30"
                }`}>
                    {importResult.success
                        ? <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                        : <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    }
                    <span>{importResult.message}</span>
                </div>
            )}

            {/* Hướng dẫn */}
            <div className="mt-auto p-2 rounded-md bg-muted/30 border border-border text-[10px] text-muted-foreground space-y-0.5">
                <p>📽️ <strong>Bước 1</strong>: Chọn folder footage → Quét AI (scan 3 frame/video)</p>
                <p>🤖 <strong>Bước 2</strong>: AI gợi ý 5-10 footage phù hợp với script</p>
                <p>📤 <strong>Bước 3</strong>: Import lên DaVinci Track V7 (footage)</p>
            </div>
        </div>
    )
}
