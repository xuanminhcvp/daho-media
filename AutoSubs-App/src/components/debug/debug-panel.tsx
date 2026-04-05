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
                                        try {
                                            const parsed = JSON.parse(content);
                                            // Format cho Request Claude
                                            if (parsed.messages && Array.isArray(parsed.messages)) {
                                                formatted = parsed.messages.map((m: any) => `[${m.role.toUpperCase()}]\n${m.content}`).join("\n\n");
                                            }
                                            // Format cho Response Claude
                                            else if (parsed.choices && Array.isArray(parsed.choices)) {
                                                formatted = parsed.choices[0]?.message?.content || "";
                                            }
                                            // Format cho Request Gemini
                                            else if (parsed.contents && Array.isArray(parsed.contents)) {
                                                formatted = parsed.contents.map((c: any) => {
                                                    const parts = Array.isArray(c.parts) ? c.parts : [];
                                                    const txt = parts.find((p: any) => p.text)?.text || "";
                                                    return `[PROMPT]\n${txt}`;
                                                }).join("\n\n");
                                            }
                                            // Format cho Response Gemini
                                            else if (parsed.candidates && Array.isArray(parsed.candidates)) {
                                                formatted = parsed.candidates[0]?.content?.parts?.[0]?.text || "";
                                            }
                                            // Fallback JSON đẹp
                                            else {
                                                formatted = JSON.stringify(parsed, null, 2);
                                            }
                                        } catch { /* giữ nguyên text raw nếu không phải JSON */ }
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
                                        let ext = "txt"
                                        try {
                                            const parsed = JSON.parse(content);
                                            if (parsed.messages && Array.isArray(parsed.messages)) {
                                                formatted = parsed.messages.map((m: any) => `[${m.role.toUpperCase()}]\n${m.content}`).join("\n\n");
                                            } else if (parsed.choices && Array.isArray(parsed.choices)) {
                                                formatted = parsed.choices[0]?.message?.content || "";
                                            } else if (parsed.contents && Array.isArray(parsed.contents)) {
                                                formatted = parsed.contents.map((c: any) => `[PROMPT]\n${(c.parts || []).find((p: any) => p.text)?.text || ""}`).join("\n\n");
                                            } else if (parsed.candidates && Array.isArray(parsed.candidates)) {
                                                formatted = parsed.candidates[0]?.content?.parts?.[0]?.text || "";
                                            } else {
                                                formatted = JSON.stringify(parsed, null, 2);
                                                ext = "json";
                                            }
                                        } catch { /* giữ nguyên */ }
                                        downloadText(
                                            formatted,
                                            `${selectedLog.label.replace(/\s/g, "_")}_${modalTab}.${ext}`
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
        const parsed = JSON.parse(text);

        // Hàm đệ quy render cấu trúc JSON đẹp mắt
        const renderJsonNode = (node: any, isRoot: boolean = false, path: string = ""): React.ReactNode => {
            if (node === null) return <span className="text-gray-500">null</span>;
            if (typeof node === "boolean") return <span className="text-purple-500">{node.toString()}</span>;
            if (typeof node === "number") return <span className="text-blue-500">{node}</span>;
            if (typeof node === "string") {
                // Nếu chuỗi dài hoặc có chứa xuống dòng -> render thành một block dễ đọc
                if (node.length > 80 || node.includes("\n")) {
                    return (
                        <div className="mt-1 mb-1 p-3 bg-muted/30 border rounded-md whitespace-pre-wrap break-words text-green-700 dark:text-green-400 font-sans">
                            {node}
                        </div>
                    );
                }
                // Chuỗi ngắn bình thường
                return <span className="text-green-600 dark:text-green-300">"{node}"</span>;
            }

            if (Array.isArray(node)) {
                if (node.length === 0) return <span className="text-gray-500">[]</span>;
                return (
                    <div className="pl-4 border-l-2 border-muted/50 ml-1 mt-1">
                        <span className="text-gray-400 select-none">[</span>
                        {node.map((item, index) => (
                            <div key={index} className="pl-2 py-0.5">
                                {renderJsonNode(item, false, `${path}[${index}]`)}
                                {index < node.length - 1 && <span className="text-gray-400 select-none">,</span>}
                            </div>
                        ))}
                        <span className="text-gray-400 select-none">]</span>
                    </div>
                );
            }

            if (typeof node === "object") {
                const keys = Object.keys(node);
                if (keys.length === 0) return <span className="text-gray-500">{"{}"}</span>;

                return (
                    <div className={isRoot ? "" : "pl-4 border-l-2 border-muted/50 ml-1 mt-1"}>
                        <span className="text-gray-400 select-none">{"{"}</span>
                        {keys.map((key, index) => (
                            <div key={key} className="pl-2 py-1">
                                <span className="text-orange-600 dark:text-orange-400 font-semibold select-none">"{key}"</span>
                                <span className="text-gray-500 select-none">: </span>
                                {renderJsonNode(node[key], false, `${path}.${key}`)}
                                {index < keys.length - 1 && <span className="text-gray-400 select-none">,</span>}
                            </div>
                        ))}
                        <span className="text-gray-400 select-none">{"}"}</span>
                    </div>
                );
            }

            return <span>{String(node)}</span>;
        };

        return (
            <div className="text-xs font-mono leading-relaxed overflow-x-auto pb-4">
                {renderJsonNode(parsed, true)}
            </div>
        );

    } catch {
        // Không phải JSON: hiện raw text với xuống dòng
        return (
            <div className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-words bg-muted/10 p-4 rounded border">
                {text}
            </div>
        );
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
