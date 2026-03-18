# ============================================================
# audio_export.py — Export audio từ DaVinci Resolve timeline
# Bao gồm: export, theo dõi tiến độ, huỷ export
# ============================================================

import time
import math
from . import state
from .helpers import to_frames, join_path, frame_from_timecode
from .timeline_info import reset_tracks


def get_clip_boundaries(timeline, selected_tracks):
    """
    Tìm điểm bắt đầu và kết thúc sớm nhất/muộn nhất
    của tất cả clips trên các audio tracks đã chọn
    Dùng để chỉ export đoạn audio có nội dung (không export khoảng trống)
    """
    earliest_start = None
    latest_end = None

    for track_index in selected_tracks:
        clips = timeline.GetItemListInTrack("audio", track_index)
        if clips:
            for clip in clips:
                clip_start = clip.GetStart()
                clip_end = clip.GetEnd()

                if earliest_start is None or clip_start < earliest_start:
                    earliest_start = clip_start
                if latest_end is None or clip_end > latest_end:
                    latest_end = clip_end

    return earliest_start, latest_end


def get_individual_clips(timeline, selected_tracks):
    """
    Lấy danh sách từng clip riêng lẻ trên các track đã chọn
    Trả về mảng sorted + merged (gộp clips overlapping)
    Dùng cho segment-based transcription
    """
    timeline_start = timeline.GetStartFrame()
    frame_rate = float(timeline.GetSetting("timelineFrameRate"))
    all_clips = []

    for track_index in selected_tracks:
        clips = timeline.GetItemListInTrack("audio", track_index)
        if clips:
            for clip in clips:
                clip_start = clip.GetStart()
                clip_end = clip.GetEnd()
                clip_name = clip.GetName() or "Unnamed"
                all_clips.append({
                    "startFrame": clip_start,
                    "endFrame": clip_end,
                    "start": (clip_start - timeline_start) / frame_rate,
                    "end": (clip_end - timeline_start) / frame_rate,
                    "name": clip_name,
                })

    # Sắp xếp theo start time
    all_clips.sort(key=lambda c: c["startFrame"])

    # Gộp clips chồng lấp (overlapping)
    merged = []
    for clip in all_clips:
        if not merged:
            merged.append(clip)
        else:
            last = merged[-1]
            if clip["startFrame"] <= last["endFrame"]:
                # Clips chồng → gộp lại
                last["endFrame"] = max(last["endFrame"], clip["endFrame"])
                last["end"] = max(last["end"], clip["end"])
                last["name"] = f"{last['name']} + {clip['name']}"
            else:
                merged.append(clip)

    return merged


def export_audio(output_dir, input_tracks):
    """
    Export audio từ các tracks đã chọn ra file .wav
    
    Flow:
    1. Mute tất cả track ngoại trừ tracks đã chọn
    2. Tìm clip boundaries để chỉ export phần có nội dung
    3. Chuyển sang trang Deliver, set render settings
    4. Bắt đầu render → trả về ngay (async)
    5. Frontend poll GetExportProgress() để theo dõi
    
    Request body: { outputDir: string, inputTracks: [string] }
    Response: { started: true, pid: number } hoặc { error: true, message: string }
    """
    # Kiểm tra đã có export đang chạy chưa
    try:
        if state.project.IsRenderingInProgress():
            return {"error": True, "message": "Another export is already in progress"}
    except Exception:
        pass

    # Reset export job state
    state.current_export_job = {
        "active": True,
        "pid": None,
        "progress": 0,
        "cancelled": False,
        "start_time": time.time(),
        "audio_info": None,
        "track_states": None,
        "individual_clips": None,
        "clip_boundaries": None,
    }

    timeline = state.project.GetCurrentTimeline()
    audio_tracks = timeline.GetTrackCount("audio")

    # Lưu trạng thái gốc của tất cả tracks (để restore sau)
    track_states = {}
    for i in range(1, audio_tracks + 1):
        track_states[i] = timeline.GetIsTrackEnabled("audio", i)

    # Tạo set các track đã chọn (convert string → int)
    selected = set()
    for v in input_tracks:
        n = int(v) if str(v).isdigit() else None
        if n:
            selected.add(n)

    # Mute tất cả track, chỉ enable tracks đã chọn
    for i in range(1, audio_tracks + 1):
        timeline.SetTrackEnable("audio", i, i in selected)

    state.current_export_job["track_states"] = track_states

    # Tìm clip boundaries trên tracks đã chọn
    clip_start, clip_end = get_clip_boundaries(timeline, selected)

    # Lấy individual clips cho segment-based transcription
    individual_clips = get_individual_clips(timeline, selected)
    state.current_export_job["individual_clips"] = individual_clips
    print(f"[AutoSubs] Found {len(individual_clips)} individual clip(s) for transcription")

    if clip_start is not None and clip_end is not None:
        print(f"[AutoSubs] Found clip boundaries: {clip_start} - {clip_end}")
        state.current_export_job["clip_boundaries"] = {"start": clip_start, "end": clip_end}
    else:
        print("[AutoSubs] No clips found on selected tracks, using full timeline")

    # Chuyển sang trang Deliver
    state.resolve.OpenPage("deliver")

    # Load preset Audio Only
    state.project.LoadRenderPreset("Audio Only")

    # ★ FIX: Ép format/codec rõ ràng (không chỉ phụ thuộc preset)
    state.project.SetCurrentRenderMode(1)  # 1 = Single clip
    state.project.SetCurrentRenderFormatAndCodec("wav", "LinearPCM")

    # ★ FIX: Dùng đúng key API: ExportAudio/ExportVideo (không phải IsExportAudio/IsExportVideo)
    render_settings = {
        "TargetDir": output_dir,
        "CustomName": "autosubs-exported-audio",
        "ExportVideo": False,   # ★ Key đúng theo DaVinci API doc
        "ExportAudio": True,    # ★ Key đúng theo DaVinci API doc
        "AudioBitDepth": 24,
        "AudioSampleRate": 44100,
    }

    # Chỉ set mark in/out nếu có clip boundaries
    if clip_start is not None and clip_end is not None:
        render_settings["MarkIn"] = clip_start
        render_settings["MarkOut"] = clip_end
        print(f"[AutoSubs] Setting render range: {clip_start} - {clip_end}")

    set_ok = state.project.SetRenderSettings(render_settings)
    print(f"[AutoSubs] SetRenderSettings = {set_ok}")

    try:
        # ★ Xóa tất cả render jobs cũ trước khi thêm mới
        state.project.DeleteAllRenderJobs()

        # Thêm render job và bắt đầu render
        pid = state.project.AddRenderJob()
        state.current_export_job["pid"] = pid
        state.project.StartRendering(pid)

        # Lấy thông tin render job vừa tạo
        render_job_list = state.project.GetRenderJobList()
        render_job = render_job_list[-1]  # job mới nhất

        frame_rate = float(timeline.GetSetting("timelineFrameRate"))
        base_offset = (render_job["MarkIn"] - timeline.GetStartFrame()) / frame_rate

        # Tính relative offsets cho mỗi clip segment
        segments = []
        for clip in (state.current_export_job.get("individual_clips") or []):
            segments.append({
                "start": clip["start"] - base_offset,        # Trong audio đã export
                "end": clip["end"] - base_offset,
                "timelineStart": clip["start"],               # Trên timeline gốc
                "timelineEnd": clip["end"],
                "name": clip["name"],
            })

        audio_info = {
            "path": join_path(render_job["TargetDir"], render_job["OutputFilename"]),
            "markIn": render_job["MarkIn"],
            "markOut": render_job["MarkOut"],
            "offset": base_offset,
            "segments": segments,
        }
        state.current_export_job["audio_info"] = audio_info

        print(f"[AutoSubs] Export started with PID: {pid}")
        return {
            "started": True,
            "message": "Export started successfully. Use GetExportProgress to monitor.",
            "pid": pid,
        }

    except Exception as e:
        state.current_export_job["active"] = False
        return {"error": True, "message": f"Failed to start export: {e}"}


