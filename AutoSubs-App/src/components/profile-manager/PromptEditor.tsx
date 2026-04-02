// PromptEditor.tsx
// Màn hình chỉnh sửa tất cả prompts + config cho 1 profile
// Hiển thị dạng Tabs: mỗi tab 1 loại prompt

import * as React from "react"
import { Save, X, RotateCcw, Info } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { CustomProfile, ProfileConfig } from "@/services/profile-storage"

// Danh sách các prompt field + label hiển thị
const PROMPT_TABS = [
    { key: "match",        label: "Match Script",   desc: "Ghép câu kịch bản với giọng đọc Whisper" },
    { key: "audio",        label: "Nhạc Nền",       desc: "Gợi ý nhạc nền theo cảm xúc cảnh" },
    { key: "sfx",          label: "SFX",            desc: "Gợi ý âm thanh phụ (tiếng động)" },
    { key: "footageScan",  label: "Scan Footage",   desc: "Phân tích mô tả video/ảnh thư viện" },
    { key: "footageMatch", label: "Match Footage",  desc: "Ghép footage phù hợp vào câu kịch bản" },
    { key: "color",        label: "Auto Color",     desc: "Gợi ý phong cách màu sắc cho cảnh" },
    { key: "voicePacing",  label: "Voice Pacing",   desc: "Căn nhịp điệu đọc/nghỉ cho AI Voice" },
    { key: "highlight",    label: "Highlight Text", desc: "Nhấn mạnh các từ khóa quan trọng" },
] as const

type PromptKey = (typeof PROMPT_TABS)[number]["key"]

interface PromptEditorProps {
    profile: CustomProfile
    onSave: (updated: CustomProfile) => Promise<void>
    onCancel: () => void
}

