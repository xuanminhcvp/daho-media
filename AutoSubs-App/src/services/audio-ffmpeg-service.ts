import { Command } from "@tauri-apps/plugin-shell";
import { join } from "@tauri-apps/api/path";
import { addDebugLog, updateDebugLog, generateLogId } from "./debug-logger";
import { runFFmpegWithFilterScript, runFFmpegSafe } from "@/utils/ffmpeg-path";

export interface MixAudioConfig {
    outputFolder: string;
    outputFileName?: string;
    scenes: Array<{
        filePath: string | null;
        startTime: number;
        endTime: number;
        startOffset: number;
    }>;
    sentences: Array<{
        start: number;
        end: number;
    }>;
    duckingVolume?: number; // Volume of BGM during speech. e.g. 0.2
    duckingFadeDuration?: number; // e.g. 0.5 seconds
    onProgress?: (progressStr: string) => void;
}

export async function mixAudioScenesAndDuck(config: MixAudioConfig) {
    const logId = generateLogId();
    const startTimeMs = Date.now();

    // Default ducking to 25% volume during speech
    const duckVol = config.duckingVolume ?? 0.25;

    // 1. Build contiguous scenes array to handle gaps
    const continuousScenes: Array<{ isSilence: boolean; filePath: string | null; inputIdx: number; dur: number; offset: number; XFADE: number }> = [];
    let currentTimeline = 0;
    const XFADE = 1.5;

    for (let i = 0; i < config.scenes.length; i++) {
        const scene = config.scenes[i];

        if (scene.startTime > currentTimeline + 0.1) {
            // Gap detected, fill with silence
            continuousScenes.push({
                isSilence: true,
                filePath: null,
                inputIdx: -1,
                dur: scene.startTime - currentTimeline + XFADE,
                offset: 0,
                XFADE: XFADE
            });
            currentTimeline = scene.startTime;
        }

        const isLast = i === config.scenes.length - 1;
        const dur = (scene.endTime - currentTimeline) + (isLast ? 0 : XFADE);

        continuousScenes.push({
            isSilence: !scene.filePath,
            filePath: scene.filePath,
            inputIdx: -1,
            dur: dur,
            offset: scene.startOffset,
            XFADE: isLast ? 0 : XFADE
        });
        currentTimeline = Math.max(currentTimeline, scene.endTime);
    }

    // ===== TRIM: Nhạc nền KHÔNG dài hơn câu nói cuối + 3s buffer =====
    // Vấn đề: Scene cuối thường có endTime = tổng thời lượng video (vd: 2974s)
    // Nhưng giọng nói kết thúc sớm hơn nhiều (vd: 2380s) → 11 phút thừa
    // Fix: Cắt totalDur tại câu nói cuối + 3s, không cho nhạc nền render dài hơn
    const latestSentenceEnd = config.sentences.length > 0 ? config.sentences[config.sentences.length - 1].end : 0;
    const effectiveEnd = latestSentenceEnd > 0 ? latestSentenceEnd + 3.0 : currentTimeline;

    if (effectiveEnd < currentTimeline) {
        // Cắt ngắn scene cuối cho vừa với voice
        const excess = currentTimeline - effectiveEnd;
        const lastScene = continuousScenes[continuousScenes.length - 1];
        lastScene.dur = Math.max(1, lastScene.dur - excess); // Tối thiểu 1s
        currentTimeline = effectiveEnd;
        console.log(`[FFmpeg] ✂️ Trim nhạc nền: cắt ${excess.toFixed(0)}s thừa ở cuối (voice ends @ ${latestSentenceEnd.toFixed(0)}s)`);
    } else if (latestSentenceEnd > currentTimeline) {
        // Voice dài hơn scenes → extend nhạc nền
        const padDur = latestSentenceEnd - currentTimeline;
        continuousScenes[continuousScenes.length - 1].dur += padDur;
        currentTimeline = latestSentenceEnd;
    }

    const totalDur = currentTimeline;

    const ffmpegArgs: string[] = ["-y", "-threads", "0"];
    const filterParts: string[] = [];
    let inputIdx = 0;

    for (let i = 0; i < continuousScenes.length; i++) {
        const cscene = continuousScenes[i];
        let outLabel = `norm${i}`;

        if (cscene.isSilence || !cscene.filePath) {
            // Generate silence in filtergraph
            filterParts.push(`anullsrc=r=44100:cl=stereo,atrim=start=0:end=${cscene.dur.toFixed(3)},asetpts=N/SR/TB[${outLabel}]`);
        } else {
            // Add as input
            ffmpegArgs.push(
                "-stream_loop", "-1",
                "-ss", cscene.offset.toFixed(3),
                "-t", cscene.dur.toFixed(3),
                "-i", cscene.filePath
            );
            // Chuẩn hoá audio:
            // Thay vì dùng volume=-11dB tĩnh (dễ bị lệch to/nhỏ giữa các bài),
            // Ta áp dụng bộ phân tích/ép dải âm chuẩn điện ảnh EBU R128 `loudnorm` (1-pass). 
            // Giả lập đưa TẤT CẢ các file gốc về cùng 1 độ lớn -20 LUFS dù file gốc bé hay to.
            filterParts.push(`[${inputIdx}:a]loudnorm=I=-20:LRA=11:tp=-2.0,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=N/SR/TB[${outLabel}]`);
            cscene.inputIdx = inputIdx;
            inputIdx++;
        }
    }

    // 2. Cascade crossfades -> Fix bug O(N^2) bằng amix + adelay + afade thay vì acrossfade
    if (continuousScenes.length === 0) {
        throw new Error("Không có dữ liệu Scene để Render.");
    }

    const mixInputs: string[] = [];
    let currentGlobalTimeMs = 0; // ms

    for (let i = 0; i < continuousScenes.length; i++) {
        const cscene = continuousScenes[i];
        const outLabel = `pos${i}`;

        let chain = `[norm${i}]`;
        
        // FADE IN (nếu có khúc giao với track trước)
        if (i > 0 && continuousScenes[i-1].XFADE > 0) {
            chain += `afade=t=in:st=0:d=${continuousScenes[i-1].XFADE.toFixed(3)},`;
        }

        // FADE OUT
        if (cscene.XFADE > 0) {
            const fadeOutStartSec = cscene.dur - cscene.XFADE;
            chain += `afade=t=out:st=${fadeOutStartSec.toFixed(3)}:d=${cscene.XFADE.toFixed(3)},`;
        }
        
        // DELAY (căn thời điểm bắt đầu ghép track)
        if (currentGlobalTimeMs > 0) {
            const d = Math.round(currentGlobalTimeMs);
            chain += `adelay=${d}|${d},`;
        }

        if (chain.endsWith(',')) chain = chain.slice(0, -1);
        chain += `[${outLabel}]`;
        
        filterParts.push(chain);
        mixInputs.push(`[${outLabel}]`);

        // Đẩy timeline (trừ đi khoảng XFADE vì track tiếp theo sẽ bắt đầu ĐÈ lên khoảng XFADE này)
        currentGlobalTimeMs += (cscene.dur - cscene.XFADE) * 1000;
    }

    let lastMixLabel = 'mixed_bgm';
    if (mixInputs.length > 1) {
        filterParts.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=0:normalize=0[${lastMixLabel}]`);
    } else {
        lastMixLabel = "pos0"; // Nếu chỉ có 1 track
    }

    // 3. Ducking (Sidechain via aevalsrc)
    let duckingLabel = lastMixLabel;
    if (config.sentences.length > 0) {
        // Tối ưu: Gộp các câu nối tiếp nhau để giảm số lượng biểu thức tính toán (tăng tốc độ render hàng chục lần)
        const mergedSentences: Array<{start: number, end: number}> = [];
        const margin = 0.5; // Cắt sớm/muộn 0.5s
        const minGap = 1.0; // Nếu khoảng lặng < 1.0s thì gộp luôn không tăng volume lên

        for (const s of config.sentences) {
            const start = Math.max(0, s.start - margin);
            const end = s.end + margin;
            if (mergedSentences.length === 0) {
                mergedSentences.push({ start, end });
            } else {
                const last = mergedSentences[mergedSentences.length - 1];
                if (start <= last.end + minGap) {
                    last.end = Math.max(last.end, end);
                } else {
                    mergedSentences.push({ start, end });
                }
            }
        }

        // Build mathematical expression for speech presence (1.0 = speech, 0.0 = silence)
        const bexprs = mergedSentences.map(s => {
            return `between(t,${s.start.toFixed(3)},${s.end.toFixed(3)})`;
        });

        const volDrop = (1.0 - duckVol).toFixed(2);
        const expr = `1.0-${volDrop}*min(1,${bexprs.join('+')})`;

        // Tối ưu: Dùng s=8000 thay vì 44100 cho aevalsrc vì ducking envelope không cần chi tiết ở mức kHz. 
        // Thay đổi này giúp giảm tải CPU đánh giá biểu thức toán học đi 5.5 lần.
        filterParts.push(
            `aevalsrc=exprs='${expr}':s=8000:d=${totalDur.toFixed(3)}[vol_mono]`,
            `[vol_mono]aresample=44100,lowpass=f=4,pan=stereo|c0=c0|c1=c0[vol_stereo]`, // Lowpass creates a smooth fade transition (~0.3s fade)
            `[${lastMixLabel}][vol_stereo]amultiply[ducked_out]`
        );
        duckingLabel = "ducked_out";
    }

    // 4. Fadeout 3 giây ở cuối — nhạc nhỏ dần thay vì cắt cụt
    const FADEOUT_SEC = 3;
    const fadeStart = Math.max(0, totalDur - FADEOUT_SEC);
    const fadeLabel = "faded_out";
    filterParts.push(
        `[${duckingLabel}]afade=t=out:st=${fadeStart.toFixed(3)}:d=${FADEOUT_SEC}[${fadeLabel}]`
    );

    const outputFileName = config.outputFileName || "final_bgm_ducked.wav";
    const outputPath = await join(config.outputFolder, outputFileName);

    ffmpegArgs.push(
        "-filter_complex", filterParts.join(";"),
        "-map", `[${fadeLabel}]`,
        "-c:a", "pcm_s16le",
        outputPath
    );

    addDebugLog({
        id: logId,
        timestamp: new Date(),
        method: "CLI",
        url: "FFmpeg (Mix & Ducking)",
        requestHeaders: {},
        requestBody: `ffmpeg ${ffmpegArgs.join(" ")}`,
        status: null,
        responseHeaders: {},
        responseBody: `(đang render ${Math.round(totalDur)}s audio, ${continuousScenes.length} scenes, ${inputIdx} input files...)`,
        duration: 0,
        error: null,
        label: `FFmpeg BGM Mix (${continuousScenes.length} scenes, ~${Math.round(totalDur / 60)} phút)`,
    });

    console.log(`[FFmpeg Service] Running FFmpeg render:`);
    console.log(`  Total duration: ${totalDur.toFixed(1)}s (~${Math.round(totalDur / 60)} phút)`);
    console.log(`  Scenes: ${continuousScenes.length}, Input files: ${inputIdx}`);
    console.log(`  Ducking volume: ${duckVol} (${Math.round(duckVol * 100)}%)`);
    console.log(`  Output: ${outputPath}`);
    console.log(`  Filter complexity: ${filterParts.length} filters`);
    console.log(`  Command: ffmpeg ${ffmpegArgs.join(" ")}`);

    let exitCode: number = -1;
    let stdoutData: string = "";
    let stderrData: string = "";

    // Parse stderr để extract tiến trình render chi tiết

    const handleStderr = (line: string) => {
        stderrData += line + "\n";

        // FFmpeg log tiến trình ở stderr: size= N kB time=00:01:23.45 bitrate=... speed=2.5x
        if (config.onProgress) {
            const timeMatch = line.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
            const speedMatch = line.match(/speed=\s*([\d.]+)x/);
            const sizeMatch = line.match(/size=\s*([\d]+)\s*kB/);

            if (timeMatch) {
                // Tính thời gian đã render (giây)
                const hours = parseInt(timeMatch[1]);
                const minutes = parseInt(timeMatch[2]);
                const seconds = parseInt(timeMatch[3]);
                const renderedSec = hours * 3600 + minutes * 60 + seconds;

                // Tính % hoàn thành
                const percent = totalDur > 0 ? Math.min(99, Math.round((renderedSec / totalDur) * 100)) : 0;

                // Tốc độ render
                const speed = speedMatch ? parseFloat(speedMatch[1]) : 0;

                // File size
                const sizeKB = sizeMatch ? parseInt(sizeMatch[1]) : 0;
                const sizeMB = (sizeKB / 1024).toFixed(1);

                // Ước lượng thời gian còn lại
                const remainingSec = speed > 0 ? Math.round((totalDur - renderedSec) / speed) : 0;
                const remainingStr = remainingSec > 60
                    ? `~${Math.round(remainingSec / 60)}p${remainingSec % 60}s`
                    : `~${remainingSec}s`;

                // Hiển thị progress chi tiết
                let progressMsg = `🎵 Render: ${percent}%`;
                if (speed > 0) progressMsg += ` | ${speed}x`;
                if (sizeKB > 0) progressMsg += ` | ${sizeMB}MB`;
                if (remainingSec > 0 && percent < 95) progressMsg += ` | còn ${remainingStr}`;

                config.onProgress(progressMsg);
            }
        }
    };

    try {
        const cmd = Command.sidecar("binaries/ffmpeg", ffmpegArgs);

        cmd.stdout.on('data', (line) => { stdoutData += line + "\n"; });
        cmd.stderr.on('data', handleStderr);

        const child = await cmd.spawn();
        console.log(`[FFmpeg Service] Spawned sidecar with PID: ${child.pid}`);

        const output = await new Promise<number>((resolve, reject) => {
            cmd.on('close', (payload: any) => resolve(payload.code ?? -1));
            cmd.on('error', reject);
        });
        exitCode = output;
    } catch (e) {
        console.log("Sidecar failed, trying ffmpeg with filter_script...");
        // Fallback: dùng filter_complex_script (ghi filter ra file tạm)
        // Tránh hoàn toàn vấn đề shell escaping cho [], ;, |

        // Tách ffmpegArgs thành: trước filter, filter content, sau filter
        const filterIdx = ffmpegArgs.indexOf("-filter_complex");
        if (filterIdx >= 0 && filterIdx + 1 < ffmpegArgs.length) {
            const argsBeforeFilter = ffmpegArgs.slice(0, filterIdx);
            const filterContent = ffmpegArgs[filterIdx + 1];
            const argsAfterFilter = ffmpegArgs.slice(filterIdx + 2);

            const result = await runFFmpegWithFilterScript(
                argsBeforeFilter, filterContent, argsAfterFilter
            );
            stderrData = result.stderr;
            stdoutData = result.stdout;
            exitCode = result.code;
        } else {
            // Không có filter_complex → dùng runFFmpegSafe
            const result = await runFFmpegSafe(ffmpegArgs);
            stderrData = result.stderr;
            stdoutData = result.stdout;
            exitCode = result.code;
        }
    }

    const duration = Date.now() - startTimeMs;

    if (exitCode !== 0) {
        // Lỗi — lưu TOÀN BỘ stderr vào Debug panel để troubleshoot
        const errorLines = stderrData.split("\n").filter(l => l.trim());
        const lastLines = errorLines.slice(-20).join("\n"); // 20 dòng cuối
        updateDebugLog(logId, {
            status: 500,
            responseBody: `❌ FFmpeg Lỗi (code ${exitCode})\n\n=== 20 DÒNG CUỐI ===\n${lastLines}\n\n=== FULL STDERR (${errorLines.length} dòng) ===\n${stderrData}`,
            duration,
            error: `FFmpeg exit code: ${exitCode}`,
        });
        throw new Error(`FFmpeg Render Lỗi (code ${exitCode}): \n${lastLines}`);
    }

    // Thành công — log chi tiết
    const renderTimeSec = Math.round(duration / 1000);
    updateDebugLog(logId, {
        status: 200,
        responseBody: `✅ Render thành công!\n\nOutput: ${outputPath}\nThời gian render: ${renderTimeSec}s\nAudio duration: ${Math.round(totalDur)}s (~${Math.round(totalDur / 60)} phút)\nScenes: ${continuousScenes.length}\nDucking: ${Math.round(duckVol * 100)}%`,
        duration,
        error: null,
    });

    console.log(`[FFmpeg Service] ✅ Render hoàn tất trong ${renderTimeSec}s → ${outputPath}`);

    return {
        success: true,
        outputPath,
        totalScenes: continuousScenes.length
    };
}

// ============================== SFX VOLUME NORMALIZE (EBU R128 LOUDNORM) ==============================

/**
 * Chuẩn hóa loudness của file SFX bằng EBU R128 (loudnorm) rồi lưu ra file mới.
 * 
 * ▸ Tại sao dùng loudnorm thay vì volume?
 *   - `volume=-6dB` chỉ giảm đều tất cả — file to vẫn to hơn file nhỏ
 *   - `loudnorm` phân tích loudness thực tế (LUFS) rồi đưa TẤT CẢ file về CÙNG 1 mức
 *   - Kết quả: SFX tiếng nổ và tiếng lá rơi sẽ có loudness cân bằng
 * 
 * ▸ Các thông số loudnorm:
 *   - I (Integrated Loudness): mức loud mục tiêu (LUFS). Voice ~= -16 LUFS, SFX nên nhỏ hơn
 *   - TP (True Peak): giới hạn peak tối đa, tránh clipping 
 *   - LRA (Loudness Range): cho phép dynamic range bao nhiêu LU
 * 
 * DaVinci Resolve API không hỗ trợ set audio clip volume qua scripting,
 * nên phải normalize trước khi import.
 * 
 * @param inputPath - Đường dẫn file SFX gốc
 * @param outputPath - Đường dẫn file output đã normalize
 * @param targetLufs - Mức loudness mục tiêu (LUFS), mặc định -20
 *                     Voice thường -16 LUFS, SFX nền khoảng -24 đến -18
 */
export async function normalizeSfxVolume(
    inputPath: string,
    outputPath: string,
    targetLufs: number = -30
): Promise<{ success: boolean; outputPath: string }> {
    const logId = generateLogId();
    const startTime = Date.now();
    const fileName = inputPath.split(/[/\\]/).pop() || "sfx";

    // THAY THẾ bộ lọc "Trừ tĩnh" (static volume) bằng bộ phân tích EBU R128 `loudnorm`
    // Tự động phân tích và đo đạc để bơm/ép mọi file SFX (ngắn hay dài)
    // về mốc LUFS cực kỳ chính xác. Loại bỏ hoàn toàn tình trạng tiếng nổ điếc tai, tiếng chim hót lại bé tí.
    const ffmpegArgs: string[] = [
        "-y",
        "-i", inputPath,
        "-vn",
        "-af", `loudnorm=I=${targetLufs}:LRA=11:tp=-2.0`,
        "-ar", "48000",     // 48kHz chuẩn cho DaVinci Resolve
        "-c:a", "pcm_s16le",
        outputPath
    ];

    // Log command vào Debug Panel
    addDebugLog({
        id: logId,
        timestamp: new Date(),
        method: "CLI",
        url: `FFmpeg EBU R128 (${fileName})`,
        requestHeaders: {},
        requestBody: `ffmpeg ${ffmpegArgs.join(" ")}`,
        status: null,
        responseHeaders: {},
        responseBody: `(đang phân tích và ép mốc chuẩn: ${fileName} → ${targetLufs} LUFS...)`,
        duration: 0,
        error: null,
        label: `🔊 EBU R128: ${fileName} → ${targetLufs} LUFS`,
    });

    console.log(`[FFmpeg] 🔊 LOUDNORM: ${fileName} → ép về mốc chuẩn ${targetLufs} LUFS`);

    // Dùng runFFmpegSafe (single-quote mọi arg) + timeout 60s
    const TIMEOUT_MS = 60000;

    // Race: FFmpeg hoàn thành vs Timeout
    const result = await Promise.race([
        runFFmpegSafe(ffmpegArgs),
        new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(new Error(`FFmpeg timeout (>${TIMEOUT_MS / 1000}s) cho ${fileName}`));
            }, TIMEOUT_MS);
        }),
    ]);

    const exitCode = result.code;
    const stderrData = result.stderr;
    const duration = Date.now() - startTime;

    if (exitCode !== 0) {
        updateDebugLog(logId, {
            status: 500,
            responseBody: `❌ FFmpeg Loudnorm FAILED\n\nFile: ${fileName}\nTarget: ${targetLufs} LUFS\n\n=== STDERR ===\n${stderrData}`,
            duration,
            error: `Exit code: ${exitCode}`,
        });
        throw new Error(`FFmpeg loudnorm failed (code ${exitCode}): ${stderrData.slice(-300)}`);
    }

    // Thành công → log kết quả vào Debug Panel
    updateDebugLog(logId, {
        status: 200,
        responseBody: `✅ EBU R128 OK\n\nFile: ${fileName}\nĐã ép thẳng về cột mốc: ${targetLufs} LUFS\nOutput: ${outputPath}\nThời gian: ${duration}ms`,
        duration,
        error: null,
    });

    return { success: true, outputPath };
}

// ============================== SFX RENDER ==============================

export interface MixSFXConfig {
    outputFolder: string;
    outputFileName?: string;
    cues: Array<{
        filePath: string;
        startTimeMs: number;     // thời điểm phát (tính bằng milli-giây để cho vào adelay)
        trimStartSec?: number;   // cắt SFX: bắt đầu lấy từ giây này (mặc định 0)
        trimEndSec?: number;     // cắt SFX: lấy đến giây này (mặc định toàn bộ file)
    }>;
    onProgress?: (progressStr: string) => void;
}

/**
 * Mix nhiều sfx chồng lên nhau ở các timeline cụ thể vào 1 file audio duy nhất (amix + adelay)
 * Hỗ trợ trim SFX: nếu có trimStartSec/trimEndSec → atrim trước khi chèn
 */
export async function mixSFXTracks(config: MixSFXConfig) {
    const logId = generateLogId();
    const startTimeTrackingMs = Date.now();

    const outputFileName = config.outputFileName || "final_sfx_track.wav";
    const outputPath = await join(config.outputFolder, outputFileName);

    if (config.cues.length === 0) {
        throw new Error("Không có SFX Cue nào để render.");
    }

    const ffmpegArgs: string[] = ["-y"];
    const filterParts: string[] = [];
    const mixInputs: string[] = [];

    // Map từng file vào input, rồi dùng adelay + atrim nếu cần
    for (let i = 0; i < config.cues.length; i++) {
        const cue = config.cues[i];
        ffmpegArgs.push("-i", cue.filePath);

        const delayTime = Math.max(0, Math.floor(cue.startTimeMs)); // ms

        // Build filter chain: resample → trim (nếu có) → delay
        let filterChain = `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo`;

        // Thêm atrim nếu có trim config (cắt đoạn SFX phù hợp)
        if (cue.trimStartSec !== undefined || cue.trimEndSec !== undefined) {
            const trimStart = cue.trimStartSec ?? 0;
            let trimFilter = `atrim=start=${trimStart.toFixed(3)}`;
            if (cue.trimEndSec !== undefined) {
                trimFilter += `:end=${cue.trimEndSec.toFixed(3)}`;
            }
            // asetpts=PTS-STARTPTS reset timestamp sau khi trim
            filterChain += `,${trimFilter},asetpts=PTS-STARTPTS`;
        }

        filterChain += `,adelay=${delayTime}|${delayTime}[out${i}]`;
        filterParts.push(filterChain);
        mixInputs.push(`[out${i}]`);
    }

    // amix ghép tất cả lại. normalize=0 để không bị drop volume tự động khi nhiều âm thanh
    filterParts.push(`${mixInputs.join("")}amix=inputs=${config.cues.length}:duration=longest:dropout_transition=0:normalize=0[mixout]`);

    // Master filter - giảm nhẹ peak xuống xíu
    filterParts.push(`[mixout]volume=0.9[final_out]`);

    ffmpegArgs.push("-filter_complex", filterParts.join(";"));
    ffmpegArgs.push("-map", "[final_out]");
    ffmpegArgs.push("-c:a", "pcm_s16le");
    ffmpegArgs.push(outputPath);

    let exitCode: number = -1;
    let stdoutData: string = "";
    let stderrData: string = "";

    const handleStderr = (line: string) => {
        stderrData += line + "\n";
        if (config.onProgress) {
            const timeMatch = line.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
            if (timeMatch && timeMatch[1]) {
                config.onProgress(`Đang Render SFX: ${timeMatch[1]}`);
            }
        }
    };

    addDebugLog({
        id: logId,
        timestamp: new Date(),
        method: "CLI",
        url: "FFmpeg (SFX Mixer)",
        requestHeaders: {},
        requestBody: `ffmpeg ${ffmpegArgs.join(" ")}`,
        status: null,
        responseHeaders: {},
        responseBody: "(đang render...)",
        duration: 0,
        error: null,
        label: `FFmpeg SFX Mix (${config.cues.length} files)`,
    });

    try {
        const cmd = Command.sidecar("binaries/ffmpeg", ffmpegArgs);
        cmd.stdout.on('data', (line) => { stdoutData += line + "\n"; });
        cmd.stderr.on('data', handleStderr);

        await cmd.spawn();
        const output = await new Promise<number>((resolve, reject) => {
            cmd.on('close', (payload: any) => resolve(payload.code ?? -1));
            cmd.on('error', reject);
        });
        exitCode = output;
    } catch (e) {
        // Fallback: dùng filter_complex_script (an toàn cho [], ;, |)
        console.log("Sidecar failed, trying ffmpeg with filter_script (SFX)...");

        const filterIdx = ffmpegArgs.indexOf("-filter_complex");
        if (filterIdx >= 0 && filterIdx + 1 < ffmpegArgs.length) {
            const argsBeforeFilter = ffmpegArgs.slice(0, filterIdx);
            const filterContent = ffmpegArgs[filterIdx + 1];
            const argsAfterFilter = ffmpegArgs.slice(filterIdx + 2);

            const result = await runFFmpegWithFilterScript(
                argsBeforeFilter, filterContent, argsAfterFilter
            );
            stderrData = result.stderr;
            stdoutData = result.stdout;
            exitCode = result.code;
        } else {
            const result = await runFFmpegSafe(ffmpegArgs);
            stderrData = result.stderr;
            stdoutData = result.stdout;
            exitCode = result.code;
        }
    }

    const duration = Date.now() - startTimeTrackingMs;

    if (exitCode !== 0) {
        updateDebugLog(logId, { status: 500, responseBody: stderrData, duration, error: String(exitCode) });
        throw new Error(`SFX Mix Error (code ${exitCode}): \n${stderrData}`);
    }

    updateDebugLog(logId, { status: 200, responseBody: `Saved: ${outputPath}`, duration, error: null });

    return { success: true, outputPath };
}

