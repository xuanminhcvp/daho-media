/**
 * footage-library-service.ts
 *
 * Service quét thư viện footage (video clip minh hoạ từ Envato)
 * - Quét folder liệt kê file .mp4/.mov/.avi/.webm
 * - FFmpeg trích 3 frame (đầu/giữa/cuối) → gửi AI Vision mô tả
 * - Lưu metadata vào file JSON ngay trong folder footage
 * - Pattern giống audio-library-service.ts (folder JSON, merge, cleanup)
 */

import { readDir, exists, writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { join, appCacheDir } from "@tauri-apps/api/path";
// const fetch = window.fetch; (bỏ qua tauri-apps/plugin-http đề phòng bug streamChannel)
import { Command } from "@tauri-apps/plugin-shell";
import { getFFmpegPath, getFFprobePath } from "@/utils/ffmpeg-path";
import type {
    FootageItem,
    FootageMetadataFile,
    FootageScanProgress,
} from "@/types/footage-types";
import { addDebugLog, updateDebugLog, generateLogId } from "@/services/debug-logger";

// ======================== CONSTANTS ========================

/** Tên file JSON metadata — nằm ngay trong folder footage */
const METADATA_FILE_NAME = "autosubs_footage_metadata.json";

/** Extensions video hỗ trợ */
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".webm", ".mkv"];

/** Max duration cho footage (giây) */
const MAX_FOOTAGE_DURATION = 20;

/** Timeout cho AI Vision call (2 phút — gửi ảnh base64) */
const AI_TIMEOUT_MS = 120000;

/** Model Gemini — dùng pro cho kết quả phân tích hình ảnh (Vision) chính xác hơn */
const DEFAULT_VISION_MODEL = "gemini-2.5-pro";

// ======================== HASH ĐƠNGIẢN ========================

