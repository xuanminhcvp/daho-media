// ============================================================
// auto-color-prompt.ts — Prompt 2-phase cho Auto Color V2
//
// THIẾT KẾ MỚI:
//   Phase A: 4 ảnh reference → AI rút ra "Color Direction" tổng thể
//   Phase B: 1 frame clip + direction → AI trả 5 thông số Primaries
//
// Chỉ dùng 5 control DaVinci Primaries - Color Wheels:
//   Contrast, Pivot, Saturation, Lift Master, Gain Master
//
// Triết lý: chỉnh nhẹ, giữ tự nhiên, giữ mood gốc, tăng liền mạch
// ============================================================


// ======================== TYPES ========================

/** 5 thông số Primaries — output cuối cùng cho mỗi clip */
export interface PrimariesValues {
    contrast: number;     // 0.90 → 1.08
    pivot: number;        // 0.45 → 0.55
    saturation: number;   // 35 → 60
    lift_master: number;  // -0.03 → +0.03
    gain_master: number;  // 0.92 → 1.05
}

/** Kết quả phân tích 1 frame — tự động từ Gemini Vision */
export interface FrameAnalysisResult {
    /** Phân loại cảnh thuộc bucket nào */
    bucket: "indoor_bright" | "indoor_dark" | "outdoor_bright" | "outdoor_dark" | "mixed";
    /** Chẩn đoán chi tiết (2-4 câu, dễ hiểu) */
    diagnosis: string;
    /** 5 thông số Primaries cần chỉnh */
    adjustment: PrimariesValues;
    /** Có cần đụng RGB riêng không (mặc định false) */
    touch_rgb: boolean;
    /** Độ tin cậy: high | medium | low */
    confidence: "high" | "medium" | "low";
}

/** Session memory — lưu lịch sử để giữ liền mạch */
export interface ColorSession {
    /** Số lượng cảnh đã phân tích */
    total_analyzed: number;
    /** 5 cảnh gần nhất (cho AI so sánh) */
    recent_shots: Array<{
        clip_name: string;
        bucket: string;
        adjustment: PrimariesValues;
    }>;
}


// ======================== HARD LIMITS ========================
// Giới hạn an toàn — AI không được trả ngoài khoảng này

export const PRIMARIES_LIMITS = {
    contrast:    { min: 0.85, max: 1.15, neutral: 1.00 },
    pivot:       { min: 0.35, max: 0.55, neutral: 0.435 },
    saturation:  { min: 30,   max: 60,   neutral: 40 },
    lift_master: { min: -0.05, max: 0.05, neutral: 0.00 },
    gain_master: { min: 0.85, max: 1.15, neutral: 1.00 },
} as const;

/** Giá trị Primaries mặc định (không chỉnh gì) */
export const DEFAULT_PRIMARIES: PrimariesValues = {
    contrast:    1.00,
    pivot:       0.435,
    saturation:  40,
    lift_master: 0.00,
    gain_master: 1.00,
};


// ======================== VALIDATOR ========================

/**
 * Validate + clamp output AI về khoảng an toàn
 * Nếu AI trả giá trị ngoài giới hạn → kéo về min/max
 * Nếu thiếu field → dùng giá trị neutral
 */
export function validatePrimariesOutput(raw: any): PrimariesValues {
    if (!raw || typeof raw !== "object") return { ...DEFAULT_PRIMARIES };

    const clamp = (v: number, min: number, max: number, fallback: number): number => {
        const num = Number(v);
        if (isNaN(num)) return fallback;
        return Math.max(min, Math.min(max, num));
    };

    return {
        contrast: clamp(
            raw.contrast,
            PRIMARIES_LIMITS.contrast.min,
            PRIMARIES_LIMITS.contrast.max,
            PRIMARIES_LIMITS.contrast.neutral
        ),
        pivot: clamp(
            raw.pivot,
            PRIMARIES_LIMITS.pivot.min,
            PRIMARIES_LIMITS.pivot.max,
            PRIMARIES_LIMITS.pivot.neutral
        ),
        saturation: clamp(
            raw.saturation,
            PRIMARIES_LIMITS.saturation.min,
            PRIMARIES_LIMITS.saturation.max,
            PRIMARIES_LIMITS.saturation.neutral
        ),
        lift_master: clamp(
            raw.lift_master,
            PRIMARIES_LIMITS.lift_master.min,
            PRIMARIES_LIMITS.lift_master.max,
            PRIMARIES_LIMITS.lift_master.neutral
        ),
        gain_master: clamp(
            raw.gain_master,
            PRIMARIES_LIMITS.gain_master.min,
            PRIMARIES_LIMITS.gain_master.max,
            PRIMARIES_LIMITS.gain_master.neutral
        ),
    };
}

