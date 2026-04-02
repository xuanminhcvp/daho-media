// ============================================================
// auto-color-tab.tsx — UI tab Auto Color V2
//
// Giao diện 3 phần:
//   1. Reference Setup: 4 slot ảnh reference + nút Tạo Direction
//   2. Timeline Scan & Analyze: scan + phân tích AI 
//   3. Results: bảng kết quả 5 thông số per clip + nút Apply
//
// Flow:
//   Chọn 4 ảnh → Tạo Direction → Scan Timeline → Phân Tích → Apply
// ============================================================

import * as React from "react";
import {
    ImagePlus, Scan, Wand2, Zap, Camera, ChevronDown,
    ChevronUp, Copy, Check, Play, Trash2,
    Sun, Moon, Cloud, CloudRain, Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { autoColorScan, autoColorApplyBatch, type AutoColorClip } from "@/api/auto-color-api";
import {
    analyzeAllClipsV2,
    convertPrimariesToCDL,
    type AutoColorResult,
    type AutoColorProgress,
} from "@/services/auto-color-service";
import type { PrimariesValues } from "@/prompts/documentary/auto-color-prompt";
import { open } from "@tauri-apps/plugin-dialog";


// ======================== CONSTANTS ========================

/** 4 loại cảnh reference */
const REF_SLOTS = [
    { id: "indoor_bright",  label: "Trong nhà sáng",     icon: Sun,       emoji: "🏠☀️" },
    { id: "indoor_dark",    label: "Trong nhà tối",      icon: Moon,      emoji: "🏠🌙" },
    { id: "outdoor_bright", label: "Ngoài trời sáng",    icon: Cloud,     emoji: "🌳☀️" },
    { id: "outdoor_dark",   label: "Ngoài trời tối/âm u", icon: CloudRain, emoji: "🌳🌧️" },
] as const;

/** Tên hiển thị cho bucket */
const BUCKET_LABELS: Record<string, string> = {
    indoor_bright:  "🏠☀️ Trong nhà sáng",
    indoor_dark:    "🏠🌙 Trong nhà tối",
    outdoor_bright: "🌳☀️ Ngoài trời sáng",
    outdoor_dark:   "🌳🌧️ Ngoài trời tối",
    mixed:          "🔀 Hỗn hợp",
};


// ======================== COMPONENT ========================

export function AutoColorTab() {
    // ===== STATE =====
    
    // State cốt lõi
    const [scannedClips, setScannedClips] = React.useState<AutoColorClip[]>([]);
    const [timelineName, setTimelineName] = React.useState("");
    const [refPaths, setRefPaths] = React.useState<Record<string, string>>({});

    // Phân tích
    const [isAnalyzing, setIsAnalyzing] = React.useState(false);
    const [analyzeProgress, setAnalyzeProgress] = React.useState<AutoColorProgress | null>(null);
    const [results, setResults] = React.useState<AutoColorResult[]>([]);
    
    // Scan
    const [isScanning, setIsScanning] = React.useState(false);
    
    // Apply
    const [isApplying, setIsApplying] = React.useState(false);
    const [applyStatus, setApplyStatus] = React.useState("");
    
    // UI
    const [expandedClip, setExpandedClip] = React.useState<number | null>(null);
    const [copiedIndex, setCopiedIndex] = React.useState<number | null>(null);
    const [skipExistingGrades, setSkipExistingGrades] = React.useState(true);
    const [selectedTrackFilter, setSelectedTrackFilter] = React.useState<string>("all");
    
    // Abort controller cho phân tích
    const abortRef = React.useRef<AbortController | null>(null);

    // ===== HANDLERS =====

    /** Chọn 1 ảnh reference cho slot */
    const handlePickReference = async (slotId: string) => {
        try {
            const selected = await open({
                multiple: false,
                filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "bmp", "tiff", "webp"] }],
            });
            if (selected) {
                setRefPaths(prev => ({ ...prev, [slotId]: selected as string }));
            }
        } catch (error) {
            console.error("[AutoColor UI] Lỗi chọn ảnh:", error);
        }
    };

    /** Xóa 1 ảnh reference */
    const handleRemoveReference = (slotId: string) => {
        setRefPaths(prev => {
            const next = { ...prev };
            delete next[slotId];
            return next;
        });
    };

    /** Scan timeline qua Python server */
    const handleScanTimeline = async () => {
        setIsScanning(true);
        setScannedClips([]);
        setResults([]);

        try {
            const scanResult = await autoColorScan("timeline");
            if (scanResult.error) {
                console.error("[AutoColor UI] Scan lỗi:", scanResult.message);
            } else {
                setScannedClips(scanResult.clips);
                setTimelineName(scanResult.timelineName);
            }
        } catch (error) {
            console.error("[AutoColor UI] ❌ Scan error:", error);
        } finally {
            setIsScanning(false);
        }
    };

    /** Phân tích toàn bộ clips (Match trực tiếp Reference) */
    const handleAnalyzeAll = async () => {
        const refs = Object.values(refPaths);
        if (refs.length === 0) {
            alert("Vui lòng chọn ít nhất 1 ảnh Reference trước khi phân tích!");
            return;
        }

        if (scannedClips.length === 0) {
            alert("Vui lòng quét Timeline trước!");
            return;
        }

        // B1: Lọc clip theo selectedTrackFilter
        const targetClips = scannedClips.filter(c => 
            selectedTrackFilter === "all" ? true : c.trackIndex.toString() === selectedTrackFilter
        );

        if (targetClips.length === 0) {
            alert("Không có clip nào trong Track được chọn!");
            return;
        }

        setIsAnalyzing(true);
        setResults([]);
        setAnalyzeProgress(null);

        abortRef.current = new AbortController();

        try {
            const allResults = await analyzeAllClipsV2(
                targetClips,
                refs, // Truyền trực tiếp danh sách mảng đường dẫn
                skipExistingGrades,
                (p) => setAnalyzeProgress(p),
                abortRef.current.signal
            );
            setResults(allResults);
        } catch (error: any) {
            if (error.name !== "AbortError") {
                console.error("[AutoColor UI] Lỗi phân tích hàng loạt:", error);
                alert(`Lỗi AI: ${error.message}`);
            }
        } finally {
            setIsAnalyzing(false);
            setAnalyzeProgress(null);
            abortRef.current = null;
        }
    };

    /** Dừng phân tích giữa chừng */
    const handleStopAnalyze = () => {
        abortRef.current?.abort();
    };

    /** Apply toàn bộ kết quả vào DaVinci (Dịch Primaries -> Toán CDL) */
    const handleApplyAll = async () => {
        const toApply = results.filter(r => r.status === "analyzed");
        if (toApply.length === 0) return;

        setIsApplying(true);
        setApplyStatus(`Đang tính toán CDL Math và apply ${toApply.length} clips mượt mà...`);

        try {
            // Dịch toán học thay vì dùng UI Automation (an toàn tuyệt đối)
            const batchData = toApply.map(r => ({
                trackIndex: r.clip.trackIndex,
                itemIndex: r.clip.itemIndex,
                cdl: convertPrimariesToCDL(r.primaries),
            }));

            const result = await autoColorApplyBatch(batchData);
            setApplyStatus(`✅ Xong! ${result.applied} applied, ${result.failed} failed, ${result.skipped} skipped`);
        } catch (error) {
            console.error("[AutoColor UI] ❌ Apply error:", error);
            setApplyStatus(`❌ Lỗi API: ${String(error).slice(0, 100)}`);
        } finally {
            setIsApplying(false);
        }
    };

    /** Copy 5 thông số 1 clip vào clipboard */
    const handleCopyClip = (index: number, p: PrimariesValues) => {
        const text = `Contrast: ${p.contrast}\nPivot: ${p.pivot}\nSaturation: ${p.saturation}\nLift Master: ${p.lift_master}\nGain Master: ${p.gain_master}`;
        navigator.clipboard.writeText(text);
        setCopiedIndex(index);
        setTimeout(() => setCopiedIndex(null), 2000);
    };

    // ===== COUNTS & FILTERS =====
    const refCount = Object.keys(refPaths).length;
    
    // Tạo danh sách video track (dupes filter)
    const availableTracks = React.useMemo(() => {
        const tracks = new Set(scannedClips.filter(c => c.type === "video_clip").map(c => c.trackIndex));
        return Array.from(tracks).sort((a,b) => a - b);
    }, [scannedClips]);

    const targetClipsCount = scannedClips.filter(c => 
        c.type === "video_clip" && 
        (selectedTrackFilter === "all" ? true : c.trackIndex.toString() === selectedTrackFilter)
    ).length;

    const analyzedCount = results.filter(r => r.status === "analyzed").length;
    const errorCount = results.filter(r => r.status === "error").length;

    // ===== RENDER =====
    return (
        <div className="flex flex-col h-full overflow-y-auto">
            <div className="p-4 space-y-4">

                {/* ======================== PHẦN 1: REFERENCE SETUP ======================== */}
                <div className="rounded-lg border bg-card p-4 space-y-3">
                    {/* Header */}
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <Camera className="h-4 w-4 text-purple-500" />
                            <span className="text-sm font-semibold">Ảnh Reference ({refCount}/4)</span>
                        </div>
                    </div>

                    {/* 4 slot reference */}
                    <div className="grid grid-cols-2 gap-2">
                        {REF_SLOTS.map(slot => {
                            const SlotIcon = slot.icon;
                            const hasImage = !!refPaths[slot.id];
                            const fileName = hasImage ? refPaths[slot.id].split("/").pop() : null;

                            return (
                                <div
                                    key={slot.id}
                                    className={`relative rounded-md border-2 border-dashed p-2 cursor-pointer transition-all hover:bg-muted/50 ${
                                        hasImage ? "border-purple-500/50 bg-purple-50/10" : "border-muted-foreground/20"
                                    }`}
                                    onClick={() => !hasImage && handlePickReference(slot.id)}
                                >
                                    <div className="flex items-center gap-1.5">
                                        <SlotIcon className={`h-3.5 w-3.5 ${hasImage ? "text-purple-500" : "text-muted-foreground"}`} />
                                        <span className={`text-xs ${hasImage ? "font-medium" : "text-muted-foreground"}`}>
                                            {slot.label}
                                        </span>
                                    </div>

                                    {hasImage ? (
                                        <div className="flex items-center gap-1 mt-1">
                                            <span className="text-[10px] text-muted-foreground truncate max-w-[120px]">
                                                {fileName}
                                            </span>
                                            {/* Nút xóa ảnh */}
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-4 w-4 text-muted-foreground hover:text-red-500"
                                                onClick={(e) => { e.stopPropagation(); handleRemoveReference(slot.id); }}
                                            >
                                                <Trash2 className="h-3 w-3" />
                                            </Button>
                                            {/* Nút đổi ảnh */}
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-4 w-4 text-muted-foreground hover:text-purple-500"
                                                onClick={(e) => { e.stopPropagation(); handlePickReference(slot.id); }}
                                            >
                                                <ImagePlus className="h-3 w-3" />
                                            </Button>
                                        </div>
                                    ) : (
                                        <div className="text-[10px] text-muted-foreground/60 mt-1 flex items-center gap-1">
                                            <ImagePlus className="h-3 w-3" />
                                            Chọn ảnh
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* ======================== PHẦN 2: SCAN & ANALYZE ======================== */}
                <div className="rounded-lg border bg-card p-4 space-y-3">
                    {/* Header */}
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <Scan className="h-4 w-4 text-blue-500" />
                            <span className="text-sm font-semibold">
                                Timeline {timelineName && `"${timelineName}"`}
                            </span>
                            {scannedClips.length > 0 && (
                                <span className="text-[10px] bg-muted rounded-full px-1.5 py-0.5">
                                    {targetClipsCount} clips
                                </span>
                            )}
                        </div>
                        {/* Selector lọc Track */}
                        {availableTracks.length > 0 && (
                            <div className="flex items-center gap-1">
                                <span className="text-[10px] text-muted-foreground font-medium">Lọc Track:</span>
                                <select 
                                    className="text-[11px] p-1 rounded border bg-background"
                                    value={selectedTrackFilter}
                                    onChange={e => setSelectedTrackFilter(e.target.value)}
                                    disabled={isAnalyzing}
                                >
                                    <option value="all">Tất cả Track</option>
                                    {availableTracks.map(t => (
                                        <option key={t} value={t.toString()}>Track V{t}</option>
                                    ))}
                                </select>
                            </div>
                        )}
                    </div>

                    {/* Buttons: Scan + Analyze */}
                    <div className="flex items-center gap-2 flex-wrap">
                        {/* Nút Scan Timeline */}
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1 text-xs"
                            disabled={isScanning || isAnalyzing}
                            onClick={handleScanTimeline}
                        >
                            {isScanning ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Scan className="h-3.5 w-3.5" />
                            )}
                            {isScanning ? "Đang quét..." : "Quét Timeline"}
                        </Button>

                        {/* Nút Phân Tích AI */}
                        <Button
                            size="sm"
                            className="h-7 gap-1 text-xs bg-gradient-to-r from-purple-600 to-blue-600 text-white hover:from-purple-700 hover:to-blue-700"
                            disabled={refCount === 0 || scannedClips.length === 0 || isAnalyzing}
                            onClick={handleAnalyzeAll}
                        >
                            {isAnalyzing ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Zap className="h-3.5 w-3.5" />
                            )}
                            {isAnalyzing ? "Đang phân tích..." : "🎨 Phân Tích AI"}
                        </Button>

                        {/* Nút dừng */}
                        {isAnalyzing && (
                            <Button
                                size="sm"
                                variant="destructive"
                                className="h-7 text-xs"
                                onClick={handleStopAnalyze}
                            >
                                Dừng
                            </Button>
                        )}

                        {/* Checkbox: bỏ qua clip đã grade */}
                        <label className="flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer">
                            <input
                                type="checkbox"
                                checked={skipExistingGrades}
                                onChange={(e) => setSkipExistingGrades(e.target.checked)}
                                className="h-3 w-3"
                            />
                            Bỏ qua clip đã grade
                        </label>
                    </div>

                    {/* Progress bar */}
                    {analyzeProgress && (
                        <div className="space-y-1">
                            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                                <span>{analyzeProgress.message}</span>
                                <span>{analyzeProgress.current}/{analyzeProgress.total}</span>
                            </div>
                            <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-gradient-to-r from-purple-500 to-blue-500 rounded-full transition-all duration-300"
                                    style={{ width: `${(analyzeProgress.current / Math.max(1, analyzeProgress.total)) * 100}%` }}
                                />
                            </div>
                        </div>
                    )}

                    {/* Tooltip: cần direction trước đã bị xoá */}
                </div>

                {/* ======================== PHẦN 3: KẾT QUẢ ======================== */}
                {results.length > 0 && (
                    <div className="rounded-lg border bg-card p-4 space-y-3">
                        {/* Header kết quả */}
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <Wand2 className="h-4 w-4 text-green-500" />
                                <span className="text-sm font-semibold">Kết quả ({analyzedCount} clips)</span>
                                {errorCount > 0 && (
                                    <span className="text-[10px] bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-full px-1.5 py-0.5">
                                        {errorCount} lỗi
                                    </span>
                                )}
                            </div>

                            {/* Nút Apply All */}
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        size="sm"
                                        className="h-7 gap-1 text-xs bg-green-600 hover:bg-green-700 text-white"
                                        disabled={analyzedCount === 0 || isApplying}
                                        onClick={handleApplyAll}
                                    >
                                        {isApplying ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Play className="h-3.5 w-3.5" />
                                        )}
                                        {isApplying ? "Đang apply..." : `Apply ${analyzedCount} clips`}
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                    Tự động dịch 5 thông số Primaries sang CDL Math. Áp dụng chuẩn xác 100% bằng Data API. Không bao giờ lo lệch chuột!
                                </TooltipContent>
                            </Tooltip>
                        </div>

                        {/* Apply status */}
                        {applyStatus && !isApplying && (
                            <div className="text-xs text-muted-foreground bg-muted/50 rounded-md p-2">
                                {applyStatus}
                            </div>
                        )}

                        {/* Danh sách clips */}
                        <div className="space-y-1 max-h-[400px] overflow-y-auto">
                            {results.map((r, idx) => (
                                <ClipResultRow
                                    key={idx}
                                    index={idx}
                                    result={r}
                                    isExpanded={expandedClip === idx}
                                    isCopied={copiedIndex === idx}
                                    onToggle={() => setExpandedClip(expandedClip === idx ? null : idx)}
                                    onCopy={() => handleCopyClip(idx, r.primaries)}
                                />
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}


// ======================== SUB-COMPONENT: Clip Result Row ========================

interface ClipResultRowProps {
    index: number;
    result: AutoColorResult;
    isExpanded: boolean;
    isCopied: boolean;
    onToggle: () => void;
    onCopy: () => void;
}

function ClipResultRow({ result, isExpanded, isCopied, onToggle, onCopy }: ClipResultRowProps) {
    const { clip, analysis, primaries, status, reason } = result;

    // Badge style theo status
    const statusBadge = {
        analyzed: "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400",
        skipped:  "bg-gray-100 dark:bg-gray-800 text-gray-500",
        error:    "bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400",
    }[status];

    const statusLabel = {
        analyzed: "✅",
        skipped:  "⏭️ skip",
        error:    "❌ lỗi",
    }[status];

    return (
        <div className="rounded-md border bg-card/50 hover:bg-muted/30 transition-colors">
            {/* Header row — luôn hiện */}
            <div
                className="flex items-center gap-2 px-2 py-1.5 cursor-pointer"
                onClick={onToggle}
            >
                {/* Expand/collapse icon */}
                {status === "analyzed" ? (
                    isExpanded ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> 
                               : <ChevronDown className="h-3 w-3 text-muted-foreground" />
                ) : (
                    <div className="w-3" />
                )}

                {/* Tên clip + Tên Track */}
                <div className="flex flex-col truncate max-w-[150px] w-0 flex-1">
                    <span className="text-xs font-medium truncate">
                        {clip.name}
                    </span>
                    <span className="text-[9px] text-muted-foreground">
                        Track V{clip.trackIndex}
                    </span>
                </div>

                {/* Bucket label */}
                {analysis && (
                    <span className="text-[10px] text-muted-foreground shrink-0">
                        {BUCKET_LABELS[analysis.bucket] || analysis.bucket}
                    </span>
                )}

                {/* Status badge */}
                <span className={`text-[10px] rounded-full px-1.5 py-0.5 shrink-0 ${statusBadge}`}>
                    {statusLabel}
                </span>

                {/* Copy button */}
                {status === "analyzed" && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-5 w-5 shrink-0"
                                onClick={(e) => { e.stopPropagation(); onCopy(); }}
                            >
                                {isCopied ? (
                                    <Check className="h-3 w-3 text-green-500" />
                                ) : (
                                    <Copy className="h-3 w-3 text-muted-foreground" />
                                )}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent side="left">Copy 5 thông số</TooltipContent>
                    </Tooltip>
                )}
            </div>

            {/* Expanded detail — 5 thông số + diagnosis */}
            {isExpanded && status === "analyzed" && (
                <div className="px-3 pb-2 space-y-1.5 border-t border-muted/30 pt-1.5">
                    {/* Diagnosis */}
                    {analysis?.diagnosis && (
                        <p className="text-[10px] text-muted-foreground italic">
                            💬 {analysis.diagnosis}
                        </p>
                    )}

                    {/* 5 thông số */}
                    <div className="grid grid-cols-5 gap-1">
                        <PrimariesBadge label="Contrast" value={primaries.contrast} neutral={1.0} />
                        <PrimariesBadge label="Pivot"    value={primaries.pivot}    neutral={0.5} />
                        <PrimariesBadge label="Sat"      value={primaries.saturation} neutral={50} />
                        <PrimariesBadge label="Lift"     value={primaries.lift_master} neutral={0.0} />
                        <PrimariesBadge label="Gain"     value={primaries.gain_master} neutral={1.0} />
                    </div>

                    {/* Confidence */}
                    {analysis?.confidence && (
                        <div className="text-[10px] text-muted-foreground">
                            Confidence: {analysis.confidence}
                            {analysis.touch_rgb && " | ⚠️ Cần đụng RGB (hiếm)"}
                        </div>
                    )}
                </div>
            )}

            {/* Error/skip reason */}
            {status !== "analyzed" && reason && (
                <div className="px-3 pb-1.5 text-[10px] text-muted-foreground">
                    {reason}
                </div>
            )}
        </div>
    );
}


// ======================== SUB-COMPONENT: Primaries Badge ========================

function PrimariesBadge({ label, value, neutral }: { label: string; value: number; neutral: number }) {
    // Hiện giá trị + highlight nếu khác neutral đáng kể
    const diff = Math.abs(value - neutral);
    const isSignificant = diff > (label === "Sat" ? 3 : 0.01);

    // Format giá trị
    const formatted = label === "Sat" ? value.toFixed(0) : value.toFixed(3);

    return (
        <div className={`text-center rounded px-1 py-0.5 ${
            isSignificant 
                ? "bg-purple-50/20 border border-purple-500/20" 
                : "bg-muted/30"
        }`}>
            <div className="text-[9px] text-muted-foreground">{label}</div>
            <div className={`text-[11px] font-mono font-medium ${
                isSignificant ? "text-purple-600 dark:text-purple-400" : "text-foreground/70"
            }`}>
                {formatted}
            </div>
        </div>
    );
}
