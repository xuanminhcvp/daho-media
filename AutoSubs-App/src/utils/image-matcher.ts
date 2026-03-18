// image-matcher.ts
// Thuật toán matching ảnh với dữ liệu Excel cho Image Import
// Trích scene number từ tên file ảnh → match với scene number trong Excel
// 1 ảnh có thể cover nhiều câu (nhiều rows cùng scene number)

import * as XLSX from "xlsx";

// ======================== INTERFACES ========================

/** 1 row trong file Excel */
export interface ExcelRow {
    id: number;          // Cột ID (số thứ tự)
    timeline: string;    // "00:00:00,000 --> 00:00:03,000"
    dialogue: string;    // Lời thoại / narration
    veoPrompt: string;   // Scene description (chứa SCENE number)
    sfx: string;         // Sound effects
    sceneNum: number;    // Parse từ Veo Prompt: SCENE 01 → 1
    startTime: number;   // Parse từ timeline: giây (start)
    endTime: number;     // Parse từ timeline: giây (end)
}

/** Kết quả matching 1 ảnh với Excel */
export interface ImageMatchResult {
    filePath: string;        // Đường dẫn file ảnh
    fileName: string;        // Tên file (không có path)
    sceneNum: number;        // Scene number từ tên file
    dialogues: string[];     // Danh sách câu thoại cover bởi ảnh
    startTime: number;       // Thời gian bắt đầu (giây) — min của tất cả rows
    endTime: number;         // Thời gian kết thúc (giây) — max của tất cả rows
    rowCount: number;        // Số câu (rows) ảnh cover
    type: "scene" | "environment";  // Loại ảnh
    quality: "matched" | "no-excel"; // Có match Excel hay không
}

// ======================== PARSE EXCEL ========================

/**
 * Parse file Excel (.xlsx) từ binary data (Uint8Array)
 * Đọc 5 cột: ID, Timeline, Dialogue, Veo Prompt, SFX
 * Tự động parse scene number và timing từ dữ liệu
 */
export function parseExcelFile(data: Uint8Array): ExcelRow[] {
    // Đọc workbook từ binary
    const workbook = XLSX.read(data, { type: "array" });

    // Lấy sheet đầu tiên
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    // Chuyển sang JSON (skip header row)
    const rawRows = XLSX.utils.sheet_to_json<any>(worksheet, { header: 1 });

    const results: ExcelRow[] = [];

    // Bỏ row 0 (header)
    for (let i = 1; i < rawRows.length; i++) {
        const row = rawRows[i];
        if (!row || row.length < 3) continue; // Bỏ row rỗng

        const id = typeof row[0] === "number" ? row[0] : parseFloat(row[0]);
        if (isNaN(id)) continue; // Bỏ row không có ID

        const timeline = String(row[1] || "");
        const dialogue = String(row[2] || "");
        const veoPrompt = String(row[3] || "");
        const sfx = String(row[4] || "");

        // Parse scene number từ Veo Prompt: "SCENE 01:", "ENVIRONMENT (SCENE 21):", etc.
        const sceneNum = extractSceneNumFromPrompt(veoPrompt);

        // Parse timing từ cột Timeline: "00:00:00,000 --> 00:00:03,000"
        const { start, end } = parseTimelineString(timeline);

        results.push({
            id,
            timeline,
            dialogue,
            veoPrompt,
            sfx,
            sceneNum,
            startTime: start,
            endTime: end,
        });
    }

    console.log(`[Image Matcher] Parsed Excel: ${results.length} rows, scenes ${results[0]?.sceneNum}→${results[results.length - 1]?.sceneNum}`);
    return results;
}

// ======================== PARSE HELPERS ========================

/**
 * Trích scene number từ Veo Prompt
 * VD: "SCENE 01: The Rescue..." → 1
 * VD: "ENVIRONMENT (SCENE 21): ..." → 21
 */
