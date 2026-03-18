import * as React from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
    Sparkles,
    Type,
    Loader2,
    FileText,
    ChevronDown,
    ChevronRight,
    Copy,
    Check,
    Save,
} from "lucide-react"
import { open } from "@tauri-apps/plugin-dialog"
import { desktopDir } from "@tauri-apps/api/path"
import {
    loadMatchingScript,
    analyzeScriptForHighlightText,
    HighlightCue
} from "@/services/audio-director-service"
import { useProject } from "@/contexts/ProjectContext"
import { saveFolderPath } from "@/services/saved-folders-service"

export function HighlightTextTab() {
    // ======================== PROJECT CONTEXT ========================
    const {
        project,
        updateHighlightText,
        setMatchingFolder: setSharedMatchingFolder,
        setMatchingSentences: setSharedMatchingSentences,
    } = useProject()

    // Lấy data từ context
    const matchingFolder = project.matchingFolder
    const sentences = project.matchingSentences
    const highlightPlan = project.highlightText.highlightPlan

    // ======================== LOCAL STATE (UI transient) ========================
    const [isAnalyzing, setIsAnalyzing] = React.useState(false)
    const [analyzeProgress, setAnalyzeProgress] = React.useState<string>("")
    const [analyzeError, setAnalyzeError] = React.useState("")
    const [suggestExpanded, setSuggestExpanded] = React.useState(true)

    // Trạng thái "đã lưu" — hiện tick xanh sau khi bấm Save matching folder
    const [matchingFolderSaved, setMatchingFolderSaved] = React.useState(false)

    // ======================== HANDLERS ========================

    const handleLoadScript = async () => {
        try {
            const desktop = await desktopDir()
            const folder = await open({
                directory: true,
                title: "Chọn thư mục chứa autosubs_matching.json",
                defaultPath: desktop,
            })
            if (!folder) return

            // Lưu vào shared context
            setSharedMatchingFolder(folder as string)
            const loaded = await loadMatchingScript(folder as string)
            if (loaded) {
                setSharedMatchingSentences(loaded.sentences)
                updateHighlightText({ highlightPlan: loaded.aiHighlightPlanResult || null })
            } else {
                setSharedMatchingSentences(null)
                updateHighlightText({ highlightPlan: null })
            }
            setAnalyzeError("")
        } catch (error: any) {
            setAnalyzeError("Lỗi đọc thư mục: " + String(error))
        }
    }

    const handleAnalyzeHighlight = async () => {
        if (!sentences || !matchingFolder) return

        setIsAnalyzing(true)
        setAnalyzeError("")
        updateHighlightText({ highlightPlan: null })

        try {
            const result = await analyzeScriptForHighlightText(
                matchingFolder,
                sentences,
                (msg: string) => setAnalyzeProgress(msg)
            )
            // Lưu kết quả vào ProjectContext
            updateHighlightText({ highlightPlan: result })
        } catch (error: any) {
            setAnalyzeError(String(error))
        } finally {
            setIsAnalyzing(false)
            setAnalyzeProgress("")
        }
    }

    // ======================== RENDER ========================

    return (
        <ScrollArea className="flex-1 min-h-0 h-full">
            <div className="p-4 space-y-4">

                {/* Tiêu đề / Giới thiệu */}
                <div className="bg-primary/10 rounded-lg p-3 border border-primary/20 text-sm">
                    <p className="font-medium flex items-center gap-1.5 text-primary">
                        <Type className="h-4 w-4" /> Highlight Text Planner
                    </p>
                    <p className="text-muted-foreground mt-1 text-xs">
                        AI sẽ tìm ra các cụm từ đắt giá để biến thành Text Nổi Bật (Call-out) trên màn hình.
                    </p>
                </div>

                {/* ===== SECTION 1: Load Kịch Bản ===== */}
                <div className="space-y-2">
                    <label className="text-sm font-medium">1. Chọn dự án kịch bản</label>
                    <div className="space-y-1">
                        <div className="flex gap-2">
                            {/* Nút chọn thư mục matching */}
                            <Button
                                variant="outline"
                                className="flex-1 justify-start gap-2 h-10 min-w-0"
                                onClick={handleLoadScript}
                            >
                                <FileText className="h-4 w-4 shrink-0" />
                                <span className="truncate">
                                    {matchingFolder
                                        ? matchingFolder.split(/[/\\]/).pop()
                                        : "Chọn thư mục chứa autosubs_matching.json"}
                                </span>
                            </Button>

                            {/* Nút Save matching folder */}
                            {matchingFolder && (
                                <Button
                                    variant={matchingFolderSaved ? "secondary" : "outline"}
                                    size="icon"
                                    className={`h-10 w-10 shrink-0 transition-all ${
                                        matchingFolderSaved
                                            ? "bg-green-500/20 border-green-500/40 text-green-400"
                                            : "hover:border-green-500/40 hover:text-green-400"
                                    }`}
                                    onClick={() => {
                                        saveFolderPath("matchingFolder", matchingFolder)
                                        setMatchingFolderSaved(true)
                                        setTimeout(() => setMatchingFolderSaved(false), 2000)
                                    }}
                                    title="Lưu thư mục matching để dùng lại lần sau"
                                >
                                    {matchingFolderSaved ? (
                                        <span className="text-sm">✓</span>
                                    ) : (
                                        <Save className="h-4 w-4" />
                                    )}
                                </Button>
                            )}
                        </div>

                        {sentences !== null && (
                            <p className="text-xs text-green-500">
                                ✅ Đã load {sentences.length} câu từ kịch bản
                            </p>
                        )}
                        {sentences === null && matchingFolder && (
                            <p className="text-xs text-yellow-500">
                                ⚠️ Không tìm thấy autosubs_matching.json
                            </p>
                        )}
                    </div>
                </div>

                {/* ===== SECTION 2: Phân Tích Highlight Text ===== */}
                {sentences && sentences.length > 0 && (
                    <div className="space-y-3 pt-2 border-t">
                        <button
                            className="flex items-center gap-1 text-sm font-medium w-full text-left hover:text-primary transition-colors"
                            onClick={() => setSuggestExpanded(!suggestExpanded)}
                        >
                            {suggestExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                            )}
                            2. Lên Kế Hoạch Highlight
                            {highlightPlan && (
                                <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-500 border border-blue-500/30">
                                    {highlightPlan.cues.length} Cues
                                </span>
                            )}
                        </button>

                        {suggestExpanded && (
                            <div className="space-y-3">
                                <Button
                                    variant="default"
                                    className="w-full gap-2 bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 shadow-md text-white"
                                    onClick={handleAnalyzeHighlight}
                                    disabled={isAnalyzing}
                                >
                                    {isAnalyzing ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <Sparkles className="h-4 w-4" />
                                    )}
                                    {isAnalyzing
                                        ? "Đang tìm các từ đắt giá..."
                                        : highlightPlan
                                            ? "Phân tích lại Kế hoạch Highlight"
                                            : "Khởi tạo Phân tích Highlight"
                                    }
                                </Button>

                                {isAnalyzing && analyzeProgress && (
                                    <p className="text-xs text-blue-400 animate-pulse text-center">
                                        {analyzeProgress}
                                    </p>
                                )}

                                {analyzeError && (
                                    <p className="text-xs text-red-500 bg-red-500/10 p-2 rounded border border-red-500/20">
                                        ❌ Lỗi: {analyzeError}
                                    </p>
                                )}

                                {/* DANH SÁCH GỢI Ý CUES */}
                                {highlightPlan && highlightPlan.cues.length > 0 && (
                                    <div className="space-y-2 mt-2">
                                        <div className="bg-green-500/10 text-green-500 border border-green-500/20 rounded p-2 text-xs font-medium text-center">
                                            ✅ Đã tìm thấy các cụm từ đắt giá. Hãy copy và chèn Text Plus trong DaVinci Resolve!
                                        </div>
                                        {highlightPlan.cues.map((cue, idx) => (
                                            <HighlightCueItem
                                                key={idx}
                                                cue={cue}
                                                sentences={sentences}
                                            />
                                        ))}
                                    </div>
                                )}

                                {highlightPlan && highlightPlan.cues.length === 0 && (
                                    <p className="text-sm text-muted-foreground text-center py-4 italic">
                                        AI không tìm thấy từ khóa nào thực sự đắt giá cho kịch bản này.
                                    </p>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </ScrollArea>
    )
}

function HighlightCueItem({
    cue,
    sentences
}: {
    cue: HighlightCue,
    sentences: { num: number; text: string; start: number; end: number }[]
}) {
    const [copiedKeyword, setCopiedKeyword] = React.useState<boolean>(false)

    // Tìm câu nói chứa Cue
    const sentence = sentences.find(s => s.num === cue.sentenceNum);
    const timeDisplay = sentence ? `[${sentence.start.toFixed(1)}s]` : `[Câu ${cue.sentenceNum}]`;

    const handleCopyKeyword = async () => {
        await navigator.clipboard.writeText(cue.textToHighlight);
        setCopiedKeyword(true);
        setTimeout(() => setCopiedKeyword(false), 2000);
    }

    return (
        <div className="bg-card/40 border rounded-md p-3 text-sm space-y-2 shadow-sm transition-all hover:bg-card/60">
            {/* Dòng tóm tắt cue + Keyword */}
            <div className="flex items-start justify-between gap-2">
                <div>
                    <span className="font-mono text-xs text-blue-400 font-semibold bg-blue-500/10 px-1.5 py-0.5 rounded">
                        {timeDisplay}
                    </span>
                </div>
            </div>

            {/* Hint & sentence context */}
            <p className="text-xs text-muted-foreground italic leading-relaxed border-l-2 border-muted pl-2 line-clamp-2">
                ...{sentence?.text}...
            </p>

            {/* Text To Highlight */}
            <div className="bg-background/50 rounded p-2 mt-1">
                <div className="flex flex-wrap gap-1.5 mb-2">
                    <button
                        onClick={handleCopyKeyword}
                        className={`flex items-center gap-1.5 px-3 py-1 rounded border transition-colors ${copiedKeyword
                            ? "bg-green-500/10 text-green-500 border-green-500/30 font-medium"
                            : "bg-blue-500/10 text-blue-400 border-blue-500/30 hover:bg-blue-500/20"
                            }`}
                    >
                        <span className="font-bold">"{cue.textToHighlight}"</span>
                        {copiedKeyword ? <Check className="w-3.5 h-3.5 ml-1" /> : <Copy className="w-3.5 h-3.5 ml-1" />}
                    </button>
                </div>

                <p className="text-[11px] text-muted-foreground mt-2">
                    <span className="font-medium text-foreground">Lý do:</span> {cue.reason}
                </p>
            </div>
        </div>
    )
}
