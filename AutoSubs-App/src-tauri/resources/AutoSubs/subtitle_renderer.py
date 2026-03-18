# ============================================================
# subtitle_renderer.py — Thêm phụ đề lên timeline
# Bao gồm: AddSubtitles, AddSimpleSubtitles, seek, scan track
# ============================================================

import math
from . import state
from .helpers import to_frames, hex_to_rgb, read_json_file, timecode_from_frame
from .template_manager import (
    get_templates, get_template_item, get_template_item_by_folder, import_title_from_file
)


def sanitize_track_index(timeline, track_index, mark_in, mark_out):
    """
    Chuẩn hoá track index — nếu "0" hoặc vượt quá → tạo track mới
    Tôn trọng lựa chọn của user nếu track hợp lệ
    """
    if track_index in ("0", "", None) or \
       (track_index is not None and str(track_index).isdigit() and
        int(track_index) > timeline.GetTrackCount("video")):
        new_idx = timeline.GetTrackCount("video") + 1
        timeline.AddTrack("video")
        return new_idx
    return int(track_index)


def set_custom_colors(speaker, tool):
    """
    Set màu tuỳ chỉnh cho từng speaker (fill, outline, border)
    Speaker data từ frontend chứa: { fill: {enabled, color}, outline: {...}, border: {...} }
    """
    # Fill color (Shading Element 1)
    fill = speaker.get("fill", {})
    if fill.get("enabled") and fill.get("color"):
        color = hex_to_rgb(fill["color"])
        if color:
            tool.SetInput("Enabled1", 1)
            tool.SetInput("Red1", color["r"])
            tool.SetInput("Green1", color["g"])
            tool.SetInput("Blue1", color["b"])

    # Outline color (Shading Element 2)
    outline = speaker.get("outline", {})
    if outline.get("enabled") and outline.get("color"):
        color = hex_to_rgb(outline["color"])
        if color:
            tool.SetInput("Enabled2", 1)
            tool.SetInput("Red2", color["r"])
            tool.SetInput("Green2", color["g"])
            tool.SetInput("Blue2", color["b"])

    # Border color (Shading Element 4)
    border = speaker.get("border", {})
    if border.get("enabled") and border.get("color"):
        color = hex_to_rgb(border["color"])
        if color:
            tool.SetInput("Enabled4", 1)
            tool.SetInput("Red4", color["r"])
            tool.SetInput("Green4", color["g"])
            tool.SetInput("Blue4", color["b"])


def check_track_conflicts(file_path, track_index):
    """
    Kiểm tra xung đột: clips hiện có trên track có chồng lấp với phụ đề mới không
    Trả về: { hasConflicts: bool, conflictingClips: [...], trackName: str }
    """
    timeline = state.project.GetCurrentTimeline()
    timeline_start = timeline.GetStartFrame()
    frame_rate = float(timeline.GetSetting("timelineFrameRate"))

    # Đọc file phụ đề
    data = read_json_file(file_path)
    if not isinstance(data, dict):
        return {"hasConflicts": False, "error": "Could not read subtitle file"}

    subtitles = data.get("segments", [])
    if not subtitles:
        return {"hasConflicts": False, "message": "No subtitles to add"}

    # Phạm vi thời gian của phụ đề mới
    first_sub_start = to_frames(subtitles[0]["start"], frame_rate) + timeline_start
    last_sub_end = to_frames(subtitles[-1]["end"], frame_rate) + timeline_start

    # Validate track index
    track_idx = int(track_index) if str(track_index).isdigit() else 0
    if track_idx <= 0 or track_idx > timeline.GetTrackCount("video"):
        return {"hasConflicts": False, "trackExists": False, "message": "Track does not exist"}

    track_name = timeline.GetTrackName("video", track_idx) or f"Video {track_idx}"

    # Lấy clips hiện có trên track
    existing_clips = timeline.GetItemListInTrack("video", track_idx)
    if not existing_clips:
        return {"hasConflicts": False, "trackName": track_name, "message": "Track is empty"}

    # Tìm clips chồng lấp
    conflicting = []
    for clip in existing_clips:
        clip_start = clip.GetStart()
        clip_end = clip.GetEnd()
        if clip_start < last_sub_end and clip_end > first_sub_start:
            conflicting.append({
                "start": (clip_start - timeline_start) / frame_rate,
                "end": (clip_end - timeline_start) / frame_rate,
                "name": clip.GetName() or "Unnamed clip",
            })

    return {
        "hasConflicts": len(conflicting) > 0,
        "conflictingClips": conflicting,
        "trackName": track_name,
        "subtitleRange": {
            "start": (first_sub_start - timeline_start) / frame_rate,
            "end": (last_sub_end - timeline_start) / frame_rate,
        },
        "totalConflicts": len(conflicting),
    }