def get_export_progress():
    """
    Kiểm tra tiến độ export audio hiện tại
    Frontend poll hàm này mỗi vài giây cho đến khi hoàn thành
    
    Trả về:
    - { active: true, progress: 50 } — đang export
    - { active: false, completed: true, audioInfo: {...} } — hoàn thành
    - { active: false, cancelled: true } — bị huỷ
    """
    job = state.current_export_job

    if not job["active"]:
        return {"active": False, "progress": 0, "message": "No export in progress"}

    if job["cancelled"]:
        return {
            "active": False,
            "progress": job["progress"],
            "cancelled": True,
            "message": "Export was cancelled",
        }

    if job["pid"] is not None:
        # Kiểm tra render đang chạy không
        render_in_progress = False
        try:
            render_in_progress = state.project.IsRenderingInProgress()
        except Exception:
            pass

        if render_in_progress:
            # Tính progress dựa vào playhead position
            try:
                timeline = state.project.GetCurrentTimeline()
                current_tc = timeline.GetCurrentTimecode()
                frame_rate = float(timeline.GetSetting("timelineFrameRate"))
                playhead = frame_from_timecode(current_tc, frame_rate)

                mark_in = job["audio_info"]["markIn"]
                mark_out = job["audio_info"]["markOut"]

                progress = round(((playhead - mark_in) / (mark_out - mark_in)) * 100)
                job["progress"] = max(0, min(100, progress))
            except Exception:
                pass

            return {
                "active": True,
                "progress": job["progress"],
                "message": "Export in progress...",
                "pid": job["pid"],
            }
        else:
            # Render đã dừng
            job["active"] = False
            reset_tracks()

            if job["cancelled"]:
                return {
                    "active": False,
                    "progress": job["progress"],
                    "cancelled": True,
                    "message": "Export was cancelled",
                }
            else:
                # Hoàn thành bình thường
                job["progress"] = 100
                return {
                    "active": False,
                    "progress": 100,
                    "completed": True,
                    "message": "Export completed successfully",
                    "audioInfo": job["audio_info"],
                }
    else:
        # Không có PID — lỗi
        job["active"] = False
        return {
            "active": False,
            "progress": 0,
            "error": True,
            "message": "Export job lost - no process ID available",
        }


def cancel_export():
    """
    Huỷ export audio đang chạy
    Gọi StopRendering() + restore tracks về trạng thái gốc
    """
    job = state.current_export_job

    if not job["active"]:
        return {"success": False, "message": "No export in progress to cancel"}

    if job["pid"]:
        try:
            state.project.StopRendering()
        except Exception as e:
            reset_tracks()
            return {"success": False, "message": f"Failed to cancel export: {e}"}

        reset_tracks()
        job["cancelled"] = True
        job["active"] = False
        return {"success": True, "message": "Export cancelled successfully"}
    else:
        return {"success": False, "message": "No render job to cancel"}
