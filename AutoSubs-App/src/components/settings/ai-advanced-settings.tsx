// ai-advanced-settings.tsx
// Panel cấu hình Hiệu Năng AI nâng cao
// 4 tham số: Temperature, Concurrency, Footage Batch, B-Roll Start
// Lưu qua SettingsContext → Tauri Store (persist tự động)

import * as React from "react"
import { Settings2, Cpu, Film, Thermometer, Clock, RotateCcw, ChevronRight, Type, AlertTriangle, FileVideo, FileImage, Volume2, Image as ImageIcon } from "lucide-react"
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { useSettings } from "@/contexts/SettingsContext"

// ======================== BOUNDS & META ========================
/** Giới hạn + màu sắc cảnh báo cho từng tham số */
const PARAM_META = {
    aiTemperature: {
        min: 0.0, max: 1.0, step: 0.05, decimals: 2,
        // Màu fill gradient theo mức nguy hiểm (thấp = xanh, cao = cam)
        colorLow: "from-blue-500/70 to-blue-400",
        colorHigh: "from-amber-500/70 to-amber-400",
        dangerThreshold: 0.85, // từ đây trở lên → dùng màu cảnh báo
    },
    aiMaxConcurrency: {
        min: 1, max: 10, step: 1, decimals: 0,
        colorLow: "from-green-500/70 to-green-400",
        colorHigh: "from-amber-500/70 to-amber-400",
        dangerThreshold: 8, // > 8 luồng → dễ bị 429
    },
    aiAudioBatches: {
        min: 1, max: 10, step: 1, decimals: 0,
        colorLow: "from-indigo-500/70 to-indigo-400",
        colorHigh: "from-rose-500/70 to-rose-400",
        dangerThreshold: 6, // Chia nhiều đợt dễ tốn token và rời rạc cảm xúc
    },
    aiMediaImportBatches: {
        min: 1, max: 8, step: 1, decimals: 0,
        colorLow: "from-violet-500/70 to-violet-400",
        colorHigh: "from-rose-500/70 to-rose-400",
        dangerThreshold: 5, // Nhiều batch → 429, concurrency cần đủ slot
    },
    aiBatchOverlapRatio: {
        min: 0.0, max: 0.5, step: 0.05, decimals: 2,
        colorLow: "from-stone-500/70 to-stone-400",
        colorHigh: "from-slate-500/70 to-slate-400",
        dangerThreshold: 0.4, // Overlap quá lớn → trùng lặp text nhiều
    },
    aiFootageBatches: {
        min: 1, max: 10, step: 1, decimals: 0,
        colorLow: "from-purple-500/70 to-purple-400",
        colorHigh: "from-orange-500/70 to-orange-400",
        dangerThreshold: 6, // Nhiều batch dễ mất tính liền mạch b-roll
    },
    aiMasterSrtBatches: {
        min: 1, max: 12, step: 1, decimals: 0,
        colorLow: "from-cyan-500/70 to-cyan-400",
        colorHigh: "from-rose-500/70 to-rose-400",
        dangerThreshold: 8, // Quá nhiều batch → AI mất context, giảm chất lượng
    },
    aiImageImportBatches: {
        min: 1, max: 8, step: 1, decimals: 0,
        colorLow: "from-pink-500/70 to-pink-400",
        colorHigh: "from-rose-500/70 to-rose-400",
        dangerThreshold: 4, 
    },
    aiSfxBatches: {
        min: 1, max: 10, step: 1, decimals: 0,
        colorLow: "from-blue-500/70 to-blue-400",
        colorHigh: "from-red-500/70 to-red-400",
        dangerThreshold: 6, 
    },
    aiTextOnScreenBatches: {
        min: 1, max: 10, step: 1, decimals: 0,
        colorLow: "from-emerald-500/70 to-emerald-400",
        colorHigh: "from-yellow-500/70 to-yellow-400",
        dangerThreshold: 6, 
    },
    aiSubtitleBatches: {
        min: 1, max: 10, step: 1, decimals: 0,
        colorLow: "from-blue-500/70 to-blue-400",
        colorHigh: "from-rose-500/70 to-rose-400",
        dangerThreshold: 6, 
    },
    aiRefImageBatches: {
        min: 1, max: 10, step: 1, decimals: 0,
        colorLow: "from-fuchsia-500/70 to-fuchsia-400",
        colorHigh: "from-rose-500/70 to-rose-400",
        dangerThreshold: 6, 
    },
    bRollStartTime: {
        min: 0, max: 300, step: 5, decimals: 0,
        colorLow: "from-sky-500/70 to-sky-400",
        colorHigh: "from-sky-500/70 to-sky-400",
        dangerThreshold: 999,
    },
    aiMaxRetries: {
        min: 0, max: 10, step: 1, decimals: 0,
        colorLow: "from-teal-500/70 to-teal-400",
        colorHigh: "from-yellow-500/70 to-yellow-400",
        dangerThreshold: 5, // retry nhiều dễ tốn tiền và lâu
    },
    aiTotalSfxCues: {
        min: 0, max: 100, step: 1, decimals: 0,
        colorLow: "from-emerald-500/70 to-emerald-400",
        colorHigh: "from-orange-500/70 to-orange-400",
        dangerThreshold: 60,
    },
    aiTotalFootageClips: {
        min: 0, max: 100, step: 1, decimals: 0,
        colorLow: "from-pink-500/70 to-pink-400",
        colorHigh: "from-orange-500/70 to-orange-400",
        dangerThreshold: 60,
    },
} as const;

