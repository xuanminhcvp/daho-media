// sentence-search.tsx
// Component tìm kiếm câu theo số hoặc text
// Nhập số câu → nhảy thẳng đến vị trí trên timeline DaVinci
// Nhập text → lọc danh sách câu chứa text đó, bấm vào để nhảy

import * as React from "react"
import { Search, ArrowRight, X } from "lucide-react"
import { seekToTime } from "@/api/resolve-api"
import type { ScriptSentence } from "@/utils/media-matcher"

interface SentenceSearchProps {
    // Danh sách câu đã match (có timing)
    matchedSentences: ScriptSentence[]
}

export function SentenceSearch({ matchedSentences }: SentenceSearchProps) {
    // Giá trị ô tìm kiếm
    const [query, setQuery] = React.useState("")
    // Danh sách kết quả tìm kiếm
    const [results, setResults] = React.useState<ScriptSentence[]>([])
    // Trạng thái đang nhảy timeline
    const [jumping, setJumping] = React.useState(false)
    // Thông báo kết quả (vd: "Đã nhảy đến câu 42")
    const [feedback, setFeedback] = React.useState("")

    // Hàm nhảy timeline đến 1 câu cụ thể
    const jumpToSentence = async (sent: ScriptSentence) => {
        setJumping(true)
        setFeedback("")
        try {
            await seekToTime(sent.start)
            setFeedback(`✅ Đã nhảy đến câu ${sent.num} (${sent.start.toFixed(1)}s)`)
        } catch (err) {
            setFeedback(`❌ Lỗi: ${String(err)}`)
        }
        setJumping(false)
    }

    // Xử lý khi nhập vào ô tìm kiếm
    const handleSearch = (value: string) => {
        setQuery(value)
        setFeedback("")

        if (!value.trim()) {
            setResults([])
            return
        }

        const trimmed = value.trim()

        // Kiểm tra xem có phải nhập số câu không (ví dụ: "42", "123")
        const asNumber = parseInt(trimmed)
        if (!isNaN(asNumber) && String(asNumber) === trimmed) {
            // Tìm theo số câu chính xác
            const found = matchedSentences.filter(s => s.num === asNumber)
            if (found.length > 0) {
                setResults(found)
            } else {
                // Không tìm thấy số chính xác → tìm các số chứa chuỗi đó
                const partial = matchedSentences.filter(s =>
                    String(s.num).includes(trimmed)
                )
                setResults(partial)
            }
            return
        }

        // Tìm theo text (case-insensitive)
        const lowerQuery = trimmed.toLowerCase()
        const filtered = matchedSentences.filter(s =>
            s.text.toLowerCase().includes(lowerQuery) ||
            s.matchedWhisper?.toLowerCase().includes(lowerQuery)
        )
        setResults(filtered)
    }

    // Nhấn Enter → nhảy thẳng nếu tìm đúng 1 kết quả hoặc nhập đúng số câu
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault()
            const trimmed = query.trim()
            const asNumber = parseInt(trimmed)

            // Nếu nhập số câu → tìm và nhảy luôn
            if (!isNaN(asNumber) && String(asNumber) === trimmed) {
                const found = matchedSentences.find(s => s.num === asNumber)
                if (found) {
                    jumpToSentence(found)
                    return
                }
            }

            // Nếu chỉ có 1 kết quả → nhảy luôn
            if (results.length === 1) {
                jumpToSentence(results[0])
            }
        }

        // Nhấn Escape → xoá ô tìm kiếm
        if (e.key === "Escape") {
            setQuery("")
            setResults([])
            setFeedback("")
        }
    }

    // Xoá ô tìm kiếm
    const handleClear = () => {
        setQuery("")
        setResults([])
        setFeedback("")
    }

    // Không hiển thị nếu chưa có matched sentences
    if (matchedSentences.length === 0) return null

    return (
        <div className="space-y-2">
            <label className="text-sm font-medium flex items-center gap-1.5">
                <Search className="h-3.5 w-3.5 text-primary" />
                Tìm kiếm câu
            </label>

            {/* Ô tìm kiếm */}
            <div className="relative">
                <input
                    type="text"
                    className="w-full h-9 rounded-md border border-input bg-background pl-8 pr-8 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    placeholder="Nhập số câu (VD: 42) hoặc text để tìm..."
                    value={query}
                    onChange={(e) => handleSearch(e.target.value)}
                    onKeyDown={handleKeyDown}
                />
                {/* Icon tìm kiếm bên trái */}
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                {/* Nút xoá bên phải */}
                {query && (
                    <button
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                        onClick={handleClear}
                        title="Xoá tìm kiếm (Esc)"
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                )}
            </div>

            {/* Feedback (kết quả nhảy) */}
            {feedback && (
                <p className={`text-xs ${feedback.startsWith("✅") ? "text-green-500" : "text-red-500"}`}>
                    {feedback}
                </p>
            )}

            {/* Danh sách kết quả */}
            {results.length > 0 && (
                <div className="border rounded-md divide-y max-h-40 overflow-y-auto bg-background">
                    {results.slice(0, 20).map((sent) => (
                        <button
                            key={sent.num}
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-primary/10 transition-colors flex items-start gap-2 group"
                            onClick={() => jumpToSentence(sent)}
                            disabled={jumping}
                            title={`Nhảy đến câu ${sent.num} (${sent.start.toFixed(1)}s)`}
                        >
                            {/* Số câu */}
                            <span className="font-mono text-primary shrink-0 w-8 text-right font-semibold">
                                #{sent.num}
                            </span>
                            {/* Nội dung */}
                            <span
                                className="flex-1 min-w-0"
                                style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                            >
                                {sent.text}
                            </span>
                            {/* Thời gian + mũi tên */}
                            <span className="shrink-0 text-muted-foreground group-hover:text-primary transition-colors flex items-center gap-1">
                                {sent.start.toFixed(1)}s
                                <ArrowRight className="h-3 w-3" />
                            </span>
                        </button>
                    ))}
                    {/* Thông báo nếu nhiều kết quả quá */}
                    {results.length > 20 && (
                        <p className="text-center text-xs text-muted-foreground py-1.5">
                            ...và {results.length - 20} kết quả khác
                        </p>
                    )}
                </div>
            )}

            {/* Không tìm thấy */}
            {query.trim() && results.length === 0 && (
                <p className="text-xs text-muted-foreground">
                    Không tìm thấy câu nào phù hợp với "{query}"
                </p>
            )}
        </div>
    )
}
