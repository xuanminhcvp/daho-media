// audio-library-service.ts
// QUAN TRỌNG: BATCH_SIZE=1 → tuần tự, tránh RAM bùng nổ
// WAV/FLAC/AIFF tự convert → MP3 tạm trước khi gửi AI
// Service quản lý Thư Viện Âm Thanh cục bộ (Local Audio Database)
// - Quét thư mục nhạc/SFX trên máy người dùng
// - Gọi AI (Gemini) để phân tích & tạo metadata cho từng file audio
// - Lưu/Load metadata trong file JSON nằm ngay trong folder nhạc/SFX
//   → Portable: copy folder đi đâu là có metadata ngay
// - Xử lý song song batch 10 file 1 lượt (tăng tốc)
// - Dọn dẹp metadata của file đã bị xoá khỏi ổ cứng

import { readDir, readFile, exists, writeTextFile, readTextFile, remove } from "@tauri-apps/plugin-fs";
import { join, appCacheDir } from "@tauri-apps/api/path";
import { fetch } from "@tauri-apps/plugin-http";
import { Command } from "@tauri-apps/plugin-shell";
import { getFFmpegPath } from "@/utils/ffmpeg-path";
import {
    AudioLibraryItem,
    AudioAIMetadata,
} from "@/types/audio-types";
import {
    addDebugLog,
    updateDebugLog,
    generateLogId,
} from "@/services/debug-logger";

/** Tên file JSON chứa metadata — nằm ngay trong folder nhạc/SFX */
const METADATA_FILE_NAME = "autosubs_audio_metadata.json";

// ======================== CẤU HÌNH ========================

/** Extensions hỗ trợ cho nhạc nền */
const MUSIC_EXTENSIONS = [".mp3", ".wav", ".aiff", ".flac", ".ogg", ".m4a"];

/** Extensions hỗ trợ cho SFX */
const SFX_EXTENSIONS = [".mp3", ".wav", ".ogg", ".m4a"];

/** Số file xử lý — 1 = tuần tự (tránh RAM bùng nổ khi load nhiều audio cùng lúc) */
const BATCH_SIZE = 1;

/** Timeout cho mỗi file audio (5 phút — file audio lớn cần thời gian upload Base64) */
const AI_TIMEOUT_MS = 300000;

/** Model Gemini mặc định cho Audio Scan */
const DEFAULT_MODEL = "gemini-2.5-pro";

// ======================== QUÉT THƯ MỤC ========================

/**
 * Tạo hash đơn giản từ tên file (dùng thay MD5 vì không cần đọc toàn bộ file)
 * Đủ để phát hiện file mới — nếu tên đổi → hash đổi
 */
function simpleFileHash(fileName: string): string {
    let hash = 0;
    for (let i = 0; i < fileName.length; i++) {
        const char = fileName.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32-bit int
    }
    return Math.abs(hash).toString(36);
}

/**
 * Hàm nội bộ: đệ quy quét 1 folder và tất cả sub-folder bên trong
 * @param folderPath - Thư mục cần quét
 * @param extensions - Danh sách extension được chấp nhận
 * @param type - Loại audio ("music" | "sfx")
 * @param results - Mảng kết quả (accumulate qua đệ quy)
 */
async function scanAudioFolderRecursive(
    folderPath: string,
    extensions: string[],
    type: "music" | "sfx",
    results: AudioLibraryItem[]
): Promise<void> {
    try {
        const entries = await readDir(folderPath);

        for (const entry of entries) {
            if (!entry.name) continue;

            // Bỏ qua file ẩn (.DS_Store, .gitignore,...)
            if (entry.name.startsWith(".")) continue;

            // ★ Try/catch từng file — tên file encoding lạ (non-UTF-8) có thể crash
            // Trên máy khác, file copy từ Windows có thể có encoding Latin-1/CP1252
            try {
                const fullPath = await join(folderPath, entry.name);

                // Nếu là thư mục con → đệ quy vào bên trong
                if (entry.isDirectory) {
                    await scanAudioFolderRecursive(fullPath, extensions, type, results);
                    continue;
                }

                // Kiểm tra extension có hợp lệ không
                const ext = entry.name.toLowerCase().slice(entry.name.lastIndexOf("."));
                if (!extensions.includes(ext)) continue;

                results.push({
                    filePath: fullPath,
                    fileName: entry.name,
                    fileHash: simpleFileHash(entry.name),
                    durationSec: 0,
                    type,
                    aiMetadata: null,
                    scannedAt: null,
                });
            } catch (entryErr) {
                // Bỏ qua file lỗi encoding, tiếp tục scan file khác
                console.warn(`[AudioLib] ⚠️ Bỏ qua file "${entry.name}" (encoding lỗi):`, entryErr);
            }
        }
    } catch (error) {
        console.error(`[AudioLib] ❌ Lỗi quét folder ${folderPath}:`, error);
    }
}

