// debug-panel.tsx
// Panel theo dõi request/response — full screen, dễ đọc
// Click vào log → mở modal xem chi tiết request & response
// Nút tải SRT để review matching

import * as React from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
    Bug, X, Trash2, CheckCircle2, AlertCircle, Loader2,
    Clock, Download, ChevronRight, Copy
} from "lucide-react"
import {
    getDebugLogs,
    clearDebugLogs,
    subscribeDebugLogs,
    DebugLogEntry,
} from "@/services/debug-logger"

// ======================== COMPONENT CHÍNH ========================
export function DebugPanel() {
    const [logs, setLogs] = React.useState<DebugLogEntry[]>([])
    const [selectedLog, setSelectedLog] = React.useState<DebugLogEntry | null>(null)
    const [modalTab, setModalTab] = React.useState<"request" | "response">("response")
    const [isOpen, setIsOpen] = React.useState(false)

    // Subscribe theo dõi logs mới
    React.useEffect(() => {
        setLogs(getDebugLogs())
        const unsubscribe = subscribeDebugLogs(() => {
            setLogs([...getDebugLogs()])
        })
        return unsubscribe
    }, [])

    // ======================== HELPERS ========================
    const formatTime = (date: Date) =>
        new Date(date).toLocaleTimeString("vi-VN", {
            hour: "2-digit", minute: "2-digit", second: "2-digit"
        })

    const formatDuration = (ms: number) => {
        if (ms === 0) return "..."
        if (ms < 1000) return `${ms}ms`
        return `${(ms / 1000).toFixed(1)}s`
    }

    const formatSize = (text: string) => {
        if (!text || text === "(đang chờ...)") return "-"
        const bytes = new Blob([text]).size
        if (bytes < 1024) return `${bytes}B`
        return `${(bytes / 1024).toFixed(1)}KB`
    }

    // Status badge
    const StatusBadge = ({ log }: { log: DebugLogEntry }) => {
        if (log.status === null && !log.error) {
            return (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-100 text-blue-700">
                    <Loader2 className="h-3 w-3 animate-spin" /> Đang gửi...
                </span>
            )
        }
        if (log.error) {
            return (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-100 text-red-700">
                    <AlertCircle className="h-3 w-3" /> Lỗi
                </span>
            )
        }
        return (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-100 text-green-700">
                <CheckCircle2 className="h-3 w-3" /> {log.status}
            </span>
        )
    }

    // ======================== NÚT MỞ DEBUG (góc dưới phải) ========================
    if (!isOpen) {
        return (
            <Button
                variant="outline"
                size="sm"
                className="fixed bottom-4 right-4 z-50 gap-1.5 shadow-md"
                onClick={() => setIsOpen(true)}
            >
                <Bug className="h-4 w-4" />
                Debug
                {logs.length > 0 && (
                    <span className="bg-primary text-primary-foreground text-[10px] px-1.5 py-0.5 rounded-full">
                        {logs.length}
                    </span>
                )}
            </Button>
        )
    }

    // ======================== PANEL NHỎ GÓC DƯỚI PHẢI ========================
    return (
        <>
            {/* Panel nhỏ góc dưới phải */}
            <div className="fixed bottom-4 right-4 z-50 w-[720px] h-[400px] bg-background border rounded-xl shadow-2xl flex flex-col">
                {/* ===== HEADER ===== */}
                <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b">
                    <div className="flex items-center gap-2">
                        <Bug className="h-4 w-4 text-primary" />
                        <h2 className="text-sm font-semibold">
                            Debug
                        </h2>
                        <span className="text-xs text-muted-foreground">
                            {logs.length} request{logs.length !== 1 ? "s" : ""}
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        {/* Nút Clear */}
                        <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            onClick={() => clearDebugLogs()}
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                            Xóa tất cả
                        </Button>
                        {/* Nút Đóng */}
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setIsOpen(false)}
                        >
                            <X className="h-4 w-4" />
                        </Button>
                    </div>
                </div>

                {/* ===== DANH SÁCH LOGS ===== */}
                <ScrollArea className="flex-1 min-h-0">
                    {logs.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full py-20 text-muted-foreground">
                            <Bug className="h-12 w-12 mb-4 opacity-30" />
                            <p className="text-sm">Chưa có request nào</p>
                            <p className="text-xs mt-1">Bấm AI Match để bắt đầu</p>
                        </div>
                    ) : (
                        <div className="divide-y">
                            {logs.map((log) => (
                                <div
                                    key={log.id}
                                    className="flex items-center gap-4 px-6 py-3 hover:bg-muted/50 cursor-pointer transition-colors"
                                    onClick={() => {
                                        setSelectedLog(log)
                                        setModalTab("response")
                                    }}
                                >
                                    {/* Cột 1: Thời gian */}
                                    <span className="shrink-0 text-xs text-muted-foreground font-mono w-[70px]">
                                        {formatTime(log.timestamp)}
                                    </span>

                                    {/* Cột 2: Method */}
                                    <span className="shrink-0 text-xs font-bold text-primary font-mono w-[40px]">
                                        {log.method}
                                    </span>

                                    {/* Cột 3: Label */}
                                    <span className="flex-1 text-sm font-medium truncate">
                                        {log.label}
                                    </span>

                                    {/* Cột 4: Status */}
                                    <StatusBadge log={log} />

                                    {/* Cột 5: Duration */}
                                    <span className="shrink-0 text-xs text-muted-foreground font-mono w-[60px] flex items-center gap-1">
                                        <Clock className="h-3 w-3" />
                                        {formatDuration(log.duration)}
                                    </span>

                                    {/* Cột 6: Size */}
                                    <span className="shrink-0 text-xs text-muted-foreground font-mono w-[50px]">
                                        {formatSize(log.responseBody)}
                                    </span>

                                    {/* Arrow */}
                                    <ChevronRight className="shrink-0 h-4 w-4 text-muted-foreground/50" />
                                </div>
                            ))}
                        </div>
                    )}
                </ScrollArea>
            </div>

            {/* ===== MODAL CHI TIẾT ===== */}
            {selectedLog && (
                <div
                    className="fixed inset-0 z-[60] bg-black/30 flex items-center justify-center p-4"
                    onClick={() => setSelectedLog(null)}
                >
                    <div
                        className="bg-background border rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Modal header */}
                        <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b">
                            <div className="flex items-center gap-3">
                                <StatusBadge log={selectedLog} />
                                <span className="font-semibold">
                                    {selectedLog.label}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    {formatTime(selectedLog.timestamp)}
                                </span>
                                {selectedLog.duration > 0 && (
                                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                                        <Clock className="h-3 w-3" />
                                        {formatDuration(selectedLog.duration)}
                                    </span>
                                )}
                            </div>
                            <Button variant="ghost" size="sm" onClick={() => setSelectedLog(null)}>
                                <X className="h-4 w-4" />
                            </Button>
                        </div>

                        {/* URL */}
                        <div className="shrink-0 px-5 py-2 border-b bg-muted/30">
                            <span className="text-xs text-muted-foreground mr-2">URL:</span>
                            <span className="text-xs text-primary font-mono break-all">
                                {selectedLog.url}
                            </span>
                        </div>

                        {/* Tabs */}
                        <div className="shrink-0 flex border-b">
                            <button
                                className={`px-5 py-2.5 text-sm font-medium transition-colors ${modalTab === "request"
                                    ? "text-primary border-b-2 border-primary"
                                    : "text-muted-foreground hover:text-foreground"
                                    }`}
                                onClick={() => setModalTab("request")}
                            >
                                📤 Request
                                <span className="ml-1.5 text-[10px] text-muted-foreground">
                                    ({formatSize(selectedLog.requestBody)})
                                </span>
                            </button>
                            <button
                                className={`px-5 py-2.5 text-sm font-medium transition-colors ${modalTab === "response"
                                    ? "text-primary border-b-2 border-primary"
                                    : "text-muted-foreground hover:text-foreground"
                                    }`}
                                onClick={() => setModalTab("response")}
                            >
                                📥 Response
                                <span className="ml-1.5 text-[10px] text-muted-foreground">
                                    ({formatSize(selectedLog.responseBody)})
                                </span>
                            </button>

                            {/* Nút copy + tải nội dung */}
                            <div className="ml-auto flex items-center gap-1.5 pr-3">
                                {/* Nút Copy nhanh */}
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="gap-1.5 text-xs h-7"
                                    onClick={async () => {
                                        const content = modalTab === "request"
                                            ? selectedLog.requestBody
                                            : selectedLog.responseBody
                                        let formatted = content
                                        try { formatted = JSON.stringify(JSON.parse(content), null, 2) } catch { /* giữ nguyên */ }
                                        await navigator.clipboard.writeText(formatted)
                                        // Hiển thị feedback "đã copy"
                                        const btn = document.getElementById('debug-copy-btn')
                                        if (btn) {
                                            btn.textContent = '✅ Copied!'
                                            setTimeout(() => { btn.textContent = `Copy ${modalTab}` }, 1500)
                                        }
                                    }}
                                >
                                    <Copy className="h-3 w-3" />
                                    <span id="debug-copy-btn">Copy {modalTab}</span>
                                </Button>
                                {/* Nút Tải file */}
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="gap-1.5 text-xs h-7"
                                    onClick={() => {
                                        const content = modalTab === "request"
                                            ? selectedLog.requestBody
                                            : selectedLog.responseBody
                                        let formatted = content
                                        try { formatted = JSON.stringify(JSON.parse(content), null, 2) } catch { /* giữ nguyên */ }
                                        downloadText(
                                            formatted,
                                            `${selectedLog.label.replace(/\s/g, "_")}_${modalTab}.json`
                                        )
                                    }}
                                >
                                    <Download className="h-3 w-3" />
                                    Tải {modalTab}
                                </Button>
                            </div>
                        </div>

                        {/* Body content — dễ đọc, xuống dòng, scroll được */}
                        <div className="flex-1 min-h-0 overflow-y-auto">
                            <div className="p-5">
                                {modalTab === "request"
                                    ? renderReadableContent(selectedLog.requestBody)
                                    : renderReadableContent(selectedLog.responseBody)
                                }
                            </div>
                        </div>

                        {/* Error bar (nếu có) */}
                        {selectedLog.error && (
                            <div className="shrink-0 px-5 py-3 border-t bg-red-50 dark:bg-red-950/20">
                                <span className="text-xs text-red-600 dark:text-red-400">
                                    ❌ {selectedLog.error}
                                </span>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </>
    )
}

// ======================== HELPERS ========================

/**
 * Render nội dung dễ đọc:
 * - JSON: tách prompt/content ra riêng, xuống dòng
 * - Text: giữ nguyên
 */
function renderReadableContent(text: string): React.ReactNode {
    try {
        const parsed = JSON.parse(text)

        // Nếu là request body (có messages[].content)
        if (parsed.messages && Array.isArray(parsed.messages)) {
            return (
                <div className="space-y-4">
                    {/* Metadata */}
                    <div className="text-xs space-y-1 border-b pb-3">
                        <p><strong>Model:</strong> {parsed.model}</p>
                        {parsed.max_tokens && <p><strong>Max tokens:</strong> {parsed.max_tokens}</p>}
                    </div>

                    {/* Messages */}
                    {parsed.messages.map((msg: { role: string; content: string }, i: number) => (
                        <div key={i} className="space-y-2">
                            <p className="text-xs font-semibold text-primary">
                                📤 {msg.role.toUpperCase()}:
                            </p>
                            {/* Render content với xuống dòng thật */}
                            <div className="text-xs leading-relaxed whitespace-pre-wrap break-words bg-muted/30 rounded-lg p-4 border">
                                {msg.content}
                            </div>
                        </div>
                    ))}
                </div>
            )
        }

        // Nếu là response body (có choices[].message.content)
        if (parsed.choices && Array.isArray(parsed.choices)) {
            const content = parsed.choices[0]?.message?.content || ""
            return (
                <div className="space-y-4">
                    {/* Metadata */}
                    <div className="text-xs space-y-1 border-b pb-3">
                        <p><strong>Model:</strong> {parsed.model}</p>
                        {parsed.usage && (
                            <p><strong>Tokens:</strong> prompt={parsed.usage.prompt_tokens}, completion={parsed.usage.completion_tokens}, total={parsed.usage.total_tokens}</p>
                        )}
                    </div>

            // AI Response
                    <div className="space-y-2">
                        <p className="text-xs font-semibold text-green-600">
                            📥 AI RESPONSE:
                        </p>
                        <div className="text-xs leading-relaxed whitespace-pre-wrap break-words bg-muted/30 rounded-lg p-4 border">
                            {content}
                        </div>
                    </div>
                </div>
            )
        }

        // Nếu là Gemini request body (có contents[].parts[].text)
        if (parsed.contents && Array.isArray(parsed.contents)) {
            return (
                <div className="space-y-4">
                    <div className="text-xs space-y-1 border-b pb-3">
                        <p><strong>Config:</strong> Gemini API Request</p>
                    </div>
                    {parsed.contents.map((content: any, i: number) => {
                        // Tách text và kiểm tra xem có inline_data (base64) không
                        const parts = Array.isArray(content.parts) ? content.parts : [];
                        const textPart = parts.find((p: any) => p.text)?.text || "";
                        const hasMedia = parts.some((p: any) => p.inline_data);

                        return (
                            <div key={i} className="space-y-2">
                                <p className="text-xs font-semibold text-primary">
                                    📤 PROMPT:
                                </p>
                                <div className="text-xs leading-relaxed whitespace-pre-wrap break-words bg-muted/30 rounded-lg p-4 border">
                                    {hasMedia && <div className="text-blue-500 mb-2 font-mono">[Đính kèm file Media Base64]</div>}
                                    {textPart}
                                </div>
                            </div>
                        )
                    })}
                </div>
            )
        }

        // Nếu là Gemini response body (có candidates[].content.parts[].text)
        if (parsed.candidates && Array.isArray(parsed.candidates)) {
            const content = parsed.candidates[0]?.content?.parts?.[0]?.text || ""
            return (
                <div className="space-y-4">
                    <div className="space-y-2">
                        <p className="text-xs font-semibold text-green-600">
                            📥 GEMINI RESPONSE:
                        </p>
                        <div className="text-xs leading-relaxed whitespace-pre-wrap break-words bg-muted/30 rounded-lg p-4 border">
                            {content}
                        </div>
                    </div>
                </div>
            )
        }

        // JSON khác: format đẹp
        return (
            <pre className="text-xs font-mono whitespace-pre-wrap break-words leading-relaxed">
                {JSON.stringify(parsed, null, 2)}
            </pre>
        )
    } catch {
        // Không phải JSON: hiện raw text với xuống dòng
        return (
            <div className="text-xs leading-relaxed whitespace-pre-wrap break-words">
                {text}
            </div>
        )
    }
}

/** Tải text xuống dạng file */
function downloadText(content: string, filename: string) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
}
