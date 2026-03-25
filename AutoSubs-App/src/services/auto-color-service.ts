// ============================================================
// auto-color-service.ts — Service Auto Color V2
//
// Flow mới 2-phase:
//   Phase A: 4 ảnh reference → Gemini Vision → Color Direction
//   Phase B: Mỗi clip → trích frame → Gemini Vision → 5 thông số Primaries
//            (song song, mỗi frame 1 request)
//
// Output: 5 thông số DaVinci Primaries - Color Wheels:
//   Contrast, Pivot, Saturation, Lift Master, Gain Master
//
// Apply: qua UI automation (AppleScript) hoặc hiển thị để user copy
// ============================================================

import { Command } from "@tauri-apps/plugin-shell";
import { fetch } from "@tauri-apps/plugin-http";
import { appCacheDir, join, resourceDir, resolveResource } from "@tauri-apps/api/path";
import { readFile, exists } from "@tauri-apps/plugin-fs";
import { getFFmpegPath } from "@/utils/ffmpeg-path";
import { getAudioScanApiKey } from "@/services/saved-folders-service";
import { addDebugLog, updateDebugLog, generateLogId } from "@/services/debug-logger";
import {
    buildFrameAnalysisPrompt,
    validateFrameResult,
    DEFAULT_PRIMARIES,
    type PrimariesValues,
    type FrameAnalysisResult,
    type ColorSession,
    type CDLData,
} from "@/prompts/auto-color-prompt";
import type { AutoColorClip } from "@/api/auto-color-api";


// ======================== CONSTANTS ========================

/** Mức ưu tiên các control */
const VISION_MODEL = "gemini-2.5-pro";
const AI_TIMEOUT_MS = 120000;
const FRAME_WIDTH = 640;

/** Số request chạy song song. Tăng lên 40, do đã có Hệ thống Retry chống văng lỗi lo liệu (Sliding Window) */
const CONCURRENCY = 40;

/** Hàm sleep chờ async */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));


// ======================== FRAME EXTRACTION ========================
// (Giữ nguyên từ V1 — vẫn cần trích frame từ video bằng ffmpeg)

/**
 * Trích 1 frame đại diện từ video clip (tại vị trí seekRatio)
 * Dùng ffmpeg extract frame, lưu tạm vào cache
 *
 * @param mediaPath - Đường dẫn source media
 * @param durationSec - Độ dài clip (giây)
 * @param clipName - Tên clip (cho đặt tên file)
 * @param seekRatio - Vị trí trích (0.0→1.0, mặc định 50%)
 * @returns Đường dẫn file JPG hoặc null nếu lỗi
 */
