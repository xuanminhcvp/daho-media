/**
 * reference-images-tab.tsx — Tab Reference Images (Ảnh Tham Khảo Thực Tế)
 *
 * 3 phần:
 * 1. AI Gợi Ý: phân tích kịch bản → liệt kê 6-10 moment cần ảnh thực tế
 * 2. Quản Lý: copy keywords, gán ảnh đã tải vào từng slot
 * 3. Import: đẩy ảnh lên DaVinci Track V2 (overlay)
 */

import * as React from "react"
import {
    ImageIcon, Sparkles, Loader2, Copy, Check,
    FolderOpen, Upload, X, ExternalLink, MapPin,
    User, FileText, Newspaper, Wrench, Zap, Map as MapIcon, Plus, Save, Link2
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { open } from "@tauri-apps/plugin-dialog"
import { desktopDir } from "@tauri-apps/api/path"
import { useProject } from "@/contexts/ProjectContext"
import { useTranscript } from "@/contexts/TranscriptContext"
import { addRefImagesToTimeline, autoRelinkMedia } from "@/api/resolve-api"
import { saveFolderPath } from "@/services/saved-folders-service"
import { loadMatchingScript } from "@/services/audio-director-service"
import type { RefImageSuggestion } from "@/types/reference-image-types"

// ======================== ICON MAP ========================

/** Icon theo loại ảnh */
const TYPE_ICONS: Record<string, React.ReactNode> = {
    portrait: <User className="h-3 w-3" />,
    location: <MapPin className="h-3 w-3" />,
    map: <MapIcon className="h-3 w-3" />,
    event: <Zap className="h-3 w-3" />,
    document: <FileText className="h-3 w-3" />,
    headline: <Newspaper className="h-3 w-3" />,
    evidence: <Wrench className="h-3 w-3" />,
}

/** Màu badge theo priority */
const PRIORITY_COLORS: Record<string, string> = {
    high: "bg-red-500/20 text-red-400 border-red-500/30",
    medium: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    low: "bg-blue-500/20 text-blue-400 border-blue-500/30",
}

// ======================== COMPONENT ========================

export function ReferenceImagesTab() {
    const { 
        project, 
        setMatchingFolder: setSharedMatchingFolder,
        setMatchingSentences: setSharedMatchingSentences,
        updateHighlightText,
        updateMusicLibrary,
        updateSfxLibrary
    } = useProject()
    // Lấy subtitles từ TranscriptContext (Generate Subtitles lưu toàn cục)
    const { subtitles } = useTranscript()

    // ===== State =====
    const [suggestions, setSuggestions] = React.useState<RefImageSuggestion[]>([])
    const [isAnalyzing, setIsAnalyzing] = React.useState(false)
    const [analyzeMessage, setAnalyzeMessage] = React.useState("")

    // Import state
    const [isImporting, setIsImporting] = React.useState(false)
    const [importMessage, setImportMessage] = React.useState("")

    // Relink state — dùng khi mở project lại bị offline/media not found
    const [isRelinking, setIsRelinking] = React.useState(false)
    const [relinkMessage, setRelinkMessage] = React.useState("")

    // Folder selection state
    const [folderSaved, setFolderSaved] = React.useState(false)

    // Add Custom State
    const [showAddCustom, setShowAddCustom] = React.useState(false)
    const [customStart, setCustomStart] = React.useState("0")
    const [customEnd, setCustomEnd] = React.useState("5")
    const [isAddingCustom, setIsAddingCustom] = React.useState(false)
    const [addCustomMessage, setAddCustomMessage] = React.useState("")

    // Copy state
    const [copiedId, setCopiedId] = React.useState<string | null>(null)

    // ===== Load cache on mount =====
    React.useEffect(() => {
        (async () => {
            const folder = project?.matchingFolder
            if (!folder) return

            try {
                const { loadRefImageCache } = await import("@/services/reference-image-service")
                const cached = await loadRefImageCache(folder)
                if (cached) {
                    setSuggestions(cached.suggestions)
                    setAnalyzeMessage(`📋 ${cached.suggestions.length} ảnh gợi ý (từ cache)`)
                }
            } catch (err) {
                console.warn("[RefImages] Lỗi load cache:", err)
            }
        })()
    }, [project?.matchingFolder])

    // ======================== LOAD M FOLDER ========================
    const handleLoadScript = React.useCallback(async () => {
        try {
            const desktop = await desktopDir()
            const folder = await open({
                directory: true,
                title: "Chọn thư mục dự án (chứa autosubs_matching.json)",
                defaultPath: desktop,
            })
            if (!folder) return

            setSharedMatchingFolder(folder as string)
            const loaded = await loadMatchingScript(folder as string)
            if (loaded) {
                setSharedMatchingSentences(loaded.sentences)
                updateMusicLibrary({ directorResult: loaded.aiDirectorResult || null })
                updateSfxLibrary({ sfxPlan: loaded.aiSfxPlanResult || null })
                updateHighlightText({ highlightPlan: loaded.aiHighlightPlanResult || null })
            } else {
                setSharedMatchingSentences(null)
            }
        } catch (error: any) {
            console.error("Lỗi đọc thư mục:", error)
        }
    }, [setSharedMatchingFolder, setSharedMatchingSentences, updateMusicLibrary, updateSfxLibrary, updateHighlightText])

    // ======================== AI GỢI Ý ========================
    /**
     * Lấy data từ 2 nguồn (ưu tiên matchingSentences, fallback subtitles):
     * 1. matchingSentences (từ Image Import AI Match) — đã có num + timing
     * 2. subtitles (từ Generate Subtitles / Whisper) — có text + timing
     */
    const handleAnalyze = React.useCallback(async () => {
        // Nguồn 1: matchingSentences (từ ProjectContext)
        let sentenceData = project?.matchingSentences

        // Nguồn 2: nếu chưa có matching → chuyển subtitles thành format tương tự
        if (!sentenceData || sentenceData.length === 0) {
            if (subtitles && subtitles.length > 0) {
                sentenceData = subtitles.map((sub: any, idx: number) => ({
                    num: idx + 1,
                    text: sub.text || "",
                    start: sub.start || 0,
                    end: sub.end || 0,
                    quality: "high",
                }))
                console.log(`[RefImages] Dùng ${sentenceData.length} subtitles làm data (fallback)`)
            }
        }

        if (!sentenceData || sentenceData.length === 0) {
            setAnalyzeMessage("❌ Cần Generate Subtitles trước (tab Subtitles → Generate Subtitles)")
            return
        }

        const folder = project?.matchingFolder
        setIsAnalyzing(true)
        setAnalyzeMessage("🔍 AI đang phân tích kịch bản...")

        try {
            // Lấy timelineId để load whisper words (timeout ngắn, không bắt buộc)
            // Giống pattern của SFX và Image Import panel
            let resolvedTimelineId: string | undefined
            try {
                const { getTimelineInfo } = await import("@/api/resolve-api")
                const info = await getTimelineInfo()
                resolvedTimelineId = info?.timelineId || undefined
                if (resolvedTimelineId) {
                    setAnalyzeMessage(`🔍 Đã lấy timeline: ${resolvedTimelineId} — đang load whisper words...`)
                }
            } catch {
                console.warn("[RefImages] DaVinci không kết nối — bỏ qua whisper words")
            }

            const { analyzeScriptForRefImages } = await import("@/services/reference-image-service")
            const result = await analyzeScriptForRefImages(
                folder || "",
                sentenceData,
                (msg) => setAnalyzeMessage(msg),
                undefined,          // customStartTimeMs
                undefined,          // customEndTimeMs
                resolvedTimelineId  // timelineId để load whisper words word-level
            )
            setSuggestions(result.suggestions)
        } catch (err) {
            setAnalyzeMessage(`❌ Lỗi: ${String(err).slice(0, 100)}`)
        } finally {
            setIsAnalyzing(false)
        }
    }, [project?.matchingSentences, project?.matchingFolder, subtitles])

    // ======================== MANUAL ADD ========================
    const handleAddCustom = React.useCallback(async () => {
         const folder = project?.matchingFolder;
         let sentenceData = project?.matchingSentences;

         if (!sentenceData || sentenceData.length === 0) {
            if (subtitles && subtitles.length > 0) {
                sentenceData = subtitles.map((sub: any, idx: number) => ({
                    num: idx + 1,
                    text: sub.text || "",
                    start: sub.start || 0,
                    end: sub.end || 0,
                    quality: "high",
                }))
            }
        }
        if (!sentenceData || sentenceData.length === 0) {
             setAddCustomMessage("❌ Cần Generate Subtitles trước.");
             return;
        }

        const startMs = parseFloat(customStart) * 1000;
        const endMs = parseFloat(customEnd) * 1000;
        
        if (isNaN(startMs) || isNaN(endMs) || startMs >= endMs) {
             setAddCustomMessage("❌ Thời gian không hợp lệ.");
             return;
        }

        setIsAddingCustom(true);
        setAddCustomMessage("🔍 AI đang phân tích đoạn này...");
        try {
            // Lấy timelineId để load whisper words (giống handleAnalyze)
            let resolvedTimelineId: string | undefined
            try {
                const { getTimelineInfo } = await import("@/api/resolve-api")
                const info = await getTimelineInfo()
                resolvedTimelineId = info?.timelineId || undefined
            } catch { /* DaVinci không kết nối, bỏ qua */ }

            const { analyzeScriptForRefImages, loadRefImageCache, saveRefImageCache } = await import("@/services/reference-image-service");
            const result = await analyzeScriptForRefImages(
                folder || "",
                sentenceData,
                (msg) => setAddCustomMessage(msg),
                startMs,
                endMs,
                resolvedTimelineId  // timelineId để load whisper words
            )

            if (result.suggestions && result.suggestions.length > 0) {
                // Sửa ID để ko bị trùng
                const newSuggestion = { ...result.suggestions[0], id: `ref_custom_${Date.now()}` };
                
                // Add lên top
                setSuggestions(prev => {
                    const next = [newSuggestion, ...prev];
                    
                    // Xử lý lưu cache = load existing cache lên, bỏ item mới vào đầu, lưu lại cache
                     if (folder) {
                         loadRefImageCache(folder).then(cached => {
                             if(cached) {
                                 cached.suggestions = next;
                                 saveRefImageCache(folder, cached);
                             }
                         });
                    }

                    return next;
                });
                setAddCustomMessage("✅ Đã thêm.");
                setShowAddCustom(false); // ẩn panel
            } else {
                setAddCustomMessage("❌ AI không tìm thấy loại ảnh phù hợp.");
            }
        } catch (err) {
             setAddCustomMessage(`❌ Lỗi: ${String(err).slice(0, 50)}`);
        } finally {
            setIsAddingCustom(false);
        }
    }, [project?.matchingSentences, project?.matchingFolder, subtitles, customStart, customEnd]);

    // ======================== COPY KEYWORDS ========================
    const handleCopyKeywords = React.useCallback((suggestion: RefImageSuggestion) => {
        const text = suggestion.searchKeywords.join("\n")
        navigator.clipboard.writeText(text)
        setCopiedId(suggestion.id)
        setTimeout(() => setCopiedId(null), 2000)
    }, [])

    // ======================== COPY TẤT CẢ ========================
    const handleCopyAll = React.useCallback(() => {
        const lines = suggestions.map((s, i) =>
            `${i + 1}. [${s.type}] ${s.description}\n   Keywords: ${s.searchKeywords.join(", ")}\n   Source: ${s.source}`
        ).join("\n\n")
        navigator.clipboard.writeText(lines)
        setAnalyzeMessage("✅ Đã copy tất cả gợi ý!")
        setTimeout(() => setAnalyzeMessage(""), 2000)
    }, [suggestions])

    // ======================== GÁN ẢNH CHO SLOT ========================
    const handleAssignImage = React.useCallback(async (suggestionId: string) => {
        const selected = await open({
            filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "bmp"] }],
            multiple: false,
            title: "Chọn ảnh tham khảo",
        })
        if (!selected) return

        const filePath = selected as string
        const fileName = filePath.split(/[/\\]/).pop() || ""

        // Cập nhật local state
        setSuggestions(prev => prev.map(s =>
            s.id === suggestionId
                ? { ...s, assignedImagePath: filePath, assignedImageName: fileName }
                : s
        ))

        // Cập nhật cache
        const folder = project?.matchingFolder
        if (folder) {
            const { updateRefImageSuggestion } = await import("@/services/reference-image-service")
            await updateRefImageSuggestion(folder, suggestionId, {
                assignedImagePath: filePath,
                assignedImageName: fileName,
            })
        }
    }, [project?.matchingFolder])

    // ======================== BỎ ẢNH ĐÃ GÁN ========================
    const handleRemoveImage = React.useCallback(async (suggestionId: string) => {
        setSuggestions(prev => prev.map(s =>
            s.id === suggestionId
                ? { ...s, assignedImagePath: undefined, assignedImageName: undefined }
                : s
        ))

        const folder = project?.matchingFolder
        if (folder) {
            const { updateRefImageSuggestion } = await import("@/services/reference-image-service")
            await updateRefImageSuggestion(folder, suggestionId, {
                assignedImagePath: undefined,
                assignedImageName: undefined,
            })
        }
    }, [project?.matchingFolder])

    // ======================== XOÁ 1 GỢI Ý ========================
    const handleRemoveSuggestion = React.useCallback(async (idx: number) => {
        let removedId = "";
        setSuggestions(prev => {
           removedId = prev[idx]?.id || "";
           return prev.filter((_, i) => i !== idx);
        });

        const folder = project?.matchingFolder;
        if(folder && removedId) {
             try {
                const { loadRefImageCache, saveRefImageCache } = await import("@/services/reference-image-service");
                const cached = await loadRefImageCache(folder);
                if(cached) {
                    cached.suggestions = cached.suggestions.filter(s => s.id !== removedId);
                    await saveRefImageCache(folder, cached);
                }
             } catch(err) {
                 console.error(err);
             }
        }
    }, [project?.matchingFolder])

    // ======================== IMPORT LÊN DAVINCI ========================
    const handleImport = React.useCallback(async () => {
        // Chỉ import những slot đã gán ảnh
        const assigned = suggestions.filter(s => s.assignedImagePath)
        if (assigned.length === 0) {
            setImportMessage("❌ Chưa gán ảnh nào. Bấm 📂 để chọn ảnh cho từng slot.")
            return
        }

        setIsImporting(true)
        setImportMessage(`📥 Đang tìm SFX phù hợp...`)

        try {
            // Build SFX clips theo type ảnh
            const { buildSfxClipsForRefImages } = await import("@/services/ref-image-sfx-service")
            const sfxClips = await buildSfxClipsForRefImages(
                assigned.map(s => ({ imageType: s.type as any, startTime: s.startTime }))
            )

            const sfxCount = sfxClips.length
            setImportMessage(`📥 Đang import ${assigned.length} ảnh + ${sfxCount} SFX lên Track V2...`)

            // Build clips data gốc
            const clips = assigned.map(s => ({
                filePath: s.assignedImagePath!,
                startTime: s.startTime,
                endTime: s.endTime,
                priority: s.priority,
                imageType: s.type,
            }))

            // ======================== CONVERT ẢNH TĨNH → VIDEO ========================
            // DaVinci Resolve không support thử webp chính thức và gặp lỗi resize/timing
            const FPS = 24
            const { isStillImage, ensureTempDir, convertImagesToVideo, getVideoOutputPath } = await import("@/services/image-converter")
            
            const stillImageJobs = []
            for (const clip of clips) {
                if (isStillImage(clip.filePath)) {
                    // Padding thêm 1s để dự phòng frame cho Cross Dissolve (0.3s)
                    const durationFrames = Math.max(1, Math.round((clip.endTime - clip.startTime + 1.0) * FPS))
                    // getVideoOutputPath giờ là async — lưu vào permanent folder thay vì /tmp/
                    const outputPath = await getVideoOutputPath(clip.filePath)
                    stillImageJobs.push({
                        inputPath: clip.filePath,
                        durationFrames,
                        outputPath,
                    })
                }
            }


            if (stillImageJobs.length > 0) {
                await ensureTempDir()
                setImportMessage(`🎨 Đang convert ${stillImageJobs.length} ảnh sang video (hỗ trợ WebP/PNG)...`)
                
                const convertResults = await convertImagesToVideo(
                    stillImageJobs,
                    FPS,
                    (progress) => {
                        setImportMessage(`🎨 Convert ảnh → video: ${progress.current}/${progress.total}`)
                    }
                )

                // Thay thế filePath gốc bằng file .mp4 đã convert thành công
                const successMap = new Map<string, string>()
                for (const r of convertResults) {
                    if (r.success) {
                        successMap.set(r.inputPath, r.outputPath)
                    }
                }

                for (const clip of clips) {
                    const videoPath = successMap.get(clip.filePath)
                    if (videoPath) {
                        clip.filePath = videoPath
                    }
                }
            }

            setImportMessage(`📥 Đang import ${clips.length} ảnh/video + ${sfxCount} SFX lên Track V2...`)

            // Gọi API thực tế đẩy File sang Resolve
            const data = await addRefImagesToTimeline(clips, sfxClips)

            if (data.error) {
                setImportMessage(`❌ ${data.message || "Lỗi import DaVinci"}`)
            } else {
                setImportMessage(`✅ Đã import ${data.clipsAdded ?? assigned.length} ảnh + ${data.sfxAdded ?? 0} SFX lên Track V2`)
            }
        } catch (err) {
            setImportMessage(`❌ Lỗi: ${String(err).slice(0, 100)}`)
        } finally {
            setIsImporting(false)
        }
    }, [suggestions])

    // ======================== RELINK MEDIA (sửa offline sau restart) ========================
    /**
     * Gọi AutoRelinkMedia khi mở project lại thấy clip bị offline / media not found
     * Resolve sẽ scan ~/Desktop/Auto_media và các sub-folder để tìm lại file
     */
    const handleRelinkMedia = React.useCallback(async () => {
        setIsRelinking(true)
        setRelinkMessage("🔗 Đang quét và relink clip offline...")
        try {
            const { getAutoMediaRoot } = await import("@/services/auto-media-storage")
            const mediaRoot = await getAutoMediaRoot()
            const result = await autoRelinkMedia(mediaRoot)
            if (result.error) {
                setRelinkMessage(`❌ ${result.message || "Relink thất bại"}`)
            } else if (result.offlineCount === 0) {
                setRelinkMessage("✅ Tất cả clip đang online, không cần relink")
            } else {
                setRelinkMessage(`✅ Đã relink ${result.relinkedCount}/${result.offlineCount} clip bị offline`)
            }
        } catch (err) {
            setRelinkMessage(`❌ Lỗi: ${String(err).slice(0, 80)}`)
        } finally {
            setIsRelinking(false)
            // Tự xoá message sau 5 giây
            setTimeout(() => setRelinkMessage(""), 5000)
        }
    }, [])


    // ======================== RENDER ========================
    const assignedCount = suggestions.filter(s => s.assignedImagePath).length

    return (
        <div className="flex flex-col gap-3 p-4 overflow-y-auto h-full">
            {/* Header */}
            <div className="flex items-center gap-2">
                <ImageIcon className="h-5 w-5 text-emerald-400" />
                <h4 className="text-sm font-semibold">Ảnh Tham Khảo Thực Tế</h4>
                {suggestions.length > 0 && (
                    <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded">
                        {assignedCount}/{suggestions.length} đã gán
                    </span>
                )}
                
                <Button 
                    variant="ghost" 
                    size="sm" 
                    className="h-6 w-6 p-0 ml-auto rounded-full bg-muted/50 hover:bg-emerald-500/20 text-emerald-500"
                    onClick={() => setShowAddCustom(!showAddCustom)}
                    title="Thêm ảnh thủ công"
                >
                    <Plus className="h-4 w-4" />
                </Button>
            </div>

            {/* ===== CHỌN FOLDER DỰ ÁN ===== */}
            <div className="space-y-1 p-2 rounded-md bg-muted/20 border border-border">
                <Label className="text-[11px] font-medium">📂 Thư mục Project (Lưu Cache)</Label>
                <div className="flex gap-2">
                    <Button
                        variant="outline"
                        className="flex-1 justify-start gap-2 h-8 min-w-0 px-2"
                        onClick={handleLoadScript}
                    >
                        <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate text-xs">
                            {project?.matchingFolder
                                ? project.matchingFolder.split(/[/\\]/).pop()
                                : "Chọn thư mục..."}
                        </span>
                    </Button>
                    {project?.matchingFolder && (
                        <Button
                            variant={folderSaved ? "secondary" : "outline"}
                            size="icon"
                            className={`h-8 w-8 shrink-0 transition-all ${
                                folderSaved
                                    ? "bg-green-500/20 border-green-500/40 text-green-400"
                                    : "hover:border-green-500/40 hover:text-green-400"
                            }`}
                            onClick={() => {
                                saveFolderPath("matchingFolder", project.matchingFolder!)
                                setFolderSaved(true)
                                setTimeout(() => setFolderSaved(false), 2000)
                            }}
                            title="Lưu thư mục để tự load lần sau"
                        >
                            {folderSaved ? <span className="text-xs">✓</span> : <Save className="h-3.5 w-3.5" />}
                        </Button>
                    )}
                </div>
            </div>

            {/* ===== FORM MANUAL ADD (Collapsible) ===== */}
            {showAddCustom && (
                <div className="p-3 rounded-md bg-emerald-500/5 border border-emerald-500/20 space-y-2 animate-in fade-in zoom-in-95 duration-200">
                    <Label className="text-[11px] font-medium text-emerald-500">➕ Thêm bằng thời gian (giây)</Label>
                    <div className="flex items-center gap-2">
                        <div className="flex-1 space-y-1">
                            <span className="text-[9px] text-muted-foreground">Bắt đầu (s)</span>
                            <input
                                type="number"
                                step="0.1"
                                value={customStart}
                                onChange={e => setCustomStart(e.target.value)}
                                className="flex h-7 w-full rounded-md border border-input bg-background px-3 py-1 text-xs shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500"
                            />
                        </div>
                        <div className="flex-1 space-y-1">
                            <span className="text-[9px] text-muted-foreground">Kết thúc (s)</span>
                            <input
                                type="number"
                                step="0.1"
                                value={customEnd}
                                onChange={e => setCustomEnd(e.target.value)}
                                className="flex h-7 w-full rounded-md border border-input bg-background px-3 py-1 text-xs shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500"
                            />
                        </div>
                    </div>
                    <Button
                        variant="default"
                        size="sm"
                        className="w-full h-7 text-[10px] bg-emerald-600 hover:bg-emerald-700 mt-2"
                        onClick={handleAddCustom}
                        disabled={isAddingCustom}
                    >
                         {isAddingCustom ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Sparkles className="h-3 w-3 mr-1" />}
                         Lấy gợi ý AI đoạn này
                    </Button>
                    {addCustomMessage && <p className="text-[10px] text-muted-foreground mt-1">{addCustomMessage}</p>}
                </div>
            )}

            {/* ===== NÚT AI PHÂN TÍCH TỔNG ===== */}
            <div className="space-y-2 p-2 rounded-md bg-muted/20 border border-border">
                <Label className="text-[11px] font-medium">🔍 Đang trống? Cho AI phân tích toàn bộ video</Label>

                <Button
                    variant="default"
                    size="sm"
                    className="w-full h-8 gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-700"
                    onClick={handleAnalyze}
                    disabled={isAnalyzing}
                >
                    {isAnalyzing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                    )}
                    {isAnalyzing ? "Đang phân tích..." : "AI Gợi Ý Ảnh Tham Khảo"}
                </Button>

                {analyzeMessage && (
                    <p className="text-[10px] text-muted-foreground">{analyzeMessage}</p>
                )}

                {/* Nút copy tất cả */}
                {suggestions.length > 0 && (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-[10px] gap-1 text-muted-foreground w-full"
                        onClick={handleCopyAll}
                    >
                        <Copy className="h-3 w-3" /> Copy tất cả gợi ý
                    </Button>
                )}
            </div>

            {/* ===== DANH SÁCH GỢI Ý ===== */}
            {suggestions.length > 0 && (
                <div className="space-y-1.5">
                    {suggestions.map((s, idx) => (
                        <div
                            key={s.id}
                            className={`p-2 rounded-md border transition-all ${
                                s.assignedImagePath
                                    ? "bg-emerald-500/5 border-emerald-500/30"
                                    : "bg-muted/20 border-border"
                            }`}
                        >
                            {/* Header: type icon + time + priority */}
                            <div className="flex items-center gap-1.5 mb-1">
                                <span className="text-emerald-400">
                                    {TYPE_ICONS[s.type] || <ImageIcon className="h-3 w-3" />}
                                </span>
                                <span className="text-[10px] font-mono text-muted-foreground">
                                    {s.startTime.toFixed(1)}s - {s.endTime.toFixed(1)}s
                                </span>
                                <span className={`text-[9px] px-1 py-0.5 rounded border ${PRIORITY_COLORS[s.priority] || ""}`}>
                                    {s.priority}
                                </span>
                                <span className="text-[9px] text-muted-foreground ml-auto">
                                    Câu {s.sentenceNum}
                                </span>
                                {/* Nút xoá suggestion */}
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-4 w-4 p-0 shrink-0 opacity-40 hover:opacity-100"
                                    onClick={() => handleRemoveSuggestion(idx)}
                                >
                                    <X className="h-3 w-3" />
                                </Button>
                            </div>

                            {/* Mô tả */}
                            <p className="text-[11px] font-medium mb-1">{s.description}</p>

                            {/* Keywords */}
                            <div className="flex flex-wrap gap-1 mb-1.5">
                                {s.searchKeywords.map((kw, ki) => (
                                    <span
                                        key={ki}
                                        className="text-[9px] px-1 py-0.5 rounded bg-muted/50 text-muted-foreground"
                                    >
                                        {kw}
                                    </span>
                                ))}
                            </div>

                            {/* Action buttons */}
                            <div className="flex items-center gap-1">
                                {/* Copy keywords */}
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 text-[10px] gap-1 px-1.5"
                                    onClick={() => handleCopyKeywords(s)}
                                >
                                    {copiedId === s.id ? (
                                        <><Check className="h-3 w-3 text-green-500" /> Copied</>
                                    ) : (
                                        <><Copy className="h-3 w-3" /> Copy</>
                                    )}
                                </Button>

                                {/* Open Google */}
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 text-[10px] gap-1 px-1.5"
                                    onClick={() => {
                                        const q = encodeURIComponent(s.searchKeywords[0] || s.description)
                                        window.open(`https://www.google.com/search?tbm=isch&q=${q}`, "_blank")
                                    }}
                                >
                                    <ExternalLink className="h-3 w-3" /> Google
                                </Button>

                                {/* Gán ảnh */}
                                {s.assignedImagePath ? (
                                    <div className="flex items-center gap-1 ml-auto">
                                        <span className="text-[10px] text-emerald-400 truncate max-w-[80px]">
                                            ✅ {s.assignedImageName}
                                        </span>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-5 w-5 p-0"
                                            onClick={() => handleRemoveImage(s.id)}
                                        >
                                            <X className="h-3 w-3" />
                                        </Button>
                                    </div>
                                ) : (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-6 text-[10px] gap-1 px-1.5 ml-auto border-emerald-500/30 hover:bg-emerald-500/10"
                                        onClick={() => handleAssignImage(s.id)}
                                    >
                                        <FolderOpen className="h-3 w-3" /> Chọn ảnh
                                    </Button>
                                )}
                            </div>

                            {/* Reason (collapsed) */}
                            {s.reason && (
                                <p className="text-[9px] text-muted-foreground mt-1 italic">
                                    💡 {s.reason}
                                </p>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {/* ===== NÚT IMPORT ===== */}
            {assignedCount > 0 && (
                <Button
                    onClick={handleImport}
                    disabled={isImporting}
                    className="w-full gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                    {isImporting ? (
                        <><Loader2 className="h-4 w-4 animate-spin" /> Đang import...</>
                    ) : (
                        <><Upload className="h-4 w-4" /> Import {assignedCount} ảnh lên Track V2</>
                    )}
                </Button>
            )}

            {/* Import message */}
            {importMessage && (
                <p className={`text-[10px] p-1.5 rounded ${
                    importMessage.startsWith("✅")
                        ? "bg-green-500/10 text-green-400"
                        : importMessage.startsWith("❌")
                            ? "bg-red-500/10 text-red-400"
                            : "text-muted-foreground"
                }`}>
                    {importMessage}
                </p>
            )}

            {/* ===== NÚT RELINK — sửa lỗi Media not found sau khi tắt máy ===== */}
            <Button
                onClick={handleRelinkMedia}
                disabled={isRelinking}
                variant="outline"
                size="sm"
                className="w-full gap-2 text-xs border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:border-amber-500/60"
                title="Dùng khi mở project lại thấy clip bị offline / Media not found"
            >
                {isRelinking ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Đang relink...</>
                ) : (
                    <><Link2 className="h-3.5 w-3.5" /> 🔗 Relink Media (Fix offline sau restart)</>
                )}
            </Button>

            {/* Relink message */}
            {relinkMessage && (
                <p className={`text-[10px] p-1.5 rounded ${
                    relinkMessage.startsWith("✅")
                        ? "bg-amber-500/10 text-amber-400"
                        : relinkMessage.startsWith("❌")
                            ? "bg-red-500/10 text-red-400"
                            : "text-muted-foreground"
                }`}>
                    {relinkMessage}
                </p>
            )}

            {/* Hướng dẫn */}
            <div className="mt-auto p-2 rounded-md bg-muted/30 border border-border text-[10px] text-muted-foreground space-y-0.5">
                <p>🔍 <strong>Bước 1</strong>: AI gợi ý 6-10 moment cần ảnh thực tế</p>
                <p>📋 <strong>Bước 2</strong>: Copy keywords → tìm ảnh trên Google/Pinterest/Wikipedia</p>
                <p>📂 <strong>Bước 3</strong>: Gán ảnh đã tải vào từng slot</p>
                <p>📤 <strong>Bước 4</strong>: Import lên DaVinci Track V2 (overlay)</p>
            </div>
        </div>
    )
}