/**
 * Quét thư mục và liệt kê tất cả file audio (bao gồm TẤT CẢ sub-folder đệ quy)
 * @param folderPath - Đường dẫn thư mục gốc cần quét
 * @param type - Loại audio: "music" hoặc "sfx"
 * @returns Danh sách AudioLibraryItem (chưa có AI metadata)
 */
export async function scanAudioFolder(
    folderPath: string,
    type: "music" | "sfx"
): Promise<AudioLibraryItem[]> {
    const extensions = type === "music" ? MUSIC_EXTENSIONS : SFX_EXTENSIONS;
    const items: AudioLibraryItem[] = [];

    // Gọi hàm đệ quy để quét toàn bộ cây thư mục
    await scanAudioFolderRecursive(folderPath, extensions, type, items);

    console.log(`[AudioLib] Quét đệ quy ${folderPath}: tìm thấy ${items.length} file ${type}`);
    return items;
}

// ======================== FILE JSON OPERATIONS ========================

/**
 * Load metadata từ file JSON trong folder nhạc/SFX
 * File nằm cùng folder audio: {folderPath}/autosubs_audio_metadata.json
 * @param folderPath - Đường dẫn folder chứa nhạc/SFX
 * @returns Danh sách AudioLibraryItem đã lưu (có metadata)
 */
export async function loadAudioItemsFromFolder(
    folderPath: string
): Promise<AudioLibraryItem[]> {
    try {
        const metaFilePath = await join(folderPath, METADATA_FILE_NAME);
        const fileExists = await exists(metaFilePath);
        if (!fileExists) {
            console.log(`[AudioLib] 📂 Chưa có metadata file tại ${folderPath}`);
            return [];
        }
        const raw = await readTextFile(metaFilePath);
        const data = JSON.parse(raw);
        const items: AudioLibraryItem[] = Array.isArray(data.items) ? data.items : [];
        console.log(`[AudioLib] ✅ Loaded ${items.length} items từ ${METADATA_FILE_NAME}`);
        return items;
    } catch (error) {
        console.error(`[AudioLib] ❌ Lỗi load metadata từ folder:`, error);
        return [];
    }
}

/**
 * Tương thích ngược: wrapper cũ gọi loadAudioItemsFromFolder
 * @deprecated — dùng loadAudioItemsFromFolder(folderPath) thay thế
 */
export async function loadAudioItemsFromDB(
    _type: "music" | "sfx",
    folderPath?: string
): Promise<AudioLibraryItem[]> {
    if (!folderPath) {
        console.warn(`[AudioLib] ⚠️ loadAudioItemsFromDB cần folderPath — trả về []`);
        return [];
    }
    return loadAudioItemsFromFolder(folderPath);
}

/**
 * Lưu metadata xuống file JSON trong folder nhạc/SFX
 * Ghi đè file cũ — luôn lưu toàn bộ danh sách items
 * @param folderPath - Đường dẫn folder chứa nhạc/SFX
 * @param items - Toàn bộ danh sách AudioLibraryItem
 */