def add_subtitles(file_path, track_index, template_name, conflict_mode=None):
    """
    Thêm phụ đề lên timeline từ file JSON
    
    Flow:
    1. Đọc file JSON (chứa segments, speakers, mark_in/out)
    2. Xử lý conflict mode (replace/skip/new_track)
    3. Tạo clips từ template → AppendToTimeline
    4. Set text + màu cho từng clip qua Fusion comp
    
    conflict_mode: "replace" | "skip" | "new_track" | None
    """
    state.resolve.OpenPage("edit")

    data = read_json_file(file_path)
    if not isinstance(data, dict):
        print("[AutoSubs] Error reading JSON file")
        return False

    timeline = state.project.GetCurrentTimeline()
    timeline_start = timeline.GetStartFrame()
    timeline_end = timeline.GetEndFrame()

    mark_in = data.get("mark_in")
    mark_out = data.get("mark_out")
    subtitles = data.get("segments", [])
    speakers = data.get("speakers", [])
    speakers_exist = bool(speakers)

    # Nếu không có mark in/out → lấy từ timeline
    if mark_in is None or mark_out is None:
        try:
            mark_in_out = timeline.GetMarkInOut()
            mark_in = (mark_in_out["audio"].get("in", 0) + timeline_start) \
                if mark_in_out["audio"].get("in") is not None else timeline_start
            mark_out = (mark_in_out["audio"].get("out", 0) + timeline_start) \
                if mark_in_out["audio"].get("out") is not None else timeline_end
        except Exception:
            mark_in = timeline_start
            mark_out = timeline_end

    track_index = sanitize_track_index(timeline, track_index, mark_in, mark_out)

    # Chuẩn hoá speaker tracks
    if speakers_exist:
        for speaker in speakers:
            if not speaker.get("track"):
                speaker["track"] = track_index
            else:
                speaker["track"] = sanitize_track_index(
                    timeline, speaker["track"], mark_in, mark_out
                )

    root_folder = state.media_pool.GetRootFolder()

    # Tìm template
    if not template_name:
        available = get_templates()
        if available:
            template_name = available[0]["value"]

    template_item = None
    if template_name:
        template_item = get_template_item(root_folder, template_name)
    if not template_item:
        template_item = get_template_item(root_folder, "Default Template")
    if not template_item:
        print(f"[AutoSubs] Error: Could not find template '{template_name}'")
        return False

    template_fps = float(template_item.GetClipProperty().get("FPS", 24))
    frame_rate = float(timeline.GetSetting("timelineFrameRate"))

    # ===== XỬ LÝ CONFLICT MODE =====
    if conflict_mode == "new_track":
        track_index = timeline.GetTrackCount("video") + 1
        timeline.AddTrack("video")
        print(f"[AutoSubs] Created new track: {track_index}")

    elif conflict_mode == "replace":
        existing = timeline.GetItemListInTrack("video", track_index)
        if existing:
            first_start = to_frames(subtitles[0]["start"], frame_rate) + timeline_start
            last_end = to_frames(subtitles[-1]["end"], frame_rate) + timeline_start
            to_delete = [c for c in existing
                         if c.GetStart() < last_end and c.GetEnd() > first_start]
            for clip in to_delete:
                timeline.DeleteClips([clip], False)
            print(f"[AutoSubs] Deleted {len(to_delete)} conflicting clips")

    elif conflict_mode == "skip":
        existing = timeline.GetItemListInTrack("video", track_index)
        if existing:
            filtered = []
            for sub in subtitles:
                sub_start = to_frames(sub["start"], frame_rate) + timeline_start
                sub_end = to_frames(sub["end"], frame_rate) + timeline_start
                has_conflict = any(
                    sub_start < c.GetEnd() and sub_end > c.GetStart()
                    for c in existing
                )
                if not has_conflict:
                    filtered.append(sub)
            skipped = len(subtitles) - len(filtered)
            print(f"[AutoSubs] Skipped {skipped} conflicting subtitles")
            subtitles = filtered
            if not subtitles:
                return {"success": True, "message": "All subtitles skipped", "added": 0}

    # ===== TẠO CLIP LIST =====
    join_threshold = frame_rate  # 1 giây
    clip_list = []

    for i, sub in enumerate(subtitles):
        start_frame = to_frames(sub["start"], frame_rate)
        end_frame = to_frames(sub["end"], frame_rate)
        timeline_pos = timeline_start + start_frame
        duration = end_frame - start_frame

        # Nối khoảng hở nếu gần nhau (< 1 giây)
        if i < len(subtitles) - 1:
            next_start = timeline_start + to_frames(subtitles[i + 1]["start"], frame_rate)
            gap = next_start - (timeline_pos + duration)
            if gap < join_threshold:
                duration = duration + gap + 1

        # Convert duration sang template FPS
        clip_duration = (duration / frame_rate) * template_fps

        # Speaker track override
        item_track = track_index
        if speakers_exist:
            speaker_id = sub.get("speaker_id")
            if speaker_id is not None and speaker_id != "?":
                idx = int(speaker_id)
                if idx < len(speakers) and speakers[idx].get("track"):
                    item_track = speakers[idx]["track"]

        clip_list.append({
            "mediaPoolItem": template_item,
            "mediaType": 1,
            "startFrame": 0,
            "endFrame": clip_duration,
            "recordFrame": timeline_pos,
            "trackIndex": item_track,
        })

    # ===== APPEND TẤT CẢ CLIPS =====
    timeline_items = state.media_pool.AppendToTimeline(clip_list)

    # Set text + màu cho từng clip
    if timeline_items:
        for i, item in enumerate(timeline_items):
            try:
                sub = subtitles[i]
                text = sub.get("text", "")

                if item.GetFusionCompCount() > 0:
                    comp = item.GetFusionCompByIndex(1)
                    tool = comp.FindToolByID("TextPlus")
                    tool.SetInput("StyledText", text)

                    # Set màu speaker nếu có
                    if speakers_exist:
                        sid = sub.get("speaker_id")
                        if sid is not None and sid != "?":
                            speaker = speakers[int(sid)]
                            set_custom_colors(speaker, tool)

                    item.SetClipColor("Green")
            except Exception as e:
                print(f"[AutoSubs] Failed to set subtitle {i}: {e}")

    # Refresh timeline
    timeline.SetCurrentTimecode(timeline.GetCurrentTimecode())


