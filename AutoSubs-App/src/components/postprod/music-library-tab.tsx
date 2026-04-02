// music-library-tab.tsx
// Sub-tab "Nhạc Nền" trong Post-Production Panel
// Cho phép:
// 1. Chọn thư mục nhạc → quét file audio
// 2. Bấm "Scan AI" → AI phân tích & tạo metadata cho từng bài
// 3. Hiển thị danh sách nhạc với tag cảm xúc + mô tả AI
// 4. AI Đạo Diễn gán nhạc cho từng Scene dựa trên kịch bản
// 5. Preview nghe thử nhạc nền (play/pause/seek)

import * as React from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
    FolderOpen,
    Sparkles,
    Music,
    Loader2,
    Info,
    Search,
    ChevronDown,
    ChevronRight,
    RefreshCw,
    Play,
    Pause,
    Save,
    StopCircle,
    Copy,
    Check,
    Zap,
    PlusCircle,
} from "lucide-react"
import { open } from "@tauri-apps/plugin-dialog"
import { desktopDir } from "@tauri-apps/api/path"
import {
    scanAudioFolder,
    scanAndAnalyzeFolder,
    loadAudioItemsFromFolder,
    findNewFiles,
    type ScanProgress,
} from "@/services/audio-library-service"
import {
    analyzeScriptForMusic,
} from "@/services/audio-director-service"
import {
    generateMediaIdeas,
    MusicKeywordSuggestion
} from "@/services/idea-generator-service"
import {
    AudioLibraryItem,
    AudioTimelineSegment,
} from "@/types/audio-types"
import { mixAudioScenesAndDuck } from "@/services/audio-ffmpeg-service"
import { useAudioPreview, type UseAudioPreviewReturn } from "@/hooks/useAudioPreview"
import { useProject } from "@/contexts/ProjectContext"
import {
    saveFolderPath,
    getSavedFolder,
    getAudioScanApiKey,
} from "@/services/saved-folders-service"
import { getMusicFolderPath } from "@/services/auto-media-storage"

