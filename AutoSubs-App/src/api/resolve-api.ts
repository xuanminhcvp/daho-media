// src/api/resolve-api.ts
// ============================================================
// Giao tiếp với Lua HTTP server (DaVinci Resolve) qua Tauri IPC.
//
// NGUYÊN NHÂN THAY ĐỔI: @tauri-apps/plugin-http v2.5.1 bị lỗi
//   "invalid args `streamChannel` for command `fetch_read_body`"
//   do version mismatch với Rust crate tauri-plugin-http.
//
// GIẢI PHÁP: invoke('call_lua_server') → Rust reqwest → localhost:56003
//   - reqwest chạy trong Rust process, không qua WebView
//   - Không bị CORS, ATS (macOS), CSP chặn
//   - Không bị version mismatch plugin
// ============================================================

import { invoke } from '@tauri-apps/api/core';
import { downloadDir } from '@tauri-apps/api/path';
import { getTranscriptPath } from '@/utils/file-utils';
import { Speaker } from '@/types/interfaces';

// ===== HELPER TRUNG TÂM =====
// Tất cả hàm trong file này đều gọi qua đây
// Rust command 'call_lua_server' → src-tauri/src/resolve_bridge.rs
async function callLua(params: Record<string, any>): Promise<any> {
  return await invoke('call_lua_server', { params });
}

/**
 * Gửi Ping tới Lua server để kiểm tra kết nối còn sống không
 * Trả về true nếu server phản hồi đúng {"message":"Pong"}, false nếu lỗi
 */
export async function pingResolve(): Promise<boolean> {
  console.log('[pingResolve] 🔍 Ping → Lua server via Rust invoke...');
  try {
    const data = await callLua({ func: "Ping" });
    const isPong = data?.message === "Pong";
    console.log(`[pingResolve] ${isPong ? '✅ Pong OK' : '❌ Phản hồi lạ:'}`, data);
    return isPong;
  } catch (err: any) {
    console.error('[pingResolve] ❌ Lỗi:', err?.message ?? err);
    return false;
  }
}

/**
 * Gọi Lua server tạo đủ 7V+5A tracks và đặt tên chuẩn
 * Chỉ dùng AddTrack + SetTrackName, không xoá gì
 */
export async function setupTimelineTracks(config?: any): Promise<any> {
  try {
    return await callLua({ func: "SetupTimelineTracks", config });
  } catch (err: any) {
    console.error('[setupTimelineTracks] Lỗi:', err?.message ?? err);
    throw err;
  }
}

/**
 * Export audio từ timeline DaVinci Resolve
 * Kết quả ghi vào Downloads folder
 */
export async function exportAudio(inputTracks: Array<string>) {
  const outputDir = await downloadDir();
  const data = await callLua({
    func: "ExportAudio",
    outputDir,
    inputTracks,
  });

  if (data.error) {
    throw new Error(data.message || "Failed to start audio export");
  }
  if (!data.started) {
    throw new Error("Export did not start successfully");
  }
  return data;
}

/**
 * Di chuyển playhead DaVinci đến vị trí (giây) — preview
 */
export async function jumpToTime(seconds: number) {
  return await callLua({ func: "JumpToTime", seconds });
}

/**
 * Lấy thông tin timeline hiện tại từ DaVinci Resolve
 * Trả về: name, timelineId, templates, inputTracks, ...
 */
export async function getTimelineInfo() {
  console.log('[getTimelineInfo] 🔍 GetTimelineInfo via Rust invoke...');
  try {
    const data = await callLua({ func: "GetTimelineInfo" });

    if (!data?.timelineId) {
      console.warn('[getTimelineInfo] ⚠️ Không có timelineId:', data);
      throw new Error("No timeline detected in Resolve.");
    }
    console.log('[getTimelineInfo] ✅ Timeline:', data.name, '— ID:', data.timelineId);
    return data;
  } catch (err: any) {
    console.error('[getTimelineInfo] ❌ Lỗi:', err?.message ?? err);
    throw err;
  }
}

/**
 * Thêm phụ đề chính lên timeline DaVinci Resolve
 */
export async function addSubtitlesToTimeline(
  filename: string,
  currentTemplate: string,
  outputTrack: string
) {
  const filePath = await getTranscriptPath(filename);
  return await callLua({
    func: "AddSubtitles",
    filePath,
    templateName: currentTemplate,
    trackIndex: outputTrack,
  });
}

/**
 * Gửi lệnh tắt Lua server (dùng khi đóng app)
 */
export async function closeResolveLink() {
  try {
    return await callLua({ func: "Exit" });
  } catch {
    // Có thể lỗi khi server đã tắt — bỏ qua
  }
}

/**
 * Kiểm tra tiến độ export audio
 */
export async function getExportProgress() {
  return await callLua({ func: "GetExportProgress" });
}

/**
 * Hủy export đang chạy
 */
export async function cancelExport() {
  return await callLua({ func: "CancelExport" });
}