function extractSceneNumFromPrompt(prompt: string): number {
    // Tìm pattern "SCENE XX" (có thể nằm trong ngoặc hoặc không)
    const match = prompt.match(/SCENE\s+(\d+)/i);
    return match ? parseInt(match[1]) : 0;
}

/**
 * Parse timestamp SRT-like thành giây
 * VD: "00:01:23,456" → 83.456
 */
function parseSrtTimestamp(timeStr: string): number {
    const parts = timeStr.trim().replace(",", ".").split(":");
    if (parts.length !== 3) return 0;
    const h = parseInt(parts[0]) || 0;
    const m = parseInt(parts[1]) || 0;
    const s = parseFloat(parts[2]) || 0;
    return h * 3600 + m * 60 + s;
}

/**
 * Parse cột Timeline: "00:00:00,000 --> 00:00:03,000"
 * Trả về {start, end} tính bằng giây
 */
function parseTimelineString(timeline: string): { start: number; end: number } {
    const match = timeline.match(/([\d:,.]+)\s*-->\s*([\d:,.]+)/);
    if (!match) return { start: 0, end: 0 };
    return {
        start: parseSrtTimestamp(match[1]),
        end: parseSrtTimestamp(match[2]),
    };
}

// ======================== TÊN FILE ẢNH ========================

/**
 * Trích scene number từ tên file ảnh
 * VD: "001_SCENE_01_The_Rescue_00_00_00_000_00_00_03_000_9897.jpg" → 1
 * VD: "021_ENVIRONMENT_SCENE_21_Grandma_Estelle_s_modest_0312.jpg" → 21
 * → Dùng pattern "SCENE_XX" trong tên file
 */
export function getImageSceneNumber(filePath: string): number {
    const fileName = filePath.split(/[/\\]/).pop() || "";

    // Tìm pattern SCENE_XX (1 hoặc nhiều chữ số)
    const match = fileName.match(/SCENE_(\d+)/i);
    if (match) return parseInt(match[1]);

    // Fallback: lấy số đầu tiên trong tên file
    const numMatch = fileName.match(/^(\d+)/);
    return numMatch ? parseInt(numMatch[1]) : 0;
}

/**
 * Xác định loại ảnh: scene hay environment
 */
export function getImageType(filePath: string): "scene" | "environment" {
    const fileName = filePath.split(/[/\\]/).pop() || "";
    return fileName.toUpperCase().includes("ENVIRONMENT") ? "environment" : "scene";
}

// ======================== MATCHING CHÍNH ========================

/**
 * Match danh sách ảnh với dữ liệu Excel
 * Logic: scene number từ tên ảnh ↔ scene number từ Veo Prompt
 *
 * 1 ảnh có thể match nhiều rows (cùng scene number)
 * → timing = range(min start, max end)
 * → dialogues = gộp tất cả
 */