type SettingKey = keyof typeof PARAM_META;

/** Giá trị mặc định để nút Reset */
const DEFAULTS: Record<SettingKey, number> = {
    aiTemperature: 0.7,
    aiMaxConcurrency: 6,
    aiAudioBatches: 1,
    aiMediaImportBatches: 4,   // 4 batch để match script với Whisper (Video Import tab)
    aiBatchOverlapRatio: 0.15, // 15% overlap
    aiFootageBatches: 1,
    aiMasterSrtBatches: 4,   // 4 batch Whisper → 4 request AI song song
    bRollStartTime: 60,
    aiMaxRetries: 3,
    aiImageImportBatches: 4,
    aiSfxBatches: 1,
    aiTextOnScreenBatches: 1,
    aiRefImageBatches: 1,
    aiSubtitleBatches: 5,
    aiTotalSfxCues: 10,
    aiTotalFootageClips: 10,
};

// ======================== PARAM ROW ========================
interface ParamRowProps {
    icon: React.ReactNode
    label: string
    desc: string
    settingKey: SettingKey
    value: number
    onChange: (key: SettingKey, val: number) => void
    unit?: string
    warningMsg?: string
}

function ParamRow({ icon, label, desc, settingKey, value, onChange, unit = "", warningMsg }: ParamRowProps) {
    const meta = PARAM_META[settingKey];
    const isDanger = value >= meta.dangerThreshold;

    // Local string state → cho phép gõ tự do mà không bị React clamp giữa chừng
    const fmt = (v: number) => meta.decimals > 0 ? v.toFixed(meta.decimals) : String(v);
    const [localStr, setLocalStr] = React.useState(fmt(value));

    // Sync khi value bên ngoài thay đổi (Reset, load settings)
    React.useEffect(() => {
        setLocalStr(fmt(value));
    }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

    /** Xác nhận giá trị: clamp vào [min, max] rồi gọi onChange */
    const commit = (raw: string) => {
        const num = parseFloat(raw);
        if (!isNaN(num)) {
            const clamped = Math.max(meta.min, Math.min(meta.max, num));
            const final = parseFloat(clamped.toFixed(meta.decimals));
            setLocalStr(fmt(final));
            onChange(settingKey, final);
        } else {
            // Revert về giá trị hợp lệ nếu gõ linh tinh
            setLocalStr(fmt(value));
        }
    };

    return (
        <div className="py-2.5 border-b border-border/25 last:border-0 group">
            {/* Row 1: Icon + Label + Input số */}
            <div className="flex items-start gap-2 mb-1.5">
                {/* Icon với màu dynamic */}
                <span className={`mt-0.5 shrink-0 ${isDanger ? "text-amber-400" : "text-muted-foreground"} transition-colors`}>
                    {icon}
                </span>

                {/* Label + mô tả nhỏ */}
                <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-foreground leading-tight">{label}</div>
                    <div className="text-[9px] text-muted-foreground/70 mt-0.5">{desc}</div>
                </div>

                {/* Input số + unit */}
                <div className="flex items-center gap-1 shrink-0">
                    <input
                        type="number"
                        value={localStr}
                        min={meta.min}
                        max={meta.max}
                        step={meta.step}
                        onChange={(e) => setLocalStr(e.target.value)}         // gõ tự do
                        onBlur={(e) => commit(e.target.value)}                // commit khi rời ô
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
                        }}
                        className={`
                            w-14 text-right text-xs font-mono px-1.5 py-0.5 rounded
                            border transition-colors duration-150
                            focus:outline-none focus:ring-1 focus:ring-primary/50
                            [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none
                            [&::-webkit-inner-spin-button]:appearance-none
                            ${isDanger
                                ? "bg-amber-500/10 border-amber-500/40 text-amber-300"
                                : "bg-muted/60 border-border/40 text-foreground"
                            }
                        `}
                    />
                    {unit && (
                        <span className={`text-[9px] ${isDanger ? "text-amber-400/80" : "text-muted-foreground"}`}>
                            {unit}
                        </span>
                    )}
                </div>
            </div>

            {/* Chỉ hiện cảnh báo khi vượt ngưỡng */}
            {isDanger && warningMsg && (
                <div className="mt-0.5 text-[9px] text-amber-400/80 font-medium animate-pulse">
                    ⚠ {warningMsg}
                </div>
            )}

        </div>
    );
}


