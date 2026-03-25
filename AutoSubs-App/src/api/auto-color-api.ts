// ============================================================
// auto-color-api.ts — HTTP client gọi Python server Auto Color
// Gửi POST đến port 56003 → server.py route → auto_color.py
// ============================================================

import { fetch } from "@tauri-apps/plugin-http";

const resolveAPI = "http://127.0.0.1:56003/";

// ======================== TYPES ========================

/** Thông tin 1 clip trên timeline (trả về từ Python scan) */
export interface AutoColorClip {
    name: string;
    trackIndex: number;
    itemIndex: number;
    startFrame: number;
    endFrame: number;
    durationFrames: number;
    startSec: number;
    endSec: number;
    durationSec: number;
    mediaPath: string;
    type: string;             // video_clip | compound_clip | fusion_title | ...
    hasExistingGrade: boolean;
}

/** Kết quả scan timeline */
export interface AutoColorScanResult {
    clips: AutoColorClip[];
    totalClips: number;
    frameRate: number;
    timelineStart: number;
    timelineName: string;
    error?: boolean;
    message?: string;
}

/** CDL data gửi cho apply */
export interface CDLData {
    slope: [number, number, number];
    offset: [number, number, number];
    power: [number, number, number];
    saturation: number;
    nodeIndex?: number;
}

// ======================== API CALLS ========================

/**
 * Quét timeline — lấy danh sách clip có thể chỉnh màu
 * Python quét qua tất cả video tracks, skip fusion/generator/adjustment
 */
export async function autoColorScan(
    scope: "timeline" | "selected" = "timeline"
): Promise<AutoColorScanResult> {
    const requestBody = { func: "AutoColorScan", scope };
    const startMs = Date.now();
    console.log(`[AutoColor API] 📤 REQUEST autoColorScan`, JSON.stringify(requestBody, null, 2));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s
    try {
        const response = await fetch(resolveAPI, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        });
        clearTimeout(timeout);
        const elapsed = Date.now() - startMs;

        // Đọc raw text trước để log, rồi parse JSON
        const rawText = await response.text();
        console.log(`[AutoColor API] 📥 RESPONSE autoColorScan (${elapsed}ms, HTTP ${response.status})`);
        console.log(`[AutoColor API]    Raw body:`, rawText.slice(0, 2000));

        let data: any;
        try {
            data = JSON.parse(rawText);
        } catch (parseErr) {
            console.error(`[AutoColor API] ❌ JSON parse lỗi! Raw:`, rawText.slice(0, 500));
            return { clips: [], totalClips: 0, frameRate: 24, timelineStart: 0, timelineName: "", error: true, message: `JSON parse error: ${rawText.slice(0, 200)}` };
        }

        // Validate format: phải có clips array
        if (!data.clips || !Array.isArray(data.clips)) {
            console.error(`[AutoColor API] ❌ Response THIẾU field 'clips'! Server có thể đang chạy bản CŨ.`);
            console.error(`[AutoColor API]    Nhận được:`, JSON.stringify(data, null, 2));
            return {
                clips: [], totalClips: 0, frameRate: 24, timelineStart: 0, timelineName: "",
                error: true,
                message: `Server Resolve trả sai format (thiếu clips). Response: ${JSON.stringify(data).slice(0, 200)}. Hãy chạy lại AutoSubs.py trong DaVinci Resolve.`,
            };
        }

        console.log(`[AutoColor API] ✅ Scan OK: ${data.clips.length} clips, timeline="${data.timelineName}", fps=${data.frameRate}`);
        return data as AutoColorScanResult;
    } catch (err: any) {
        clearTimeout(timeout);
        const elapsed = Date.now() - startMs;
        if (err.name === "AbortError") {
            console.error(`[AutoColor API] ⏱️ TIMEOUT autoColorScan sau ${elapsed}ms`);
            return { clips: [], totalClips: 0, frameRate: 24, timelineStart: 0, timelineName: "", error: true, message: "Timeout 30s — DaVinci Resolve không phản hồi" };
        }
        console.error(`[AutoColor API] ❌ NETWORK ERROR autoColorScan (${elapsed}ms):`, err);
        throw err;
    }
}

/**
 * Apply CDL correction vào 1 clip
 * @param trackIndex - Track video (1-based)
 * @param itemIndex - Clip index trong track (0-based)
 * @param cdl - CDL values: slope, offset, power, saturation
 */
