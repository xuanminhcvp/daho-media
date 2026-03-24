// master-srt-tab.tsx
// Tab "Master SRT" — tách riêng khỏi Generate Subtitles
// Flow: paste kịch bản → đọc transcript từ file → AI so khớp → verify kết quả
// Hoạt động độc lập, giải phóng RAM transcription trước khi chạy AI

import { useState, useCallback, useRef, useEffect } from "react"
import {
    FileText,
    X,
    RefreshCw,
    CheckCircle,
    AlertTriangle,
    XCircle,
    Sparkles,
    Loader2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useProject } from "@/contexts/ProjectContext"
import { useTranscript } from "@/contexts/TranscriptContext"
import { useSettings } from "@/contexts/SettingsContext"
import { useResolve } from "@/contexts/ResolveContext"
import { generateTranscriptFilename, readTranscript } from "@/utils/file-utils"
import { extractWhisperWords } from "@/utils/media-matcher"
import {
    createMasterSrt,
    verifyMasterSrt,
    type VerifyResult,
} from "@/services/master-srt-service"

// ======================== COMPONENT CHÍNH ========================

export function MasterSrtTab() {
    // === Contexts ===
    const { project, setMasterSrt } = useProject()
    const { subtitles } = useTranscript()
    const { settings } = useSettings()
    const { timelineInfo } = useResolve()

    // === Local State ===
    // Kịch bản gốc — paste ở đây
    const [scriptText, setScriptText] = useState("")
    // Đang chạy AI so khớp
    const [isProcessing, setIsProcessing] = useState(false)
    // Progress message
    const [progress, setProgress] = useState("")
    // Kết quả verify sau khi AI trả về
    const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null)
    // Đang retry
    const [isRetrying, setIsRetrying] = useState(false)
    // Cache wordsText để retry không cần đọc lại file
    const [cachedWordsText, setCachedWordsText] = useState("")

    // Unmount guard — chặn setState khi component đã bị unmount
    const isMountedRef = useRef(true)
    useEffect(() => {
        return () => { isMountedRef.current = false }
    }, [])

    // Safe setState wrappers
    const safeSetProgress = useCallback((msg: string) => {
        if (isMountedRef.current) setProgress(msg)
    }, [])
    const safeSetVerify = useCallback((v: VerifyResult | null) => {
        if (isMountedRef.current) setVerifyResult(v)
    }, [])

    // Kiểm tra đã có subtitles chưa (cần transcribe trước)
    const hasSubtitles = subtitles && subtitles.length > 0
    // Kiểm tra đã có Master SRT chưa
    const hasMasterSrt = project.masterSrt && project.masterSrt.length > 0

    // ======================== TẠO MASTER SRT ========================

    const handleCreateMasterSrt = useCallback(async () => {
        // Validate đầu vào
        if (!scriptText.trim()) {
            setProgress("⚠ Chưa paste kịch bản gốc!")
            return
        }
        if (!hasSubtitles) {
            setProgress("⚠ Chưa có subtitles! Hãy Generate Subtitles trước.")
            return
        }

        setIsProcessing(true)
        setProgress("Đang chuẩn bị...")
        setVerifyResult(null)

        try {
            // 1. Đọc transcript từ file (word-level data)
            const filename = generateTranscriptFilename(
                settings.isStandaloneMode,
                null, // fileInput — dùng null vì lấy từ timeline
                timelineInfo?.timelineId ?? "standalone"
            )
            setProgress("📂 Đọc transcript...")
            console.log("[MSRT-Tab] Đọc transcript:", filename)

            const transcript = await readTranscript(filename)
            if (!transcript) {
                setProgress("⚠ Không tìm thấy transcript! Hãy Generate Subtitles trước.")
                setIsProcessing(false)
                return
            }

            // 2. Trích xuất whisper words
            const segments = transcript.originalSegments || transcript.segments || []
            const whisperWords = extractWhisperWords({ segments } as any)
            console.log("[MSRT-Tab] WhisperWords:", whisperWords.length)

            if (whisperWords.length === 0) {
                setProgress("⚠ Transcript không có word-level data!")
                setIsProcessing(false)
                return
            }

            // 3. Format wordsText
            const wordsText = whisperWords
                .map(w => `[${w.start.toFixed(2)}] ${w.word}`)
                .join(" ")
            setCachedWordsText(wordsText)

            // 4. Gọi AI so khớp
            setProgress(`🎯 Bắt đầu AI so khớp (${whisperWords.length} từ)...`)
            console.log("[DEBUG-Tab] createMasterSrt start, words:", whisperWords.length)

            const result = await createMasterSrt(
                wordsText,
                scriptText.trim(),
                (msg) => {
                    console.log("[DEBUG-Tab] onProgress:", msg)
                    safeSetProgress(msg)
                }
            )
            console.log("[DEBUG-Tab] ★ createMasterSrt XONG — totalWords:", result.totalWords, "words.length:", result.words.length)

            // 5. Lưu kết quả vào ProjectContext (toàn cục)
            // ★ LUÔN gọi setMasterSrt — đây là context setter, an toàn dù component unmount
            // Trước đây guard isMountedRef → nếu HMR hoặc chuyển tab → mất toàn bộ kết quả!
            console.log("[DEBUG-Tab] ▶ gọi setMasterSrt...")
            setMasterSrt(result.words, result.createdAt)
            console.log("[DEBUG-Tab] ★ setMasterSrt XONG")

            // 6. Verify kết quả — chỉ update UI nếu component vẫn mounted
            if (isMountedRef.current) {
                setProgress("🔍 Đang kiểm tra kết quả...")
                console.log("[DEBUG-Tab] ▶ verifyMasterSrt bắt đầu...")
                const vResult = verifyMasterSrt(result.words, scriptText.trim())
                console.log("[DEBUG-Tab] ★ verifyMasterSrt XONG — verdict:", vResult.verdict, "match%:", vResult.matchPercent)
                safeSetVerify(vResult)

                const icon = vResult.verdict === "good" ? "✅" : vResult.verdict === "ok" ? "⚠️" : "❌"
                setProgress(`${icon} Master SRT: ${result.totalWords} từ | Khớp: ${vResult.matchPercent}%`)
            } else {
                console.log("[DEBUG-Tab] component unmounted — bỏ qua verify UI, data đã lưu vào context")
            }
            console.log("[DEBUG-Tab] ✅✅✅ DONE hoàn toàn")

        } catch (err) {
            console.error("[MSRT-Tab] Lỗi:", err)
            if (isMountedRef.current) setProgress(`❌ Lỗi: ${String(err).slice(0, 120)}`)
        } finally {
            // ★ LUÔN tắt loading — dù unmount hay không
            setIsProcessing(false)
        }
    }, [scriptText, hasSubtitles, settings, timelineInfo, setMasterSrt, safeSetProgress, safeSetVerify])

    // ======================== RETRY ========================

    const handleRetry = useCallback(async () => {
        if (!cachedWordsText || !scriptText.trim()) return
        setIsRetrying(true)
        setVerifyResult(null)
        setProgress("🔄 Đang so khớp lại...")

        try {
            const result = await createMasterSrt(
                cachedWordsText,
                scriptText.trim(),
                (msg) => safeSetProgress(msg)
            )

            if (!isMountedRef.current) return

            setMasterSrt(result.words, result.createdAt)
            const vr = verifyMasterSrt(result.words, scriptText.trim())
            safeSetVerify(vr)

            const icon = vr.verdict === "good" ? "✅" : vr.verdict === "ok" ? "⚠️" : "❌"
            setProgress(`${icon} Retry: ${result.totalWords} từ | Khớp: ${vr.matchPercent}%`)
        } catch (err) {
            setProgress(`⚠ Retry lỗi: ${err}`)
        } finally {
            if (isMountedRef.current) setIsRetrying(false)
        }
    }, [cachedWordsText, scriptText, setMasterSrt, safeSetProgress, safeSetVerify])

    // ======================== RENDER ========================

    return (
        <div className="flex flex-col h-full gap-3 p-4 overflow-y-auto">
            {/* Tiêu đề + trạng thái */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-primary" />
                    <h3 className="text-sm font-semibold">Master SRT</h3>
                </div>
                {/* Badge Master SRT đã có */}
                {hasMasterSrt && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-500 font-medium">
                        🟢 {project.masterSrt.length} từ
                        {project.masterSrtCreatedAt && (
                            <> • {new Date(project.masterSrtCreatedAt).toLocaleTimeString("vi-VN")}</>
                        )}
                    </span>
                )}
            </div>

            {/* Hướng dẫn */}
            <p className="text-[11px] text-muted-foreground leading-relaxed">
                So khớp kịch bản gốc với transcript Whisper để tạo Master SRT chuẩn word-level.
                <br />
                <strong>Yêu cầu:</strong> Đã Generate Subtitles ở tab Subtitles trước.
            </p>

            {/* Trạng thái subtitles */}
            {!hasSubtitles && (
                <div className="flex items-center gap-2 p-2.5 rounded-md border border-yellow-500/30 bg-yellow-500/5 text-xs text-yellow-600">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    <span>Chưa có subtitles! Hãy Generate Subtitles trước ở tab Subtitles.</span>
                </div>
            )}

            {/* Kịch bản gốc textarea */}
            <div>
                <div className="flex items-center justify-between mb-1">
                    <label className="text-[11px] text-muted-foreground font-medium flex items-center gap-1">
                        <FileText className="h-3 w-3" />
                        Kịch bản gốc
                    </label>
                    <div className="flex items-center gap-2">
                        {/* Đếm số dòng */}
                        {scriptText.trim() && (
                            <span className="text-[10px] text-muted-foreground">
                                {scriptText.split(/\n+/).filter(l => l.trim()).length} dòng
                                {" • "}
                                {scriptText.trim().split(/\s+/).length} từ
                            </span>
                        )}
                        {/* Nút xoá */}
                        {scriptText.trim() && (
                            <button
                                onClick={() => setScriptText("")}
                                className="text-muted-foreground hover:text-destructive transition-colors"
                                title="Xoá kịch bản"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        )}
                    </div>
                </div>
                <textarea
                    className="w-full h-32 text-xs px-2.5 py-2 rounded border border-border bg-muted/30 resize-none focus:outline-none focus:ring-1 focus:ring-primary/50 placeholder:text-muted-foreground/50"
                    placeholder="Paste kịch bản gốc vào đây..."
                    value={scriptText}
                    onChange={(e) => setScriptText(e.target.value)}
                    disabled={isProcessing}
                />
            </div>

            {/* Nút tạo Master SRT */}
            <Button
                onClick={handleCreateMasterSrt}
                disabled={isProcessing || !hasSubtitles || !scriptText.trim()}
                className="w-full gap-2"
                size="sm"
            >
                {isProcessing ? (
                    <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Đang xử lý...
                    </>
                ) : (
                    <>
                        <Sparkles className="h-4 w-4" />
                        Tạo Master SRT
                    </>
                )}
            </Button>

            {/* Progress */}
            {progress && (
                <p className="text-[10px] text-muted-foreground">{progress}</p>
            )}

            {/* Verify Result Card */}
            {verifyResult && (
                <div className={`p-2.5 rounded-md border text-xs ${
                    verifyResult.verdict === "good" ? "border-green-500/30 bg-green-500/5" :
                    verifyResult.verdict === "ok" ? "border-yellow-500/30 bg-yellow-500/5" :
                    "border-red-500/30 bg-red-500/5"
                }`}>
                    {/* Header verdict */}
                    <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-1.5">
                            {verifyResult.verdict === "good" && <CheckCircle className="h-3.5 w-3.5 text-green-500" />}
                            {verifyResult.verdict === "ok" && <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />}
                            {verifyResult.verdict === "poor" && <XCircle className="h-3.5 w-3.5 text-red-500" />}
                            <span className="font-medium">
                                {verifyResult.verdict === "good" ? "Kết quả tốt" :
                                 verifyResult.verdict === "ok" ? "Kết quả khá" : "Kết quả yếu"}
                            </span>
                        </div>
                        {/* Nút retry — chỉ hiện khi verdict không good */}
                        {verifyResult.verdict !== "good" && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-6 text-[10px] px-2"
                                disabled={isRetrying || isProcessing}
                                onClick={handleRetry}
                            >
                                <RefreshCw className={`h-3 w-3 mr-1 ${isRetrying ? "animate-spin" : ""}`} />
                                So khớp lại
                            </Button>
                        )}
                    </div>

                    {/* Stats */}
                    <div className="grid grid-cols-2 gap-2 text-[10px] text-muted-foreground">
                        <div>Từ khớp: <span className="font-medium text-foreground">{verifyResult.matchPercent}%</span> ({verifyResult.matchedWords}/{verifyResult.totalMasterWords})</div>
                        <div>Gaps &gt;5s: <span className="font-medium text-foreground">{verifyResult.timestampGaps}</span></div>
                    </div>

                    {/* Từ không khớp (mẫu) */}
                    {verifyResult.unmatchedSamples.length > 0 && (
                        <div className="mt-1.5 text-[10px] text-muted-foreground">
                            <span className="font-medium">Từ lạ:</span>{" "}
                            {verifyResult.unmatchedSamples.slice(0, 10).join(", ")}
                            {verifyResult.unmatchedSamples.length > 10 && ` +${verifyResult.unmatchedSamples.length - 10}`}
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