/**
 * Validate kết quả phân tích 1 frame từ AI
 * Parse JSON → clamp Primaries → trả FrameAnalysisResult chuẩn
 */
export function validateFrameResult(raw: any): FrameAnalysisResult {
    const validBuckets = ["indoor_bright", "indoor_dark", "outdoor_bright", "outdoor_dark", "mixed"];
    const bucket = validBuckets.includes(raw?.bucket) ? raw.bucket : "mixed";
    const diagnosis = typeof raw?.diagnosis === "string" ? raw.diagnosis.slice(0, 200) : "Không có chẩn đoán";
    const confidence = ["high", "medium", "low"].includes(raw?.confidence) ? raw.confidence : "medium";

    return {
        bucket,
        diagnosis,
        adjustment: validatePrimariesOutput(raw?.adjustment),
        touch_rgb: raw?.touch_rgb === true ? true : false,
        confidence,
    };
}


// ======================== PROMPT ANALYSIS ========================

/**
 * Build prompt phân tích thẳng 1 frame clip bằng cách so sánh TRỰC TIẾP với 4 ảnh Reference
 *
 * @param recentShots - Lịch sử 3-5 cảnh gần nhất (giữ liền mạch)
 * @param clipName - Tên clip đang phân tích
 */
export function buildFrameAnalysisPrompt(
    recentShots: Array<{ clip_name: string; bucket: string; adjustment: PrimariesValues }>,
    clipName?: string
): string {
    // Format lịch sử cảnh trước (nếu có)
    let recentContext = "";
    if (recentShots.length > 0) {
        recentContext = `\n\nLịch sử các cảnh gần nhất (để giữ liền mạch tone):\n`;
        for (const shot of recentShots.slice(-5)) {
            recentContext += `- ${shot.clip_name} [${shot.bucket}]: ` +
                `Contrast=${shot.adjustment.contrast}, Pivot=${shot.adjustment.pivot}, ` +
                `Sat=${shot.adjustment.saturation}, Lift=${shot.adjustment.lift_master}, ` +
                `Gain=${shot.adjustment.gain_master}\n`;
        }
    }

    return `Bạn là trợ lý phân tích màu cho DaVinci Resolve.

*LƯU Ý CỰC QUAN TRỌNG VỀ HÌNH ẢNH ĐÍNH KÈM*:
Bạn đang được cung cấp đồng thời nhiều hình ảnh trong yêu cầu này.
- NHỮNG ẢNH ĐẦU TIÊN (Ảnh 1 đến Ảnh 4) là các ẢNH REFERENCE gốc, mang tinh thần màu mong muốn.
- ẢNH CUỐI CÙNG (một ảnh duy nhất) là ẢNH TARGET của Clip "${clipName || "clip"}".

Nhiệm vụ:
1. Hãy quan sát nhanh 4 Ảnh Reference để NẮM BẮT TRỰC QUAN không khí, mood, độ đậm nhạt, độ tương phản chung.
2. NHÌN VÀO Ảnh Target cuối cùng.
3. So sánh trực tiếp mắt thường giữa Ảnh Target và 4 Ảnh Reference.
4. Điều chỉnh 5 thông số Primaries để Ảnh Target hoà nhập về mặt CẢM GIÁC THỊ GIÁC với 4 ảnh Reference.
${recentContext}

NGUYÊN TẮC BẮT BUỘC:
- Không cố ép mọi cảnh giống hệt nhau về ánh sáng nhưng màu sắc phải ĐỒNG NHẤT.
- Giữ đúng logic ánh sáng riêng của từng cảnh (trong nhà, ngoài trời, sáng, tối).
- BẠN PHẢI MẠNH TAY HƠN để Ảnh Target thực sự hòa quyện và khớp với 4 Ảnh Reference.
- ĐỪNG sợ thay đổi. Áp dụng các thay đổi rõ rệt để tái tạo đúng tinh thần màu, độ lóa, độ tối của Reference.
- Ưu tiên: Đồng bộ hoàn toàn tính thẩm mỹ (Aesthetic Match). Khớp càng sát các ảnh Reference càng tốt.

CHỈ ĐƯỢC DÙNG 5 CONTROL:
- Contrast (0.85 đến 1.15)
- Pivot (0.35 đến 0.55) -> Mức trung tính (không đổi) là 0.435
- Saturation (30 đến 60) -> Mức trung tính (không đổi) là 40
- Lift Master (-0.05 đến +0.05)
- Gain Master (0.85 đến 1.15)

KHÔNG đụng RGB riêng. touch_rgb luôn false.

Nếu cảnh đã gần direction chung → chỉ thay đổi rất nhẹ hoặc trả về mốc trung tính (Sat 40, Pivot 0.435).
Nếu cảnh có độ sai lệch lớn so với Reference → MẠNH DẠN thay đổi các thông số (kéo Lift, Gain, Contrast) để dồn nó về đúng tinh thần ảnh mẫu.

Khi nhận cảnh mới, ngoài so với reference, hãy còn ngầm so với những cảnh trước đó (trong lịch sử ở trên) để giữ tone tổng thể đồng bộ.

Diagnosis phải cực ngắn, dễ hiểu, dùng từ như: bớt gắt, bớt đậm, mềm hơn, lạnh hơn nhẹ, vùng tối bớt nặng, vùng sáng bớt chói.

Trả về đúng JSON format, KHÔNG thêm text ngoài:

{
  "bucket": "indoor_bright | indoor_dark | outdoor_bright | outdoor_dark | mixed",
  "diagnosis": "chẩn đoán cực ngắn (tiếng Việt)",
  "adjustment": {
    "contrast": 1.00,
    "pivot": 0.435,
    "saturation": 40,
    "lift_master": 0.00,
    "gain_master": 1.00
  },
  "touch_rgb": false,
  "confidence": "high | medium | low"
}`;
}