// ======================== MAIN COMPONENT ========================

export function AiAdvancedSettings() {
    const { settings, updateSetting } = useSettings();
    const [open, setOpen] = React.useState(false);

    /** Cập nhật setting — SettingsContext tự persist vào Tauri Store */
    const handleChange = (key: SettingKey, val: number) => {
        updateSetting(key, val);
    };

    /** Reset tất cả về mặc định */
    const handleReset = () => {
        (Object.keys(DEFAULTS) as SettingKey[]).forEach(key => {
            updateSetting(key, DEFAULTS[key]);
        });
    };

    // Đếm số tham số đang không mặc định (để badge cảnh báo)
    const changedCount = (Object.keys(DEFAULTS) as SettingKey[]).filter(
        k => settings[k] !== DEFAULTS[k]
    ).length;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                {/* Nút mở panel trên Titlebar */}
                <Button
                    id="ai-advanced-settings-btn"
                    variant="ghost"
                    size="sm"
                    className={`
                        relative h-7 px-2 gap-1.5 text-xs transition-all duration-200
                        ${open ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"}
                    `}
                    title="Cấu hình Hiệu Năng AI Nâng cao"
                >
                    <Settings2 className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">AI Config</span>
                    {/* Badge số tham số đã thay đổi */}
                    {changedCount > 0 && (
                        <span className="absolute -top-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-primary text-[8px] font-bold text-primary-foreground flex items-center justify-center leading-none">
                            {changedCount}
                        </span>
                    )}
                </Button>
            </PopoverTrigger>

            <PopoverContent
                side="bottom"
                align="end"
                sideOffset={4}
                className="w-[280px] p-0 shadow-xl border border-border/60 bg-card overflow-hidden max-h-[85vh] overflow-y-auto"
            >
                {/* ── Header ─────────────────────────────── */}
                <div className="px-3 py-2.5 border-b border-border/50 bg-gradient-to-r from-primary/5 to-transparent flex items-center gap-2">
                    <Cpu className="h-3.5 w-3.5 text-primary shrink-0" />
                    <div className="flex-1">
                        <div className="text-xs font-bold text-foreground">Hiệu Năng AI</div>
                        <div className="text-[9px] text-muted-foreground">Áp dụng lần call AI tiếp theo</div>
                    </div>
                    {/* Nút Reset về mặc định */}
                    {changedCount > 0 && (
                        <button
                            onClick={handleReset}
                            title="Reset về mặc định"
                            className="
                                flex items-center gap-1 text-[9px] text-muted-foreground
                                hover:text-foreground px-1.5 py-1 rounded hover:bg-muted/60
                                transition-colors cursor-pointer
                            "
                        >
                            <RotateCcw className="h-2.5 w-2.5" />
                            Reset
                        </button>
                    )}
                </div>

                {/* ── SECTION: Chung ──────────────────────── */}
                <div className="px-3 pt-2.5 pb-0.5">
                    <div className="flex items-center gap-1.5 mb-1">
                        <div className="h-px flex-1 bg-border/40" />
                        <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/50">
                            Chung
                        </span>
                        <div className="h-px flex-1 bg-border/40" />
                    </div>

                    {/* Temperature */}
                    <ParamRow
                        icon={<Thermometer className="h-3 w-3" />}
                        label="Nhiệt độ AI"
                        desc="Thấp = chặt chẽ, chuẩn xác | Cao = sáng tạo, biến tấu"
                        settingKey="aiTemperature"
                        value={settings.aiTemperature}
                        onChange={handleChange}
                        warningMsg="Rất sáng tạo, kém chính xác"
                    />

                    {/* Max Retries */}
                    <ParamRow
                        icon={<AlertTriangle className="h-3 w-3" />}
                        label="Số lần thử lại API"
                        desc="Tự động gọi lại khi API lỗi hoặc bị Rate Limit"
                        settingKey="aiMaxRetries"
                        value={settings.aiMaxRetries}
                        onChange={handleChange}
                        unit=" lần"
                        warningMsg="Retry nhiều → chậm app"
                    />
                </div>

                {/* ── SECTION: Hiệu suất ──────────────────── */}
                <div className="px-3 pt-2 pb-0.5">
                    <div className="flex items-center gap-1.5 mb-1">
                        <div className="h-px flex-1 bg-border/40" />
                        <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/50">
                            Hiệu suất
                        </span>
                        <div className="h-px flex-1 bg-border/40" />
                    </div>

                    {/* Max Concurrency — GLOBAL, ảnh hưởng tất cả tính năng */}
                    <ParamRow
                        icon={<Cpu className="h-3 w-3" />}
                        label="Luồng song song"
                        desc="Giới hạn chung cho tất cả tính năng AI — ảnh hưởng Master SRT, Footage, Audio"
                        settingKey="aiMaxConcurrency"
                        value={settings.aiMaxConcurrency}
                        onChange={handleChange}
                        unit=" luồng"
                        warningMsg="Dễ bị 429 Rate Limit!"
                    />
                    <ParamRow
                        icon={<RotateCcw className="h-3 w-3" />}
                        label="Batch Overlap (Chống trượt)"
                        desc="Tỷ lệ chồng lấn vùng văn bản giữa 2 batch kề nhau (tránh AI mất ngữ cảnh ở biên)"
                        settingKey="aiBatchOverlapRatio"
                        value={settings.aiBatchOverlapRatio}
                        onChange={handleChange}
                        unit=""
                        warningMsg="Quá cao → AI có thể match trùng lặp"
                    />
                </div>

                {/* ── SECTION: Mật độ (Density) ───────────── */}
                <div className="px-3 pt-2 pb-0.5">
                    <div className="flex items-center gap-1.5 mb-1">
                        <div className="h-px flex-1 bg-border/40" />
                        <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/50">
                            Mật độ (Hiệu ứng / Chèn)
                        </span>
                        <div className="h-px flex-1 bg-border/40" />
                    </div>

                    <ParamRow
                        icon={<Film className="h-3 w-3" />}
                        label="Tổng Footage toàn video"
                        desc="Mật độ chèn B-Roll (VD: 10 là sẽ chia đều 10 clip rải rác)"
                        settingKey="aiTotalFootageClips"
                        value={settings.aiTotalFootageClips}
                        onChange={handleChange}
                        unit=" clip"
                        warningMsg="Nhiều → chớp mắt liên tục!"
                    />

                    <ParamRow
                        icon={<Volume2 className="h-3 w-3" />}
                        label="Tổng SFX toàn video"
                        desc="Mật độ chèn tiếng động (VD: 10 là chia đều 10 SFX vào video)"
                        settingKey="aiTotalSfxCues"
                        value={settings.aiTotalSfxCues}
                        onChange={handleChange}
                        unit=" SFX"
                        warningMsg="Nhiều → rất nhức đầu"
                    />
                </div>

                {/* ── SECTION: Batch theo tính năng ───────── */}
                <div className="px-3 pt-2 pb-2">
                    <div className="flex items-center gap-1.5 mb-1">
                        <div className="h-px flex-1 bg-border/40" />
                        <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/50">
                            Batch theo tính năng
                        </span>
                        <div className="h-px flex-1 bg-border/40" />
                    </div>
                    <p className="text-[9px] text-muted-foreground/50 mb-2 leading-relaxed">
                        Số batch ≤ Luồng song song → chạy 1 đợt. Số batch &gt; Luồng song song → chạy nhiều đợt.
                    </p>

                    {/* Master SRT Batches */}
                    <ParamRow
                        icon={<Type className="h-3 w-3" />}
                        label="Master SRT"
                        desc="Chia Whisper transcript → N batch AI (căn chỉnh timestamp lời thoại)"
                        settingKey="aiMasterSrtBatches"
                        value={settings.aiMasterSrtBatches}
                        onChange={handleChange}
                        unit=" batch"
                        warningMsg="Quá nhiều: AI mất ngữ cảnh"
                    />

                    {/* Subtitle Match Batches */}
                    <ParamRow
                        icon={<Type className="h-3 w-3" />}
                        label="Phụ Đề (Subtitle Match)"
                        desc="Chia số đợt xử lý logic nối phụ đề"
                        settingKey="aiSubtitleBatches"
                        value={settings.aiSubtitleBatches}
                        onChange={handleChange}
                        unit=" batch"
                        warningMsg="Nhiều đợt dễ tốn API, chờ lâu"
                    />

                    {/* Video Import Batches */}
                    <ParamRow
                        icon={<FileVideo className="h-3 w-3" />}
                        label="Video Import"
                        desc="Số batch chia transcript khi bấm AI Match trong tab Video Import"
                        settingKey="aiMediaImportBatches"
                        value={settings.aiMediaImportBatches}
                        onChange={handleChange}
                        unit=" batch"
                        warningMsg="Nhiều batch → dễ bị 429 rate limit"
                    />


                    {/* Footage AI Batches */}
                    <ParamRow
                        icon={<Film className="h-3 w-3" />}
                        label="Footage AI"
                        desc="Số batch khi AI gợi ý B-roll trong tab Post-Production → Footage"
                        settingKey="aiFootageBatches"
                        value={settings.aiFootageBatches}
                        onChange={handleChange}
                        unit=" batch"
                        warningMsg="Nhiều batch → tốn thời gian"
                    />

                    {/* Audio Batches */}
                    <ParamRow
                        icon={<Volume2 className="h-3 w-3" />}
                        label="Audio Director"
                        desc="Chia nhỏ để AI tập trung phân tích cảm xúc từng đoạn cho nhạc nền"
                        settingKey="aiAudioBatches"
                        value={settings.aiAudioBatches}
                        onChange={handleChange}
                        unit=" batch"
                        warningMsg="Nhiều batch → đứt gãy cảm xúc nhạc"
                    />

                    {/* SFX Batches */}
                    <ParamRow
                        icon={<Volume2 className="h-3 w-3" />}
                        label="SFX Master"
                        desc="Chia nhỏ để AI tìm hiệu ứng âm thanh (SFX) chuẩn sát từng câu"
                        settingKey="aiSfxBatches"
                        value={settings.aiSfxBatches}
                        onChange={handleChange}
                        unit=" batch"
                        warningMsg="Nhiều batch → dễ vượt giới hạn API"
                    />

                    {/* Image Import Batches */}
                    <ParamRow
                        icon={<FileImage className="h-3 w-3" />}
                        label="Image Import"
                        desc="Chia nhỏ danh sách ảnh và script để AI map hình ảnh với câu nói"
                        settingKey="aiImageImportBatches"
                        value={settings.aiImageImportBatches}
                        onChange={handleChange}
                        unit=" batch"
                        warningMsg="Phân mảnh kịch bản → sai lệch context hình ảnh"
                    />

                    {/* Text On Screen Batches */}
                    <ParamRow
                        icon={<Type className="h-3 w-3" />}
                        label="Text On Screen"
                        desc="Chia transcript để AI trích xuất các từ khoá nổi bật gắn lên màn hình"
                        settingKey="aiTextOnScreenBatches"
                        value={settings.aiTextOnScreenBatches}
                        onChange={handleChange}
                        unit=" batch"
                        warningMsg="Chia quá nhiều → sót ý chính"
                    />

                    {/* Ref Image Batches */}
                    <ParamRow
                        icon={<ImageIcon className="h-3 w-3" />}
                        label="Ref Image"
                        desc="Chia đợt để AI đọc và vẽ prompt tạo ảnh tham chiếu (Midjourney)"
                        settingKey="aiRefImageBatches"
                        value={settings.aiRefImageBatches}
                        onChange={handleChange}
                        unit=" batch"
                        warningMsg="Nhiều batch → hao tốn tài nguyên"
                    />

                    {/* B-Roll Start Time */}
                    <ParamRow
                        icon={<Clock className="h-3 w-3" />}
                        label="Khóa B-Roll đầu video"
                        desc="AI không chèn footage trước mốc này (0s = TikTok style)"
                        settingKey="bRollStartTime"
                        value={settings.bRollStartTime}
                        onChange={handleChange}
                        unit="s"
                    />
                </div>


                {/* ── Footer ─────────────────────────────── */}
                <div className="flex items-center justify-between px-3 py-1.5 border-t border-border/25 bg-muted/10">
                    <p className="text-[9px] text-muted-foreground/60">
                        Lưu tự động • Không ảnh hưởng đến phiên hiện tại
                    </p>
                    <ChevronRight className="h-2.5 w-2.5 text-muted-foreground/30" />
                </div>
            </PopoverContent>
        </Popover>
    );
}
