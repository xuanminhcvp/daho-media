// image-converter.ts
// Service convert ảnh tĩnh (jpg/png) → video MP4 ngắn có đúng duration
// Lý do: DaVinci Resolve API KHÔNG hỗ trợ resize still image sau khi import,
// luôn dùng "Standard still duration" (mặc định 5 giây).
// Giải pháp: convert ảnh → video trước, rồi import video vào timeline.
//
// Sử dụng ffmpeg qua Tauri plugin-shell (đã config trong capabilities)

import { Command } from "@tauri-apps/plugin-shell";
import { getFFmpegPath } from "@/utils/ffmpeg-path";

// ======================== CẤU HÌNH ========================

/** Số ảnh convert song song cùng lúc */
const CONCURRENCY = 60;

/** FPS cho video output (khớp với timeline thông thường) */
const DEFAULT_FPS = 24;

// ======================== TYPES ========================

export interface ConvertJob {
    /** Đường dẫn ảnh gốc (jpg/png/webp...) */
    inputPath: string;
    /** Số frame video output (= durationFrames, chính xác hơn giây) */
    durationFrames: number;
    /** Đường dẫn video output (.mp4) */
    outputPath: string;
}

export interface ConvertResult {
    inputPath: string;
    outputPath: string;
    success: boolean;
    error?: string;
}

export interface ConvertProgress {
    current: number;
    total: number;
    message: string;
}

// ======================== HELPER: KIỂM TRA ẢNH TĨNH ========================

/**
 * Kiểm tra file có phải ảnh tĩnh không (dựa vào extension)
 * Ảnh tĩnh cần convert → video trước khi import DaVinci
 */
export function isStillImage(filePath: string): boolean {
    const ext = filePath.toLowerCase().split(".").pop() || "";
    return ["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff", "exr"].includes(ext);
}

// ======================== CONVERT 1 ẢNH ========================

/**
 * Convert 1 ảnh → video MP4 bằng ffmpeg
 *
 * Command: ffmpeg -loop 1 -i input.jpg -c:v libx264 -t 12.5 -pix_fmt yuv420p -r 25 -y output.mp4
 * - `-loop 1`: lặp ảnh
 * - `-t duration`: thời lượng chính xác
 * - `-pix_fmt yuv420p`: tương thích tốt nhất với DaVinci
 * - `-r fps`: frame rate khớp timeline
 * - `-y`: ghi đè nếu tồn tại
 */
async function convertSingleImage(
    inputPath: string,
    outputPath: string,
    durationFrames: number,
    fps: number = DEFAULT_FPS
): Promise<ConvertResult> {
    try {
        // Tạo command string cho sh -c
        // Escape đường dẫn bằng single quotes (xử lý dấu cách, ký tự đặc biệt)
        const escapePath = (p: string) => `'${p.replace(/'/g, "'\\''")}'`

        // Lấy đường dẫn ffmpeg (tự detect theo máy)
        const ffmpegBin = await getFFmpegPath();

        const fullCommand = [
            ffmpegBin,
            "-loop", "1",
            "-framerate", fps.toString(),
            "-i", escapePath(inputPath),
            // Pad width/height thành số chẵn (libx264 yêu cầu divisible by 2)
            "-vf", "'pad=ceil(iw/2)*2:ceil(ih/2)*2'",
            // libx264 ultrafast — nhanh cho ảnh tĩnh
            "-c:v", "libx264", "-preset", "ultrafast",
            // Dùng -frames:v thay -t duration → chính xác frame count
            "-frames:v", String(durationFrames),
            "-pix_fmt", "yuv420p",
            "-r", fps.toString(),
            "-y",
            "-loglevel", "error",
            escapePath(outputPath),
        ].join(" ")

        console.log(`[ImageConverter] 🎥 sh -c:`, fullCommand)

        // Dùng "exec-sh" → sh -c "command" (khai báo trong capabilities)
        const cmd = Command.create("exec-sh", ["-c", fullCommand])

        const output = await cmd.execute()

        console.log(`[ImageConverter] exit code: ${output.code}, stderr: ${output.stderr?.slice(0, 200)}`)

        if (output.code !== 0) {
            const errorMsg = output.stderr || `ffmpeg exit code ${output.code}`
            console.error(`[ImageConverter] ❌ ${inputPath}: ${errorMsg}`)
            return { inputPath, outputPath, success: false, error: errorMsg }
        }

        console.log(`[ImageConverter] ✅ ${outputPath}`)
        return { inputPath, outputPath, success: true };
    } catch (error) {
        const errorMsg = String(error);
        console.error(`[ImageConverter] ❌ ${inputPath}: ${errorMsg}`);
        return { inputPath, outputPath, success: false, error: errorMsg };
    }
}

// ======================== CONVERT SONG SONG ========================

/**
 * Convert nhiều ảnh → video song song (batch N ảnh cùng lúc)
 *
 * @param jobs - Danh sách ảnh cần convert (inputPath, duration, outputPath)
 * @param fps - FPS cho video output (nên khớp timeline)
 * @param onProgress - Callback cập nhật tiến trình
 * @returns Kết quả convert cho từng ảnh
 */
