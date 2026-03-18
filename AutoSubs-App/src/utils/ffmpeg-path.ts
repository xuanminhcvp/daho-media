// ============================================================
// ffmpeg-path.ts — Helper tìm đường dẫn ffmpeg/ffprobe
// 
// Vấn đề: macOS GUI app KHÔNG có /opt/homebrew/bin trong PATH
// → gọi "ffmpeg" trực tiếp sẽ lỗi "No such file or directory"
//
// Giải pháp: Tìm ffmpeg theo thứ tự ưu tiên:
// 1. Bundled trong app (production) 
// 2. /opt/homebrew/bin/ — macOS ARM (Homebrew)
// 3. /usr/local/bin/ — macOS Intel (Homebrew)
// 4. /usr/bin/ — System
// ============================================================

import { Command } from "@tauri-apps/plugin-shell";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { appCacheDir, join } from "@tauri-apps/api/path";

/**
 * Danh sách đường dẫn ffmpeg phổ biến trên macOS
 * Thứ tự: Bundled → Homebrew ARM → Homebrew Intel → System
 */
const FFMPEG_CANDIDATES = [
    // Bundled trong app (Tauri sidecar — tên có suffix architecture)
    "/Applications/AutoSubs_Media.app/Contents/MacOS/ffmpeg-aarch64-apple-darwin",
    // Bundled trong app (tên ngắn — có khi Tauri export tên ngắn)
    "/Applications/AutoSubs_Media.app/Contents/MacOS/ffmpeg",
    // Homebrew ARM (M1/M2/M3/M4)
    "/opt/homebrew/bin/ffmpeg",
    // Homebrew Intel
    "/usr/local/bin/ffmpeg",
    // System default
    "/usr/bin/ffmpeg",
];

const FFPROBE_CANDIDATES = [
    // Bundled trong app (Tauri sidecar — tên có suffix architecture)
    "/Applications/AutoSubs_Media.app/Contents/MacOS/ffprobe-aarch64-apple-darwin",
    // Bundled trong app (tên ngắn)
    "/Applications/AutoSubs_Media.app/Contents/MacOS/ffprobe",
    // Homebrew ARM (M1/M2/M3/M4)
    "/opt/homebrew/bin/ffprobe",
    // Homebrew Intel
    "/usr/local/bin/ffprobe",
    // System default
    "/usr/bin/ffprobe",
];

/** Cache kết quả để không check lại mỗi lần */
let cachedFFmpegPath: string | null = null;
let cachedFFprobePath: string | null = null;

/**
 * Tìm đường dẫn ffmpeg có thể chạy được trên máy hiện tại
 * @returns Full path tới ffmpeg
 */
export async function getFFmpegPath(): Promise<string> {
    if (cachedFFmpegPath) return cachedFFmpegPath;

    for (const candidate of FFMPEG_CANDIDATES) {
        try {
            const cmd = Command.create("exec-sh", ["-c", `test -x '${candidate}' && echo OK`]);
            const output = await cmd.execute();
            if (output.stdout.trim() === "OK") {
                cachedFFmpegPath = candidate;
                console.log(`[FFmpegPath] ✅ Found ffmpeg: ${candidate}`);
                return candidate;
            }
        } catch {
            // Candidate không tồn tại → thử tiếp
        }
    }

    console.warn("[FFmpegPath] ⚠️ Không tìm thấy ffmpeg, dùng tên ngắn fallback");
    return "ffmpeg";
}

/**
 * Tìm đường dẫn ffprobe
 */
export async function getFFprobePath(): Promise<string> {
    if (cachedFFprobePath) return cachedFFprobePath;

    for (const candidate of FFPROBE_CANDIDATES) {
        try {
            const cmd = Command.create("exec-sh", ["-c", `test -x '${candidate}' && echo OK`]);
            const output = await cmd.execute();
            if (output.stdout.trim() === "OK") {
                cachedFFprobePath = candidate;
                console.log(`[FFmpegPath] ✅ Found ffprobe: ${candidate}`);
                return candidate;
            }
        } catch {
            // tiếp
        }
    }

    console.warn("[FFmpegPath] ⚠️ Không tìm thấy ffprobe");
    return "ffprobe";
}

// ============================================================
// SHELL ESCAPING — An toàn cho filter_complex chứa [], ;, |
// ============================================================

/**
 * Escape 1 arg cho bash single-quote (bảo toàn tất cả ký tự đặc biệt)
 * Ví dụ: "hello 'world'" → "'hello '\\''world'\\'''"
 * Trong single quotes, bash KHÔNG interpret bất kỳ ký tự nào (trừ ')
 */
function shellEscapeArg(arg: string): string {
    return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Chạy ffmpeg với full path — escape AN TOÀN tất cả args
 * Mỗi arg được bọc single quotes → [], ;, | KHÔNG bị shell interpret
 */
export async function runFFmpegSafe(args: string[]): Promise<{
    code: number;
    stdout: string;
    stderr: string;
}> {
    const ffmpegPath = await getFFmpegPath();
    // Single-quote mỗi arg → bảo toàn [], ;, |, dấu cách, v.v.
    const escapedArgs = args.map(shellEscapeArg).join(" ");
    const fullCommand = `${ffmpegPath} ${escapedArgs}`;

    console.log(`[FFmpegPath] 🚀 Running: ${ffmpegPath} (${args.length} args)`);

    const cmd = Command.create("exec-sh", ["-c", fullCommand]);
    const result = await cmd.execute();
    return {
        code: result.code ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
    };
}

/**
 * Chạy ffmpeg với -filter_complex_script (AN TOÀN NHẤT cho filter phức tạp)
 * Ghi filter ra file tạm → ffmpeg đọc từ file → tránh hoàn toàn shell escaping
 * 
 * Dùng cho: BGM mix, SFX mix (filter dài hàng trăm ký tự với [], ;)
 * 
 * @param argsBeforeFilter - Args trước -filter_complex (ví dụ: ["-y", "-i", "file1.wav", ...])
 * @param filterComplex - Nội dung filter_complex (ví dụ: "[0:a][1:a]acrossfade=...")
 * @param argsAfterFilter - Args sau filter (ví dụ: ["-map", "[out]", "-c:a", "pcm_s16le", "output.wav"])
 */
export async function runFFmpegWithFilterScript(
    argsBeforeFilter: string[],
    filterComplex: string,
    argsAfterFilter: string[]
): Promise<{
    code: number;
    stdout: string;
    stderr: string;
}> {
    const ffmpegPath = await getFFmpegPath();

    // Ghi filter_complex ra file tạm
    const cacheDir = await appCacheDir();
    const filterFile = await join(cacheDir, `autosubs_filter_${Date.now()}.txt`);
    await writeTextFile(filterFile, filterComplex);

    // Build command: ffmpeg [args_before] -filter_complex_script /tmp/filter.txt [args_after]
    const allArgs = [
        ...argsBeforeFilter,
        "-filter_complex_script", filterFile,
        ...argsAfterFilter,
    ];
    const escapedArgs = allArgs.map(shellEscapeArg).join(" ");
    const fullCommand = `${ffmpegPath} ${escapedArgs}`;

    console.log(`[FFmpegPath] 🚀 Running with filter_script: ${ffmpegPath} (filter ${filterComplex.length} chars)`);

    const cmd = Command.create("exec-sh", ["-c", fullCommand]);
    const result = await cmd.execute();

    // Cleanup file tạm (best effort)
    try {
        const rmCmd = Command.create("exec-sh", ["-c", `rm -f '${filterFile}'`]);
        await rmCmd.execute();
    } catch { /* ignore */ }

    return {
        code: result.code ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
    };
}