export async function saveAudioItemsToFolder(
    folderPath: string,
    items: AudioLibraryItem[]
): Promise<void> {
    try {
        const metaFilePath = await join(folderPath, METADATA_FILE_NAME);
        const data = {
            version: "2.0",
            lastScanned: new Date().toISOString(),
            itemCount: items.length,
            items: items,
        };
        await writeTextFile(metaFilePath, JSON.stringify(data, null, 2));
        console.log(`[AudioLib] 💾 Đã lưu ${items.length} items vào ${METADATA_FILE_NAME}`);
    } catch (error) {
        console.error(`[AudioLib] ❌ Lỗi lưu metadata vào folder:`, error);
        throw error;
    }
}

/**
 * So sánh danh sách file mới quét với dữ liệu trong IndexedDB
 * Trả về danh sách file CHƯA CÓ metadata AI (cần gửi AI phân tích)
 * @param scannedItems - File mới quét từ folder
 * @param existingItems - Items đã có trong IndexedDB
 */
export function findNewFiles(
    scannedItems: AudioLibraryItem[],
    existingItems: AudioLibraryItem[]
): AudioLibraryItem[] {
    // Tạo Map từ existing items để lookup nhanh
    const existingMap = new Map(existingItems.map(item => [item.filePath, item]));

    return scannedItems.filter((item) => {
        const existing = existingMap.get(item.filePath);
        // File cũ đã có metadata AI → kiểm tra xem có phải bị lỗi không
        if (existing && existing.aiMetadata && existing.fileHash === item.fileHash) {
            // Nếu đánh dấu là "Lỗi" thì coi như file mới để cho phép quét lại
            if (existing.aiMetadata.emotion.includes("Lỗi") || existing.aiMetadata.emotion.includes("Không xác định")) {
                return true;
            }
            return false;
        }
        // File mới hoặc hash đã đổi → cần quét AI
        return true;
    });
}

// ======================== AI ANALYSIS ========================

/**
 * Chuyển Uint8Array byte sang chuỗi Base64 (bất đồng bộ, không gây lag)
 * Dùng Blob + FileReader thay vì vòng lặp for
 */