export async function getRenderJobStatus() {
  return await callLua({ func: "GetRenderJobStatus" });
}

/**
 * Tạo preview phụ đề trước khi render
 */
export async function generatePreview(
  speaker: Speaker,
  templateName: string,
  exportPath: string
) {
  return await callLua({ func: "GeneratePreview", speaker, templateName, exportPath });
}

/**
 * Import media clips lên VIDEO TRACK trên timeline DaVinci Resolve
 * Timeout 120s — footage import có thể lâu (import + Fusion zoom)
 * @param clips - Mảng clips cần import
 * @param trackIndex - Track video đích
 * @param videoOnly - Nếu true chỉ import video, bỏ audio
 */
export async function addMediaToTimeline(
  clips: Array<{ filePath: string; startTime: number; endTime: number; trimStart?: number; trimEnd?: number }>,
  trackIndex: string,
  videoOnly?: boolean
) {
  try {
    const body: any = { func: "AddMediaToTimeline", clips, trackIndex };
    if (videoOnly) body.videoOnly = true;
    return await callLua(body);
  } catch (err: any) {
    console.error('[addMediaToTimeline] Lỗi:', err?.message ?? err);
    return { error: true, message: err?.message ?? "Không kết nối được DaVinci Resolve." };
  }
}

/**
 * Import 1 file audio vào AUDIO TRACK MỚI (dùng cho BGM render)
 */
export async function addAudioToTimeline(
  filePath: string,
  trackName?: string
): Promise<{ success?: boolean; audioTrack?: number; trackName?: string; message?: string; error?: boolean }> {
  return await callLua({ func: "AddAudioToTimeline", filePath, trackName });
}

/**
 * Quét track trên timeline — trả về danh sách số trích từ tên clip
 * Dùng để so khớp với matching JSON → tìm câu chưa import
 */
export async function getTrackClipNumbers(trackIndex: string): Promise<{
  clipNumbers: number[];
  clipRanges: { start: number; endTime: number; name: string }[];
  totalClips: number;
  error?: boolean;
  message?: string;
}> {
  return await callLua({ func: "GetTrackClipNumbers", trackIndex });
}

/**
 * Di chuyển playhead đến vị trí (giây) — preview
 */
export async function seekToTime(seconds: number): Promise<{
  success?: boolean;
  timecode?: string;
  error?: boolean;
  message?: string;
}> {
  return await callLua({ func: "SeekToTime", seconds });
}

/**
 * Thêm Subtitles với mỗi câu là 1 template riêng biệt (AI Template Assignment)
 */
export async function addTemplateSubtitlesToTimeline(
  clips: Array<{ start: number; end: number; text: string; template: string; color?: string }>,
  trackIndex: string
) {
  return await callLua({ func: "AddTemplateSubtitles", clips, trackIndex });
}

/**
 * Thêm nhiều SFX clips trực tiếp vào AUDIO TRACK
 * Mỗi clip đặt đúng vị trí (exactStartTime)
 */
export async function addSfxClipsToTimeline(
  clips: Array<{ filePath: string; startTime: number; trimStartSec?: number; trimEndSec?: number }>,
  trackName?: string
): Promise<{ success?: boolean; audioTrack?: number; clipsAdded?: number; message?: string; error?: boolean }> {
  try {
    return await callLua({ func: "AddSfxClipsToTimeline", clips, trackName });
  } catch (err: any) {
    return { error: true, message: err?.message ?? "Không kết nối được DaVinci Resolve." };
  }
}

/**
 * Tạo 5 template folder trong DaVinci Resolve Media Pool
 */
export async function createTemplateSet(templateNames: string[]) {
  return await callLua({ func: "CreateTemplateSet", templateNames });
}

/**
 * Import ảnh tham khảo lên Track V4 kèm Ken Burns + Cross Dissolve
 * Và SFX kèm (nếu có) lên Audio Track
 */
export async function addRefImagesToTimeline(
  clips: Array<{
    filePath: string;
    startTime: number;
    endTime: number;
    priority: string;
    imageType: string;
  }>,
  sfxClips?: Array<{ filePath: string; startTime: number }>
): Promise<{ success?: boolean; clipsAdded?: number; sfxAdded?: number; message?: string; error?: boolean }> {
  try {
    const body: any = { func: "AddRefImagesToTimeline", clips };
    if (sfxClips && sfxClips.length > 0) body.sfxClips = sfxClips;
    return await callLua(body);
  } catch (err: any) {
    return { error: true, message: err?.message ?? "Không kết nối được DaVinci Resolve." };
  }
}

/**
 * Relink lại tất cả clip bị offline trong Media Pool
 */
export async function autoRelinkMedia(
  folderPath?: string
): Promise<{ success?: boolean; relinkedCount?: number; offlineCount?: number; message?: string; error?: boolean }> {
  try {
    return await callLua({ func: "AutoRelinkMedia", folderPath: folderPath || null });
  } catch (err: any) {
    return { error: true, message: err?.message ?? "Không kết nối được DaVinci Resolve." };
  }
}