export function MusicLibraryTab() {
    // ======================== PROJECT CONTEXT ========================
    // Dùng ProjectContext để chia sẻ data với các tab khác + lưu vào session
    const {
        project,
        updateMusicLibrary,
    } = useProject()

    // Lấy data từ context (thay vì useState)
    const musicFolder = project.musicLibrary.musicFolder
    const musicItems = project.musicLibrary.musicItems
    const directorResult = project.musicLibrary.directorResult
    // Matching folder + sentences dùng chung
    const matchingFolder = project.matchingFolder

    // Ref giữ bản sao mới nhất của musicItems — tránh stale closure trong callback
    const musicItemsRef = React.useRef(musicItems)
    React.useEffect(() => { musicItemsRef.current = musicItems }, [musicItems])
    const sentences = project.matchingSentences

    // ======================== LOCAL STATE (UI transient) ========================

    // Hook audio preview — quản lý play/pause/seek nhạc nền
    const audioPreview = useAudioPreview()

    // Bài nhạc đang được chọn (click để xem mô tả)
    const [selectedItem, setSelectedItem] = React.useState<AudioLibraryItem | null>(null)

    // Trạng thái quét AI
    const [isScanning, setIsScanning] = React.useState(false)
    const [scanProgress, setScanProgress] = React.useState<ScanProgress | null>(null)

    // Ref để giữ AbortController — dùng để dừng scan giữa chừng
    const abortControllerRef = React.useRef<AbortController | null>(null)

    // Số file mới cần quét
    const [newFilesCount, setNewFilesCount] = React.useState(0)

    // Thanh tìm kiếm
    const [searchQuery, setSearchQuery] = React.useState("")

    // Section collapse
    const [libraryExpanded, setLibraryExpanded] = React.useState(true)
    const [suggestExpanded, setSuggestExpanded] = React.useState(true)

    // Trạng thái đang phân tích kịch bản
    const [isAnalyzing, setIsAnalyzing] = React.useState(false)
    const [analyzeProgress, setAnalyzeProgress] = React.useState<string>("")
    const [analyzeError, setAnalyzeError] = React.useState("")
    const [isImporting, setIsImporting] = React.useState(false)
    const [importProgress, setImportProgress] = React.useState("")

    // Gợi ý từ khóa nhạc nền
    const [isSuggestingKeywords, setIsSuggestingKeywords] = React.useState(false)
    const [musicKeywords, setMusicKeywords] = React.useState<MusicKeywordSuggestion[]>([])
    const [keywordsExpanded, setKeywordsExpanded] = React.useState(true)

    // Trạng thái "đã lưu" — hiện tick xanh sau khi bấm Save
    const [musicFolderSaved, setMusicFolderSaved] = React.useState(false)
    // ======================== AUTO-LOAD THƯ MỤC ĐÃ LƯU ========================
    // Khi component mount lần đầu, tự động load thư mục nhạc nền đã lưu.
    // Nếu chưa từng lưu folder nào → fallback vào ~/Desktop/Auto_media/nhac_nen
    React.useEffect(() => {
        const loadSavedMusicFolder = async () => {
            // Chỉ load nếu chưa có folder nào được chọn
            if (musicFolder) return

            // Ưu tiên: folder đã lưu trước đó
            let folderToLoad = await getSavedFolder("musicFolder")

            // Fallback: ~/Desktop/Auto_media/nhac_nen (đường dẫn động theo máy)
            if (!folderToLoad) {
                folderToLoad = await getMusicFolderPath()
                console.log("[MusicLib] Dùng Auto_media fallback:", folderToLoad)
            }

            console.log("[MusicLib] Auto-load thư mục nhạc:", folderToLoad)
            updateMusicLibrary({ musicFolder: folderToLoad })

            try {
                // Quét folder + load metadata từ file JSON trong folder
                const scanned = await scanAudioFolder(folderToLoad, "music")
                const folderItems = await loadAudioItemsFromFolder(folderToLoad)

                // TỰ ĐỘNG DỌN DẸP: NẾU FILE ĐÃ BỊ XOÁ KHỎI Ổ CỨNG -> XOÁ LUÔN KHỎI DỮ LIỆU JSON
                const currentPaths = new Set(scanned.map(i => i.filePath));
                const cleanedFolderItems = folderItems.filter(item => currentPaths.has(item.filePath));
                const deletedCount = folderItems.length - cleanedFolderItems.length;
                
                if (deletedCount > 0) {
                    const { saveAudioItemsToFolder } = await import("@/services/audio-library-service");
                    await saveAudioItemsToFolder(folderToLoad, cleanedFolderItems);
                    console.log(`[MusicLib] 🧹 Khởi động: Đã dọn dẹp ${deletedCount} file bị xoá khỏi metadata JSON`);
                }

                const folderMap = new Map(cleanedFolderItems.map(i => [i.filePath, i]))

                // Merge: ưu tiên metadata từ file JSON
                const mergedItems = scanned.map(item => {
                    const existing = folderMap.get(item.filePath)
                    if (existing && existing.aiMetadata) return existing
                    return item
                })
                updateMusicLibrary({ musicItems: mergedItems })

                // Đếm file mới cần quét AI
                const newFiles = findNewFiles(scanned, cleanedFolderItems)
                setNewFilesCount(newFiles.length)
            } catch (error) {
                console.error("[MusicLib] Lỗi auto-load thư mục nhạc:", error)
            }
        }
        loadSavedMusicFolder()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // ======================== HANDLERS ========================

    /**
     * Chọn thư mục chứa nhạc nền
     * Quét tất cả file audio → load metadata từ file JSON → tìm file mới
     */
    const handleSelectFolder = async () => {
        try {
            // Mặc định mở dialog tại Desktop cho dễ chọn
            const desktop = await desktopDir()
            const folderPath = await open({
                directory: true,
                multiple: false,
                title: "Chọn thư mục chứa nhạc nền (BGM)",
                defaultPath: desktop,
            })
            if (!folderPath) return

            // Lưu vào ProjectContext
            updateMusicLibrary({ musicFolder: folderPath as string })

            // Quét folder + load metadata từ file JSON trong folder
            const scanned = await scanAudioFolder(folderPath as string, "music")
            const folderItems = await loadAudioItemsFromFolder(folderPath as string)

            // TỰ ĐỘNG DỌN DẸP KHI CHỌN FOLDER MỚI
            const currentPaths = new Set(scanned.map(i => i.filePath));
            const cleanedFolderItems = folderItems.filter(item => currentPaths.has(item.filePath));
            const deletedCount = folderItems.length - cleanedFolderItems.length;
            
            if (deletedCount > 0) {
                const { saveAudioItemsToFolder } = await import("@/services/audio-library-service");
                await saveAudioItemsToFolder(folderPath as string, cleanedFolderItems);
                console.log(`[MusicLib] 🧹 Chọn folder: Đã dọn dẹp ${deletedCount} file bị xoá khỏi metadata JSON`);
            }

            const folderMap = new Map(cleanedFolderItems.map(i => [i.filePath, i]))

            // Merge: ưu tiên metadata từ file JSON
            const mergedItems = scanned.map(item => {
                const existing = folderMap.get(item.filePath)
                if (existing && existing.aiMetadata) return existing
                return item
            })

            updateMusicLibrary({ musicItems: mergedItems })

            // Đếm file mới cần quét AI
            const newFiles = findNewFiles(scanned, cleanedFolderItems)
            setNewFilesCount(newFiles.length)

        } catch (error) {
            console.error("[MusicLib] Lỗi chọn folder:", error)
        }
    }

    /**
     * Quét AI cho tất cả file mới (chưa có metadata)
     * Sliding window: luôn giữ ~10 request đồng thời, lưu file JSON trong folder
     */
    const handleScanAI = async () => {
        // Đọc API key từ Settings (localStorage)
        const savedApiKey = await getAudioScanApiKey()
        if (!musicFolder || !savedApiKey) {
            if (!savedApiKey) {
                setAnalyzeError("Vui lòng vào Settings nhập Gemini API Key trước khi scan!")
            }
            return
        }

        // Tạo AbortController mới cho lần scan này
        const abortController = new AbortController()
        abortControllerRef.current = abortController

        setIsScanning(true)
        setScanProgress(null)
        setAnalyzeError("")

        try {
            // Gọi service quét + phân tích (sliding window, lưu IndexedDB)
            const updatedItems = await scanAndAnalyzeFolder(
                musicFolder,
                "music",
                savedApiKey,
                (progress) => {
                    setScanProgress(progress)
                },
                abortController.signal,
                // Callback mỗi khi 1 file scan xong → cập nhật UI real-time
                (completedItem) => {
                    // Dùng ref để lấy mảng mới nhất (tránh stale closure)
                    const latest = musicItemsRef.current
                    const updated = latest.map(item =>
                        item.filePath === completedItem.filePath ? completedItem : item
                    )
                    musicItemsRef.current = updated
                    updateMusicLibrary({ musicItems: updated })
                }
            )

            // Cập nhật vào ProjectContext
            updateMusicLibrary({ musicItems: updatedItems })

            // Nếu không bị dừng giữa chừng → đã quét hết
            if (!abortController.signal.aborted) {
                setNewFilesCount(0)
            }
        } catch (error) {
            console.error("[MusicLib] Lỗi scan AI:", error)
            setAnalyzeError("Lỗi scan AI: " + String(error))
        } finally {
            setIsScanning(false)
            abortControllerRef.current = null
        }
    }

    /**
     * Dừng scan AI giữa chừng
     * Các file đang chạy sẽ hoàn tất, nhưng không nhận thêm file mới
     */
    const handleStopScan = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort()
            console.log("[MusicLib] ⏹️ User yêu cầu dừng scan")
        }
    }

    // ======================== FILTER ========================

    // Lọc nhạc theo search query (tìm trong tên file, tags, emotion, description)
    const filteredItems = React.useMemo(() => {
        if (!searchQuery.trim()) return musicItems

        const q = searchQuery.toLowerCase()
        return musicItems.filter((item) => {
            // Tìm trong tên file
            if (item.fileName.toLowerCase().includes(q)) return true
            // Tìm trong metadata AI
            if (item.aiMetadata) {
                const meta = item.aiMetadata
                if (meta.description.toLowerCase().includes(q)) return true
                if (meta.emotion.some((e) => e.toLowerCase().includes(q))) return true
                if (meta.tags.some((t) => t.toLowerCase().includes(q))) return true
            }
            return false
        })
    }, [musicItems, searchQuery])

    // Đếm nhạc đã có metadata vs tổng
    const analyzedCount = musicItems.filter((i) => i.aiMetadata).length

    // ======================== MANUAL SCAN TOOLS ========================
    const handleRevealInFinder = React.useCallback(async (filePath: string) => {
        try {
            const { Command } = await import('@tauri-apps/plugin-shell');
            await Command.create("exec-sh", ["-c", `open -R "${filePath}"`]).execute();
        } catch (e) {
            console.error("Lỗi khi mở Finder:", e);
        }
    }, []);

    const handleCopyPrompt = React.useCallback(async (_item: AudioLibraryItem) => {
        const prompt = `Phân tích nhạc nền (Music) này và trả về định dạng JSON chính xác sau (CHỈ TRẢ VỀ JSON, KHÔNG THÊM BẤT KỲ VĂN BẢN NÀO KHÁC):\n{\n  "description": "mô tả cảm xúc và nhạc cụ chính (dưới 15 từ)",\n  "tags": ["epic", "piano", "sad"],\n  "emotion": ["mood1", "mood2"],\n  "intensity": "Cao",\n  "totalDurationSec": 60,\n  "timeline": [],\n  "beats": [],\n  "trimSuggestions": []\n}`; // "Cao" / "Trung bình" / "Thấp"
        await navigator.clipboard.writeText(prompt);
    }, []);

    const handlePasteJson = React.useCallback(async (item: AudioLibraryItem) => {
        const jsonStr = window.prompt(`Dán JSON từ Gemini cho file ${item.fileName}:\nVD: {"description":"...","tags":["..."],"emotion":["..."],"intensity":"Cao",...}`);
        if (!jsonStr) return;
        try {
            const match = jsonStr.match(/\{[\s\S]*\}/);
            if (!match) throw new Error("Không tìm thấy dấu {} JSON hợp lệ");
            const parsed = JSON.parse(match[0]);

            const newMeta = {
                description: parsed.description || "Manual",
                tags: Array.isArray(parsed.tags) ? parsed.tags : [],
                emotion: Array.isArray(parsed.emotion) ? parsed.emotion : [],
                intensity: parsed.intensity || "Trung bình",
                totalDurationSec: parsed.totalDurationSec || item.durationSec || 60,
                timeline: Array.isArray(parsed.timeline) ? parsed.timeline : [],
                beats: Array.isArray(parsed.beats) ? parsed.beats : [],
                trimSuggestions: Array.isArray(parsed.trimSuggestions) ? parsed.trimSuggestions : []
            };

            const newItem: AudioLibraryItem = {
                ...item,
                aiMetadata: newMeta,
                scannedAt: new Date().toISOString()
            };

            const allItems = musicItems.map(i => i.filePath === item.filePath ? newItem : i);
            
            if (matchingFolder) {
                const { saveAudioItemsToFolder } = await import("@/services/audio-library-service");
                await saveAudioItemsToFolder(matchingFolder, allItems);
                updateMusicLibrary({ musicItems: allItems });
                alert(`✅ Đã cập nhật metadata thủ công cho ${item.fileName}`);
            }
        } catch (e) {
            alert("Lỗi parse JSON: " + String(e));
        }
    }, [musicItems, matchingFolder, updateMusicLibrary]);

    // ======================== RENDER ========================

    return (
        <ScrollArea className="flex-1 min-h-0 h-full">
            <div className="p-4 space-y-4">

                {/* ===== SECTION 1: Chọn Thư Mục ===== */}
                <div className="space-y-2">
                    <label className="text-sm font-medium">1. Thư Mục Nhạc Nền</label>
                    <div className="flex gap-2">
                        {/* Nút chọn thư mục nhạc — click để đổi thư mục */}
                        <Button
                            variant="outline"
                            className="flex-1 justify-start gap-2 h-10 min-w-0"
                            onClick={handleSelectFolder}
                        >
                            <FolderOpen className="h-4 w-4 shrink-0" />
                            <span className="truncate">
                                {musicFolder
                                    ? musicFolder.split(/[/\\]/).pop()
                                    : "Chọn thư mục chứa nhạc..."}
                            </span>
                        </Button>

                        {/* Nút Save — lưu đường dẫn thư mục để dùng lại lần sau */}
                        {musicFolder && (
                            <Button
                                variant={musicFolderSaved ? "secondary" : "outline"}
                                size="icon"
                                className={`h-10 w-10 shrink-0 transition-all ${
                                    musicFolderSaved
                                        ? "bg-green-500/20 border-green-500/40 text-green-400"
                                        : "hover:border-green-500/40 hover:text-green-400"
                                }`}
                                onClick={() => {
                                    saveFolderPath("musicFolder", musicFolder)
                                    setMusicFolderSaved(true)
                                    // Reset trạng thái sau 2 giây
                                    setTimeout(() => setMusicFolderSaved(false), 2000)
                                }}
                                title="Lưu thư mục nhạc để dùng lại lần sau"
                            >
                                {musicFolderSaved ? (
                                    <span className="text-sm">✓</span>
                                ) : (
                                    <Save className="h-4 w-4" />
                                )}
                            </Button>
                        )}
                    </div>

                    {/* Thống kê sau khi chọn folder */}
                    {musicItems.length > 0 && (
                        <div className="flex items-center justify-between">
                            <p className="text-xs text-muted-foreground">
                                🎵 {musicItems.length} file nhạc •{" "}
                                {analyzedCount > 0 && (
                                    <span className="text-green-500">
                                        {analyzedCount} đã phân tích
                                    </span>
                                )}
                                {newFilesCount > 0 && (
                                    <span className="text-yellow-500 ml-1">
                                        • {newFilesCount} file mới
                                    </span>
                                )}
                            </p>

                            {/* Nút Scan AI — chỉ hiện khi có file mới */}
                            {newFilesCount > 0 && (
                                <Button
                                    variant="default"
                                    size="sm"
                                    className="h-7 gap-1 text-xs bg-purple-600 hover:bg-purple-700"
                                    onClick={handleScanAI}
                                    disabled={isScanning}
                                >
                                    {isScanning ? (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                        <Sparkles className="h-3 w-3" />
                                    )}
                                    Scan AI ({newFilesCount})
                                </Button>
                            )}
                        </div>
                    )}

                    {/* Progress bar + nút Dừng khi đang scan */}
                    {isScanning && scanProgress && (
                        <div className="space-y-1.5">
                            <div className="flex items-center gap-2">
                                <Loader2 className="h-3 w-3 animate-spin text-purple-400 shrink-0" />
                                <p className="text-xs text-purple-400 animate-pulse flex-1 min-w-0 truncate">
                                    {scanProgress.message}
                                </p>
                                {/* Nút Dừng scan */}
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-6 px-2 gap-1 text-[11px] shrink-0 border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                                    onClick={handleStopScan}
                                >
                                    <StopCircle className="h-3 w-3" />
                                    Dừng
                                </Button>
                            </div>
                            {/* Progress bar */}
                            <div className="w-full bg-muted rounded-full h-1.5">
                                <div
                                    className="bg-purple-500 h-1.5 rounded-full transition-all duration-300"
                                    style={{
                                        width: scanProgress.total > 0
                                            ? `${(scanProgress.current / scanProgress.total) * 100}%`
                                            : "0%",
                                    }}
                                />
                            </div>
                        </div>
                    )}

                    {/* Hiển thị lỗi scan */}
                    {analyzeError && (
                        <p className="text-xs text-red-500 bg-red-500/10 p-2 rounded border border-red-500/20">
                            ❌ {analyzeError}
                        </p>
                    )}
                </div>

                {/* ===== SECTION 2: Danh Sách Nhạc ===== */}
                {musicItems.length > 0 && (
                    <div className="space-y-2">
                        {/* Header section có thể collapse */}
                        <button
                            className="flex items-center gap-1 text-sm font-medium w-full text-left hover:text-primary transition-colors"
                            onClick={() => setLibraryExpanded(!libraryExpanded)}
                        >
                            {libraryExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                            )}
                            2. Thư Viện Nhạc ({filteredItems.length})
                        </button>

                        {libraryExpanded && (
                            <>
                                {/* Thanh tìm kiếm */}
                                <div className="relative">
                                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                                    <input
                                        type="text"
                                        placeholder="Tìm nhạc (tên, cảm xúc, tag)..."
                                        className="w-full h-8 pl-8 pr-3 rounded-md border border-input bg-background text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                    />
                                </div>

                                {/* Danh sách nhạc */}
                                <div className="space-y-1 max-h-64 overflow-y-auto">
                                    {filteredItems.map((item) => (
                                        <MusicItemRow
                                            key={item.filePath}
                                            item={item}
                                            isSelected={selectedItem?.filePath === item.filePath}
                                            audioPreview={audioPreview}
                                            onClick={() =>
                                                setSelectedItem(
                                                    selectedItem?.filePath === item.filePath
                                                        ? null
                                                        : item
                                                )
                                            }
                                            onRevealInFinder={handleRevealInFinder}
                                            onCopyPrompt={handleCopyPrompt}
                                            onPasteJson={handlePasteJson}
                                        />
                                    ))}

                                    {filteredItems.length === 0 && searchQuery && (
                                        <p className="text-xs text-muted-foreground text-center py-4">
                                            Không tìm thấy nhạc nào khớp "{searchQuery}"
                                        </p>
                                    )}
                                </div>

                                {/* === Mini Player: thanh preview khi đang phát nhạc === */}
                                {audioPreview.state.currentFilePath && (
                                    <MiniPlayer
                                        audioPreview={audioPreview}
                                        musicItems={musicItems}
                                    />
                                )}

                                {/* Hiển thị mô tả khi chọn bài */}
                                {selectedItem?.aiMetadata && (
                                    <div className="bg-muted/50 rounded-md px-3 py-2 border border-border/50 space-y-2">
                                        <div className="flex items-start gap-2">
                                            <Info className="h-3.5 w-3.5 text-blue-400 mt-0.5 shrink-0" />
                                            <p className="text-xs text-muted-foreground leading-relaxed">
                                                {selectedItem.aiMetadata.description}
                                            </p>
                                        </div>

                                        {/* Hiển thị Timeline nếu có */}
                                        {selectedItem.aiMetadata.timeline && selectedItem.aiMetadata.timeline.length > 0 && (
                                            <div className="pt-2 border-t border-border/50">
                                                <p className="text-[10px] font-semibold text-muted-foreground mb-1">TIMELINE CẢM XÚC:</p>
                                                <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
                                                    {selectedItem.aiMetadata.timeline.map((seg: AudioTimelineSegment, idx: number) => (
                                                        <div key={idx} className="flex gap-2 items-start opacity-80 hover:opacity-100 transition-opacity">
                                                            <span className="text-[10px] font-mono text-primary bg-primary/10 px-1 py-0.5 rounded shrink-0 mt-0.5">
                                                                {Math.floor(seg.startSec / 60)}:{String(Math.floor(seg.startSec % 60)).padStart(2, "0")} - {Math.floor(seg.endSec / 60)}:{String(Math.floor(seg.endSec % 60)).padStart(2, "0")}
                                                            </span>
                                                            <div className="flex flex-col">
                                                                <span className="text-[10px] font-medium text-foreground">{seg.emotion}</span>
                                                                <span className="text-[9px] text-muted-foreground">{seg.description}</span>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                )}

                {/* ===== SECTION: Gợi Ý Từ Khóa Nhạc Nền ===== */}
                <div className="space-y-2 pt-2 border-t">
                    {/* Header collapse */}
                    <button
                        className="flex items-center gap-1 text-sm font-medium w-full text-left hover:text-primary transition-colors"
                        onClick={() => setKeywordsExpanded(!keywordsExpanded)}
                    >
                        {keywordsExpanded ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                        )}
                        🎵 Gợi Ý Suno AI Prompts
                        {musicKeywords.length > 0 && (
                            <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30">
                                {musicKeywords.length} prompts
                            </span>
                        )}
                    </button>

                    {keywordsExpanded && (
                        <div className="space-y-2">
                            {/* Nút gọi AI gợi ý keywords */}
                            <Button
                                variant="outline"
                                size="sm"
                                className="w-full gap-2 h-8 text-xs"
                                onClick={async () => {
                                    setIsSuggestingKeywords(true)
                                    try {
                                        const keywords = await generateMediaIdeas(
                                            "music",
                                            (msg) => setAnalyzeProgress(msg)
                                        )
                                        setMusicKeywords(keywords)
                                    } catch (err) {
                                        setAnalyzeError(String(err))
                                    } finally {
                                        setIsSuggestingKeywords(false)
                                        setAnalyzeProgress("")
                                    }
                                }}
                                disabled={isSuggestingKeywords}
                            >
                                    {isSuggestingKeywords ? (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                        <Zap className="h-3 w-3" />
                                    )}
                                    {isSuggestingKeywords
                                        ? "Đang phân tích..."
                                        : musicKeywords.length > 0
                                            ? "Gợi ý lại"
                                            : "AI Tạo Suno Prompts Nhạc Nền"}
                                </Button>

                                {/* Danh sách Suno AI prompts — dạng card */}
                                {musicKeywords.length > 0 && (
                                    <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
                                        {musicKeywords.map((item, idx) => (
                                            <MusicKeywordRow key={idx} item={item} index={idx + 1} />
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                {/* ===== SECTION 3: AI Gợi Ý Nhạc Nền ===== */}
                {analyzedCount > 0 && (
                    <div className="space-y-3 pt-2 border-t">
                        {/* Header collapse */}
                        <button
                            className="flex items-center gap-1 text-sm font-medium w-full text-left hover:text-primary transition-colors"
                            onClick={() => setSuggestExpanded(!suggestExpanded)}
                        >
                            {suggestExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                            )}
                            3. AI Gợi Ý Nhạc Nền
                            {directorResult && (
                                <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-400 border border-green-500/30">
                                    {directorResult.scenes.length} cảnh
                                </span>
                            )}
                        </button>

                        {suggestExpanded && (
                            <div className="space-y-2">
                                {/* Hiển thị trạng thái dữ liệu thay vì bắt chọn file */}
                                <div className="space-y-1 mb-2">
                                    {sentences && sentences.length > 0 ? (
                                        <div className="flex items-center gap-2 text-xs bg-green-500/10 text-green-600 dark:text-green-400 p-2 rounded-md border border-green-500/20">
                                            <Check className="h-4 w-4 shrink-0" />
                                            <span>
                                                Đã nhận <strong>{sentences.length} câu</strong> từ kết quả AI Matching.
                                            </span>
                                        </div>
                                    ) : (
                                        <div className="flex items-start gap-2 text-xs bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 p-2 rounded-md border border-yellow-500/20">
                                            <span className="text-[14px] leading-none shrink-0">⚠️</span>
                                            <div>
                                                <p className="font-medium mb-0.5">Chưa có dữ liệu Kịch bản (Matching)</p>
                                                <p className="text-[11px] opacity-80">
                                                    Vui lòng qua tab <strong>Media Import</strong> và chạy <strong>AI Match</strong> trước để AI phân tích nhạc chuẩn xác.
                                                </p>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* Nút Gợi Ý AI */}
                                {sentences && sentences.length > 0 && (
                                    <Button
                                        variant="default"
                                        className="w-full gap-2 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700"
                                        onClick={async () => {
                                            if (!sentences || musicItems.length === 0) return
                                            setIsAnalyzing(true)
                                            setAnalyzeError("")
                                            updateMusicLibrary({ directorResult: null })
                                            try {
                                                const result = await analyzeScriptForMusic(
                                                    matchingFolder || "",
                                                    sentences,
                                                    musicItems.filter(i => i.aiMetadata),
                                                    (msg) => setAnalyzeProgress(msg)
                                                )
                                                // Lưu kết quả AI gợi ý vào ProjectContext
                                                updateMusicLibrary({ directorResult: result })
                                            } catch (err) {
                                                setAnalyzeError(String(err))
                                            } finally {
                                                setIsAnalyzing(false)
                                                setAnalyzeProgress("")
                                            }
                                        }}
                                        disabled={isAnalyzing}
                                    >
                                        {isAnalyzing ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : directorResult ? (
                                            <RefreshCw className="h-4 w-4" />
                                        ) : (
                                            <Sparkles className="h-4 w-4" />
                                        )}
                                        {isAnalyzing
                                            ? "Đang phân tích..."
                                            : directorResult
                                                ? "Phân tích lại"
                                                : "AI Gợi Ý Nhạc Nền"}
                                    </Button>
                                )}

                                {/* Progress */}
                                {isAnalyzing && analyzeProgress && (
                                    <p className="text-xs text-purple-400 animate-pulse">
                                        🤖 {analyzeProgress}
                                    </p>
                                )}

                                {/* Lỗi */}
                                {analyzeError && (
                                    <p className="text-xs text-red-400">❌ {analyzeError}</p>
                                )}

                                {/* Kết quả: Danh sách Scene với nhạc gợi ý */}
                                {directorResult && directorResult.scenes.length > 0 && (
                                    <div className="space-y-2 mt-1">
                                        <p className="text-xs text-muted-foreground">Kết quả phân tích — có thể đổi nhạc thủ công:</p>
                                        {directorResult.scenes.map((scene) => (
                                            <SceneCard
                                                key={scene.sceneId}
                                                scene={scene}
                                                musicItems={musicItems.filter(i => i.aiMetadata)}
                                                onMusicChange={(newMusic) => {
                                                    // Cho phép user đổi nhạc thủ công — cập nhật vào ProjectContext
                                                    const currentResult = project.musicLibrary.directorResult
                                                    if (!currentResult) return
                                                    updateMusicLibrary({
                                                        directorResult: {
                                                            ...currentResult,
                                                            scenes: currentResult.scenes.map(s =>
                                                                s.sceneId === scene.sceneId
                                                                    ? { ...s, assignedMusic: newMusic }
                                                                    : s
                                                            )
                                                        }
                                                    })
                                                }}
                                            />
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {/* ===== SECTION 4: Render & Import ===== */}
                {analyzedCount > 0 && directorResult && directorResult.scenes.length > 0 && (
                    <div className="space-y-3 pt-2 border-t">
                        <label className="text-sm font-medium flex items-center gap-2">
                            4. Render nhạc nền
                        </label>
                        {isImporting ? (
                            <div className="w-full relative overflow-hidden rounded-md h-10 border border-purple-500 bg-purple-900/20">
                                <div className="absolute inset-0 bg-primary/20" />
                                <div
                                    className="absolute inset-0 bg-gradient-to-r from-purple-500/40 via-indigo-500/40 to-purple-500/40 flex items-center justify-center font-medium text-purple-100 text-sm shadow-[inset_0_0_10px_rgba(168,85,247,0.3)] animate-pulse"
                                    style={{
                                        backgroundImage: 'linear-gradient(45deg, rgba(255,255,255,.1) 25%, transparent 25%, transparent 50%, rgba(255,255,255,.1) 50%, rgba(255,255,255,.1) 75%, transparent 75%, transparent)',
                                        backgroundSize: '1rem 1rem',
                                        animation: 'progress-bar-stripes 1s linear infinite'
                                    }}
                                >
                                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                    {importProgress || "Đang khởi tạo FFmpeg..."}
                                </div>
                            </div>
                        ) : (
                            <Button
                                variant="default"
                                className="w-full gap-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white"
                                disabled={!sentences}
                                onClick={async () => {
                                    setIsImporting(true)
                                    setImportProgress("")
                                    try {
                                        if (!sentences) return;
                                        // Dùng FFmpeg render file Audio Master (Có Crossfade + Auto Ducking)
                                        const ffmpegScenes = directorResult.scenes.map(s => ({
                                            filePath: s.assignedMusic?.filePath || null,
                                            startTime: s.startTime,
                                            endTime: s.endTime,
                                            startOffset: s.assignedMusicStartTime ?? 0
                                        }));

                                        const resFFmpeg = await mixAudioScenesAndDuck({
                                            outputFolder: matchingFolder,
                                            scenes: ffmpegScenes,
                                            sentences: sentences,
                                            duckingVolume: 0.30, // Tăng lên 30% để nhạc không bị tụt quá sâu, nghe tự nhiên hơn
                                            onProgress: (p) => setImportProgress(p)
                                        });

                                        // Sau render xong → import vào audio track mới trong DaVinci
                                        setImportProgress("Đang thêm nhạc nền vào DaVinci timeline...");
                                        try {
                                            const { addAudioToTimeline } = await import("@/api/resolve-api");
                                            const resolveResult = await addAudioToTimeline(
                                                resFFmpeg.outputPath,
                                                "BGM - AutoSubs"
                                            );
                                            if (resolveResult.error) {
                                                alert(`✅ Render xong!\n📁 File: ${resFFmpeg.outputPath}\n\n⚠️ Không import được vào DaVinci: ${resolveResult.message}\nHãy import thủ công file này vào Audio Track.`);
                                            } else {
                                                alert(`✅ Hoàn tất!\n\n🎵 File nhạc nền: ${resFFmpeg.outputPath}\n🎚️ Đã thêm vào Audio Track A${resolveResult.audioTrack} (${resolveResult.trackName})\n\nNếu không ưng, bạn chỉ cần xoá track này và tạo lại!`);
                                            }
                                        } catch (resolveErr) {
                                            // DaVinci không kết nối — vẫn thông báo file đã render
                                            alert(`✅ Render xong!\n📁 File: ${resFFmpeg.outputPath}\n\n⚠️ Không kết nối được DaVinci Resolve.\nHãy import thủ công file này vào Audio Track.`);
                                        }
                                    } catch (error: any) {
                                        alert("Lỗi Render FFmpeg: " + String(error));
                                    } finally {
                                        setIsImporting(false);
                                    }
                                }}
                            >
                                <Sparkles className="h-4 w-4" />
                                ✨ Render BGM (Crossfade + Auto Ducking)
                            </Button>
                        )}
                    </div>
                )}
            </div>
        </ScrollArea>
    )
}

// ======================== SUB-COMPONENTS ========================

/**
 * 1 hàng hiển thị thông tin 1 bài nhạc
 * Hiện tên file + nút play/pause + tags cảm xúc (nếu đã có AI metadata)
 */
function MusicItemRow({
    item,
    isSelected,
    audioPreview,
    onClick,
    onRevealInFinder,
    onCopyPrompt,
    onPasteJson
}: {
    item: AudioLibraryItem
    isSelected: boolean
    audioPreview: UseAudioPreviewReturn
    onClick: () => void
    onRevealInFinder?: (path: string) => void
    onCopyPrompt?: (item: AudioLibraryItem) => void
    onPasteJson?: (item: AudioLibraryItem) => void
}) {
    const meta = item.aiMetadata
    // Kiểm tra bài này có đang phát không
    const isThisPlaying =
        audioPreview.state.currentFilePath === item.filePath &&
        audioPreview.state.isPlaying

    return (
        <div
            className={`w-full text-left px-3 py-2 rounded-md flex items-center gap-2 transition-colors border cursor-pointer ${isSelected
                ? "bg-primary/10 border-primary/30 text-primary"
                : "bg-background hover:bg-muted/50 border-transparent hover:border-border/50"
                }`}
            onClick={onClick}
        >
            {/* Nút Play/Pause — click để nghe thử */}
            <button
                className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center transition-all
                    ${isThisPlaying
                        ? "bg-primary text-primary-foreground shadow-sm shadow-primary/30"
                        : "bg-muted/60 text-muted-foreground hover:bg-primary/20 hover:text-primary"
                    }`}
                onClick={(e) => {
                    e.stopPropagation() // Không trigger chọn bài
                    audioPreview.togglePlay(item.filePath)
                }}
                title={isThisPlaying ? "Tạm dừng" : "Nghe thử"}
            >
                {isThisPlaying ? (
                    <Pause className="h-3 w-3" />
                ) : (
                    <Play className="h-3 w-3 ml-0.5" />
                )}
            </button>

            {/* Tên file */}
            <span className="text-xs truncate flex-1 min-w-0" title={item.fileName}>{item.fileName}</span>

            {/* Tags cảm xúc (badge) — chỉ hiện khi có metadata */}
            {meta && (
                <div className="flex items-center gap-1 shrink-0 hidden sm:flex">
                    {meta.emotion.slice(0, 2).map((emo, i) => (
                        <span
                            key={i}
                            className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30"
                        >
                            {emo}
                        </span>
                    ))}
                    {/* Badge cường độ */}
                    <span
                        className={`text-[10px] px-1.5 py-0.5 rounded-full border ${meta.intensity === "Cao"
                            ? "bg-red-500/20 text-red-400 border-red-500/30"
                            : meta.intensity === "Thấp"
                                ? "bg-green-500/20 text-green-400 border-green-500/30"
                                : "bg-yellow-500/20 text-yellow-400 border-yellow-500/30"
                            }`}
                    >
                        {meta.intensity}
                    </span>
                </div>
            )}

            {/* Chưa scan → badge xám + nhóm nut công cụ manual scan */}
            {!meta && (
                <div className="flex items-center gap-1 shrink-0">
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-red-400/80 border border-border/50 mr-1 italic">
                        Chưa scan
                    </span>
                    {onRevealInFinder && (
                        <Button
                            variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground hover:text-blue-400"
                            onClick={(e) => { e.stopPropagation(); onRevealInFinder(item.filePath) }} title="Mở trong Finder"
                        >
                            <FolderOpen className="h-3.5 w-3.5" />
                        </Button>
                    )}
                    {onCopyPrompt && (
                        <Button
                            variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground hover:text-green-400"
                            onClick={(e) => { e.stopPropagation(); onCopyPrompt(item) }} title="Copy Prompt gửi Gemini"
                        >
                            <Copy className="h-3.5 w-3.5" />
                        </Button>
                    )}
                    {onPasteJson && (
                        <Button
                            variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground hover:text-orange-400"
                            onClick={(e) => { e.stopPropagation(); onPasteJson(item) }} title="Nhúng JSON từ Gemini"
                        >
                            <PlusCircle className="h-3.5 w-3.5" />
                        </Button>
                    )}
                </div>
            )}
        </div>
    )
}

// ======================== SCENE CARD ========================

/**
 * Hiển thị 1 cảnh (Scene) với nhạc AI gợi ý
 * User có thể bấm vào dropdown để đổi nhạc thủ công
 */
function SceneCard({
    scene,
    musicItems,
    onMusicChange,
}: {
    scene: { sceneId: number; startTime: number; endTime: number; emotion: string; emotionReason: string; assignedMusic: AudioLibraryItem | null, searchKeywords?: string[], assignedMusicStartTime?: number }
    musicItems: AudioLibraryItem[]
    onMusicChange: (newMusic: AudioLibraryItem | null) => void
}) {
    const [showDropdown, setShowDropdown] = React.useState(false)

    // Format giây: 90 → "1:30"
    const fmtTime = (sec: number) => {
        const m = Math.floor(sec / 60)
        const s = Math.floor(sec % 60)
        return `${m}:${String(s).padStart(2, "0")}`
    }

    // Màu badge cảm xúc
    const emotionColor = (() => {
        const e = scene.emotion.toLowerCase()
        if (e.includes("kịch") || e.includes("căng") || e.includes("action")) return "bg-red-500/20 text-red-400 border-red-500/30"
        if (e.includes("buồn") || e.includes("lặng") || e.includes("sad")) return "bg-blue-500/20 text-blue-400 border-blue-500/30"
        if (e.includes("vui") || e.includes("tươi") || e.includes("happy")) return "bg-green-500/20 text-green-400 border-green-500/30"
        if (e.includes("huyền") || e.includes("bí ẩn") || e.includes("mystery")) return "bg-purple-500/20 text-purple-400 border-purple-500/30"
        return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30"
    })()

    return (
        <div className="rounded-md border border-border/60 bg-card/50 p-2.5 space-y-2">
            {/* Header: cảnh + thời gian + badge cảm xúc */}
            <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-muted-foreground shrink-0">
                    Cảnh {scene.sceneId} • {fmtTime(scene.startTime)}–{fmtTime(scene.endTime)}
                </span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full border shrink-0 ${emotionColor}`}>
                    {scene.emotion}
                </span>
            </div>

            {/* Lý do AI */}
            {scene.emotionReason && (
                <p className="text-[11px] text-muted-foreground leading-tight">
                    {scene.emotionReason}
                </p>
            )}

            {/* Nhạc được gợi ý + dropdown đổi nhạc */}
            <div className="relative">
                <button
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md bg-background border border-border/50 hover:border-primary/40 transition-colors"
                    onClick={() => setShowDropdown(!showDropdown)}
                >
                    <Music className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="text-xs truncate flex-1 min-w-0 text-left">
                        {scene.assignedMusic ? (
                            <span className="flex items-center gap-1.5">
                                {scene.assignedMusic.fileName}
                                {(scene.assignedMusicStartTime ?? 0) > 0 && (
                                    <span className="text-[10px] bg-primary/10 text-primary px-1 rounded-sm border border-primary/20">
                                        ➤ Từ {fmtTime(scene.assignedMusicStartTime!)}
                                    </span>
                                )}
                            </span>
                        ) : "Không có nhạc phù hợp"}
                    </span>
                    {/* Arrow */}
                    <ChevronDown className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${showDropdown ? "rotate-180" : ""}`} />
                </button>

                {/* Hiển thị Keyword nếu không có nhạc */}
                {!scene.assignedMusic && scene.searchKeywords && scene.searchKeywords.length > 0 && (
                    <div className="mt-2 p-2 bg-muted/30 rounded-md border border-dashed border-border flex flex-col gap-1.5">
                        <span className="text-[10px] text-muted-foreground font-medium">Bạn có thể tìm nhạc với từ khoá:</span>
                        <div className="flex flex-wrap gap-1">
                            {scene.searchKeywords.map((kw, i) => (
                                <span key={i} className="text-[10px] px-1.5 py-0.5 bg-primary/10 text-primary rounded-sm border border-primary/20">
                                    {kw}
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                {/* Dropdown chọn nhạc khác */}
                {showDropdown && (
                    <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-popover border border-border rounded-md shadow-lg max-h-48 overflow-y-auto">
                        {/* Option: không dùng nhạc */}
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 flex items-center gap-2"
                            onClick={() => { onMusicChange(null); setShowDropdown(false) }}
                        >
                            <span className="text-muted-foreground">— Không dùng nhạc —</span>
                        </button>
                        {/* Danh sách nhạc */}
                        {musicItems.map((item) => (
                            <button
                                key={item.filePath}
                                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 flex items-center gap-2 ${scene.assignedMusic?.filePath === item.filePath ? "bg-primary/10 text-primary" : ""
                                    }`}
                                onClick={() => { onMusicChange(item); setShowDropdown(false) }}
                            >
                                <Music className="h-3 w-3 shrink-0" />
                                <span className="truncate">{item.fileName}</span>
                                {item.aiMetadata?.emotion[0] && (
                                    <span className="ml-auto text-[10px] shrink-0 text-muted-foreground">{item.aiMetadata.emotion[0]}</span>
                                )}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}

// ======================== MINI PLAYER ========================

/**
 * Thanh mini player hiển thị khi đang phát nhạc
 * Gồm: tên bài, thanh progress (có thể click để seek), nút pause/stop, thời gian
 */
function MiniPlayer({
    audioPreview,
    musicItems,
}: {
    audioPreview: UseAudioPreviewReturn
    musicItems: AudioLibraryItem[]
}) {
    const { state, togglePlay, stop, seek } = audioPreview
    const progressRef = React.useRef<HTMLDivElement>(null)

    // Tìm tên file đang phát
    const currentItem = musicItems.find(
        (i) => i.filePath === state.currentFilePath
    )
    const fileName = currentItem?.fileName || "Unknown"

    // Tính phần trăm progress
    const progressPercent =
        state.duration > 0 ? (state.currentTime / state.duration) * 100 : 0

    // Format giây thành m:ss
    const fmtTime = (sec: number) => {
        const m = Math.floor(sec / 60)
        const s = Math.floor(sec % 60)
        return `${m}:${String(s).padStart(2, "0")}`
    }

    // Xử lý click vào thanh progress để seek
    const handleSeekClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!progressRef.current || state.duration <= 0) return
        const rect = progressRef.current.getBoundingClientRect()
        const clickX = e.clientX - rect.left
        const percent = clickX / rect.width
        const newTime = percent * state.duration
        seek(Math.max(0, Math.min(newTime, state.duration)))
    }

    return (
        <div className="bg-muted/40 rounded-lg px-3 py-2.5 border border-border/60 space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
            {/* Dòng trên: Tên bài + Nút điều khiển + Thời gian */}
            <div className="flex items-center gap-2">
                {/* Nút Play/Pause */}
                <button
                    className="shrink-0 w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 transition-colors shadow-sm"
                    onClick={() => {
                        if (state.currentFilePath) togglePlay(state.currentFilePath)
                    }}
                    title={state.isPlaying ? "Tạm dừng" : "Tiếp tục phát"}
                >
                    {state.isPlaying ? (
                        <Pause className="h-3.5 w-3.5" />
                    ) : (
                        <Play className="h-3.5 w-3.5 ml-0.5" />
                    )}
                </button>

                {/* Tên file nhạc */}
                <span className="text-xs font-medium truncate flex-1 min-w-0">
                    {fileName}
                </span>

                {/* Thời gian hiện tại / tổng */}
                <span className="text-[10px] font-mono text-muted-foreground shrink-0">
                    {fmtTime(state.currentTime)} / {fmtTime(state.duration)}
                </span>

                {/* Nút Stop (dừng hẳn) */}
                <button
                    className="shrink-0 w-5 h-5 rounded flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                    onClick={stop}
                    title="Dừng phát"
                >
                    <span className="w-2.5 h-2.5 rounded-sm bg-current" />
                </button>
            </div>

            {/* Thanh progress — có thể click để seek */}
            <div
                ref={progressRef}
                className="w-full h-1.5 bg-muted rounded-full cursor-pointer group relative"
                onClick={handleSeekClick}
                title="Click để nhảy đến vị trí"
            >
                {/* Thanh đã phát */}
                <div
                    className="h-full bg-primary rounded-full transition-[width] duration-100 relative"
                    style={{ width: `${progressPercent}%` }}
                >
                    {/* Chấm tròn nhỏ ở đầu thanh — hiện khi hover */}
                    <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-primary border-2 border-background shadow-sm opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
            </div>
        </div>
    )
}

/**
 * Card hiển thị 1 Suno AI prompt gợi ý nhạc nền
 * Gồm: mood badge, mô tả tiếng Việt, prompt Suno AI + nút Copy rõ ràng
 */
function MusicKeywordRow({ item, index }: { item: MusicKeywordSuggestion; index: number }) {
    const [copiedPrompt, setCopiedPrompt] = React.useState(false)

    const handleCopyPrompt = async () => {
        await navigator.clipboard.writeText(item.prompt)
        setCopiedPrompt(true)
        setTimeout(() => setCopiedPrompt(false), 2000)
    }

    // Màu mood badge
    const moodColor = (() => {
        const m = item.mood.toLowerCase()
        if (m.includes("tense") || m.includes("suspense")) return "bg-orange-500/20 text-orange-400 border-orange-500/30"
        if (m.includes("emotional") || m.includes("sad")) return "bg-blue-500/20 text-blue-400 border-blue-500/30"
        if (m.includes("dramatic") || m.includes("climax")) return "bg-red-500/20 text-red-400 border-red-500/30"
        if (m.includes("calm") || m.includes("reflect")) return "bg-green-500/20 text-green-400 border-green-500/30"
        if (m.includes("dark") || m.includes("mystery")) return "bg-purple-500/20 text-purple-400 border-purple-500/30"
        if (m.includes("hopeful") || m.includes("uplift")) return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30"
        return "bg-muted text-muted-foreground border-border/50"
    })()

    return (
        <div className="rounded-md border border-border/60 bg-card/50 p-2.5 space-y-1.5">
            {/* Header: số thứ tự + mood badge + mô tả */}
            <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-muted-foreground shrink-0">{index}.</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium shrink-0 ${moodColor}`}>
                    {item.mood}
                </span>
                {/* Mô tả ngắn tiếng Việt */}
                <span className="text-[11px] text-muted-foreground flex-1 min-w-0 truncate">
                    {item.description}
                </span>
            </div>

            {/* Prompt Suno AI — monospace text box */}
            <p className="text-[11px] text-foreground/80 leading-relaxed bg-muted/40 rounded px-2.5 py-2 font-mono">
                {item.prompt}
            </p>

            {/* Nút Copy Prompt — luôn hiển thị rõ ràng */}
            <button
                onClick={handleCopyPrompt}
                className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded border transition-all w-full justify-center ${
                    copiedPrompt
                        ? "border-green-500/40 text-green-400 bg-green-500/10"
                        : "border-border/60 text-muted-foreground hover:text-foreground hover:border-border hover:bg-muted/50"
                }`}
                title="Copy Suno AI prompt"
            >
                {copiedPrompt
                    ? <><Check className="w-3 h-3" /> Đã copy!</>
                    : <><Copy className="w-3 h-3" /> Copy prompt</>
                }
            </button>
        </div>
    )
}