async function uint8ArrayToBase64(buffer: Uint8Array): Promise<string> {
    return new Promise((resolve, reject) => {
        const blob = new Blob([buffer as any]);
        const reader = new FileReader();
        reader.onloadend = () => {
            if (typeof reader.result === 'string') {
                // Tách bỏ phần header "data:audio/mp3;base64,"
                const base64 = reader.result.split(',')[1];
                resolve(base64 || "");
            } else {
                reject(new Error("Failed to read base64"));
            }
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

/**
 * Suy luận mime type từ file name
 */
function getMimeTypeFromExt(fileName: string): string {
    const ext = fileName.toLowerCase().slice(fileName.lastIndexOf("."));
    switch (ext) {
        case ".mp3": return "audio/mp3";
        case ".wav": return "audio/wav";
        case ".flac": return "audio/flac";
        case ".ogg": return "audio/ogg";
        case ".m4a": return "audio/m4a";
        default: return "audio/mp3";
    }
}

// ======================== CONVERT → MP3 TẠM ========================

/** Extensions cần convert sang MP3 trước khi gửi AI (nặng RAM nếu giữ nguyên) */
const HEAVY_EXTENSIONS = [".wav", ".flac", ".aiff", ".aif"];

/**
 * Convert WAV/FLAC/AIFF → MP3 tạm bằng FFmpeg (128kbps)
 * Giảm ~10x dung lượng → giảm RAM khi đọc vào bộ nhớ + base64
 * @param inputPath - Đường dẫn file gốc
 * @param fileName - Tên file (để tạo tên file tạm)
 * @returns Đường dẫn file MP3 tạm hoặc null nếu lỗi/không cần convert
 */
async function convertToMp3Temp(inputPath: string, fileName: string): Promise<string | null> {
    const ext = fileName.toLowerCase().slice(fileName.lastIndexOf("."));
    if (!HEAVY_EXTENSIONS.includes(ext)) return null; // Không cần convert

    try {
        // Tạo file tạm trong thư mục cache app
        const cacheDir = await appCacheDir();
        const tempName = `autosubs_scan_${Date.now()}_${fileName.replace(/\.[^.]+$/, ".mp3")}`;
        const tempPath = await join(cacheDir, tempName);

        console.log(`[AudioLib] 🔄 Convert ${ext} → MP3: ${fileName}`);

        // Gọi FFmpeg convert: 128kbps mono (đủ cho AI phân tích)
        const ffmpegBin = await getFFmpegPath();
        const escapedInput = inputPath.replace(/'/g, "'\\''");
        const escapedOutput = tempPath.replace(/'/g, "'\\''");
        const cmd = Command.create("exec-sh", ["-c",
            `${ffmpegBin} -y -i '${escapedInput}' -codec:a libmp3lame -b:a 128k -ac 1 -ar 22050 '${escapedOutput}'`
        ]);

        const result = await cmd.execute();

        if (result.code !== 0) {
            console.error(`[AudioLib] ❌ FFmpeg convert lỗi:`, result.stderr);
            return null; // Fallback: dùng file gốc
        }

        console.log(`[AudioLib] ✅ Convert xong: ${tempName}`);
        return tempPath;
    } catch (error) {
        console.error(`[AudioLib] ❌ Lỗi convert MP3:`, error);
        return null; // Fallback: dùng file gốc
    }
}

/**
 * Gọi AI (Gemini) để nghe bản nhạc và phân tích diễn biến Timeline
 * Tự convert WAV/FLAC → MP3 tạm để giảm RAM ~10x
 *
 * @param item - File audio cần phân tích
 * @param apiKey - Gemini API key (user nhập trên giao diện)
 * @returns Metadata AI đã phân tích (bao gồm cả timeline)
 */
export async function analyzeAudioWithAI(
    item: AudioLibraryItem,
    apiKey: string
): Promise<AudioAIMetadata> {
    const logId = generateLogId();
    const startTime = Date.now();
    let tempMp3Path: string | null = null;

    try {
        // 1. Convert WAV/FLAC/AIFF → MP3 tạm (nếu cần) để giảm RAM
        tempMp3Path = await convertToMp3Temp(item.filePath, item.fileName);
        const fileToRead = tempMp3Path || item.filePath;
        const mimeForAI = tempMp3Path ? "audio/mp3" : getMimeTypeFromExt(item.fileName);

        // 2. Đọc byte nhị phân (file MP3 tạm hoặc file gốc nếu đã là MP3)
        const fileContent = await readFile(fileToRead);
        const base64Audio = await uint8ArrayToBase64(fileContent);
        const mimeType = mimeForAI;

        // 2. Chuẩn bị prompt từ file prompts/ (dễ chỉnh sửa riêng)
        //    SFX: prompt đơn giản (chỉ mô tả + tags, không timeline/beats/trim)
        //    Music: prompt đầy đủ (timeline + beats + trimSuggestions)
        const { buildAudioScanPrompt, buildSfxScanPrompt } = await import("@/prompts/audio-scan-prompt");
        const promptText = item.type === "sfx" ? buildSfxScanPrompt() : buildAudioScanPrompt();

        const requestBody = JSON.stringify({
            contents: [
                {
                    parts: [
                        { text: promptText },
                        {
                            inline_data: {
                                mime_type: mimeType,
                                data: base64Audio
                            }
                        }
                    ]
                }
            ],
            generationConfig: {
                responseMimeType: "application/json" // Ép kết quả Json Mode
            }
        });

        // URL Gemini API — dùng API key user nhập
        const baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent?key=${apiKey}`;

        // Log request vào Debug panel
        addDebugLog({
            id: logId,
            timestamp: new Date(),
            method: "POST",
            url: baseUrl.split("?key=")[0],
            requestHeaders: { "Content-Type": "application/json" },
            requestBody: `(Base64 payload kích thước: ${(base64Audio.length / 1024 / 1024).toFixed(2)} MB)`,
            status: null,
            responseHeaders: {},
            responseBody: "(đang chờ Gemini nghe nhạc & phân tích...)",
            duration: 0,
            error: null,
            label: `Gemini Audio: ${item.fileName}`,
        });

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

        const response = await fetch(baseUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: requestBody,
            signal: controller.signal,
        });
        clearTimeout(timeout);

        const duration = Date.now() - startTime;
        const responseText = await response.text();

        updateDebugLog(logId, {
            status: response.status,
            responseBody: responseText,
            duration,
            error: response.ok ? null : `HTTP ${response.status}`,
        });

        if (!response.ok) {
            throw new Error(`Gemini API error ${response.status}: ${responseText}`);
        }

        const data = JSON.parse(responseText);
        const rawResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

        // Parse JSON response
        const result = parseAIMetadataResponse(rawResponse);
        return result;

    } catch (error) {
        const duration = Date.now() - startTime;
        updateDebugLog(logId, {
            duration,
            error: String(error),
            responseBody: `(Lỗi: ${String(error)})`,
        });

        console.error(`[AudioLib] ❌ AI lỗi cho ${item.fileName}:`, error);
        return {
            emotion: ["Lỗi"],
            intensity: "Trung bình",
            description: `Không thể kết nối Gemini API. Lỗi: ${String(error)}`,
            tags: [item.type],
            timeline: []
        };
    } finally {
        // 🧹 Dọn file MP3 tạm (dù thành công hay lỗi)
        if (tempMp3Path) {
            try {
                await remove(tempMp3Path);
                console.log(`[AudioLib] 🧹 Xoá file tạm: ${tempMp3Path}`);
            } catch {
                // Bỏ qua lỗi xoá — file tạm không quan trọng
            }
        }
    }
}

/**
 * Parse AI response text thành AudioAIMetadata
 * Xử lý cả trường hợp AI trả về markdown code block
 */
function parseAIMetadataResponse(aiResponse: string): AudioAIMetadata {
    // Bỏ thinking tags (nếu AI model dùng thinking)
    let cleaned = aiResponse.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");

    // Bỏ markdown code block
    const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) cleaned = codeBlock[1];

    // Tìm JSON object
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        console.warn("[AudioLib] ⚠️ AI không trả về JSON, dùng mặc định");
        return {
            emotion: ["Không xác định"],
            intensity: "Trung bình",
            description: "Chưa phân tích được.",
            tags: [],
            timeline: []
        };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
        emotion: Array.isArray(parsed.emotion) ? parsed.emotion : ["Không xác định"],
        intensity: parsed.intensity || "Trung bình",
        description: parsed.description || "Không có mô tả.",
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
        bestFor: Array.isArray(parsed.bestFor) ? parsed.bestFor : undefined,
        hasDrop: parsed.hasDrop ?? undefined,
        hasBuildUp: parsed.hasBuildUp ?? undefined,
        totalDurationSec: typeof parsed.totalDurationSec === "number" ? parsed.totalDurationSec : undefined,
        timeline: Array.isArray(parsed.timeline) ? parsed.timeline : [],
        beats: Array.isArray(parsed.beats) ? parsed.beats : undefined,
        trimSuggestions: Array.isArray(parsed.trimSuggestions) ? parsed.trimSuggestions : undefined,
    };
}

// ======================== QUÉT HÀNG LOẠT (CONCURRENCY POOL) ========================

/** Callback progress khi quét AI hàng loạt */
export interface ScanProgress {
    current: number;
    total: number;
    fileName: string;
    message: string;
}

/**
 * Concurrency Pool — chạy đồng thời tối đa CONCURRENCY_LIMIT task
 * Khi 1 task xong → task tiếp theo vào ngay (sliding window)
 * Hỗ trợ cancel qua AbortController
 *
 * @param tasks - Danh sách hàm async cần chạy
 * @param concurrency - Số task chạy đồng thời tối đa
 * @param abortSignal - Signal để huỷ (optional)
 * @param onTaskComplete - Callback mỗi khi 1 task hoàn thành
 */
async function runConcurrencyPool<T>(
    tasks: (() => Promise<T>)[],
    concurrency: number,
    abortSignal?: AbortSignal,
    onTaskComplete?: (result: T, index: number) => void
): Promise<T[]> {
    const results: T[] = [];
    let nextIndex = 0; // Index task tiếp theo cần chạy

    // Hàm worker — mỗi worker liên tục lấy task mới khi xong
    const worker = async (): Promise<void> => {
        while (nextIndex < tasks.length) {
            // Kiểm tra đã bị cancel chưa
            if (abortSignal?.aborted) {
                console.log("[AudioLib] ⏹️ Đã dừng scan theo yêu cầu");
                return;
            }

            const currentIndex = nextIndex++;
            try {
                const result = await tasks[currentIndex]();
                results.push(result);
                onTaskComplete?.(result, currentIndex);
            } catch (error) {
                console.error(`[AudioLib] ❌ Task ${currentIndex} lỗi:`, error);
                // Không dừng — tiếp tục task khác
            }
        }
    };

    // Khởi chạy N worker song song (N = concurrency)
    const workers = Array.from(
        { length: Math.min(concurrency, tasks.length) },
        () => worker()
    );
    await Promise.all(workers);

    return results;
}

/**
 * Quét & phân tích AI cho tất cả file mới trong thư mục
 * - Chỉ gọi AI cho file CHƯA CÓ metadata (file cũ bỏ qua)
 * - Sliding window: luôn giữ ~10 request đồng thời, xong 1 thì vào 1 mới
 * - Lưu kết quả vào IndexedDB ngay sau mỗi file
 * - Dọn dẹp file đã xoá khỏi ổ cứng
 * - Hỗ trợ cancel qua AbortController
 *
 * @param folderPath - Thư mục chứa file audio
 * @param type - "music" hoặc "sfx"
 * @param apiKey - Gemini API key (truyền từ giao diện)
 * @param onProgress - Callback báo tiến trình
 * @param abortSignal - Signal để dừng scan giữa chừng (optional)
 * @returns Danh sách tất cả items (cũ + mới, đã đồng bộ)
 */
export async function scanAndAnalyzeFolder(
    folderPath: string,
    type: "music" | "sfx",
    apiKey: string,
    onProgress?: (progress: ScanProgress) => void,
    abortSignal?: AbortSignal,
    onItemComplete?: (item: AudioLibraryItem) => void
): Promise<AudioLibraryItem[]> {
    // ===== Bước 1: Quét thư mục =====
    const scannedItems = await scanAudioFolder(folderPath, type);

    // ===== Bước 2: Load dữ liệu đã có từ file JSON trong folder =====
    const existingItems = await loadAudioItemsFromFolder(folderPath);

    // ===== Bước 3: Dọn dẹp metadata file đã bị xoá khỏi ổ cứng =====
    const currentPaths = new Set(scannedItems.map(i => i.filePath));
    const beforeCount = existingItems.length;
    const cleanedExisting = existingItems.filter(item => currentPaths.has(item.filePath));
    const deletedCount = beforeCount - cleanedExisting.length;
    if (deletedCount > 0) {
        console.log(`[AudioLib] 🧹 Đã dọn dẹp ${deletedCount} file ${type} đã xoá khỏi metadata`);
        // Lưu lại file JSON đã dọn
        await saveAudioItemsToFolder(folderPath, cleanedExisting);
    }

    // ===== Bước 4: Tìm file mới chưa có metadata AI =====
    const newFiles = findNewFiles(scannedItems, cleanedExisting);

    if (newFiles.length === 0) {
        console.log(`[AudioLib] Không có file ${type} mới cần quét AI.`);
        onProgress?.({
            current: 0,
            total: 0,
            fileName: "",
            message: `Tất cả file đã có metadata! ${deletedCount > 0 ? `(Đã dọn ${deletedCount} file xoá)` : ""}`,
        });

        // Merge + lưu (đảm bảo file mới cũng được track)
        const merged = mergeItems(scannedItems, cleanedExisting);
        await saveAudioItemsToFolder(folderPath, merged);
        return merged;
    }

    console.log(`[AudioLib] 🆕 ${newFiles.length} file ${type} mới cần AI phân tích (pool ${BATCH_SIZE} đồng thời)`);

    // Theo dõi tất cả items hiện tại (merge scan + existing)
    let allItems = mergeItems(scannedItems, cleanedExisting);

    // ===== Bước 5: Tạo danh sách task — mỗi task phân tích 1 file =====
    let processedCount = 0;

    const tasks = newFiles.map((item) => async (): Promise<AudioLibraryItem> => {
        // Gọi AI phân tích
        const metadata = await analyzeAudioWithAI(item, apiKey);
        item.aiMetadata = metadata;
        item.scannedAt = new Date().toISOString();

        // Cập nhật item trong allItems
        allItems = allItems.map(i => i.filePath === item.filePath ? item : i);

        // Lưu ngay vào file JSON (phòng crash)
        await saveAudioItemsToFolder(folderPath, allItems);

        return item;
    });

    // ===== Bước 6: Chạy concurrency pool (sliding window) =====
    onProgress?.({
        current: 0,
        total: newFiles.length,
        fileName: "",
        message: `Bắt đầu phân tích ${newFiles.length} file (${BATCH_SIZE} đồng thời)...`,
    });

    await runConcurrencyPool(
        tasks,
        BATCH_SIZE,
        abortSignal,
        (item, _index) => {
            processedCount++;
            console.log(`[AudioLib] ✅ [${processedCount}/${newFiles.length}] ${item.fileName}: ${item.aiMetadata?.emotion.join(", ")}`);

            onProgress?.({
                current: processedCount,
                total: newFiles.length,
                fileName: item.fileName,
                message: `${processedCount}/${newFiles.length} — ${item.fileName}`,
            });

            // Gọi callback để UI cập nhật danh sách real-time
            onItemComplete?.(item);
        }
    );

    // ===== Bước 7: Kết quả =====
    const wasCancelled = abortSignal?.aborted;
    onProgress?.({
        current: processedCount,
        total: newFiles.length,
        fileName: "",
        message: wasCancelled
            ? `⏹️ Đã dừng! ${processedCount}/${newFiles.length} file đã phân tích.`
            : `✅ Hoàn tất! Đã phân tích ${processedCount} file ${type} mới.${deletedCount > 0 ? ` Dọn ${deletedCount} file xoá.` : ""}`,
    });

    // Lưu file JSON cuối cùng
    await saveAudioItemsToFolder(folderPath, allItems);
    return allItems;
}

/**
 * Merge danh sách file quét được với items đã có trong DB
 * Ưu tiên giữ metadata từ DB (nếu có)
 */
function mergeItems(
    scannedItems: AudioLibraryItem[],
    existingItems: AudioLibraryItem[]
): AudioLibraryItem[] {
    const existingMap = new Map(existingItems.map(item => [item.filePath, item]));

    return scannedItems.map(scanned => {
        const existing = existingMap.get(scanned.filePath);
        // Nếu đã có metadata AI → giữ nguyên
        if (existing && existing.aiMetadata) {
            return existing;
        }
        return scanned;
    });
}

// ======================== UTILITIES ========================

/**
 * Lấy tất cả items đã có metadata từ danh sách
 * (Dùng để hiển thị trên UI và gửi cho AI Đạo Diễn)
 */
export function getAnalyzedItems(items: AudioLibraryItem[]): AudioLibraryItem[] {
    return items.filter((item) => item.aiMetadata !== null);
}

/**
 * Tạo "Catalog text" từ danh sách items — gửi cho AI Đạo Diễn (Text thuần, rẻ token)
 * Format: "1. nhac_buon.mp3 — [Buồn, Piano] — Tiếng piano chậm rãi..."
 */
export function buildCatalogText(musicItems: AudioLibraryItem[], sfxItems: AudioLibraryItem[]): string {
    const lines: string[] = [];

    // Nhạc nền
    lines.push("=== NHẠC NỀN CÓ SẴN ===");
    const analyzed = getAnalyzedItems(musicItems);
    analyzed.forEach((item, i) => {
        const meta = item.aiMetadata!;
        lines.push(
            `${i + 1}. "${item.fileName}" — [${meta.emotion.join(", ")}] (${meta.intensity}) — ${meta.description}`
        );
    });

    // SFX
    lines.push("\n=== SFX CÓ SẴN ===");
    const sfxAnalyzed = getAnalyzedItems(sfxItems);
    sfxAnalyzed.forEach((item, i) => {
        const meta = item.aiMetadata!;
        lines.push(
            `${i + 1}. "${item.fileName}" — [${meta.tags.join(", ")}] — ${meta.description}`
        );
    });

    return lines.join("\n");
}
