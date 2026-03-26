// src/api/resolveApi.ts
import { fetch } from '@tauri-apps/plugin-http';
import { downloadDir } from '@tauri-apps/api/path';
import { getTranscriptPath } from '@/utils/file-utils';
import { Speaker } from '@/types/interfaces';

const resolveAPI = "http://127.0.0.1:56003/";

/**
 * Gửi Ping tới Lua server để kiểm tra kết nối còn sống không
 * Trả về true nếu server phản hồi, false nếu timeout hoặc lỗi
 */
export async function pingResolve(): Promise<boolean> {
  try {
    const controller = new AbortController();
    // Timeout 3 giây để tránh treo UI
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(resolveAPI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ func: "Ping" }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await response.json();
    return data?.message === "Pong";
  } catch (err) {
    console.error("[pingResolve] Lỗi khi Ping tới Resolve:", err);
    return false;
  }
}

/**
 * Gọi Lua server tạo đủ 7V+5A tracks và đặt tên chuẩn
 * Chỉ dùng AddTrack + SetTrackName, không xoá gì
 */
export async function setupTimelineTracks(): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(resolveAPI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ func: "SetupTimelineTracks" }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return await response.json();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

export async function exportAudio(inputTracks: Array<string>) {
  const outputDir = await downloadDir();
  const response = await fetch(resolveAPI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      func: "ExportAudio",
      outputDir,
      inputTracks,
    }),
  });
  const data = await response.json();

  // Check for errors in starting export
  if (data.error) {
    throw new Error(data.message || "Failed to start audio export");
  }

  // New non-blocking API returns started: true instead of timeline data
  if (!data.started) {
    throw new Error("Export did not start successfully");
  }

  return data;
}

export async function jumpToTime(seconds: number) {
  const response = await fetch(resolveAPI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ func: "JumpToTime", seconds }),
  });
  return response.json();
}

export async function getTimelineInfo() {
  try {
    const response = await fetch(resolveAPI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ func: "GetTimelineInfo" }),
    });
    const data = await response.json();
    if (!data.timelineId) {
      throw new Error("No timeline detected in Resolve.");
    }
    return data;
  } catch (err) {
    console.error("[getTimelineInfo] Lỗi khi gọi GetTimelineInfo:", err);
    throw err;
  }
}

export async function addSubtitlesToTimeline(filename: string, currentTemplate: string, outputTrack: string) {
  const filePath = await getTranscriptPath(filename);
  const response = await fetch(resolveAPI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      func: "AddSubtitles",
      filePath,
      templateName: currentTemplate,
      trackIndex: outputTrack,
    }),
  });
  return response.json();
}

export async function closeResolveLink() {
  const response = await fetch(resolveAPI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ func: "Exit" }),
  });
  return response.json();
}

export async function getExportProgress() {
  const response = await fetch(resolveAPI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ func: "GetExportProgress" }),
  });
  return response.json();
}

export async function cancelExport() {
  const response = await fetch(resolveAPI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ func: "CancelExport" }),
  });
  return response.json();
}

export async function getRenderJobStatus() {
  const response = await fetch(resolveAPI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ func: "GetRenderJobStatus" }),
  });
  return response.json();
}

export async function generatePreview(speaker: Speaker, templateName: string, exportPath: string) {
  const response = await fetch(resolveAPI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ func: "GeneratePreview", speaker, templateName, exportPath }),
  });
  return response.json();
}

/**
 * Import media clips lên VIDEO TRACK trên timeline DaVinci Resolve
 * Mỗi clip cần: filePath, startTime, endTime
 * Timeout 120 giây — footage import có thể lâu (import + Fusion zoom)
 * @param clips - Mảng clips cần import
 * @param trackIndex - Track video đích (số thứ tự track)
 * @param videoOnly - Nếu true chỉ import video, bỏ audio (dùng cho footage V2)
 */
export async function addMediaToTimeline(
  clips: Array<{ filePath: string; startTime: number; endTime: number; trimStart?: number; trimEnd?: number }>,
  trackIndex: string,
  videoOnly?: boolean
) {
  // Timeout 120 giây — footage import có thể lâu (import + Fusion zoom)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const body: any = {
      func: "AddMediaToTimeline",
      clips,
      trackIndex,
    };
    // Chỉ gửi videoOnly khi true (tránh gửi false/undefined)
    if (videoOnly) body.videoOnly = true;

    const response = await fetch(resolveAPI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response.json();
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return { error: true, message: "Timeout 120s — DaVinci Resolve không phản hồi." };
    }
    throw err;
  }
}

/**
 * Import 1 file audio vào AUDIO TRACK MỚI trên timeline DaVinci Resolve
 * File được đặt ở vị trí 0s (đầu timeline), tạo track audio mới
 * Dùng cho BGM render — user có thể xoá track nếu không ưng
 * @param filePath - Đường dẫn tuyệt đối tới file audio (vd: final_bgm_ducked.wav)
 * @param trackName - Tên track (vd: "BGM - AutoSubs") — optional
 */
export async function addAudioToTimeline(
  filePath: string,
  trackName?: string
): Promise<{ success?: boolean; audioTrack?: number; trackName?: string; message?: string; error?: boolean }> {
  const response = await fetch(resolveAPI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      func: "AddAudioToTimeline",
      filePath,
      trackName,
    }),
  });
  return response.json();
}

