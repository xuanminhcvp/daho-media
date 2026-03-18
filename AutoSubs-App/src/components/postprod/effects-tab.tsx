// =====================================================
// effects-tab.tsx — Tab Hiệu Ứng Chuyển Động
// Áp dụng Ken Burns (zoom + pan) + Camera Shake cho clips ảnh
// Gửi request đến Lua backend → ApplyMotionEffects
// =====================================================

import * as React from "react"
import { Clapperboard, Play, Loader2, CheckCircle2, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { fetch as tauriFetch } from "@tauri-apps/plugin-http"

// ======================== CẤU HÌNH HIỆU ỨNG ========================

// Loại hiệu ứng có thể chọn
const EFFECT_TYPES = [
    { value: "both", label: "Ken Burns + Shake", desc: "Zoom chậm + rung nhẹ (khuyến nghị)" },
    { value: "kenburns", label: "Ken Burns", desc: "Chỉ zoom chậm vào + pan nhẹ" },
    { value: "shake", label: "Camera Shake", desc: "Chỉ rung nhẹ như quay tay" },
] as const

// Cường độ hiệu ứng
const INTENSITY_LEVELS = [
    { value: "subtle", label: "Nhẹ", desc: "Tinh tế, chuyên nghiệp" },
    { value: "medium", label: "Vừa", desc: "Rõ ràng hơn, vẫn mượt" },
    { value: "strong", label: "Mạnh", desc: "Dramatic, bắt mắt" },
] as const

// ======================== COMPONENT ========================

export function EffectsTab() {
    // State UI
    const [trackIndex, setTrackIndex] = React.useState("1")
    const [effectType, setEffectType] = React.useState<string>("kenburns")
    const [intensity, setIntensity] = React.useState<string>("subtle")
    const [fadeEnabled, setFadeEnabled] = React.useState(true)     // Bật Fade In/Out mặc định
    const [fadeDuration, setFadeDuration] = React.useState(0.3)    // 0.3 giây
    const [isApplying, setIsApplying] = React.useState(false)
    const [result, setResult] = React.useState<{ success: boolean; message: string } | null>(null)

    // ======================== APPLY EFFECTS ========================
    // Gửi request đến Lua backend để áp dụng hiệu ứng
    const handleApply = React.useCallback(async () => {
        setIsApplying(true)
        setResult(null)

        try {
            console.log(`[EffectsTab] Applying ${effectType} (${intensity}) to track V${trackIndex}`)

            const response = await tauriFetch("http://127.0.0.1:56003/", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    func: "ApplyMotionEffects",
                    trackIndex: trackIndex,
                    effectType: effectType,
                    intensity: intensity,
                    fadeDuration: fadeEnabled ? fadeDuration : 0,
                }),
            })

            const data = await response.json() as any
            console.log("[EffectsTab] Response:", data)

            if (data.error) {
                setResult({ success: false, message: data.message || "Lỗi không rõ" })
            } else {
                setResult({
                    success: true,
                    message: `✅ Đã áp dụng ${data.applied || 0}/${data.total || 0} clips trên V${data.trackIndex || trackIndex}`
                })
            }
        } catch (err) {
            console.error("[EffectsTab] Error:", err)
            setResult({ success: false, message: String(err) })
        } finally {
            setIsApplying(false)
        }
    }, [trackIndex, effectType, intensity, fadeEnabled, fadeDuration])

    return (
        <div className="flex flex-col gap-4 p-4 overflow-y-auto h-full">
            {/* Header */}
            <div className="flex items-center gap-2">
                <Clapperboard className="h-5 w-5 text-purple-400" />
                <h4 className="text-sm font-semibold">Hiệu Ứng Chuyển Động</h4>
            </div>
            <p className="text-xs text-muted-foreground -mt-2">
                Thêm Ken Burns (zoom + pan) và Camera Shake cho ảnh tĩnh trên timeline
            </p>

            {/* Chọn Track */}
            <div className="space-y-1.5">
                <Label className="text-xs font-medium">Track áp dụng</Label>
                <div className="flex gap-1.5">
                    {["1", "2", "3", "4"].map(t => (
                        <Button
                            key={t}
                            variant={trackIndex === t ? "secondary" : "outline"}
                            size="sm"
                            className="h-7 px-3 text-xs"
                            onClick={() => setTrackIndex(t)}
                        >
                            V{t}
                        </Button>
                    ))}
                </div>
            </div>

            {/* Chọn loại hiệu ứng */}
            <div className="space-y-1.5">
                <Label className="text-xs font-medium">Loại hiệu ứng</Label>
                <div className="flex flex-col gap-1.5">
                    {EFFECT_TYPES.map(ef => (
                        <Button
                            key={ef.value}
                            variant={effectType === ef.value ? "secondary" : "outline"}
                            size="sm"
                            className="h-auto py-1.5 px-3 text-left justify-start"
                            onClick={() => setEffectType(ef.value)}
                        >
                            <div>
                                <div className="text-xs font-medium">{ef.label}</div>
                                <div className="text-[10px] text-muted-foreground">{ef.desc}</div>
                            </div>
                        </Button>
                    ))}
                </div>
            </div>

            {/* Chọn cường độ */}
            <div className="space-y-1.5">
                <Label className="text-xs font-medium">Cường độ</Label>
                <div className="flex gap-1.5">
                    {INTENSITY_LEVELS.map(lv => (
                        <Button
                            key={lv.value}
                            variant={intensity === lv.value ? "secondary" : "outline"}
                            size="sm"
                            className="h-auto py-1.5 px-3 flex-1 text-center"
                            onClick={() => setIntensity(lv.value)}
                        >
                            <div>
                                <div className="text-xs font-medium">{lv.label}</div>
                                <div className="text-[10px] text-muted-foreground">{lv.desc}</div>
                            </div>
                        </Button>
                    ))}
                </div>
            </div>

            {/* Fade In/Out */}
            <div className="space-y-1.5">
                <Label className="text-xs font-medium">Chuyển cảnh (Fade In/Out)</Label>
                <div className="flex items-center gap-3">
                    <Button
                        variant={fadeEnabled ? "secondary" : "outline"}
                        size="sm"
                        className="h-7 px-3 text-xs"
                        onClick={() => setFadeEnabled(!fadeEnabled)}
                    >
                        {fadeEnabled ? "✅ Bật" : "❌ Tắt"}
                    </Button>
                    {fadeEnabled && (
                        <div className="flex items-center gap-1.5">
                            {[0.2, 0.3, 0.5, 0.8].map(d => (
                                <Button
                                    key={d}
                                    variant={fadeDuration === d ? "secondary" : "outline"}
                                    size="sm"
                                    className="h-7 px-2 text-xs"
                                    onClick={() => setFadeDuration(d)}
                                >
                                    {d}s
                                </Button>
                            ))}
                        </div>
                    )}
                </div>
                {fadeEnabled && (
                    <p className="text-[10px] text-muted-foreground">
                        Mỗi clip sẽ fade in từ đen ở đầu và fade out ra đen ở cuối → tạo hiệu ứng cross-fade tự nhiên
                    </p>
                )}
            </div>

            {/* Nút Apply */}
            <Button
                onClick={handleApply}
                disabled={isApplying}
                className="w-full gap-2 bg-purple-600 hover:bg-purple-700 text-white"
            >
                {isApplying ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /> Đang áp dụng...</>
                ) : (
                    <><Play className="h-4 w-4" /> Áp dụng hiệu ứng cho Track V{trackIndex}</>
                )}
            </Button>

            {/* Kết quả */}
            {result && (
                <div className={`flex items-start gap-2 p-3 rounded-md text-xs ${
                    result.success
                        ? "bg-green-500/10 text-green-400 border border-green-500/30"
                        : "bg-red-500/10 text-red-400 border border-red-500/30"
                }`}>
                    {result.success
                        ? <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                        : <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    }
                    <span>{result.message}</span>
                </div>
            )}

            {/* Thông tin hướng dẫn */}
            <div className="mt-auto p-3 rounded-md bg-muted/30 border border-border text-[10px] text-muted-foreground space-y-1">
                <p>💡 <strong>Ken Burns</strong>: Zoom chậm với tốc độ cố định + dịch nhẹ — cảm giác chuyển động cho ảnh tĩnh</p>
                <p>🎬 <strong>Fade In/Out</strong>: Mở dần từ đen + tối dần cuối clip → chuyển cảnh mượt mà</p>
                <p>⚠️ Tự động tạo Fusion comp cho mỗi clip ảnh trên track.</p>
            </div>
        </div>
    )
}