export async function autoColorApplyCDL(
    trackIndex: number,
    itemIndex: number,
    cdl: CDLData
): Promise<{ success?: boolean; error?: boolean; message?: string }> {
    const requestBody = { func: "AutoColorApplyCDL", trackIndex, itemIndex, cdl };
    const startMs = Date.now();
    console.log(`[AutoColor API] 📤 REQUEST applyCDL track=${trackIndex} item=${itemIndex}`, JSON.stringify(cdl));

    const response = await fetch(resolveAPI, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
    });
    const rawText = await response.text();
    const elapsed = Date.now() - startMs;
    console.log(`[AutoColor API] 📥 RESPONSE applyCDL (${elapsed}ms, HTTP ${response.status}):`, rawText.slice(0, 500));

    try {
        return JSON.parse(rawText);
    } catch {
        console.error(`[AutoColor API] ❌ applyCDL JSON parse lỗi:`, rawText.slice(0, 300));
        return { error: true, message: `JSON parse error: ${rawText.slice(0, 200)}` };
    }
}

/**
 * Apply CDL cho nhiều clip cùng lúc
 * @param clips - Mảng { trackIndex, itemIndex, cdl }
 */
export async function autoColorApplyBatch(
    clips: Array<{ trackIndex: number; itemIndex: number; cdl: CDLData }>
): Promise<{
    results: Array<{ index: number; status: string; message?: string }>;
    applied: number;
    failed: number;
    skipped: number;
    total: number;
}> {
    const requestBody = { func: "AutoColorApplyBatch", clips };
    const startMs = Date.now();
    console.log(`[AutoColor API] 📤 REQUEST applyBatch (${clips.length} clips)`);

    const controller = new AbortController();
    // 120s timeout — batch có thể lâu
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
        const response = await fetch(resolveAPI, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        });
        clearTimeout(timeout);
        const rawText = await response.text();
        const elapsed = Date.now() - startMs;
        console.log(`[AutoColor API] 📥 RESPONSE applyBatch (${elapsed}ms, HTTP ${response.status}):`, rawText.slice(0, 1000));

        try {
            const data = JSON.parse(rawText);
            console.log(`[AutoColor API] ✅ Batch: applied=${data.applied}, failed=${data.failed}, skipped=${data.skipped}`);
            return data;
        } catch {
            console.error(`[AutoColor API] ❌ applyBatch JSON parse lỗi:`, rawText.slice(0, 500));
            return { results: [], applied: 0, failed: 0, skipped: 0, total: clips.length };
        }
    } catch (err: any) {
        clearTimeout(timeout);
        const elapsed = Date.now() - startMs;
        if (err.name === "AbortError") {
            console.error(`[AutoColor API] ⏱️ TIMEOUT applyBatch sau ${elapsed}ms`);
            return { results: [], applied: 0, failed: 0, skipped: 0, total: clips.length };
        }
        console.error(`[AutoColor API] ❌ NETWORK ERROR applyBatch (${elapsed}ms):`, err);
        throw err;
    }
}

/**
 * Backup timeline trước khi chỉnh màu
 * Duplicate thành "{name}_AUTOCOLOR_BACKUP"
 */
export async function autoColorBackup(): Promise<{
    success?: boolean;
    backupName?: string;
    error?: boolean;
    message?: string;
}> {
    const startMs = Date.now();
    console.log(`[AutoColor API] 📤 REQUEST backup`);
    const response = await fetch(resolveAPI, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ func: "AutoColorBackup" }),
    });
    const rawText = await response.text();
    const elapsed = Date.now() - startMs;
    console.log(`[AutoColor API] 📥 RESPONSE backup (${elapsed}ms):`, rawText.slice(0, 500));
    try {
        return JSON.parse(rawText);
    } catch {
        console.error(`[AutoColor API] ❌ backup JSON parse lỗi:`, rawText.slice(0, 300));
        return { error: true, message: `JSON parse error: ${rawText.slice(0, 200)}` };
    }
}

/**
 * Lấy thông tin clip tại playhead hiện tại
 * Dùng khi user muốn chọn clip đang xem làm reference
 */