// ======================== BACKWARD COMPAT ========================
// Giữ exports cũ để code khác không bị lỗi khi import

/** CDL mặc định (backward compat — code cũ vẫn import) */
export const DEFAULT_CDL = {
    slope:      [1.0, 1.0, 1.0] as [number, number, number],
    offset:     [0.0, 0.0, 0.0] as [number, number, number],
    power:      [1.0, 1.0, 1.0] as [number, number, number],
    saturation: 1.0,
};

/** Kiểu CDLData (backward compat) */
export interface CDLData {
    slope:      [number, number, number];
    offset:     [number, number, number];
    power:      [number, number, number];
    saturation: number;
}

/** Alias backward compat — code cũ dùng GeminiColorAnalysis */
export type GeminiColorAnalysis = FrameAnalysisResult;
export type GeminiSemanticAnalysis = FrameAnalysisResult;

/** Danh sách 10 preset tông màu (backward compat — UI tab cũ import) */
export const COLOR_PRESETS = [
    { id: "neutral_clean",          label: "🎯 Neutral Clean",          description: "Trung tính, chỉ sửa lỗi kỹ thuật" },
    { id: "warm_documentary",       label: "🌅 Warm Documentary",       description: "Tông ấm vàng cam — phim tài liệu" },
    { id: "cool_thriller",          label: "🌊 Cool Thriller",           description: "Tông lạnh xanh dương — kịch tính" },
    { id: "cinematic_teal_orange",  label: "🎬 Teal & Orange",           description: "Hollywood blockbuster" },
    { id: "soft_pastel",            label: "🌸 Soft Pastel",             description: "Nhẹ nhàng, giảm contrast — lifestyle" },
    { id: "dark_moody",             label: "🌑 Dark Moody",              description: "Tối, contrast cao, shadow sâu" },
    { id: "vintage_film",           label: "📷 Vintage Film",            description: "Retro, fade highlight, tông ấm" },
    { id: "bright_commercial",      label: "💡 Bright Commercial",       description: "Sáng rõ, sắc nét — quảng cáo" },
    { id: "golden_hour",            label: "🌇 Golden Hour",             description: "Ánh hoàng hôn vàng ấm" },
    { id: "surveillance_gritty",    label: "📹 Surveillance Gritty",     description: "CCTV, gritty, giảm sat" },
] as const;

/** Stub backward compat — code cũ gọi buildCDLFromSemantics */
export function buildCDLFromSemantics(_analysis: any): CDLData {
    return { ...DEFAULT_CDL };
}

/** Stub backward compat — code cũ gọi buildAutoColorPrompt */
export function buildAutoColorPrompt(_presetName?: string, _clipName?: string): string {
    return buildFrameAnalysisPrompt([], _clipName);
}
