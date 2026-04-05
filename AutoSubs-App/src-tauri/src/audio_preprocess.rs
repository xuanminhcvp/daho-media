use eyre::{bail, Result};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Runtime};
use tauri_plugin_shell::ShellExt;
use tokio::process::Command as TokioCommand;

/// Converts audio/video files to mono 16kHz 16-bit PCM WAV using FFmpeg.
/// This is the only preprocessing step needed before passing audio to whisper-diarize-rs.
/// Handles both audio files and video files (extracts audio stream only).
pub async fn normalize<R: Runtime>(
    app: AppHandle<R>,
    input: PathBuf,
    output: PathBuf,
    additional_ffmpeg_args: Option<Vec<String>>,
) -> std::result::Result<(), String> {
    async fn normalize_inner<R: Runtime>(
        app: &AppHandle<R>,
        input: PathBuf,
        output: PathBuf,
        additional_ffmpeg_args: Option<Vec<String>>,
    ) -> Result<()> {
        // Ensure the output directory exists
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }

        println!("Converting audio to mono: {:?} -> {:?}", input, output);
        tracing::info!("Audio normalization: converting to mono 16kHz PCM16 WAV");

        let sidecar_command = app.shell().sidecar("ffmpeg");
        let input_lossy = input.to_string_lossy().into_owned();
        let output_lossy = output.to_string_lossy().into_owned();

        // Build FFmpeg command: extract audio, convert to mono 16kHz PCM16 WAV
        let mut args = vec![
            "-nostdin".into(),
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-vn".into(),      // No video
            "-sn".into(),      // No subtitles
            "-dn".into(),      // No data streams
            "-i".into(),
            input_lossy,
            "-ar".into(),
            "16000".into(),    // Sample rate: 16kHz
            "-ac".into(),
            "1".into(),        // Channels: mono
            "-c:a".into(),
            "pcm_s16le".into(), // Codec: 16-bit PCM
            "-map_metadata".into(),
            "-1".into(),       // Strip metadata
            "-f".into(),
            "wav".into(),      // Format: WAV
            "-nostats".into(),
        ];

        // Add any additional FFmpeg arguments
        if let Some(ref additional_args) = additional_ffmpeg_args {
            args.extend(additional_args.clone());
        }

        // Overwrite output file
        args.push("-y".into());
        args.push(output_lossy);

        tracing::debug!("Running ffmpeg with args: {:?}", args);

        // Execute FFmpeg (try sidecar first, fallback to system ffmpeg)
        let (success, code, stdout, stderr) = match sidecar_command {
            Ok(cmd) => match cmd.args(args.clone()).output().await {
                Ok(o) => (o.status.success(), o.status.code(), o.stdout, o.stderr),
                Err(_) => {
                    tracing::warn!("ffmpeg sidecar unavailable, falling back to system ffmpeg");
                    let sys = TokioCommand::new("ffmpeg").args(args.clone()).output().await?;
                    (sys.status.success(), sys.status.code(), sys.stdout, sys.stderr)
                }
            },
            Err(e) => {
                tracing::warn!("ffmpeg sidecar init error: {}. Falling back to system ffmpeg", e);
                let sys = TokioCommand::new("ffmpeg").args(args.clone()).output().await?;
                (sys.status.success(), sys.status.code(), sys.stdout, sys.stderr)
            }
        };

        // Log FFmpeg output for diagnostics
        if !stdout.is_empty() {
            tracing::debug!("ffmpeg stdout: {}", String::from_utf8_lossy(&stdout));
        }
        if !stderr.is_empty() {
            tracing::debug!("ffmpeg stderr: {}", String::from_utf8_lossy(&stderr));
        }

        // Check for errors
        if !success {
            let error_message = String::from_utf8_lossy(&stderr);
            bail!(
                "ffmpeg failed with exit code: {:?}\nStderr: {}",
                code,
                error_message
            );
        }

        // Verify output file was created
        if !output.exists() {
            bail!("ffmpeg succeeded but output file was not created");
        }

        // Check file size
        let out_meta = fs::metadata(&output)?;
        if out_meta.len() <= 44 {
            tracing::warn!("Output WAV file is suspiciously small (header-only): {:?}", output);
        }

        println!("Audio conversion successful: {:?}", output);
        Ok(())
    }

    normalize_inner(&app, input, output, additional_ffmpeg_args)
        .await
        .map_err(|e| e.to_string())
}

// ======================== GET AUDIO DURATION (ffprobe) ========================
/// Lấy duration (giây, float) của file audio bằng ffprobe
/// Dùng cho CapCut pipeline: xác định chính xác VO dài bao lâu
/// → clamp tất cả media track về duration này
#[tauri::command]
pub async fn get_audio_duration<R: Runtime>(
    app: AppHandle<R>,
    file_path: String,
) -> std::result::Result<f64, String> {
    // Chuẩn bị args cho ffprobe: chỉ lấy format duration, output raw number
    let args = vec![
        "-v".to_string(),
        "error".to_string(),
        "-show_entries".to_string(),
        "format=duration".to_string(),
        "-of".to_string(),
        "default=noprint_wrappers=1:nokey=1".to_string(),
        file_path.clone(),
    ];

    // Thử sidecar ffprobe trước, fallback về system ffprobe
    let sidecar_command = app.shell().sidecar("ffprobe");
    let (success, stdout, stderr) = match sidecar_command {
        Ok(cmd) => {
            match tokio::time::timeout(std::time::Duration::from_secs(10), cmd.args(args.clone()).output()).await {
                Ok(Ok(o)) => (o.status.success(), o.stdout, o.stderr),
                Ok(Err(_)) | Err(_) => {
                    tracing::warn!("[get_audio_duration] ffprobe sidecar timeout/error, fallback to system");
                    match tokio::time::timeout(std::time::Duration::from_secs(10), TokioCommand::new("ffprobe").args(args.clone()).output()).await {
                        Ok(Ok(sys)) => (sys.status.success(), sys.stdout, sys.stderr),
                        _ => return Err("ffprobe timed out or failed to run".to_string()),
                    }
                }
            }
        },
        Err(_) => {
            tracing::warn!("[get_audio_duration] ffprobe sidecar not found, fallback to system");
            match tokio::time::timeout(std::time::Duration::from_secs(10), TokioCommand::new("ffprobe").args(args.clone()).output()).await {
                Ok(Ok(sys)) => (sys.status.success(), sys.stdout, sys.stderr),
                _ => return Err("ffprobe timed out or failed to run system fallback".to_string()),
            }
        }
    };

    if !success {
        let err_text = String::from_utf8_lossy(&stderr);
        return Err(format!("ffprobe failed: {}", err_text));
    }

    // Parse duration (float seconds) từ stdout
    let text = String::from_utf8_lossy(&stdout).trim().to_string();
    let duration = text.parse::<f64>()
        .map_err(|e| format!("Invalid ffprobe duration '{}': {}", text, e))?;

    tracing::info!("[get_audio_duration] {} → {:.3}s", file_path, duration);
    Ok(duration)
}