export async function autoColorGetCurrentFrame(): Promise<{
    mediaPath?: string;
    clipName?: string;
    timecode?: string;
    trackIndex?: number;
    error?: boolean;
    message?: string;
}> {
    const startMs = Date.now();
    console.log(`[AutoColor API] 📤 REQUEST getCurrentFrame`);
    const response = await fetch(resolveAPI, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ func: "AutoColorGetCurrentFrame" }),
    });
    const rawText = await response.text();
    const elapsed = Date.now() - startMs;
    console.log(`[AutoColor API] 📥 RESPONSE getCurrentFrame (${elapsed}ms):`, rawText.slice(0, 500));
    try {
        return JSON.parse(rawText);
    } catch {
        console.error(`[AutoColor API] ❌ getCurrentFrame JSON parse lỗi:`, rawText.slice(0, 300));
        return { error: true, message: `JSON parse error: ${rawText.slice(0, 200)}` };
    }
}


// ======================== PRIMARIES UI AUTOMATION ========================
// Gửi 5 thông số Primaries → Python → UI automation apply vào DaVinci

/** Thông số Primaries gửi lên Python để apply */
export interface PrimariesApplyData {
    contrast: number;
    pivot: number;
    saturation: number;
    lift_master: number;
    gain_master: number;
}

/**
 * Apply 5 Primaries vào 1 clip qua UI automation
 * Python: chọn clip → chuyển Color page → AppleScript set giá trị
 *
 * @param trackIndex - Track video (1-based)
 * @param itemIndex - Clip index (0-based)
 * @param primaries - 5 thông số Primaries
 */
export async function autoColorApplyPrimaries(
    trackIndex: number,
    itemIndex: number,
    primaries: PrimariesApplyData
): Promise<{ success?: boolean; error?: boolean; message?: string }> {
    const requestBody = { func: "AutoColorApplyPrimaries", trackIndex, itemIndex, primaries };
    const startMs = Date.now();
    console.log(`[AutoColor API] 📤 REQUEST applyPrimaries track=${trackIndex} item=${itemIndex}`, JSON.stringify(primaries));

    const controller = new AbortController();
    // 30s timeout — UI automation mỗi clip ~3-5 giây
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
        const response = await fetch(resolveAPI, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        });
        clearTimeout(timeout);
        const rawText = await response.text();
        const elapsed = Date.now() - startMs;
        console.log(`[AutoColor API] 📥 RESPONSE applyPrimaries (${elapsed}ms, HTTP ${response.status}):`, rawText.slice(0, 500));

        try {
            return JSON.parse(rawText);
        } catch {
            console.error(`[AutoColor API] ❌ applyPrimaries JSON parse lỗi:`, rawText.slice(0, 300));
            return { error: true, message: `JSON parse error: ${rawText.slice(0, 200)}` };
        }
    } catch (err: any) {
        clearTimeout(timeout);
        if (err.name === "AbortError") {
            return { error: true, message: "Timeout 30s — UI automation không phản hồi" };
        }
        throw err;
    }
}

/**
 * Apply Primaries cho nhiều clip hàng loạt qua UI automation
 *
 * @param clips - Danh sách { trackIndex, itemIndex, primaries }
 */
export async function autoColorApplyPrimariesBatch(
    clips: Array<{ trackIndex: number; itemIndex: number; primaries: PrimariesApplyData }>
): Promise<{
    results: Array<{ index: number; status: string; message?: string }>;
    applied: number;
    failed: number;
    total: number;
}> {
    const requestBody = { func: "AutoColorApplyPrimariesBatch", clips };
    const startMs = Date.now();
    console.log(`[AutoColor API] 📤 REQUEST applyPrimariesBatch (${clips.length} clips)`);

    const controller = new AbortController();
    // 5 phút timeout — batch UI automation chạy lâu (mỗi clip ~3-5s)
    const timeout = setTimeout(() => controller.abort(), 300000);
    try {
        const response = await fetch(resolveAPI, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        });
        clearTimeout(timeout);
        const rawText = await response.text();
        const elapsed = Date.now() - startMs;
        console.log(`[AutoColor API] 📥 RESPONSE applyPrimariesBatch (${elapsed}ms):`, rawText.slice(0, 1000));

        try {
            const data = JSON.parse(rawText);
            console.log(`[AutoColor API] ✅ PrimariesBatch: applied=${data.applied}, failed=${data.failed}`);
            return data;
        } catch {
            console.error(`[AutoColor API] ❌ applyPrimariesBatch JSON parse lỗi:`, rawText.slice(0, 500));
            return { results: [], applied: 0, failed: 0, total: clips.length };
        }
    } catch (err: any) {
        clearTimeout(timeout);
        if (err.name === "AbortError") {
            return { results: [], applied: 0, failed: 0, total: clips.length };
        }
        throw err;
    }
}
