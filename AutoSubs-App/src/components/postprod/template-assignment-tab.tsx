// template-assignment-tab.tsx
// Tab giao diện để quản lý 5 Template hiệu ứng chữ và yêu cầu AI gán template cho từng câu
// Gồm 3 phần chính:
//   1. Chọn dự án kịch bản (matching.json) + file whisper words
//   2. AI phân tích → gán template + rút gọn displayText + matchWords
//   3. Matching whisper words timestamps → import vào DaVinci Resolve

import * as React from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
    Sparkles,
    Loader2,
    FileText,
    ChevronDown,
    ChevronRight,
    Send,
    CheckCircle2,
    AudioLines,
    Save,
} from "lucide-react"
import { open } from "@tauri-apps/plugin-dialog"
import { desktopDir } from "@tauri-apps/api/path"
import { useResolve } from "@/contexts/ResolveContext"
import { useProject } from "@/contexts/ProjectContext"
import { saveFolderPath } from "@/services/saved-folders-service"
import { addTemplateSubtitlesToTimeline } from "@/api/resolve-api"
import {
    loadMatchingScript,
    MatchingSentence,
} from "@/services/audio-director-service"
import {
    TextTemplate,
    TemplateAssignment,
    AITemplateAssignmentResult,
    DEFAULT_TEMPLATES,
    loadTemplatesConfig,
    analyzeScriptForTemplateAssignment,
} from "@/services/template-assignment-service"
import {
    WhisperWordsFile,
    loadWhisperWordsFile,
    batchMatchWordsToTimestamps,
    type WordMatchResult,
    type AssignmentToMatch,
} from "@/utils/whisper-words-matcher"