def add_simple_subtitles(clips, template_name, track_index, font_size):
    """
    Thêm phụ đề stories lên timeline (batch)
    Nhận mảng clips [{text, start, end}] + 1 template + fontSize cố định
    """
    print(f"[AutoSubs] AddSimpleSubtitles: {len(clips)} clips, "
          f"template='{template_name}', track={track_index}, fontSize={font_size}")

    if not clips:
        return {"error": True, "message": "No clips provided"}

    state.resolve.OpenPage("edit")
    timeline = state.project.GetCurrentTimeline()
    if not timeline:
        return {"error": True, "message": "No active timeline found"}

    frame_rate = float(timeline.GetSetting("timelineFrameRate"))
    timeline_start = timeline.GetStartFrame()
    root_folder = state.media_pool.GetRootFolder()

    # Xử lý track: 0 = tạo track auto, nếu lớn hơn hiện tại thì tạo thêm
    track_idx = int(track_index or 0)
    total_tracks = timeline.GetTrackCount("video")
    if track_idx == 0:
        track_idx = total_tracks + 1
        timeline.AddTrack("video")
        print(f"[AutoSubs] Tạo track mới: V{track_idx}")
    elif track_idx > total_tracks:
        for _ in range(total_tracks, track_idx):
            timeline.AddTrack("video")
        print(f"[AutoSubs] Thêm tracks đến V{track_idx}")
    print(f"[AutoSubs] Sử dụng track V{track_idx} (tổng tracks: {timeline.GetTrackCount('video')})")

    # Tìm template
    if not template_name:
        template_name = "Default Template"
    template_item = get_template_item(root_folder, template_name)
    if not template_item:
        print("[AutoSubs] Template không có — thử import từ file...")
        template_item = import_title_from_file(template_name)
    if not template_item:
        available = get_templates()
        if available:
            template_item = get_template_item(root_folder, available[0]["value"])
    if not template_item:
        return {"error": True, "message": f"Template not found: {template_name}"}

    template_fps = float(template_item.GetClipProperty().get("FPS", frame_rate))
    font_size = float(font_size or 0.04)
    print(f"[AutoSubs] Template: '{template_name}', FPS={template_fps}, fontSize={font_size}")

    # ⭐ Chia clips thành batch 30 cái → AppendToTimeline từng batch
    # DaVinci API không xử lý được hàng trăm clips 1 lúc dẫn đến None return
    BATCH_SIZE = 30
    added = 0
    total_batches = math.ceil(len(clips) / BATCH_SIZE)

    for batch_idx in range(total_batches):
        batch_start_idx = batch_idx * BATCH_SIZE
        batch_end_idx = min((batch_idx + 1) * BATCH_SIZE, len(clips))
        batch_clips_data = clips[batch_start_idx:batch_end_idx]

        clip_list = []
        for clip_data in batch_clips_data:
            start_frame = to_frames(clip_data["start"], frame_rate)
            end_frame = to_frames(clip_data["end"], frame_rate)
            duration = end_frame - start_frame
            if duration <= 0:
                duration = 1
            clip_duration = (duration / frame_rate) * template_fps

            clip_list.append({
                "mediaPoolItem": template_item,
                "mediaType": 1,
                "startFrame": 0,
                "endFrame": clip_duration,
                "recordFrame": timeline_start + start_frame,
                "trackIndex": track_idx,
            })

        print(f"[AutoSubs] Batch {batch_idx + 1}/{total_batches}: appending {len(clip_list)} clips...")
        
        timeline_items = state.media_pool.AppendToTimeline(clip_list)
        
        if not timeline_items:
            print(f"[AutoSubs] ⚠️ Batch {batch_idx + 1} failed! Trying one-by-one fallback...")
            # Fallback: chạy từng clip một
            for ci, single_clip in enumerate(clip_list):
                single_res = state.media_pool.AppendToTimeline([single_clip])
                if single_res and len(single_res) > 0:
                    item = single_res[0]
                    try:
                        text = batch_clips_data[ci].get("text", "")
                        if item.GetFusionCompCount() > 0:
                            comp = item.GetFusionCompByIndex(1)
                            tool = comp.FindToolByID("TextPlus")
                            if tool:
                                tool.SetInput("StyledText", text)
                                try:
                                    tool.SetInput("Size", font_size)
                                except Exception:
                                    pass
                                added += 1
                        item.SetClipColor("Yellow")
                    except Exception as e:
                        print(f"[AutoSubs] Clip error in one-by-one: {e}")
        else:
            # Set text + font size cho từng clip trong batch thành công
            for ci, item in enumerate(timeline_items):
                try:
                    text = batch_clips_data[ci].get("text", "")
                    if item.GetFusionCompCount() > 0:
                        comp = item.GetFusionCompByIndex(1)
                        tool = comp.FindToolByID("TextPlus")
                        if tool:
                            tool.SetInput("StyledText", text)
                            try:
                                tool.SetInput("Size", font_size)
                            except Exception:
                                pass
                            added += 1
                    item.SetClipColor("Yellow")
                except Exception as e:
                    print(f"[AutoSubs] Clip {ci} error: {e}")
                    
            print(f"[AutoSubs] Batch {batch_idx + 1} done: {len(timeline_items)} clips added.")

    # Refresh timeline
    timeline.SetCurrentTimecode(timeline.GetCurrentTimecode())

    print(f"[AutoSubs] AddSimpleSubtitles done: {added}/{len(clips)} clips added to V{track_idx}")
    return {"success": True, "added": added, "total": len(clips), "trackIndex": track_idx}