export async function convertImagesToVideo(
    jobs: ConvertJob[],
    fps: number = DEFAULT_FPS,
    onProgress?: (progress: ConvertProgress) => void
): Promise<ConvertResult[]> {
    if (jobs.length === 0) return [];

    console.log(`[ImageConverter] 🎬 Bắt đầu convert ${jobs.length} ảnh → video (${CONCURRENCY} song song, ${fps}fps)`);

    const results: ConvertResult[] = [];
    let completed = 0;

    // Chia thành batch, mỗi batch CONCURRENCY ảnh song song
    for (let i = 0; i < jobs.length; i += CONCURRENCY) {
        const batch = jobs.slice(i, i + CONCURRENCY);

        // Chạy song song trong batch
        const batchResults = await Promise.all(
            batch.map(async (job) => {
                const result = await convertSingleImage(job.inputPath, job.outputPath, job.durationFrames, fps);
                completed++;

                // Cập nhật progress
                onProgress?.({
                    current: completed,
                    total: jobs.length,
                    message: `Đang convert ảnh → video: ${completed}/${jobs.length}`,
                });

                return result;
            })
        );

        results.push(...batchResults);
    }

    // ======================== RETRY ẢNH CONVERT LỖI ========================
    // Retry tối đa 3 lần cho ảnh bị lỗi (ffmpeg occasionally fails)
    const MAX_CONVERT_RETRIES = 3;

    for (let retry = 1; retry <= MAX_CONVERT_RETRIES; retry++) {
        // Tìm ảnh failed
        const failedIndices = results
            .map((r, idx) => ({ r, idx }))
            .filter(({ r }) => !r.success);

        if (failedIndices.length === 0) break; // Hết lỗi → dừng

        console.log(`[ImageConverter] 🔄 Retry ${retry}/${MAX_CONVERT_RETRIES}: ${failedIndices.length} ảnh lỗi`);

        // Retry từng ảnh failed
        for (const { r, idx } of failedIndices) {
            // Tìm job tương ứng
            const job = jobs.find(j => j.inputPath === r.inputPath);
            if (!job) continue;

            console.log(`[ImageConverter] 🔄 Retry ${retry}: ${r.inputPath.split("/").pop()}`);
            const retryResult = await convertSingleImage(job.inputPath, job.outputPath, job.durationFrames, fps);

            if (retryResult.success) {
                // Ghi đè kết quả cũ
                results[idx] = retryResult;
                console.log(`[ImageConverter] ✅ Retry ${retry} OK: ${r.inputPath.split("/").pop()}`);
            }
        }
    }

    // Thống kê
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    console.log(`[ImageConverter] ✅ Hoàn tất: ${successCount} thành công, ${failCount} lỗi`);

    return results;
}

// ======================== THƯ MỤC TẠM ========================

/** Thư mục lưu video tạm — macOS tự dọn /tmp/ khi restart */
const TEMP_DIR = "/tmp/autosubs-convert";

/**
 * Tạo thư mục /tmp/autosubs-convert/ nếu chưa có
 * Nếu đã có nhưng không có quyền ghi (do user khác tạo) → xóa và tạo lại
 * Gọi trước khi convert batch đầu tiên
 */
export async function ensureTempDir(): Promise<void> {
    try {
        // Bước 1: Kiểm tra folder đã tồn tại và có quyền ghi không
        const checkCmd = Command.create("exec-sh", ["-c",
            `if [ -d '${TEMP_DIR}' ]; then
                if [ -w '${TEMP_DIR}' ]; then
                    echo "OK"
                else
                    echo "NO_WRITE"
                fi
            else
                echo "NOT_EXIST"
            fi`
        ]);
        const checkResult = await checkCmd.execute();
        const status = checkResult.stdout.trim();

        if (status === "NO_WRITE") {
            // Folder tồn tại nhưng không có quyền ghi (user khác tạo)
            // → Xóa và tạo lại
            console.warn("[ImageConverter] ⚠️ /tmp/autosubs-convert/ không có quyền ghi → tạo lại");
            const rmCmd = Command.create("exec-sh", ["-c", `rm -rf '${TEMP_DIR}' && mkdir -p '${TEMP_DIR}'`]);
            await rmCmd.execute();
        } else if (status === "NOT_EXIST") {
            // Folder chưa tồn tại → tạo mới
            const mkCmd = Command.create("exec-sh", ["-c", `mkdir -p '${TEMP_DIR}'`]);
            await mkCmd.execute();
        }
        // status === "OK" → folder đã có và có quyền ghi → không cần làm gì
    } catch (e) {
        console.warn("[ImageConverter] ⚠️ Không tạo được thư mục temp:", e);
    }
}

// ======================== TẠO OUTPUT PATH ========================

/**
 * Tạo đường dẫn output video (.mp4) trong thư mục /tmp/autosubs-convert/
 * Lấy tên file gốc, thêm suffix "_autosubs.mp4"
 *
 * Ví dụ: /path/to/SCENE_01.jpg → /tmp/autosubs-convert/SCENE_01_autosubs.mp4
 */
export function getVideoOutputPath(imagePath: string): string {
    // Lấy tên file (không có folder)
    const fileName = imagePath.split("/").pop()?.split("\\").pop() || "image";
    // Bỏ extension gốc
    const lastDot = fileName.lastIndexOf(".");
    const baseName = lastDot > 0 ? fileName.substring(0, lastDot) : fileName;
    return `${TEMP_DIR}/${baseName}_autosubs.mp4`;
}