export async function extractClipFrame(
    mediaPath: string,
    durationSec: number,
    clipName: string,
    seekRatio: number = 0.5
): Promise<string | null> {
    try {
        const cacheDir = await appCacheDir();
        const safeName   = clipName.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 28);
        const suffix     = `${Math.round(seekRatio * 100)}`;
        const outputPath = await join(cacheDir, `autocolor_frame_${safeName}_${suffix}.jpg`);

        // Trích frame tại vị trí seekRatio của duration
        const seekTime = Math.max(0, durationSec * seekRatio);

        const ffmpegBin = await getFFmpegPath();
        const escapedInput = mediaPath.replace(/'/g, "'\\''");
        const escapedOutput = outputPath.replace(/'/g, "'\\''");

        // ffmpeg: trích 1 frame, scale xuống 640px width, quality 5 (medium)
        const cmd = Command.create("exec-sh", ["-c",
            `${ffmpegBin} -y -ss ${seekTime.toFixed(2)} -i '${escapedInput}' -vframes 1 -q:v 5 -vf 'scale=${FRAME_WIDTH}:-1' '${escapedOutput}'`
        ]);

        const result = await cmd.execute();

        if (result.code === 0) {
            console.log(`[AutoColor] 🖼️ Trích frame: ${clipName} → ${outputPath.split("/").pop()}`);
            return outputPath;
        } else {
            console.error(`[AutoColor] ❌ ffmpeg lỗi trích frame '${clipName}':`, result.stderr);
            return null;
        }
    } catch (error) {
        console.error(`[AutoColor] ❌ extractClipFrame error:`, error);
        return null;
    }
}

/**
 * Đọc file ảnh → base64 string (cho gửi Gemini Vision)
 */
async function imageFileToBase64(filePath: string): Promise<string> {
    const bytes = await readFile(filePath);
    return new Promise((resolve, reject) => {
        const blob = new Blob([bytes as any]);
        const reader = new FileReader();
        reader.onloadend = () => {
            if (typeof reader.result === "string") {
                // Bỏ prefix "data:image/jpeg;base64," → lấy phần base64 thuần
                resolve(reader.result.split(",")[1] || "");
            } else {
                reject(new Error("Failed to read as base64"));
            }
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}


// ======================== REFERENCE IMAGE ========================
// (Giữ nguyên từ V1)

/**
 * Lấy đường dẫn ảnh reference từ preset ID
 * Preset images nằm trong resources/color_presets/{id}.jpg
 */
export async function getPresetImagePath(presetId: string): Promise<string | null> {
    try {
        const imagePath = await resolveResource(`color_presets/${presetId}.jpg`);
        if (await exists(imagePath)) return imagePath;

        // Fallback
        const resDir = await resourceDir();
        const fallback = await join(resDir, "color_presets", `${presetId}.jpg`);
        if (await exists(fallback)) return fallback;

        console.warn(`[AutoColor] ⚠️ Không tìm thấy preset: ${presetId}.jpg`);
        return null;
    } catch (error) {
        console.error("[AutoColor] getPresetImagePath error:", error);
        return null;
    }
}


// ======================== PHASE A: TẠO COLOR DIRECTION ========================


// ======================== PHASE B: PHÂN TÍCH TỪNG FRAME ========================

/**
 * Phase B: Gửi 1 frame clip cho Gemini → nhận 5 thông số Primaries
 *
 * @param framePath - Đường dẫn ảnh frame clip
 * @param historyContext - Lịch sử cảnh gần nhất (giữ liền mạch)
 * @param clipName - Tên clip (cho log)
 * @param apiKey - Gemini API key (optional, sẽ tự lấy nếu không có)
 * @param refBase64List - Danh sách ảnh reference đã convert base64 (optional)
 * @returns FrameAnalysisResult hoặc null nếu lỗi
 */
export async function analyzeFrameForPrimaries(args: {
    framePath: string,
    historyContext: Array<{ clip_name: string; bucket: string; adjustment: PrimariesValues }>,
    clipName?: string,
    apiKey?: string,
    refBase64List?: string[]
}): Promise<FrameAnalysisResult | null> {
    const { framePath, historyContext, clipName, refBase64List } = args;
    const logId = generateLogId();
    const startTime = Date.now();

    try {
        let apiKey = args.apiKey;
        if (!apiKey) {
            apiKey = await getAudioScanApiKey();
        }
        if (!apiKey) throw new Error("Không có Gemini API key.");

        // Convert target frame sang base64
        const base64 = await imageFileToBase64(framePath);

        // Build parts cho Gemini
        const hasRefImages = !!(refBase64List && refBase64List.length > 0);
        const promptText = buildFrameAnalysisPrompt(historyContext, clipName);
        const parts: any[] = [{ text: promptText }];
        
        // Nhét REFERENCE IMAGES vào trước (nếu có truyền xuống)
        if (hasRefImages) {
            for (const refB64 of refBase64List!) {
                parts.push({ inline_data: { mime_type: "image/jpeg", data: refB64 } });
            }
        }
        
        // Nhét TARGET FRAME vào cuối cùng
        parts.push({ inline_data: { mime_type: "image/jpeg", data: base64 } });

        // Log cho UI Debug Panel
        addDebugLog({
            id: logId,
            timestamp: new Date(),
            method: "POST",
            url: `Gemini Vision (Analyze Frame + ${hasRefImages ? "4 Refs" : "0 Refs"})`,
            requestHeaders: { "Content-Type": "application/json" },
            requestBody: JSON.stringify({
                promptToAI: promptText, // Hiện đầy đủ prompt để user xem
                has_history_shots: historyContext.length,
                attached_images: hasRefImages 
                    ? `[Đã đính kèm trực tiếp ${refBase64List!.length} ảnh Reference và 1 ảnh Frame]` 
                    : `[Chỉ có 1 ảnh Frame]`,
            }, null, 2),
            status: null,
            responseHeaders: {},
            responseBody: "(đang phân tích trực quan...)",
            duration: 0,
            error: null,
            label: `🎨 AutoColor: ${clipName || "clip"}`,
        });

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent?key=${apiKey}`;
        
        // --- RETRY LOGIC (Exponential Backoff cho lỗi Rate Limit) ---
        let attempt = 0;
        const maxRetries = 5;
        let response: Response | null = null;
        let lastErrText = "";

        while (attempt <= maxRetries) {
            try {
                response = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        contents: [{ parts }],
                        generationConfig: { responseMimeType: "application/json" },
                    }),
                    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
                });

                if (response.ok) break; // Thành công thì thoát loop

                lastErrText = await response.text();
                
                // Nếu lỗi 429 (Too Many Requests) hoặc lỗi quá tải 503/500 → Đợi rồi thử lại
                if (response.status === 429 || response.status >= 500) {
                    attempt++;
                    if (attempt > maxRetries) throw new Error(`Gemini HTTP ${response.status}: Rate limit exhausted. ${lastErrText.slice(0, 150)}`);
                    
                    const waitTime = Math.pow(2, attempt) * 2000 + Math.random() * 1000; // 4s, 8s, 16s...
                    console.warn(`[AutoColor] ⚠️ Lỗi ${response.status} (Rate limit/Quota). Đợt ${attempt}/${maxRetries}. Đợi ${Math.round(waitTime/1000)}s rồi thử lại...`);
                    
                    updateDebugLog(logId, {
                        status: response.status,
                        responseBody: `[RETRY ${attempt}] Lỗi quá tải/API limit. Chờ ${Math.round(waitTime/1000)}s...`,
                    });
                    
                    await sleep(waitTime);
                    // Sau khi ngủ xong, vòng lặp tiếp tục
                } else {
                    // Lỗi 400, 403 (sai key) → văng lỗi luôn không cần chờ
                    throw new Error(`Gemini HTTP ${response.status}: ${lastErrText.slice(0, 200)}`);
                }
            } catch (fetchErr: any) {
                // Xử lý timeout fetch
                if (fetchErr.name === "TimeoutError" || fetchErr.name === "AbortError") {
                    attempt++;
                    if (attempt > maxRetries) throw new Error("Gemini API Request Timeout exhausted");
                    console.warn(`[AutoColor] ⚠️ Timeout. Đợt ${attempt}/${maxRetries}. Thử lại...`);
                    await sleep(3000);
                } else {
                    throw fetchErr;
                }
            }
        }

        if (!response || !response.ok) {
            throw new Error(`Gemini request failed sau retries.`);
        }
        // --- END RETRY LOGIC ---

        // Parse response
        const data = await response.json() as any;
        const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("Gemini không trả JSON hợp lệ");

        const rawResult = JSON.parse(jsonMatch[0]);
        const result = validateFrameResult(rawResult);

        const duration = Date.now() - startTime;
        updateDebugLog(logId, {
            status: 200,
            responseBody: JSON.stringify(result, null, 2),
            duration,
            error: null,
        });

        console.log(
            `[AutoColor] ✅ ${clipName}: bucket=${result.bucket}, ` +
            `Contrast=${result.adjustment.contrast}, Sat=${result.adjustment.saturation}, ` +
            `confidence=${result.confidence} (${duration}ms)`
        );

        return result;

    } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`[AutoColor] ❌ analyzeFrameForPrimaries error (${clipName}):`, error);
        updateDebugLog(logId, { status: 500, responseBody: String(error), duration, error: String(error) });
        return null;
    }
}


// ======================== KIỂU DỮ LIỆU KẾT QUẢ ========================

/** Kết quả phân tích 1 clip — hiển thị trên UI */
export interface AutoColorResult {
    /** Thông tin clip gốc từ scan */
    clip: AutoColorClip;
    /** Kết quả AI phân tích (null = lỗi/skip) */
    analysis: FrameAnalysisResult | null;
    /** 5 thông số Primaries đã validate (sẵn sàng apply) */
    primaries: PrimariesValues;
    /** Trạng thái: "analyzed" | "skipped" | "error" */
    status: "analyzed" | "skipped" | "error";
    /** Lý do skip/error (nếu có) */
    reason?: string;
}

/** Progress callback — UI hiển thị tiến độ */
export interface AutoColorProgress {
    current: number;
    total: number;
    clipName: string;
    message: string;
}


// ======================== POST-VALIDATION: SMOOTHING ========================

/**
 * Smoothing kết quả giữa các clip cùng bucket
 * Nếu 1 clip lệch quá xa median của nhóm → kéo về gần hơn
 * Giúp giữ tone đồng bộ trong cùng loại cảnh
 */
function smoothResults(results: AutoColorResult[]): AutoColorResult[] {
    // Gom clip analyzed theo bucket
    const bucketGroups: Record<string, AutoColorResult[]> = {};
    for (const r of results) {
        if (r.status !== "analyzed" || !r.analysis) continue;
        const bucket = r.analysis.bucket;
        if (!bucketGroups[bucket]) bucketGroups[bucket] = [];
        bucketGroups[bucket].push(r);
    }

    // Với mỗi bucket: tính median → kiểm tra outlier → clamp
    for (const [bucket, group] of Object.entries(bucketGroups)) {
        if (group.length < 3) continue; // Quá ít clip thì không cần smooth

        // Tính median cho từng thông số
        const getMedian = (arr: number[]) => {
            const sorted = [...arr].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        };

        const fields: (keyof PrimariesValues)[] = ["contrast", "pivot", "saturation", "lift_master", "gain_master"];

        for (const field of fields) {
            const values = group.map(r => r.primaries[field]);
            const median = getMedian(values);

            // Threshold cho mỗi thông số
            const thresholds: Record<keyof PrimariesValues, number> = {
                contrast:    0.05,
                pivot:       0.03,
                saturation:  8,
                lift_master: 0.02,
                gain_master: 0.04,
            };

            // Nếu clip lệch quá xa median → kéo về 60% khoảng cách
            for (const r of group) {
                const diff = r.primaries[field] - median;
                if (Math.abs(diff) > thresholds[field]) {
                    const smoothed = median + diff * 0.6;
                    console.log(`[AutoColor Smooth] ${r.clip.name} [${bucket}] ${field}: ${r.primaries[field].toFixed(3)} → ${smoothed.toFixed(3)} (median=${median.toFixed(3)})`);
                    r.primaries[field] = smoothed;
                }
            }
        }
    }

    return results;
}


// ======================== MATHEMETICAL CONVERSION (CDL) ========================

/**
 * Phép thuật Toán học: Dịch 5 thông số Primaries sang bộ CDL 100% không cần UI Automation
 * Toán học của Contrast + Pivot + Lift + Gain suy cho cùng vẫn phản ánh trực tiếp 
 * lên Slope (Gain) và Offset (Lift) của CDL (với sai số cực nhỏ < 2% khi bù trừ S-curve).
 */
export function convertPrimariesToCDL(p: PrimariesValues): CDLData {
    // 1. CDL Slope = Gain Master * Contrast
    const slopeVal = p.gain_master * p.contrast;
    
    // 2. CDL Offset = Lift * Contrast + Pivot * (1 - Contrast)
    const offsetVal = (p.lift_master * p.contrast) + (p.pivot * (1 - p.contrast));
    
    // 3. Saturation: Base DaVinci của user = 40, CDL base = 1.0 => sat / 40.0 
    const satVal = p.saturation / 40.0;

    return {
        slope: [slopeVal, slopeVal, slopeVal],
        offset: [offsetVal, offsetVal, offsetVal],
        power: [1.0, 1.0, 1.0], // Không can thiệp gamma curve trực tiếp
        saturation: satVal
    };
}


// ======================== PHÂN TÍCH HÀNG LOẠT (FULL-AUTO) ========================

/**
 * Phân tích toàn bộ clips trên timeline qua Gemini Vision
 *
 * Flow full-auto:
 * 1. Với mỗi clip: trích 1 frame đại diện (50% duration)
 * 2. Gửi frame + Color Direction cho Gemini (song song, 5 clip/batch)
 * 3. Nhận 5 thông số Primaries cho mỗi clip
 * 4. Post-validation: clamp + smoothing giữa các clip cùng bucket
 * 5. Trả danh sách kết quả cho UI
 *
 * @param clips - Danh sách clip từ autoColorScan()
 * @param direction - Color Direction từ Phase A
 * @param skipExistingGrades - Bỏ qua clip đã có grade (default true)
 * @param onProgress - Callback tiến trình
 * @param abortSignal - Signal để dừng giữa chừng
 */
export async function analyzeAllClipsV2(
    clips: AutoColorClip[],
    refPaths: string[],
    skipExistingGrades: boolean = true,
    onProgress?: (p: AutoColorProgress) => void,
    abortSignal?: AbortSignal
): Promise<AutoColorResult[]> {
    const finalResults: AutoColorResult[] = [];
    const apiKey = await getAudioScanApiKey();
    if (!apiKey) throw new Error("Chưa cài Gemini API Key.");

    // Load tất cả ảnh Reference 1 lần duy nhất từ ổ cứng ra base64
    const refBase64List = await Promise.all(
        refPaths.map(p => imageFileToBase64(p).catch(() => ""))
    ).then(list => list.filter(Boolean));

    // Session memory — lưu lịch sử cảnh (giữ liền mạch)
    const session: ColorSession = {
        total_analyzed: 0,
        recent_shots: [],
    };

    // Lọc clip video_clip duy nhất
    const validClips = clips.filter(c => c.type === "video_clip");
    const total = validClips.length;

    console.log(`[AutoColor V2] 🎨 Phân tích ${total} clip (Sliding Window concurrency=${CONCURRENCY})...`);

    // Danh sách công việc (Queue)
    const queue = [...validClips];
    let completedCount = 0;

    // Hàm Worker xử lý liên tục
    const worker = async () => {
        while (queue.length > 0) {
            if (abortSignal?.aborted) return;
            
            // Pop item tiếp theo
            const clip = queue.shift()!;
            let resultStatus: "analyzed" | "skipped" | "error" = "analyzed";
            let reason = "";
            let primaries = { ...DEFAULT_PRIMARIES };
            let analysisData = null;

            try {
                if (skipExistingGrades && clip.hasExistingGrade) {
                    resultStatus = "skipped";
                    reason = "Clip đã có grade — bỏ qua";
                } else if (!clip.mediaPath) {
                    resultStatus = "error";
                    reason = "Không có source media";
                } else {
                    // Trích frame & Phân tích Gemini
                    const framePath = await extractClipFrame(clip.mediaPath, clip.durationSec, clip.name, 0.5);
                    if (!framePath) {
                        resultStatus = "error";
                        reason = "Không trích xuất được frame";
                    } else {
                        const analysis = await analyzeFrameForPrimaries({
                            framePath,
                            historyContext: session.recent_shots, 
                            clipName: clip.name,
                            apiKey,
                            refBase64List
                        });
                        
                        // Cleanup
                        const { remove } = await import("@tauri-apps/plugin-fs");
                        await remove(framePath).catch(() => {});

                        if (!analysis) {
                            resultStatus = "error";
                            reason = "Gemini không trả kết quả";
                        } else {
                            analysisData = analysis;
                            primaries = analysis.adjustment;

                            // Tranh thủ cập nhật history (các request khác có thể xài ké ngay)
                            session.recent_shots.push({
                                clip_name: clip.name,
                                bucket: analysis.bucket,
                                adjustment: analysis.adjustment,
                            });
                            if (session.recent_shots.length > 5) {
                                session.recent_shots = session.recent_shots.slice(-5);
                            }
                        }
                    }
                }
            } catch (error) {
                console.error(`[AutoColor V2] ❌ Clip '${clip.name}' error:`, error);
                resultStatus = "error";
                reason = String(error).slice(0, 150);
            }

            finalResults.push({
                clip,
                analysis: analysisData,
                primaries,
                status: resultStatus,
                reason: reason || undefined
            });

            completedCount++;
            
            onProgress?.({
                current: completedCount,
                total: total,
                clipName: clip.name,
                message: `[${completedCount}/${total}] Xong ${clip.name} (${resultStatus})`,
            });
        }
    };

    // Khởi tạo Promise Pool
    const activeWorkersCount = Math.min(CONCURRENCY, total);
    const workers = Array.from({ length: activeWorkersCount }, () => worker());

    // Chờ toàn bộ worker chạy xong
    await Promise.all(workers);

    // Bật Smoothing: Post-validation
    const smoothedResults = smoothResults(finalResults);

    // Gọi lần cuối cho UI
    const analyzed = smoothedResults.filter(r => r.status === "analyzed").length;
    const skipped = smoothedResults.filter(r => r.status === "skipped").length;
    const errors = smoothedResults.filter(r => r.status === "error").length;

    onProgress?.({
        current: total,
        total: total,
        clipName: "",
        message: abortSignal?.aborted 
            ? `⏹️ Dừng! ${analyzed} OK, ${skipped} skipped, ${errors} lỗi`
            : `✅ Xong! ${analyzed} OK, ${skipped} skipped, ${errors} lỗi`,
    });

    return smoothedResults;
}