/**
 * Quét track trên timeline DaVinci Resolve
 * Trả về danh sách số trích từ tên clip trên track đó
 * Dùng để so khớp với matching JSON → tìm câu chưa import
 */
export async function getTrackClipNumbers(trackIndex: string): Promise<{
  clipNumbers: number[];
  clipRanges: { start: number; endTime: number; name: string }[];
  totalClips: number;
  error?: boolean;
  message?: string;
}> {
  const response = await fetch(resolveAPI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      func: "GetTrackClipNumbers",
      trackIndex,
    }),
  });
  return response.json();
}

/**
 * Di chuyển playhead trên timeline DaVinci đến vị trí (giây)
 * Dùng để preview — bấm vào số câu → nhảy đến vị trí đó
 */
export async function seekToTime(seconds: number): Promise<{
  success?: boolean;
  timecode?: string;
  error?: boolean;
  message?: string;
}> {
  const response = await fetch(resolveAPI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      func: "SeekToTime",
      seconds,
    }),
  });
  return response.json();
}

/**
 * Thêm Subtitles vào timeline với mỗi câu là 1 template riêng biệt
 * Dựa vào kết quả AI Template Assignment
 */
export async function addTemplateSubtitlesToTimeline(
  clips: Array<{ start: number; end: number; text: string; template: string; color?: string }>,
  trackIndex: string
) {
  const response = await fetch(resolveAPI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      func: "AddTemplateSubtitles",
      clips,
      trackIndex,
    }),
  });
  return response.json();
}

/**
 * Thêm nhiều SFX clips trực tiếp vào AUDIO TRACK trên timeline DaVinci Resolve
 * Mỗi clip được đặt đúng vị trí (exactStartTime) — chỉ thêm cue có whisper timing chính xác
 * @param clips - Danh sách SFX: {filePath, startTime} (startTime tính bằng giây)
 * @param trackName - Tên audio track mới (vd: "SFX - AutoSubs")
 */
export async function addSfxClipsToTimeline(
  clips: Array<{ filePath: string; startTime: number; trimStartSec?: number; trimEndSec?: number }>,
  trackName?: string
): Promise<{ success?: boolean; audioTrack?: number; clipsAdded?: number; message?: string; error?: boolean }> {
  // Timeout 60 giây — DaVinci có thể mất thời gian import nhiều SFX
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(resolveAPI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        func: "AddSfxClipsToTimeline",
        clips,
        trackName,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response.json();
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return { error: true, message: "Timeout 60s — DaVinci Resolve không phản hồi. Hãy kiểm tra DaVinci đang mở và Lua server đang chạy." };
    }
    throw err;
  }
}

/**
 * Tạo 5 template folder trong DaVinci Resolve Media Pool
 * Mỗi folder chứa 1 bản copy của Default Template để user customize riêng
 * @param templateNames - Danh sách tên template cần tạo
 */
export async function createTemplateSet(
  templateNames: string[]
) {
  const response = await fetch(resolveAPI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      func: "CreateTemplateSet",
      templateNames,
    }),
  });
  return response.json();
}

/**
 * Import ảnh tham khảo thực tế lên Track V4 trong DaVinci Resolve
 * Kèm theo: Ken Burns nhẹ (zoom 100→108%) + Cross Dissolve transition
 * Full-frame nếu priority=high + type portrait/headline/evidence
 * Overlay (80% size, 90% opacity) nếu priority không phải high
 * Đồng thời import SFX kèm (nếu có) lên Audio Track
 *
 * @param clips - Danh sách ảnh cần import: filePath, startTime, endTime, priority, imageType
 * @param sfxClips - Danh sách SFX kèm theo (optional): filePath, startTime
 */
export async function addRefImagesToTimeline(
  clips: Array<{
    filePath: string;
    startTime: number;
    endTime: number;
    priority: string;      // "high" | "medium" | "low"
    imageType: string;     // "portrait" | "headline" | "evidence" | ...
  }>,
  sfxClips?: Array<{ filePath: string; startTime: number }>
): Promise<{ success?: boolean; clipsAdded?: number; sfxAdded?: number; message?: string; error?: boolean }> {
  const controller = new AbortController();
  // 120 giây timeout — Fusion composition apply có thể chậm
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const body: any = {
      func: "AddRefImagesToTimeline",
      clips,
    };
    // Chỉ gửi sfxClips khi có data (tránh gửi mảng rỗng)
    if (sfxClips && sfxClips.length > 0) {
      body.sfxClips = sfxClips;
    }

    const response = await fetch(resolveAPI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response.json();
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return { error: true, message: "Timeout 120s — DaVinci Resolve không phản hồi." };
    }
    throw err;
  }
}

/**
 * Relink lại tất cả clip bị offline trong Media Pool
 * Gọi khi mở project lại thấy "Media not found"
 * Resolve sẽ scan folderPath và sub-folders để tìm lại file
 *
 * @param folderPath - Thư mục chứa media (mặc định ~/Desktop/Auto_media)
 */
export async function autoRelinkMedia(
  folderPath?: string
): Promise<{ success?: boolean; relinkedCount?: number; offlineCount?: number; message?: string; error?: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s
  try {
    const response = await fetch(resolveAPI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        func: "AutoRelinkMedia",
        folderPath: folderPath || null,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response.json();
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return { error: true, message: "Timeout 30s — DaVinci không phản hồi." };
    }
    throw err;
  }
}