function simpleFileHash(fileName: string): string {
    let hash = 0;
    for (let i = 0; i < fileName.length; i++) {
        hash = ((hash << 5) - hash) + fileName.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}

// ======================== QUÉT FOLDER ========================

/**
 * Đệ quy quét folder footage + sub-folders
 * Liệt kê tất cả file video (.mp4/.mov/...)
 */
async function scanFootageFolderRecursive(
    folderPath: string,
    results: FootageItem[]
): Promise<void> {
    try {
        const entries = await readDir(folderPath);
        for (const entry of entries) {
            if (!entry.name || entry.name.startsWith(".")) continue;

            const fullPath = await join(folderPath, entry.name);

            // Thư mục con → đệ quy
            if (entry.isDirectory) {
                await scanFootageFolderRecursive(fullPath, results);
                continue;
            }

            // Kiểm tra extension video
            const ext = entry.name.toLowerCase().slice(entry.name.lastIndexOf("."));
            if (!VIDEO_EXTENSIONS.includes(ext)) continue;

            results.push({
                filePath: fullPath,
                fileName: entry.name,
                fileHash: simpleFileHash(entry.name),
                durationSec: 0,
                aiDescription: null,
                aiTags: null,
                aiMood: null,
                scannedAt: null,
            });
        }
    } catch (error) {
        console.error(`[FootageLib] ❌ Lỗi quét folder ${folderPath}:`, error);
    }
}

/**
 * Quét folder footage → danh sách FootageItem (chưa có AI metadata)
 */
export async function scanFootageFolder(folderPath: string): Promise<FootageItem[]> {
    const items: FootageItem[] = [];
    await scanFootageFolderRecursive(folderPath, items);
    console.log(`[FootageLib] Quét ${folderPath}: tìm thấy ${items.length} file video`);
    return items;
}

// ======================== FILE JSON OPERATIONS ========================

/**
 * Load metadata từ file JSON trong folder footage
 */
export async function loadFootageMetadata(folderPath: string): Promise<FootageItem[]> {
    try {
        const metaFilePath = await join(folderPath, METADATA_FILE_NAME);
        if (!await exists(metaFilePath)) {
            console.log(`[FootageLib] 📂 Chưa có metadata file tại ${folderPath}`);
            return [];
        }
        const raw = await readTextFile(metaFilePath);
        const data: FootageMetadataFile = JSON.parse(raw);
        console.log(`[FootageLib] ✅ Loaded ${data.items.length} items từ ${METADATA_FILE_NAME}`);
        return Array.isArray(data.items) ? data.items : [];
    } catch (error) {
        console.error("[FootageLib] ❌ Lỗi load metadata:", error);
        return [];
    }
}

/**
 * Lưu metadata vào file JSON trong folder footage
 */
export async function saveFootageMetadata(
    folderPath: string,
    items: FootageItem[]
): Promise<void> {
    try {
        const metaFilePath = await join(folderPath, METADATA_FILE_NAME);
        const data: FootageMetadataFile = {
            version: "1.0",
            lastScanned: new Date().toISOString(),
            itemCount: items.length,
            items,
        };
        await writeTextFile(metaFilePath, JSON.stringify(data, null, 2));
        console.log(`[FootageLib] 💾 Đã lưu ${items.length} items vào ${METADATA_FILE_NAME}`);
    } catch (error) {
        console.error("[FootageLib] ❌ Lỗi lưu metadata:", error);
        throw error;
    }
}

/**
 * Lấy duration (giây) của file video
 * Cách 1: Chạy ffprobe qua exec-sh (vì Tauri shell chỉ whitelist ffmpeg, không có ffprobe riêng)
 * Cách 2 (fallback): Dùng ffmpeg -i, parse "Duration: HH:MM:SS.xx" từ stderr
 */
export async function getVideoDuration(filePath: string): Promise<number> {
    // === Cách 1: ffprobe qua exec-sh ===
    try {
        // Lấy full path ffprobe (tự detect theo máy)
        const ffprobeBin = await getFFprobePath();
        const cmd = Command.create("exec-sh", [
            "-c",
            `${ffprobeBin} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
        ]);
        const result = await cmd.execute();
        if (result.code === 0 && result.stdout.trim()) {
            const dur = parseFloat(result.stdout.trim());
            if (!isNaN(dur) && dur > 0) {
                console.log(`[FootageLib] ffprobe duration: ${dur.toFixed(1)}s for ${filePath.split("/").pop()}`);
                return dur;
            }
        }
    } catch (error) {
        console.warn(`[FootageLib] ffprobe via sh failed, trying ffmpeg fallback:`, error);
    }

    // === Cách 2 (fallback): ffmpeg -i → parse "Duration:" từ stderr ===
    try {
        // Fallback: dùng ffmpeg -i để parse duration
        const ffmpegBin = await getFFmpegPath();
        const cmd = Command.create("exec-sh", ["-c",
            `${ffmpegBin} -i "${filePath}" -f null - 2>&1`
        ]);
        const result = await cmd.execute();
        // ffmpeg -i luôn exit 1 nếu không có output, nhưng in Duration vào stderr
        const output = result.stderr || result.stdout || "";
        const durationMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
        if (durationMatch) {
            const hours = parseInt(durationMatch[1]);
            const minutes = parseInt(durationMatch[2]);
            const seconds = parseInt(durationMatch[3]);
            const fraction = parseInt(durationMatch[4]) / 100;
            const totalSec = hours * 3600 + minutes * 60 + seconds + fraction;
            console.log(`[FootageLib] ffmpeg fallback duration: ${totalSec.toFixed(1)}s`);
            return totalSec;
        }
    } catch (error) {
        console.error(`[FootageLib] ffmpeg fallback also failed for ${filePath}:`, error);
    }

    return 0;
}

/**
 * Trích 3 frame từ video: đầu (10%), giữa (50%), cuối (90%)
 * Lưu vào thư mục cache tạm, trả về đường dẫn 3 file ảnh
 */
export async function extractFrames(
    filePath: string,
    durationSec: number
): Promise<string[]> {
    const cacheDir = await appCacheDir();
    const baseName = filePath.split("/").pop()?.replace(/\.[^.]+$/, "") || "footage";
    const timestamps = [
        Math.max(0, durationSec * 0.1),   // Đầu 10%
        durationSec * 0.5,                 // Giữa 50%
        Math.min(durationSec - 0.1, durationSec * 0.9), // Cuối 90%
    ];

    const framePaths: string[] = [];

    for (let i = 0; i < timestamps.length; i++) {
        const outputPath = await join(cacheDir, `autosubs_frame_${baseName}_${i}.jpg`);
        try {
            // Dùng ffmpeg full path để extract frame
            const ffmpegBin = await getFFmpegPath();
            const escapedInput = filePath.replace(/'/g, "'\\''");
            const escapedOutput = outputPath.replace(/'/g, "'\\''");
            const cmd = Command.create("exec-sh", ["-c",
                `${ffmpegBin} -y -ss ${timestamps[i].toFixed(2)} -i '${escapedInput}' -vframes 1 -q:v 5 -vf 'scale=512:-1' '${escapedOutput}'`
            ]);
            const result = await cmd.execute();
            if (result.code === 0) {
                framePaths.push(outputPath);
            }
        } catch (error) {
            console.error(`[FootageLib] FFmpeg extract frame ${i} error:`, error);
        }
    }

    return framePaths;
}

/**
 * Đọc file ảnh → base64 string
 */
async function imageFileToBase64(filePath: string): Promise<string> {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const bytes = await readFile(filePath);
    // Chuyển Uint8Array → base64
    return new Promise((resolve, reject) => {
        const blob = new Blob([bytes as any]);
        const reader = new FileReader();
        reader.onloadend = () => {
            if (typeof reader.result === "string") {
                resolve(reader.result.split(",")[1] || "");
            } else {
                reject(new Error("Failed to read as base64"));
            }
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// ======================== AI VISION SCAN ========================

/**
 * Gửi 3 frame cho AI Vision (Gemini) → nhận mô tả + tags + mood
 * @param framePaths - Đường dẫn 3 file ảnh (jpg)
 * @param apiKey - Gemini API key
 * @returns { description, tags, mood }
 */
export async function analyzeFootageWithAI(
    framePaths: string[],
    apiKey: string
): Promise<{ description: string; tags: string[]; mood: string }> {
    const { buildFootageScanPrompt } = await import("../prompts/documentary/footage-scan-prompt");
    const promptText = buildFootageScanPrompt();

    // Tạo parts: text prompt + inline_data cho mỗi frame
    const parts: any[] = [{ text: promptText }];

    for (const framePath of framePaths) {
        try {
            const base64 = await imageFileToBase64(framePath);
            parts.push({
                inline_data: {
                    mime_type: "image/jpeg",
                    data: base64,
                },
            });
        } catch (error) {
            console.warn(`[FootageLib] Skip frame ${framePath}:`, error);
        }
    }

    // Gọi Gemini Vision
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_VISION_MODEL}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Gemini Vision error ${response.status}: ${err}`);
    }

    const data = await response.json() as any;
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Parse JSON từ response
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        return { description: "Unknown footage", tags: [], mood: "Unknown" };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
        description: parsed.description || "No description",
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
        mood: parsed.mood || "Unknown",
    };
}

// ======================== QUÉT HÀNG LOẠT ========================

/**
 * Quét toàn bộ folder footage: scan files → check metadata → AI Vision
 * - Chỉ gọi AI cho file MỚI (chưa có metadata)
 * - Lưu JSON trong folder footage sau mỗi file
 * - Bỏ qua footage > 20 giây
 *
 * @param folderPath - Thư mục chứa footage
 * @param apiKey - Gemini API key
 * @param onProgress - Callback tiến trình
 * @param abortSignal - Signal để dừng giữa chừng
 * @returns Danh sách tất cả footage items
 */
export async function scanAndAnalyzeFootageFolder(
    folderPath: string,
    apiKey: string,
    onProgress?: (p: FootageScanProgress) => void,
    abortSignal?: AbortSignal
): Promise<FootageItem[]> {
    const logId = generateLogId();
    const startTime = Date.now();

    addDebugLog({
        id: logId,
        timestamp: new Date(),
        method: "SCAN",
        url: `Footage: ${folderPath}`,
        requestHeaders: {},
        requestBody: `Quét folder footage...`,
        status: null,
        responseHeaders: {},
        responseBody: "(đang quét...)",
        duration: 0,
        error: null,
        label: `📽️ Footage Scan: ${folderPath.split("/").pop()}`,
    });

    // Bước 1: Quét file video
    const scannedItems = await scanFootageFolder(folderPath);

    // Bước 2: Load metadata đã có
    const existingItems = await loadFootageMetadata(folderPath);
    const existingMap = new Map(existingItems.map(i => [i.filePath, i]));

    // Bước 3: Merge — giữ metadata cũ, lọc file mới hoặc file bị lỗi cần re-scan
    let allItems: FootageItem[] = scannedItems.map(scanned => {
        const existing = existingMap.get(scanned.filePath);
        // Giữ metadata cũ NẾU: đã scan thành công (có description, không phải Error, duration > 0)
        if (existing && existing.aiDescription
            && existing.aiMood !== "Error"
            && existing.durationSec > 0
            && existing.fileHash === scanned.fileHash) {
            return existing;
        }
        return scanned; // File mới HOẶC file lỗi → cần scan lại
    });

    // Tìm file chưa scan (hoặc cần re-scan)
    const newItems = allItems.filter(i => !i.aiDescription || i.aiMood === "Error" || i.durationSec === 0);

    if (newItems.length === 0) {
        onProgress?.({
            current: 0, total: 0, fileName: "",
            message: `Tất cả ${allItems.length} footage đã có metadata!`,
        });
        await saveFootageMetadata(folderPath, allItems);

        updateDebugLog(logId, {
            status: 200,
            responseBody: `✅ Không có file mới. Tổng: ${allItems.length} footage.`,
            duration: Date.now() - startTime,
            error: null,
        });
        return allItems;
    }

    console.log(`[FootageLib] 🆕 ${newItems.length} file mới cần AI Vision scan`);

    // Bước 4: Tuần tự scan AI (1 file/lần — tránh rate limit Vision)
    let processedCount = 0;

    for (const item of newItems) {
        if (abortSignal?.aborted) break;

        onProgress?.({
            current: processedCount,
            total: newItems.length,
            fileName: item.fileName,
            message: `[${processedCount + 1}/${newItems.length}] ${item.fileName}...`,
        });

        try {
            // Lấy duration
            const duration = await getVideoDuration(item.filePath);
            item.durationSec = Math.round(duration * 10) / 10;

            // Cảnh báo nếu > 20 giây (vẫn scan nhưng ghi chú)
            if (item.durationSec > MAX_FOOTAGE_DURATION) {
                console.warn(`[FootageLib] ⚠️ ${item.fileName} dài ${item.durationSec}s (> ${MAX_FOOTAGE_DURATION}s)`);
            }

            // Trích 3 frame
            const framePaths = await extractFrames(item.filePath, item.durationSec);

            if (framePaths.length > 0) {
                // AI Vision scan
                const aiResult = await analyzeFootageWithAI(framePaths, apiKey);
                item.aiDescription = aiResult.description;
                item.aiTags = aiResult.tags;
                item.aiMood = aiResult.mood;
            } else {
                item.aiDescription = `Video file: ${item.fileName}`;
                item.aiTags = [];
                item.aiMood = "Unknown";
            }

            item.scannedAt = new Date().toISOString();

            // Cleanup frame tạm
            for (const fp of framePaths) {
                try {
                    const { remove } = await import("@tauri-apps/plugin-fs");
                    await remove(fp);
                } catch { /* ignore */ }
            }

        } catch (error) {
            console.error(`[FootageLib] ❌ Lỗi scan ${item.fileName}:`, error);
            item.aiDescription = `Lỗi: ${String(error).slice(0, 100)}`;
            item.aiTags = [];
            item.aiMood = "Error";
            item.scannedAt = new Date().toISOString();
        }

        // Cập nhật vào allItems
        allItems = allItems.map(i => i.filePath === item.filePath ? item : i);

        // Lưu ngay sau mỗi file (phòng crash)
        await saveFootageMetadata(folderPath, allItems);

        processedCount++;
    }

    // Kết quả
    const wasCancelled = abortSignal?.aborted;
    onProgress?.({
        current: processedCount,
        total: newItems.length,
        fileName: "",
        message: wasCancelled
            ? `⏹️ Đã dừng! ${processedCount}/${newItems.length} file đã scan.`
            : `✅ Hoàn tất! Đã scan ${processedCount} footage mới. Tổng: ${allItems.length}.`,
    });

    updateDebugLog(logId, {
        status: 200,
        responseBody: `✅ Scan xong: ${processedCount} mới, tổng ${allItems.length} footage.`,
        duration: Date.now() - startTime,
        error: wasCancelled ? "Cancelled" : null,
    });

    return allItems;
}