def seek_to_time(seconds):
    """
    Di chuyển playhead đến vị trí (giây) trên timeline
    Dùng khi user click số câu → nhảy đến vị trí đó
    """
    timeline = state.project.GetCurrentTimeline()
    if not timeline:
        return {"error": True, "message": "No active timeline found"}

    frame_rate = float(timeline.GetSetting("timelineFrameRate"))
    timeline_start = timeline.GetStartFrame()
    target_frame = timeline_start + math.floor(float(seconds) * frame_rate)

    timecode = timecode_from_frame(target_frame, frame_rate)
    timeline.SetCurrentTimecode(timecode)

    print(f"[AutoSubs] Seek to {seconds:.2f}s → frame {target_frame} → {timecode}")
    return {"success": True, "timecode": timecode}


def get_track_clip_numbers(track_index):
    """
    Quét track trên timeline → trả về danh sách số từ tên clip + time ranges
    Frontend dùng time ranges để phát hiện khoảng trắng = câu thiếu
    """
    print(f"[AutoSubs] Quét track V{track_index} trên timeline...")

    timeline = state.project.GetCurrentTimeline()
    if not timeline:
        return {"error": True, "message": "No active timeline found"}

    track_idx = int(track_index or 1)
    frame_rate = float(timeline.GetSetting("timelineFrameRate"))
    timeline_start = timeline.GetStartFrame()
    track_items = timeline.GetItemListInTrack("video", track_idx)

    if not track_items:
        print(f"  Track V{track_idx} trống")
        return {"clipNumbers": [], "clipRanges": [], "totalClips": 0}

    clip_numbers = []
    clip_ranges = []

    for item in track_items:
        item_name = item.GetName() or ""
        # Trích số đầu tiên từ tên clip (VD: "videoscene_28" → 28)
        import re
        match = re.search(r'(\d+)', item_name)
        if match:
            clip_numbers.append(int(match.group(1)))

        # Lấy vị trí thời gian
        start = item.GetStart()
        end = item.GetEnd()
        start_sec = round((start - timeline_start) / frame_rate, 2)
        end_sec = round((end - timeline_start) / frame_rate, 2)
        clip_ranges.append({
            "start": start_sec,
            "endTime": end_sec,
            "name": item_name,
        })

    print(f"  Tìm thấy {len(track_items)} clips trên track V{track_idx} "
          f"(có số: {len(clip_numbers)})")

    return {
        "clipNumbers": clip_numbers,
        "clipRanges": clip_ranges,
        "totalClips": len(track_items),
    }