export function TemplateAssignmentTab() {
    // ======================== CONTEXTS ========================

    // ProjectContext — dữ liệu persist (lưu session, chia sẻ giữa các tab)
    const { project, updateTemplateAssignment } = useProject()
    // Destructure với giá trị mặc định — đề phòng session cũ không có field mới
    const {
        matchingFolder = '',
        sentences = null,
        assignmentResult = null,
        whisperWordsPath = '',
        wordMatchResults: wordMatchResultsArray = [],
        selectedTrack = '2',
    } = project.templateAssignment || {}

    // Chuyển wordMatchResults từ Array (serializable) sang Map (để dùng nhanh)
    const wordMatchResults = React.useMemo(
        () => new Map<number, WordMatchResult>(wordMatchResultsArray),
        [wordMatchResultsArray]
    )

    // Resolve Context
    const { timelineInfo } = useResolve()

    // ======================== LOCAL STATE (chỉ UI transient) ========================

    // Cấu hình 5 template (load async từ settings.json)
    const [templates, setTemplates] = React.useState<TextTemplate[]>(() => DEFAULT_TEMPLATES)

    // Load templates config async khi mount
    React.useEffect(() => {
        loadTemplatesConfig().then(t => setTemplates(t))
    }, [])

    // Whisper words file in-memory (không serialize được — load lại từ path)
    const [whisperWordsFile, setWhisperWordsFile] = React.useState<WhisperWordsFile | null>(null)

    // Trạng thái UI nhất thời
    const [isAnalyzing, setIsAnalyzing] = React.useState(false)
    const [analyzeProgress, setAnalyzeProgress] = React.useState<string>("")
    const [analyzeError, setAnalyzeError] = React.useState("")
    const [resultExpanded, setResultExpanded] = React.useState(true)
    const [isApplying, setIsApplying] = React.useState(false)
    const [applySuccess, setApplySuccess] = React.useState(false)

    // Trạng thái "đã lưu" — hiện tick xanh sau khi bấm Save
    const [matchingFolderSaved, setMatchingFolderSaved] = React.useState(false)

    // ======================== EFFECT: Tự động load lại whisper words file từ path (đã lưu) ========================
    React.useEffect(() => {
        if (whisperWordsPath && !whisperWordsFile) {
            loadWhisperWordsFile(whisperWordsPath)
                .then(loaded => {
                    if (loaded) setWhisperWordsFile(loaded)
                })
                .catch(err => console.warn('[TemplateAssignment] Không load lại được whisper words:', err))
        }
    }, [whisperWordsPath, whisperWordsFile])

    // ======================== HELPER: setter cho ProjectContext ========================
    // Gói gọn việc ghi dữ liệu vào ProjectContext
    const setMatchingFolder = (folder: string) => updateTemplateAssignment({ matchingFolder: folder })
    const setSentences = (s: MatchingSentence[] | null) => updateTemplateAssignment({ sentences: s })
    const setAssignmentResult = (r: AITemplateAssignmentResult | null) => updateTemplateAssignment({ assignmentResult: r })
    const setWhisperWordsPath = (p: string) => updateTemplateAssignment({ whisperWordsPath: p })
    const setSelectedTrack = (t: string) => updateTemplateAssignment({ selectedTrack: t })
    const setWordMatchResults = (map: Map<number, WordMatchResult>) => {
        // Chuyển Map sang Array [để lưu IndexedDB]
        updateTemplateAssignment({ wordMatchResults: Array.from(map.entries()) })
    }


    // ======================== HANDLERS ========================

    /** Load kịch bản từ thư mục */
    const handleLoadScript = async () => {
        try {
            const desktop = await desktopDir()
            const folder = await open({
                directory: true,
                title: "Chọn thư mục chứa autosubs_matching.json",
                defaultPath: desktop,
            })
            if (!folder) return

            setMatchingFolder(folder as string)
            const loaded = await loadMatchingScript(folder as string)
            if (loaded) {
                setSentences(loaded.sentences)
                // Load kết quả template assignment đã cache (nếu có)
                const raw = loaded as any
                setAssignmentResult(raw.templateAssignmentResult || null)
            } else {
                setSentences(null)
                setAssignmentResult(null)
            }
            setAnalyzeError("")
        } catch (error: any) {
            setAnalyzeError("Lỗi đọc thư mục: " + String(error))
        }
    }

    /** Load file whisper words (chọn file riêng) */
    const handleLoadWhisperWords = async () => {
        try {
            const desktop = await desktopDir()
            const filePath = await open({
                title: "Chọn file autosubs_whisper_words.txt hoặc .json",
                defaultPath: desktop,
                filters: [
                    { name: "Whisper Words", extensions: ["txt", "json"] },
                ],
            })
            if (!filePath) return

            const loaded = await loadWhisperWordsFile(filePath as string)
            if (loaded) {
                setWhisperWordsFile(loaded)
                setWhisperWordsPath(filePath as string)
            } else {
                setAnalyzeError("File whisper words không hợp lệ")
            }
        } catch (error: any) {
            setAnalyzeError("Lỗi đọc file whisper words: " + String(error))
        }
    }

    /** Gọi AI phân tích và gán template + sau đó matching whisper words */
    const handleAnalyze = async () => {
        if (!sentences || !matchingFolder) return

        setIsAnalyzing(true)
        setAnalyzeError("")
        setAssignmentResult(null)
        setWordMatchResults(new Map())

        try {
            const result = await analyzeScriptForTemplateAssignment(
                matchingFolder,
                sentences,
                templates,
                (msg: string) => setAnalyzeProgress(msg)
            )
            setAssignmentResult(result)

            // Sau khi AI xong → matching whisper words timestamps (nếu đã load file)
            if (whisperWordsFile && result.assignments.length > 0) {
                setAnalyzeProgress("Đang khớp whisper words timestamps...")
                const assignmentsToMatch: AssignmentToMatch[] = result.assignments
                    .filter((a) => a.matchWords && a.matchWords.trim().length > 0)
                    .map((a) => {
                        const s = sentences.find((x) => x.num === a.sentenceNum)
                        return {
                            sentenceNum: a.sentenceNum,
                            matchWords: a.matchWords,
                            sentenceStart: s?.start ?? 0,
                            sentenceEnd: s?.end ?? 0,
                        }
                    })

                const matchResults = batchMatchWordsToTimestamps(
                    assignmentsToMatch,
                    whisperWordsFile.words
                )
                setWordMatchResults(matchResults)
            }
        } catch (error: any) {
            setAnalyzeError(String(error))
        } finally {
            setIsAnalyzing(false)
            setAnalyzeProgress("")
        }
    }

    /** Gửi kết quả sang DaVinci Resolve — dùng whisper timestamps + displayText */
    const handleApplyToResolve = async () => {
        if (!assignmentResult || !sentences) return
        if (!timelineInfo?.timelineId) {
            setAnalyzeError("Vui lòng mở một timeline trên DaVinci Resolve trước khi áp dụng.")
            return
        }

        setIsApplying(true)
        setAnalyzeError("")
        setApplySuccess(false)

        try {
            // Chuyển kết quả assignments thành clip array cho Resolve
            const clipsToApply = assignmentResult.assignments.map(a => {
                const s = sentences.find(x => x.num === a.sentenceNum)
                const tpl = getTemplateById(a.templateId)

                // ⭐ Ưu tiên timestamps từ whisper words matching
                // Nếu không có → fallback về sentence start/end
                const matchResult = wordMatchResults.get(a.sentenceNum)
                const start = matchResult?.success ? matchResult.start : (s?.start ?? 0)
                const end = matchResult?.success ? matchResult.end : (s?.end ?? 0)

                // ⭐ Dùng displayText thay vì toàn bộ câu
                const text = a.displayText || (s?.text ?? "")

                // ⭐ Dùng resolveTemplateName ("Title 1", "Title 2"...) thay vì displayName
                const tplName = tpl?.resolveTemplateName || tpl?.displayName || "Title 2"

                return { start, end, text, template: tplName }
            })

            const res = await addTemplateSubtitlesToTimeline(clipsToApply, selectedTrack)
            if (res.error) {
                setAnalyzeError("Lỗi DaVinci Resolve: " + res.message)
            } else {
                setApplySuccess(true)
                setTimeout(() => setApplySuccess(false), 3000)
            }
        } catch (error: any) {
            setAnalyzeError("Không kết nối được với DaVinci Resolve: " + String(error))
        } finally {
            setIsApplying(false)
        }
    }

    // ======================== HELPERS ========================



    /** Tìm template theo ID */
    const getTemplateById = (id: string): TextTemplate | undefined =>
        templates.find((t) => t.id === id)

    /** Đếm số câu theo từng template */
    const getTemplateCounts = (): Record<string, number> => {
        const counts: Record<string, number> = {}
        templates.forEach((t) => (counts[t.id] = 0))
        if (assignmentResult) {
            assignmentResult.assignments.forEach((a) => {
                if (counts[a.templateId] !== undefined) {
                    counts[a.templateId]++
                }
            })
        }
        return counts
    }

    // ======================== RENDER ========================

    const counts = getTemplateCounts()

    return (
        <ScrollArea className="flex-1 min-h-0 min-w-0 h-full w-full overflow-hidden">
            <div className="p-4 space-y-4 overflow-hidden">

                {/* ===== SECTION 2: Load Kịch Bản ===== */}
                <div className="space-y-2 pt-2 border-t">
                    <label className="text-sm font-medium">📂 Chọn dự án kịch bản</label>
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

                {/* ===== SECTION: Whisper Words File ===== */}
                <div className="space-y-2 pt-2 border-t">
                    <label className="text-sm font-medium">🎤 Whisper Words Timestamps</label>
                    <Button
                        variant="outline"
                        className="w-full justify-start gap-2 h-10"
                        onClick={handleLoadWhisperWords}
                    >
                        <AudioLines className="h-4 w-4" />
                        {whisperWordsPath
                            ? whisperWordsPath.split(/[/\\]/).pop()
                            : "Chọn file autosubs_whisper_words.txt"}
                    </Button>

                    {whisperWordsFile && (
                        <p className="text-xs text-green-500">
                            ✅ Loaded {whisperWordsFile.totalWords} words ({whisperWordsFile.totalDuration.toFixed(0)}s)
                        </p>
                    )}
                    {!whisperWordsFile && (
                        <p className="text-xs text-muted-foreground">
                            💡 Cần file này để khớp chính xác thời gian hiển thị text
                        </p>
                    )}
                </div>

                {/* ===== SECTION 3: Nút Phân Tích AI ===== */}
                {sentences && sentences.length > 0 && (
                    <div className="space-y-3 pt-2 border-t">
                        <button
                            className="flex items-center gap-1 text-sm font-medium w-full text-left hover:text-primary transition-colors"
                            onClick={() => setResultExpanded(!resultExpanded)}
                        >
                            {resultExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                            )}
                            🎬 Kết quả Gán Template
                            {assignmentResult && (
                                <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-400 border border-violet-500/30">
                                    {assignmentResult.assignments.length} câu
                                </span>
                            )}
                        </button>

                        {resultExpanded && (
                            <div className="space-y-3 overflow-hidden">
                                {/* Nút chạy AI và Áp dụng DaVinci */}
                                <div className="flex flex-col gap-2 overflow-hidden">
                                    <Button
                                        variant="default"
                                        className="w-full gap-2 bg-gradient-to-r from-violet-500 to-cyan-500 hover:from-violet-600 hover:to-cyan-600 shadow-md text-white border-0"
                                        onClick={handleAnalyze}
                                        disabled={isAnalyzing || isApplying}
                                    >
                                        {isAnalyzing ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                            <Sparkles className="h-4 w-4" />
                                        )}
                                        {isAnalyzing
                                            ? "AI đang phân tích..."
                                            : assignmentResult
                                                ? "Phân tích lại"
                                                : "Khởi tạo AI Assignment"
                                        }
                                    </Button>

                                    {/* Nút Render sang DaVinci */}
                                    {assignmentResult && (
                                        <div className="flex flex-wrap items-center gap-2 w-full min-w-0">
                                            {/* Track selector */}
                                            <select
                                                className="h-9 w-[80px] shrink-0 rounded-md border border-input bg-background px-2 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                                value={selectedTrack}
                                                onChange={(e) => setSelectedTrack(e.target.value)}
                                                disabled={isApplying}
                                                title="Chọn Track Video đích trên DaVinci"
                                            >
                                                <option value="1">V1</option>
                                                <option value="2">V2</option>
                                                <option value="3">V3</option>
                                                <option value="4">V4</option>
                                                <option value="5">V5</option>
                                            </select>
                                            <Button
                                                variant="secondary"
                                                className={`flex-1 min-w-0 gap-1.5 h-9 text-xs font-medium shadow border transition-colors truncate ${applySuccess ? 'bg-green-500/10 text-green-600 border-green-500/20 hover:bg-green-500/20' : 'hover:bg-accent'}`}
                                                onClick={handleApplyToResolve}
                                                disabled={isApplying}
                                            >
                                                {isApplying ? (
                                                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                                                ) : applySuccess ? (
                                                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                                                ) : (
                                                    <Send className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                                                )}
                                                <span className="truncate">{isApplying ? "Đang gửi..." : applySuccess ? "Đã áp dụng" : "Áp dụng DaVinci"}</span>
                                            </Button>
                                        </div>
                                    )}
                                </div>

                                {/* Thanh tiến trình */}
                                {isAnalyzing && analyzeProgress && (
                                    <p className="text-xs text-violet-400 animate-pulse text-center">
                                        {analyzeProgress}
                                    </p>
                                )}

                                {/* Lỗi */}
                                {analyzeError && (
                                    <p className="text-xs text-red-500 bg-red-500/10 p-2 rounded border border-red-500/20">
                                        ❌ Lỗi: {analyzeError}
                                    </p>
                                )}

                                {/* ===== Thống kê phân bổ ===== */}
                                {assignmentResult && assignmentResult.assignments.length > 0 && (
                                    <div className="space-y-3">
                                        {/* Thanh phân bổ trực quan */}
                                        <div className="bg-card/40 border rounded-lg p-3 space-y-2 overflow-hidden">
                                            <p className="text-xs font-medium text-muted-foreground">
                                                📊 Phân bổ Template
                                            </p>
                                            {/* Thanh progress tổng */}
                                            <div className="flex h-3 rounded-full overflow-hidden border border-border">
                                                {templates
                                                    .filter((t) => counts[t.id] > 0)
                                                    .map((tpl) => (
                                                        <div
                                                            key={tpl.id}
                                                            className="transition-all duration-500"
                                                            style={{
                                                                width: `${(counts[tpl.id] / assignmentResult.assignments.length) * 100}%`,
                                                                backgroundColor: tpl.badgeColor,
                                                            }}
                                                            title={`${tpl.displayName}: ${counts[tpl.id]} câu`}
                                                        />
                                                    ))}
                                            </div>
                                            {/* Legend — wrap xuống dòng khi hẹp */}
                                            <div className="flex flex-wrap gap-x-2 gap-y-1 min-w-0">
                                                {templates
                                                    .filter((t) => counts[t.id] > 0)
                                                    .map((tpl) => (
                                                        <div key={tpl.id} className="flex items-center gap-1 text-[10px]">
                                                            <div
                                                                className="w-2 h-2 rounded-full shrink-0"
                                                                style={{ backgroundColor: tpl.badgeColor }}
                                                            />
                                                            <span className="text-muted-foreground whitespace-nowrap">
                                                                {tpl.displayName}: <span className="font-medium text-foreground">{counts[tpl.id]}</span>
                                                            </span>
                                                        </div>
                                                    ))}
                                            </div>
                                        </div>

                                        {/* Danh sách từng câu đã gán */}
                                        <div className="space-y-1.5 min-w-0">
                                            {assignmentResult.assignments.map((assignment, idx) => (
                                                <TemplateAssignmentItem
                                                    key={idx}
                                                    assignment={assignment}
                                                    template={getTemplateById(assignment.templateId)}
                                                    sentence={sentences?.find(
                                                        (s) => s.num === assignment.sentenceNum
                                                    )}
                                                    matchResult={wordMatchResults.get(assignment.sentenceNum)}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Không có kết quả */}
                                {assignmentResult && assignmentResult.assignments.length === 0 && (
                                    <p className="text-sm text-muted-foreground text-center py-4 italic">
                                        AI không gán được template nào. Kiểm tra lại cấu hình templates.
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

// ======================== SUB-COMPONENT: 1 dòng Assignment ========================

function TemplateAssignmentItem({
    assignment,
    template,
    sentence,
    matchResult,
}: {
    assignment: TemplateAssignment
    template: TextTemplate | undefined
    sentence: MatchingSentence | undefined
    matchResult?: WordMatchResult
}) {
    // Nếu không tìm thấy template (vd: user xóa), fallback
    const tplName = template?.displayName || assignment.templateId
    const tplColor = template?.badgeColor || "#64748b"

    return (
        <div className="bg-card/30 border rounded-md px-3 py-2 text-sm flex items-start gap-2 transition-all hover:bg-card/50 min-w-0">
            {/* Số câu */}
            <span className="font-mono text-[11px] text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded shrink-0 mt-0.5">
                #{assignment.sentenceNum}
            </span>

            {/* Nội dung chính */}
            <div className="min-w-0 flex-1 space-y-1">
                {/* displayText — text hiển thị trên màn hình (rút gọn) */}
                {assignment.displayText && (
                    <p className="text-xs font-bold break-words text-foreground">
                        📺 {assignment.displayText}
                    </p>
                )}
                {/* Nội dung câu gốc (nếu có) — màu nhạt hơn */}
                {sentence && (
                    <p className="text-[11px] break-words text-foreground/50">
                        {sentence.text}
                    </p>
                )}
                {/* Whisper words timing (nếu match thành công) */}
                {matchResult?.success && (
                    <p className="text-[10px] text-green-500/80 font-mono">
                        ⏱ {matchResult.start.toFixed(2)}s → {matchResult.end.toFixed(2)}s
                    </p>
                )}
                {/* Lý do */}
                <p className="text-[11px] text-muted-foreground italic">
                    {assignment.reason}
                </p>
            </div>

            {/* Badge template */}
            <span
                className="shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full border whitespace-nowrap mt-0.5"
                style={{
                    backgroundColor: tplColor + "20",
                    color: tplColor,
                    borderColor: tplColor + "40",
                }}
            >
                {tplName}
            </span>
        </div>
    )
}