export function PromptEditor({ profile, onSave, onCancel }: PromptEditorProps) {
    // Deep clone để edit mà không ảnh hưởng original
    const [draft, setDraft] = React.useState<CustomProfile>(() => ({
        ...profile,
        prompts: { ...profile.prompts },
        config: { ...profile.config, RESOLUTION: profile.config.RESOLUTION ? { ...profile.config.RESOLUTION } : undefined },
    }))
    const [activeTab, setActiveTab] = React.useState<PromptKey>("match")
    const [saving, setSaving] = React.useState(false)
    const [isDirty, setIsDirty] = React.useState(false)

    // Update prompt text
    const handlePromptChange = (key: PromptKey, value: string) => {
        setDraft(prev => ({
            ...prev,
            prompts: { ...prev.prompts, [key]: value }
        }))
        setIsDirty(true)
    }

    // Update config number
    const handleConfigChange = (key: keyof ProfileConfig, value: number) => {
        setDraft(prev => ({
            ...prev,
            config: { ...prev.config, [key]: value }
        }))
        setIsDirty(true)
    }

    // Update resolution
    const handleResolutionChange = (field: "width" | "height" | "useVertical", value: number | boolean) => {
        setDraft(prev => ({
            ...prev,
            config: {
                ...prev.config,
                RESOLUTION: {
                    width: prev.config.RESOLUTION?.width ?? 1920,
                    height: prev.config.RESOLUTION?.height ?? 1080,
                    useVertical: prev.config.RESOLUTION?.useVertical ?? false,
                    [field]: value,
                }
            }
        }))
        setIsDirty(true)
    }

    // Update meta info (label, desc, icon)
    const handleMetaChange = (field: "label" | "desc" | "icon", value: string) => {
        setDraft(prev => ({ ...prev, [field]: value }))
        setIsDirty(true)
    }

    // Reset tab hiện tại về rỗng
    const handleResetTab = () => {
        handlePromptChange(activeTab, "")
    }

    const handleSave = async () => {
        setSaving(true)
        try {
            await onSave(draft)
            setIsDirty(false)
        } catch (e) {
            console.error("[PromptEditor] Lỗi lưu:", e)
        } finally {
            setSaving(false)
        }
    }

    const currentTabInfo = PROMPT_TABS.find(t => t.key === activeTab)!
    const charCount = (draft.prompts[activeTab] || "").length

    return (
        <div className="flex flex-col h-full gap-0">

            {/* ── Header ── */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-border/40 shrink-0">
                <div className="flex-1 min-w-0">
                    {/* Tên profile chỉnh được */}
                    <input
                        value={draft.label}
                        onChange={e => handleMetaChange("label", e.target.value)}
                        className="text-sm font-bold text-foreground bg-transparent border-none outline-none w-full"
                        placeholder="Tên profile..."
                    />
                    <input
                        value={draft.desc}
                        onChange={e => handleMetaChange("desc", e.target.value)}
                        className="text-[10px] text-muted-foreground bg-transparent border-none outline-none w-full mt-0.5"
                        placeholder="Mô tả ngắn..."
                    />
                </div>

                {isDirty && (
                    <span className="text-[9px] text-amber-400 font-medium shrink-0">● Chưa lưu</span>
                )}

                <div className="flex gap-1.5 shrink-0">
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onCancel}>
                        <X className="h-3 w-3 mr-1" /> Đóng
                    </Button>
                    <Button
                        size="sm"
                        className="h-7 px-3 text-xs gap-1"
                        onClick={handleSave}
                        disabled={saving || !isDirty}
                    >
                        <Save className="h-3 w-3" />
                        {saving ? "Đang lưu..." : "Lưu"}
                    </Button>
                </div>
            </div>

            {/* ── Config kỹ thuật (luôn hiển thị) ── */}
            <div className="px-4 py-2.5 border-b border-border/30 bg-muted/10 shrink-0">
                <p className="text-[9px] text-muted-foreground/60 font-semibold uppercase tracking-wider mb-2">Cấu hình kỹ thuật</p>
                <div className="flex flex-wrap gap-3">
                    <ConfigInput
                        label="Music Batch" value={draft.config.MUSIC_BATCH_COUNT}
                        onChange={v => handleConfigChange("MUSIC_BATCH_COUNT", v)} min={1} max={10}
                    />
                    <ConfigInput
                        label="SFX Batch" value={draft.config.SFX_BATCH_COUNT}
                        onChange={v => handleConfigChange("SFX_BATCH_COUNT", v)} min={1} max={10}
                    />
                    <ConfigInput
                        label="SFX/Batch" value={draft.config.MAX_SFX_CUES_PER_BATCH}
                        onChange={v => handleConfigChange("MAX_SFX_CUES_PER_BATCH", v)} min={1} max={30}
                    />
                    <ConfigInput
                        label="Width" value={draft.config.RESOLUTION?.width ?? 1920}
                        onChange={v => handleResolutionChange("width", v)} min={360} max={7680}
                    />
                    <ConfigInput
                        label="Height" value={draft.config.RESOLUTION?.height ?? 1080}
                        onChange={v => handleResolutionChange("height", v)} min={360} max={7680}
                    />
                    {/* Toggle Dọc/Ngang */}
                    <label className="flex flex-col gap-0.5 text-[10px]">
                        <span className="text-muted-foreground/60">Dọc</span>
                        <input
                            type="checkbox"
                            checked={draft.config.RESOLUTION?.useVertical ?? false}
                            onChange={e => handleResolutionChange("useVertical", e.target.checked)}
                            className="w-4 h-4 accent-primary mt-0.5"
                        />
                    </label>
                </div>
            </div>

            {/* ── Tabs prompt ── */}
            <div className="flex gap-0 border-b border-border/30 shrink-0 overflow-x-auto">
                {PROMPT_TABS.map(tab => (
                    <button
                        key={tab.key}
                        onClick={() => setActiveTab(tab.key)}
                        className={`
                            px-3 py-2 text-[10px] font-medium whitespace-nowrap transition-all
                            border-b-2 -mb-px
                            ${activeTab === tab.key
                                ? "border-primary text-primary bg-primary/5"
                                : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/30"
                            }
                        `}
                    >
                        {tab.label}
                        {/* Dot nếu có nội dung */}
                        {(draft.prompts[tab.key]?.length || 0) > 0 && (
                            <span className="inline-block ml-1 h-1.5 w-1.5 rounded-full bg-emerald-400 align-middle" />
                        )}
                    </button>
                ))}
            </div>

            {/* ── Tab info + Textarea ── */}
            <div className="flex items-center gap-2 px-4 py-1.5 bg-muted/5 shrink-0">
                <Info className="h-3 w-3 text-muted-foreground/40 shrink-0" />
                <span className="text-[9px] text-muted-foreground/50 flex-1">{currentTabInfo.desc}</span>
                <span className="text-[9px] text-muted-foreground/40 font-mono">{charCount} ký tự</span>
                <button
                    onClick={handleResetTab}
                    className="text-[9px] text-muted-foreground/40 hover:text-muted-foreground flex items-center gap-0.5 transition-colors"
                    title="Xóa trắng tab này"
                >
                    <RotateCcw className="h-2.5 w-2.5" />
                    Xóa
                </button>
            </div>

            {/* ── Textarea chỉnh prompt ── */}
            <div className="flex-1 px-4 pb-4 min-h-0">
                <textarea
                    value={draft.prompts[activeTab] || ""}
                    onChange={e => handlePromptChange(activeTab, e.target.value)}
                    placeholder={`Nhập nội dung prompt cho "${currentTabInfo.label}"...\n\nTip: Sao chép từ prompt mặc định trong code, rồi chỉnh sửa theo ý muốn.`}
                    className="
                        w-full h-full resize-none
                        text-xs font-mono text-foreground/90 leading-relaxed
                        bg-muted/20 border border-border/30 rounded-lg
                        p-3 focus:outline-none focus:ring-1 focus:ring-primary/30
                        focus:border-primary/40 transition-all
                        placeholder:text-muted-foreground/30
                    "
                    spellCheck={false}
                />
            </div>
        </div>
    )
}

// ── Nhỏ: Input số có label ──
interface ConfigInputProps {
    label: string
    value: number
    onChange: (v: number) => void
    min: number
    max: number
}

function ConfigInput({ label, value, onChange, min, max }: ConfigInputProps) {
    return (
        <label className="flex flex-col gap-0.5 text-[10px]">
            <span className="text-muted-foreground/60">{label}</span>
            <input
                type="number"
                value={value}
                min={min}
                max={max}
                onChange={e => {
                    const v = parseInt(e.target.value, 10)
                    if (!isNaN(v)) onChange(Math.max(min, Math.min(max, v)))
                }}
                className="
                    w-16 text-center text-xs px-1.5 py-0.5 rounded
                    bg-muted/50 border border-border/40 text-foreground
                    focus:outline-none focus:ring-1 focus:ring-primary/40
                    [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none
                    [&::-webkit-inner-spin-button]:appearance-none
                "
            />
        </label>
    )
}