export function matchImagesToExcel(
    imageFiles: string[],
    excelRows: ExcelRow[]
): ImageMatchResult[] {
    // Bước 1: Nhóm Excel rows theo scene number
    const sceneMap = new Map<number, ExcelRow[]>();
    for (const row of excelRows) {
        if (row.sceneNum <= 0) continue;
        if (!sceneMap.has(row.sceneNum)) {
            sceneMap.set(row.sceneNum, []);
        }
        sceneMap.get(row.sceneNum)!.push(row);
    }

    console.log(`[Image Matcher] Excel: ${sceneMap.size} unique scenes, ${excelRows.length} total rows`);

    // Bước 2: Match từng ảnh
    const results: ImageMatchResult[] = [];

    for (const filePath of imageFiles) {
        const fileName = filePath.split(/[/\\]/).pop() || "";
        const sceneNum = getImageSceneNumber(filePath);
        const type = getImageType(filePath);

        // Tìm rows tương ứng trong Excel
        const matchedRows = sceneMap.get(sceneNum);

        if (matchedRows && matchedRows.length > 0) {
            // Có match — lấy timing range + gộp dialogues
            const startTime = Math.min(...matchedRows.map(r => r.startTime));
            const endTime = Math.max(...matchedRows.map(r => r.endTime));
            const dialogues = matchedRows.map(r => r.dialogue).filter(d => d.length > 0);

            results.push({
                filePath,
                fileName,
                sceneNum,
                dialogues,
                startTime,
                endTime,
                rowCount: matchedRows.length,
                type,
                quality: "matched",
            });
        } else {
            // Không match — ảnh không có trong Excel
            results.push({
                filePath,
                fileName,
                sceneNum,
                dialogues: [],
                startTime: 0,
                endTime: 0,
                rowCount: 0,
                type,
                quality: "no-excel",
            });
            console.warn(`[Image Matcher] ⚠️ Scene ${sceneNum} (${fileName}) không tìm thấy trong Excel`);
        }
    }

    // Thống kê
    const matched = results.filter(r => r.quality === "matched").length;
    const noExcel = results.filter(r => r.quality === "no-excel").length;
    console.log(`[Image Matcher] Kết quả: ✅ ${matched} matched, ⚠️ ${noExcel} no-excel | Tổng ${results.length} ảnh`);

    return results;
}

// ======================== SORT & HELPERS ========================

/** Sắp xếp file paths theo scene number */
export function sortImagesByScene(filePaths: string[]): string[] {
    return [...filePaths].sort((a, b) => getImageSceneNumber(a) - getImageSceneNumber(b));
}

/** Format giây thành timestamp dễ đọc: 00:01:23 */
export function formatTime(totalSec: number): string {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = Math.floor(totalSec % 60);
    if (h > 0) {
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ======================== REPORT ========================

/**
 * Tạo report chi tiết về kết quả matching ảnh
 */
export function generateImageMatchReport(results: ImageMatchResult[]): string {
    const lines: string[] = [];

    lines.push("═══════════════════════════════════════════════════════");
    lines.push("    IMAGE IMPORT — MATCHING REPORT");
    lines.push("═══════════════════════════════════════════════════════");
    lines.push(`Tổng số ảnh: ${results.length}`);
    lines.push(`Thời gian tạo: ${new Date().toLocaleString("vi-VN")}`);
    lines.push("");

    const matched = results.filter(r => r.quality === "matched").length;
    const noExcel = results.filter(r => r.quality === "no-excel").length;
    const scenes = results.filter(r => r.type === "scene").length;
    const envs = results.filter(r => r.type === "environment").length;

    lines.push("📊 THỐNG KÊ:");
    lines.push(`  ✅ Matched:     ${matched} ảnh`);
    lines.push(`  ⚠️ No Excel:    ${noExcel} ảnh`);
    lines.push(`  🎬 Scene:       ${scenes} ảnh`);
    lines.push(`  🏞️ Environment: ${envs} ảnh`);
    lines.push("");
    lines.push("───────────────────────────────────────────────────────");

    for (const r of results) {
        const qi = r.quality === "matched" ? "✅" : "⚠️";
        const typeLabel = r.type === "environment" ? "🏞️ ENV" : "🎬 SCN";
        const duration = (r.endTime - r.startTime).toFixed(1);

        lines.push("");
        lines.push(`${qi} Scene ${r.sceneNum} [${typeLabel}] — ${r.fileName}`);
        lines.push(`  ⏱️ Timing: ${formatTime(r.startTime)} → ${formatTime(r.endTime)} (${duration}s)`);
        lines.push(`  📝 ${r.rowCount} câu thoại:`);
        for (const d of r.dialogues) {
            lines.push(`     "${d.slice(0, 80)}${d.length > 80 ? "..." : ""}"`);
        }
    }

    lines.push("");
    lines.push("═══════════════════════════════════════════════════════");
    return lines.join("\n");
}
