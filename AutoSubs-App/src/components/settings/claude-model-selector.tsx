// claude-model-selector.tsx
// Nút đổi model AI — dùng Popover của shadcn/ui
// QUAN TRỌNG: Chọn provider nào thì TẤT CẢ request đi provider đó
// Chọn claude → Claude nhận mọi request; chọn gemini → Gemini nhận mọi request

import * as React from "react"
import { Bot, Check, Sparkles, Cpu, Shuffle } from "lucide-react"
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import {
    AVAILABLE_CLAUDE_MODELS,
    AVAILABLE_GEMINI_MODELS,
    getClaudeModel,
    getGeminiModel,
    getPreferredProvider,
    setClaudeModel,
    setGeminiModel,
    setPreferredProvider,
    initModelsFromSettings,
} from "@/utils/ai-provider"

// ======================== COMPONENT ========================

export function ClaudeModelSelector() {
    const [currentClaude, setCurrentClaude] = React.useState<string>("")
    const [currentGemini, setCurrentGemini] = React.useState<string>("")
    // Provider đang được ưu tiên ("claude" | "gemini" | "auto")
    const [currentProvider, setCurrentProvider] = React.useState<"claude" | "gemini" | "auto">("auto")
    const [open, setOpen] = React.useState(false)

    // Load từ settings khi mount
    React.useEffect(() => {
        initModelsFromSettings().then(() => {
            setCurrentClaude(getClaudeModel())
            setCurrentGemini(getGeminiModel())
            setCurrentProvider(getPreferredProvider())
        })
    }, [])

    // Chọn Claude model → đồng thời set preferred provider = "claude"
    const handleSelectClaude = async (modelId: string) => {
        await setClaudeModel(modelId)
        await setPreferredProvider("claude")  // ← QUAN TRỌNG: route mọi request sang Claude
        setCurrentClaude(modelId)
        setCurrentProvider("claude")
        setOpen(false)
    }

    // Chọn Gemini model → đồng thời set preferred provider = "gemini"
    const handleSelectGemini = async (modelId: string) => {
        await setGeminiModel(modelId)
        await setPreferredProvider("gemini")  // ← QUAN TRỌNG: route mọi request sang Gemini
        setCurrentGemini(modelId)
        setCurrentProvider("gemini")
        setOpen(false)
    }

    // Chế độ Auto: round-robin Claude/Gemini
    const handleSetAuto = async () => {
        await setPreferredProvider("auto")
        setCurrentProvider("auto")
        setOpen(false)
    }

    // Label hiển thị trên nút — cho biết provider đang active
    const displayLabel = () => {
        if (currentProvider === "claude") {
            // "S4-6" hoặc "S4-5"
            return currentClaude.replace("claude-sonnet-", "S").replace("claude-", "")
        }
        if (currentProvider === "gemini") {
            // "2.5P" | "2.5F" | "2.0F"
            return currentGemini
                .replace("gemini-", "")
                .replace("-pro", "P")
                .replace("-flash", "F")
        }
        return "Auto"
    }

    // Màu indicator theo provider
    const providerColor = currentProvider === "claude"
        ? "text-violet-400 hover:text-violet-300 hover:bg-violet-500/15"
        : currentProvider === "gemini"
            ? "text-blue-400 hover:text-blue-300 hover:bg-blue-500/15"
            : "text-muted-foreground hover:text-foreground hover:bg-accent"

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="ghost"
                    size="sm"
                    className={`h-6 gap-1 px-2 text-[10px] font-medium rounded-full transition-all ${providerColor}`}
                    data-tauri-drag-region="false"
                    title={`AI Provider: ${currentProvider} | Claude: ${currentClaude} | Gemini: ${currentGemini}`}
                >
                    <Bot className="h-3 w-3 shrink-0" />
                    <span>{displayLabel() || "AI"}</span>
                </Button>
            </PopoverTrigger>

            <PopoverContent className="w-[260px] p-0" align="end" sideOffset={6}>

                {/* ── AUTO MODE ── */}
                <button
                    onClick={handleSetAuto}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left
                        border-b border-border/50 transition-colors duration-100 cursor-pointer
                        ${currentProvider === "auto"
                            ? "bg-accent text-foreground font-medium"
                            : "hover:bg-accent/50 text-muted-foreground hover:text-foreground"
                        }`}
                >
                    <Shuffle className="h-3 w-3 shrink-0" />
                    <span className="flex-1 font-medium">Auto (Round-robin)</span>
                    {currentProvider === "auto" && <Check className="h-3 w-3" />}
                </button>

                {/* ── CLAUDE SECTION ── */}
                <div className="px-3 py-1.5 border-b border-border/50 bg-violet-500/5 flex items-center gap-1.5">
                    <Cpu className="h-3 w-3 text-violet-400" />
                    <span className="text-[10px] font-semibold text-violet-400 uppercase tracking-wider flex-1">
                        Claude (ezaiapi)
                    </span>
                    {currentProvider === "claude" && (
                        <span className="text-[9px] text-violet-400 bg-violet-500/20 px-1.5 py-0.5 rounded-full">
                            Active
                        </span>
                    )}
                </div>
                <div className="py-1">
                    {AVAILABLE_CLAUDE_MODELS.map(model => {
                        const isSelectedModel = model.id === currentClaude
                        const isActiveProvider = currentProvider === "claude"
                        return (
                            <button
                                key={model.id}
                                onClick={() => handleSelectClaude(model.id)}
                                className={`
                                    w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left
                                    transition-colors duration-100 cursor-pointer
                                    ${isSelectedModel && isActiveProvider
                                        ? "bg-violet-500/15 text-violet-300"
                                        : "hover:bg-accent text-foreground/80 hover:text-foreground"
                                    }
                                `}
                            >
                                <span className="w-4 flex justify-center shrink-0">
                                    {isSelectedModel && isActiveProvider && (
                                        <Check className="h-3 w-3 text-violet-400" />
                                    )}
                                </span>
                                <span className="flex-1">
                                    <span className="font-medium">{model.label}</span>
                                    <span className="block text-[9px] text-muted-foreground">
                                        {model.id}
                                    </span>
                                </span>
                            </button>
                        )
                    })}
                </div>

                {/* ── GEMINI SECTION ── */}
                <div className="px-3 py-1.5 border-y border-border/50 bg-blue-500/5 flex items-center gap-1.5">
                    <Sparkles className="h-3 w-3 text-blue-400" />
                    <span className="text-[10px] font-semibold text-blue-400 uppercase tracking-wider flex-1">
                        Gemini (Google AI)
                    </span>
                    {currentProvider === "gemini" && (
                        <span className="text-[9px] text-blue-400 bg-blue-500/20 px-1.5 py-0.5 rounded-full">
                            Active
                        </span>
                    )}
                </div>
                <div className="py-1">
                    {AVAILABLE_GEMINI_MODELS.map(model => {
                        const isSelectedModel = model.id === currentGemini
                        const isActiveProvider = currentProvider === "gemini"
                        return (
                            <button
                                key={model.id}
                                onClick={() => handleSelectGemini(model.id)}
                                className={`
                                    w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left
                                    transition-colors duration-100 cursor-pointer
                                    ${isSelectedModel && isActiveProvider
                                        ? "bg-blue-500/15 text-blue-300"
                                        : "hover:bg-accent text-foreground/80 hover:text-foreground"
                                    }
                                `}
                            >
                                <span className="w-4 flex justify-center shrink-0">
                                    {isSelectedModel && isActiveProvider && (
                                        <Check className="h-3 w-3 text-blue-400" />
                                    )}
                                </span>
                                <span className="flex-1">
                                    <span className="font-medium">{model.label}</span>
                                    <span className="block text-[9px] text-muted-foreground">
                                        {model.id}
                                    </span>
                                </span>
                            </button>
                        )
                    })}
                </div>

                {/* Footer */}
                <div className="px-3 py-1.5 border-t border-border/50 bg-muted/20">
                    <p className="text-[9px] text-muted-foreground">
                        Chọn provider → <strong>mọi request</strong> đi provider đó. Fallback tự động khi rate limit.
                    </p>
                </div>
            </PopoverContent>
        </Popover>
    )
}
