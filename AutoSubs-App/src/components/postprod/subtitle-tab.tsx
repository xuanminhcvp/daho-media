// subtitle-tab.tsx
// Tab "Phụ Đề" trong Post-Production Panel
// Tính năng: AI so khớp kịch bản → whisper → tạo phụ đề stories → import lên DaVinci
// UI: chọn matching folder → AI so khớp → preview list → chọn template → import


import { useState, useCallback, useEffect } from "react"
import { 
    Subtitles, 
    AlertCircle, 
    FolderOpen,
    Loader2,
    Sparkles,
    Download,
    ChevronDown,
    ChevronUp,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useProject } from "@/contexts/ProjectContext"
import { useResolve } from "@/contexts/ResolveContext"
import { open } from "@tauri-apps/plugin-dialog"

import {
    aiSubtitleMatchFromSentences,
    loadSubtitleLines,
} from "@/services/subtitle-matcher-service"
import type { SubtitleMatchProgress } from "@/services/subtitle-matcher-service"
const tauriFetch = window.fetch; // Bypass Tauri streamChannel bug
import { hasMasterSrt, MASTER_SRT_REQUIRED_MESSAGE } from "@/utils/master-srt-utils"
import { join } from '@tauri-apps/api/path'
import { writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'

// ======================== HELPERS ========================

function stripScriptNumbers(text: string): string {
    if (!text) return ''
    return text.split('\n')
        .map(line => line.replace(/^\[\d+\]\s*/, ''))
        .filter(line => line.trim())
        .join('\n')
}

/** Format giây → MM:SS.ss */
function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m.toString().padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`
}

// ======================== COMPONENT CHÍNH ========================

export function SubtitleTab() {
    // === State ===
    const { project, updateSubtitleData } = useProject()
    const { timelineInfo } = useResolve()

    const subData = project.subtitleData

    // UI state
    const [isMatching, setIsMatching] = useState(false)
    const [isImporting, setIsImporting] = useState(false)
    const [matchProgress, setMatchProgress] = useState<SubtitleMatchProgress | null>(null)
    const [importProgress, setImportProgress] = useState<{ current: number; total: number } | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [showAllLines, setShowAllLines] = useState(false)

    // Auto-fill script từ AutoMedia/MasterSRT tabs nếu panel này trống
    // Điều này giúp user "vẫn phải paste kịch bản gốc à" KHÔNG CẦN paste lại
    useEffect(() => {
        if (!subData.scriptText && project.scriptText) {
            const cleanText = stripScriptNumbers(project.scriptText)
            updateSubtitleData({ scriptText: cleanText })
        }
    }, [subData.scriptText, project.scriptText, updateSubtitleData])

    // ======================== CHỌN MATCHING FOLDER ========================

    const handleSelectFolder = useCallback(async () => {
        try {
            const selected = await open({
                directory: true,
                multiple: false,
                title: "Chọn thư mục chứa matching.json + kịch bản",
            })
            if (!selected || typeof selected !== "string") return

            updateSubtitleData({ matchingFolder: selected })
            setError(null)

            // Thử load cache phụ đề đã có
            const cached = await loadSubtitleLines(selected)
            if (cached && cached.length > 0) {
                updateSubtitleData({ subtitleLines: cached })
                console.log(`[SubtitleTab] Loaded ${cached.length} dòng từ cache`)
            }
        } catch (err) {
            console.error("[SubtitleTab] Lỗi chọn folder:", err)
            setError(String(err))
        }
    }, [updateSubtitleData])

    // ======================== AI SO KHỚP PHỤ ĐỀ ========================

    const handleAIMatch = useCallback(async () => {
        // Chỉ cần kịch bản gốc - timing lấy từ Master SRT (bắt buộc)
        if (!(subData.scriptText || '').trim()) {
            setError("Chưa có kịch bản — hãy paste kịch bản vào ô Kịch Bản Gốc bên dưới")
            return
        }

        // ⭐ BẮT BUỘC Master SRT — không dùng raw transcript
        if (!hasMasterSrt(project.masterSrt)) {
            setError(MASTER_SRT_REQUIRED_MESSAGE)
            return
        }

        setIsMatching(true)
        setError(null)
        setMatchProgress({ current: 0, total: 5, message: "Đang chuẩn bị..." })

        try {
            // 1. Lấy Matching Sentences (từ Project hoặc đọc từ file)
            let sentencesToUse = project.matchingSentences;
            if (!sentencesToUse || sentencesToUse.length === 0) {
                if (subData.matchingFolder) {
                    try {
                        const { readTextFile } = await import('@tauri-apps/plugin-fs');
                        const path = await import('@tauri-apps/api/path');
                        const filePath = await path.join(subData.matchingFolder, 'matching.json');
                        const content = await readTextFile(filePath);
                        const data = JSON.parse(content);
                        sentencesToUse = data.sentences || data.matchedSentences || data.matchingSentences;
                    } catch (e) {
                        console.warn("[SubtitleTab] Chưa đọc được matching.json:", e);
                    }
                }
            }

            if (!sentencesToUse || sentencesToUse.length === 0) {
                throw new Error("Không tìm thấy Matching_Sentence! Bạn phải chọn Cache Folder chứa `matching.json`, hoặc chạy Auto Media trước.");
            }

            console.log(`[SubtitleTab] Dùng MatchingSentences: ${sentencesToUse.length} câu`);
            const lines = await aiSubtitleMatchFromSentences(
                sentencesToUse,
                project.masterSrt || null,
                (progress: any) => setMatchProgress(progress),
                subData.matchingFolder || undefined // Chỉ lưu cache nếu đã chọn folder
            );
            updateSubtitleData({ subtitleLines: lines })

            setMatchProgress(null)

        } catch (err) {
            console.error("[SubtitleTab] Lỗi AI match:", err)
            setError(String(err))
            setMatchProgress(null)
        } finally {
            setIsMatching(false)
        }
    }, [subData.scriptText, subData.matchingFolder, project.masterSrt, updateSubtitleData])

    // ======================== IMPORT LÊN DAVINCI ========================

    const handleImportToDaVinci = useCallback(async () => {
        if (subData.subtitleLines.length === 0) {
            setError("Chưa có phụ đề — hãy chạy AI So Khớp trước")
            return
        }

        setIsImporting(true)
        setError(null)

        const lines = subData.subtitleLines
        const totalLines = lines.length

        try {
            // Gửi TẤT CẢ clips 1 lần duy nhất (không chia batch)
            // Lua backend AppendToTimeline() xử lý tất cả trong 1 lần gọi → nhanh nhất
            // Track cố định V4 — Text Onscreen (không còn dropdown)
            const trackToUse = "4"

            setImportProgress({ current: 0, total: totalLines })
            
            if (subData.subtitleMode === 'srt') {
                console.log(`[SubtitleTab] Generating SRT mode for ${totalLines} clips`)
                
                // 1. Convert sang nội dung SRT
                let srtContent = ''
                lines.forEach((line, index) => {
                    const formatTime = (secs: number) => {
                        const h = Math.floor(secs / 3600).toString().padStart(2, '0')
                        const m = Math.floor((secs % 3600) / 60).toString().padStart(2, '0')
                        const s = Math.floor(secs % 60).toString().padStart(2, '0')
                        const ms = Math.floor((secs % 1) * 1000).toString().padStart(3, '0')
                        return `${h}:${m}:${s},${ms}`
                    }
                    const startTc = formatTime(line.start)
                    const endTc = formatTime(line.end)
                    const text = (line.text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
                    if (text && line.end > line.start) {
                        srtContent += `${index + 1}\n`
                        srtContent += `${startTc} --> ${endTc}\n`
                        srtContent += `${text}\n\n`
                    }
                })

                // 2. Lưu file SRT vào Desktop/Auto_media/
                const { desktopDir } = await import('@tauri-apps/api/path')
                const pDesktop = await desktopDir()
                const autoMediaDir = await join(pDesktop, 'Auto_media')
                if (!(await exists(autoMediaDir))) {
                    await mkdir(autoMediaDir, { recursive: true })
                }
                const tlId = timelineInfo?.timelineId || 'manual'
                const srtPath = await join(autoMediaDir, `Autosubs_${tlId}_phude.srt`)
                await writeTextFile(srtPath, srtContent)

                // 3. Gọi server import SRT vào Media Pool rồi append lên timeline
                console.log(`[SubtitleTab] Calling Server to ImportSrtToTimeline: ${srtPath}`)
                const response = await tauriFetch("http://127.0.0.1:56003/", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        func: "ImportSrtToTimeline",
                        filePath: srtPath
                    }),
                })

                const result = await response.json() as any
                if (result.error) {
                    throw new Error(result.message || "Lỗi import SRT")
                }

                setImportProgress({ current: totalLines, total: totalLines })
                console.log(`[SubtitleTab] ✅ Import SRT lên timeline hoàn tất!`)
                
            } else {
                console.log(`[SubtitleTab] Sending ${totalLines} clips in 1 request → track V${trackToUse}`)
                const response = await tauriFetch("http://127.0.0.1:56003/", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        func: "AddSimpleSubtitles",
                        clips: lines.map(line => ({
                            text: line.text,
                            start: line.start,
                            end: line.end,
                        })),
                        templateName: subData.selectedTemplate,
                        trackIndex: trackToUse,
                        fontSize: subData.fontSize,
                    }),
                })

                const result = await response.json() as any
                if (result.error) {
                    throw new Error(result.message || "Lỗi import")
                }

                setImportProgress({ current: totalLines, total: totalLines })
                console.log(`[SubtitleTab] ✅ Import hoàn tất: ${result.added || totalLines} clips → track V${trackToUse}`)
            }

        } catch (err) {
            console.error("[SubtitleTab] Lỗi import:", err)
            setError(String(err))
        } finally {
            setIsImporting(false)
        }
    }, [subData])

    // ======================== DANH SÁCH PHỤ ĐỀ HIỂN THỊ ========================

    // Giới hạn preview: chỉ hiện 30 dòng nếu chưa expand
    const MAX_PREVIEW = 30
    const displayLines = showAllLines
        ? subData.subtitleLines
        : subData.subtitleLines.slice(0, MAX_PREVIEW)
    const hasMore = subData.subtitleLines.length > MAX_PREVIEW

    // ======================== RENDER ========================

    return (
        <div className="flex flex-col h-full overflow-y-auto">
            {/* Header */}
            <div className="shrink-0 px-4 pt-3 pb-2">
                <div className="flex items-center gap-2 mb-1">
                    <Subtitles className="h-4 w-4 text-yellow-500" />
                    <h4 className="text-sm font-semibold">Phụ Đề Stories</h4>
                    {subData.subtitleLines.length > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-500/15 text-yellow-500 font-medium">
                            {subData.subtitleLines.length} dòng
                        </span>
                    )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                    AI so khớp kịch bản → Whisper (trong session) → phụ đề. Import lên DaVinci Resolve.
                </p>
            </div>



            {/* Matching Folder (TÙY CHỌN - chỉ để lưu cache) */}
            <div className="shrink-0 px-4 py-2 border-t">
                <label className="text-[11px] text-muted-foreground block mb-1">
                    Cache Folder <span className="text-muted-foreground/60">(tùy chọn — lưu kết quả phụ đề để dùng lại)</span>
                </label>
                <div className="flex gap-2">
                    <div className="flex-1 min-w-0">
                        <div className="text-xs truncate bg-muted/50 px-2 py-1.5 rounded border border-border/50">
                            {subData.matchingFolder
                                ? subData.matchingFolder.split(/[/\\]/).pop() || subData.matchingFolder
                                : "Chưa chọn..."}
                        </div>
                    </div>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 shrink-0"
                                onClick={handleSelectFolder}
                                disabled={isMatching}
                            >
                                <FolderOpen className="h-3.5 w-3.5" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Chọn thư mục chứa matching.json</TooltipContent>
                    </Tooltip>
                </div>
            </div>

            {/* Cảnh báo khi chưa có Master SRT */}
            {!hasMasterSrt(project.masterSrt) && (
                <div className="shrink-0 mx-4 mt-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
                    <div className="flex items-center gap-2">
                        <AlertCircle className="h-4 w-4 text-amber-400 shrink-0" />
                        <div className="flex-1">
                            <p className="text-xs font-medium text-amber-400">
                                Cần tạo Master SRT trước
                            </p>
                            <p className="text-[10px] text-muted-foreground">
                                Vào tab &quot;Master SRT&quot; → tạo từ Whisper + kịch bản. Phụ đề sẽ chính xác hơn nhiều.
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* Nút AI So Khớp */}
            <div className="shrink-0 px-4 py-2 border-t">
                <Button
                    className="w-full h-9 gap-2 text-xs font-medium bg-yellow-600 hover:bg-yellow-700 text-white"
                    onClick={handleAIMatch}
                    disabled={isMatching || !(subData.scriptText || '').trim() || !hasMasterSrt(project.masterSrt)}
                >
                    {isMatching ? (
                        <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Đang so khớp...
                        </>
                    ) : (
                        <>
                            <Sparkles className="h-3.5 w-3.5" />
                            AI So Khớp Phụ Đề
                        </>
                    )}
                </Button>

                {/* Progress bar */}
                {matchProgress && (
                    <div className="mt-2 space-y-1">
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                            <span>{matchProgress.message}</span>
                            <span className="font-medium">{matchProgress.current}/{matchProgress.total}</span>
                        </div>
                        <div className="h-1.5 rounded-full overflow-hidden bg-muted">
                            <div
                                className="h-full bg-yellow-500 transition-all duration-300 rounded-full"
                                style={{ width: `${(matchProgress.current / matchProgress.total) * 100}%` }}
                            />
                        </div>
                    </div>
                )}
            </div>

            {/* Error */}
            {error && (
                <div className="shrink-0 mx-4 mt-1 p-2 rounded bg-destructive/10 border border-destructive/20">
                    <div className="flex items-start gap-1.5">
                        <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
                        <p className="text-[11px] text-destructive break-words">{error}</p>
                    </div>
                </div>
            )}

            {/* Danh sách phụ đề preview */}
            {subData.subtitleLines.length > 0 && (
                <div className="flex-1 min-h-0 flex flex-col px-4 py-2 border-t">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-[11px] text-muted-foreground font-medium">
                            Kết quả: {subData.subtitleLines.length} dòng phụ đề
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                            {formatTime(subData.subtitleLines[0]?.start || 0)} →{" "}
                            {formatTime(subData.subtitleLines[subData.subtitleLines.length - 1]?.end || 0)}
                        </span>
                    </div>

                    {/* Scrollable list */}
                    <div className="flex-1 min-h-0 overflow-y-auto rounded border border-border/50 bg-muted/20">
                        {displayLines.map((line, idx) => (
                            <div
                                key={idx}
                                className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] border-b border-border/30 last:border-b-0 hover:bg-muted/40 transition-colors"
                            >
                                {/* Timing */}
                                <span className="shrink-0 w-[90px] font-mono text-muted-foreground text-[10px]">
                                    {formatTime(line.start)} → {formatTime(line.end)}
                                </span>
                                {/* Chấm vàng */}
                                <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 shrink-0" />
                                {/* Text */}
                                <span className="flex-1 truncate text-foreground">
                                    {line.text}
                                </span>
                            </div>
                        ))}
                    </div>

                    {/* Show more/less */}
                    {hasMore && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 mt-1 text-[10px] text-muted-foreground w-full"
                            onClick={() => setShowAllLines(!showAllLines)}
                        >
                            {showAllLines ? (
                                <><ChevronUp className="h-3 w-3 mr-1" />Thu gọn</>
                            ) : (
                                <><ChevronDown className="h-3 w-3 mr-1" />Xem tất cả ({subData.subtitleLines.length} dòng)</>
                            )}
                        </Button>
                    )}
                </div>
            )}

            {/* Cài đặt Import */}
            {subData.subtitleLines.length > 0 && (
                <div className="shrink-0 px-4 py-3 border-t space-y-2.5">
                    <span className="text-[11px] text-muted-foreground font-medium">Cài đặt Import</span>

                    {/* Template */}
                    <div className="flex items-center gap-2">
                        <label className="text-[10px] text-muted-foreground w-[60px] shrink-0">Template:</label>
                        <select
                            className="flex-1 text-xs h-7 px-2 rounded border border-border bg-background"
                            value={subData.selectedTemplate}
                            onChange={(e) => updateSubtitleData({ selectedTemplate: e.target.value })}
                        >
                            <option value="Subtitle Default">Subtitle Default (vàng gold)</option>
                            {/* Template từ DaVinci sẽ hiển thị ở đây nếu có */}
                            {timelineInfo?.templates?.map((t: any) => (
                                <option key={t.value} value={t.value}>{t.label}</option>
                            ))}
                        </select>
                    </div>

                    {/* Font Size */}
                    <div className="flex items-center gap-2">
                        <label className="text-[10px] text-muted-foreground w-[60px] shrink-0">Font Size:</label>
                        <select
                            className="flex-1 text-xs h-7 px-2 rounded border border-border bg-background"
                            value={subData.fontSize}
                            onChange={(e) => updateSubtitleData({ fontSize: parseFloat(e.target.value) })}
                        >
                            <option value={0.03}>S — Nhỏ (0.03)</option>
                            <option value={0.04}>M — Medium (0.04)</option>
                            <option value={0.055}>L — Lớn (0.055)</option>
                            <option value={0.07}>XL — Rất lớn (0.07)</option>
                        </select>
                    </div>

                    {/* Chế Độ Phụ Đề */}
                    <div className="flex items-start gap-2 pt-1 border-t border-border/50">
                        <label className="text-[10px] text-muted-foreground w-[60px] shrink-0 mt-2">Chế Độ:</label>
                        <div className="flex-1 space-y-2">
                            <div className="grid grid-cols-2 gap-1.5 bg-background border rounded-md p-1">
                                <button 
                                    onClick={() => updateSubtitleData({ subtitleMode: 'srt' })}
                                    className={`text-[11px] py-1.5 rounded-sm font-medium transition-colors ${subData.subtitleMode === 'srt' ? 'bg-primary text-primary-foreground shadow' : 'hover:bg-muted text-muted-foreground'}`}
                                >
                                    📝 Mượt mà (.srt)
                                </button>
                                <button 
                                    onClick={() => updateSubtitleData({ subtitleMode: 'fusion' })}
                                    className={`text-[11px] py-1.5 rounded-sm font-medium transition-colors ${subData.subtitleMode === 'fusion' ? 'bg-primary text-primary-foreground shadow' : 'hover:bg-muted text-muted-foreground'}`}
                                >
                                    ✨ Hiệu ứng (Text+)
                                </button>
                            </div>
                            <p className="text-[9.5px] text-muted-foreground leading-tight px-1 text-center">
                                {subData.subtitleMode === 'srt' 
                                    ? "Khuyên dùng cho Phim Tài Liệu. Rất nhẹ, không chiếm RAM, tạo file .srt vào Media Pool." 
                                    : "Ăn chục GB RAM của DaVinci. Phù hợp cho video ngắn cần text Animation."}
                            </p>
                        </div>
                    </div>

                    {/* Track — cố định V4 (Text Onscreen) */}
                    <div className="flex items-center gap-2">
                        <label className="text-[10px] text-muted-foreground w-[60px] shrink-0">Track:</label>
                        <div className="flex-1 text-xs h-7 px-2 rounded border border-border bg-muted/30 flex items-center text-muted-foreground">
                            💬 Track V4 — Text Onscreen (cố định)
                        </div>
                    </div>

                    {/* Nút Import */}
                    <Button
                        className="w-full h-9 gap-2 text-xs font-medium"
                        variant="default"
                        onClick={handleImportToDaVinci}
                        disabled={isImporting || subData.subtitleLines.length === 0}
                    >
                        {isImporting ? (
                            <>
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Đang import...
                            </>
                        ) : (
                            <>
                                <Download className="h-3.5 w-3.5" />
                                Import {subData.subtitleLines.length} phụ đề lên DaVinci
                            </>
                        )}
                    </Button>

                    {/* Import progress */}
                    {importProgress && (
                        <div className="space-y-1">
                            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                                <span>
                                    {importProgress.current >= importProgress.total
                                        ? "✅ Import hoàn tất!"
                                        : `Import batch: ${importProgress.current}/${importProgress.total}`}
                                </span>
                                <span className="font-medium">
                                    {Math.round((importProgress.current / importProgress.total) * 100)}%
                                </span>
                            </div>
                            <div className="h-1.5 rounded-full overflow-hidden bg-muted">
                                <div
                                    className={`h-full transition-all duration-300 rounded-full ${
                                        importProgress.current >= importProgress.total
                                            ? "bg-green-500"
                                            : "bg-primary"
                                    }`}
                                    style={{ width: `${(importProgress.current / importProgress.total) * 100}%` }}
                                />
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Empty state */}
            {subData.subtitleLines.length === 0 && !isMatching && (
                <div className="flex-1 flex items-center justify-center px-6">
                    <div className="text-center space-y-2">
                        <Subtitles className="h-8 w-8 mx-auto text-muted-foreground/30" />
                        <p className="text-xs text-muted-foreground">
                            {!(subData.scriptText || '').trim()
                                ? 'Paste kịch bản gốc (mỗi câu 1 dòng) → bấm "AI So Khớp"'
                                : 'Bấm "AI So Khớp" để tạo phụ đề'
                            }
                        </p>
                    </div>
                </div>
            )}
        </div>
    )
}
