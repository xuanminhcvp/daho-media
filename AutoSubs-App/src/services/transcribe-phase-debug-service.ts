// transcribe-phase-debug-service.ts
// ============================================================
// Mục tiêu:
// - Ghi log timing chi tiết các pha transcribe vào DEBUG Panel.
// - Giúp user biết bottleneck nằm ở cache/normalize/transcribe/postprocess.
//
// Request gửi vào service này:
// - label: tên luồng gọi (Transcription Workspace, Auto Media, Voice Pipeline...)
// - options: object options đã gửi cho backend transcribe_audio
// - transcript: response backend trả về
//
// Response service tạo ra:
// - 1 DebugLogEntry local (method=TRANSCRIBE, url=local://transcribe/phase-timing)
// - requestBody: options dễ đọc
// - responseBody: phase timings + summary + metadata
// ============================================================

import {
  addDebugLog,
  generateLogId,
  updateDebugLog,
} from "@/services/debug-logger";

interface PhaseTimingsMs {
  cache_check?: number;
  normalize?: number;
  transcribe?: number;
  postprocess?: number;
  total?: number;
  cache_hit?: boolean;
}

/**
 * Tạo log "đang chạy transcribe" để user thấy ngay trên tab API
 * thay vì phải đợi transcribe xong mới có log.
 */
export function startTranscribePhaseDebugLog(params: {
  label: string;
  options: unknown;
}): string {
  const { label, options } = params;
  const logId = generateLogId();

  addDebugLog({
    id: logId,
    timestamp: new Date(),
    method: "TRANSCRIBE",
    url: "local://transcribe/phase-timing",
    requestHeaders: { "Content-Type": "application/json" },
    requestBody: JSON.stringify({ label, options }, null, 2),
    status: null, // null = đang xử lý
    responseHeaders: {},
    responseBody: "",
    duration: 0,
    error: null,
    label: `Transcribe Timing | ${label}`,
  });

  return logId;
}

/**
 * Cập nhật tiến độ trong lúc transcribe đang chạy.
 * Dùng để người dùng thấy progress realtime trong tab API, tránh cảm giác "đứng".
 */
export function updateTranscribePhasePendingProgress(params: {
  logId: string;
  progress?: number;
  type?: string;
  label?: string;
}): void {
  const { logId, progress, type, label } = params;
  updateDebugLog(logId, {
    responseBody: JSON.stringify(
      {
        status: "running",
        progress: typeof progress === "number" ? progress : null,
        type: type || null,
        label: label || null,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ),
  });
}

/**
 * Ghi 1 log timing transcribe vào DEBUG Panel (tab API).
 */
export function logTranscribePhaseTimingToDebug(params: {
  logId?: string;
  label: string;
  options: unknown;
  transcript: any;
}): void {
  const { logId, label, options, transcript } = params;

  const phase: PhaseTimingsMs = transcript?.phase_timings_ms || {};
  const processingSec = Number(transcript?.processing_time_sec ?? 0);
  const segmentsCount = Array.isArray(transcript?.segments) ? transcript.segments.length : 0;
  const speakersCount = Array.isArray(transcript?.speakers) ? transcript.speakers.length : 0;

  // Ước tính tổng words để tiện so sánh tốc độ theo dung lượng transcript.
  let wordsCount = 0;
  if (Array.isArray(transcript?.segments)) {
    for (const seg of transcript.segments) {
      if (Array.isArray(seg?.words)) {
        wordsCount += seg.words.length;
      }
    }
  }

  const summary = {
    cacheHit: Boolean(phase.cache_hit),
    cacheCheckMs: Number(phase.cache_check ?? 0),
    normalizeMs: Number(phase.normalize ?? 0),
    transcribeMs: Number(phase.transcribe ?? 0),
    postprocessMs: Number(phase.postprocess ?? 0),
    totalMs: Number(phase.total ?? Math.round(processingSec * 1000)),
    processingTimeSec: processingSec,
    segmentsCount,
    wordsCount,
    speakersCount,
  };

  const responseBody = JSON.stringify({
    summary,
    phaseTimingsRaw: phase,
    note: "Bottleneck thường nằm ở transcribe hoặc normalize. cacheHit=true thì gần như bỏ qua Whisper.",
  }, null, 2);

  // Nếu có logId từ lúc bắt đầu chạy -> update đúng dòng đang pending.
  // Nếu không có (backward compatibility) -> tạo log mới như cũ.
  if (logId) {
    updateDebugLog(logId, {
      status: 200,
      responseBody,
      duration: summary.totalMs,
      error: null,
    });
    return;
  }

  addDebugLog({
    id: generateLogId(),
    timestamp: new Date(),
    method: "TRANSCRIBE",
    url: "local://transcribe/phase-timing",
    requestHeaders: { "Content-Type": "application/json" },
    requestBody: JSON.stringify({
      label,
      options,
    }, null, 2),
    status: 200,
    responseHeaders: {},
    responseBody,
    duration: summary.totalMs,
    error: null,
    label: `Transcribe Timing | ${label}`,
  });
}
