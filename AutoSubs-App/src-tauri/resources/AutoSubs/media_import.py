# ============================================================
# media_import.py — Import media files vào DaVinci Resolve timeline
# Bao gồm: audio (BGM), SFX clips, video/image files
# ============================================================

import os
import math
from . import state
from .helpers import to_frames
from .template_manager import walk_media_pool


def add_audio_to_timeline(file_path, track_name=None):
    """
    Import 1 file audio vào AUDIO TRACK MỚI trên timeline
    File audio (VD: final_bgm_ducked.wav) được đặt ở đầu timeline (0s)
    Tạo track audio mới để user có thể xoá/tạo lại nếu không ưng
    
    Request: { filePath: string, trackName?: string }
    Response: { success: true, audioTrack: number, trackName: string }
    """
    print(f"[AutoSubs] AddAudioToTimeline: {file_path}")

    timeline = state.project.GetCurrentTimeline()
    if not timeline:
        return {"error": True, "message": "No active timeline found"}

    frame_rate = float(timeline.GetSetting("timelineFrameRate"))
    timeline_start = timeline.GetStartFrame()

    # 1. Import file vào Media Pool
    current_folder = state.media_pool.GetCurrentFolder()
    audio_folder = state.media_pool.AddSubFolder(current_folder, "AutoSubs Audio")
    if audio_folder:
        state.media_pool.SetCurrentFolder(audio_folder)

    media_items = state.media_pool.ImportMedia([file_path])

    # Quay lại folder gốc
    if current_folder:
        state.media_pool.SetCurrentFolder(current_folder)

    if not media_items:
        return {"error": True, "message": "Không import được file audio vào Media Pool"}

    audio_item = media_items[0]
    clip_props = audio_item.GetClipProperty()
    print(f"[AutoSubs] Imported audio: {clip_props.get('Clip Name', 'unknown')}")

    # 2. Tạo audio track mới
    audio_track_count = timeline.GetTrackCount("audio")
    new_track_idx = audio_track_count + 1
    timeline.AddTrack("audio")

    # Đặt tên cho track mới
    label = track_name or "BGM - AutoSubs"
    try:
        timeline.SetTrackName("audio", new_track_idx, label)
    except Exception:
        pass

    print(f"[AutoSubs] Created audio track A{new_track_idx} ({label})")

    # 3. Đặt file audio lên track mới tại đầu timeline
    clip_fps = float(clip_props.get("FPS", 0)) or frame_rate
    total_frames = int(clip_props.get("Frames", 0))

    if total_frames <= 0:
        duration = float(clip_props.get("Duration", 0))
        if duration > 0:
            total_frames = math.floor(duration * clip_fps)
        else:
            total_frames = math.floor(3600 * clip_fps)  # 1 giờ max

    audio_clip = {
        "mediaPoolItem": audio_item,
        "mediaType": 2,                  # 2 = Audio only
        "startFrame": 0,
        "endFrame": total_frames,
        "recordFrame": timeline_start,   # Đặt ở đầu timeline
        "trackIndex": new_track_idx,
    }

    timeline_items = state.media_pool.AppendToTimeline([audio_clip])

    if not timeline_items:
        return {"error": True, "message": "Không thêm được audio lên timeline"}

    # Đánh dấu clip màu tím
    try:
        timeline_items[0].SetClipColor("Purple")
    except Exception:
        pass

    # Refresh timeline
    timeline.SetCurrentTimecode(timeline.GetCurrentTimecode())

    print(f"[AutoSubs] ✅ Audio added to track A{new_track_idx}")
    return {
        "success": True,
        "audioTrack": new_track_idx,
        "trackName": label,
        "message": f"Đã thêm nhạc nền vào Audio Track A{new_track_idx}",
    }


def add_sfx_clips_to_timeline(clips, track_name=None):
    """
    Import nhiều file SFX vào AUDIO TRACK trên timeline
    Mỗi clip được đặt đúng vị trí (startTime giây)
    Hỗ trợ trim: nếu có trimStartSec/trimEndSec → cắt đoạn SFX
    
    Request: { clips: [{filePath, startTime, trimStartSec?, trimEndSec?}], trackName?: string }
    Response: { success: true, clipsAdded: number, skippedCount: number }
    """
    print(f"[AutoSubs] AddSfxClipsToTimeline: {len(clips)} clips")

    timeline = state.project.GetCurrentTimeline()
    if not timeline:
        return {"error": True, "message": "No active timeline found"}

    if not clips:
        return {"error": True, "message": "No SFX clips provided"}

    frame_rate = float(timeline.GetSetting("timelineFrameRate"))
    timeline_start = timeline.GetStartFrame()

    # 1. Thu thập file paths unique
    unique_paths = []
    path_set = set()
    for clip in clips:
        fp = clip.get("filePath", "")
        if fp and fp not in path_set:
            path_set.add(fp)
            unique_paths.append(fp)

    # 2. Import tất cả SFX files vào Media Pool
    current_folder = state.media_pool.GetCurrentFolder()
    sfx_folder = state.media_pool.AddSubFolder(current_folder, "AutoSubs SFX")
    if sfx_folder:
        state.media_pool.SetCurrentFolder(sfx_folder)

    print(f"[AutoSubs] Importing {len(unique_paths)} unique SFX files...")
    media_items = state.media_pool.ImportMedia(unique_paths)

    if current_folder:
        state.media_pool.SetCurrentFolder(current_folder)

    if not media_items:
        return {"error": True, "message": "Failed to import SFX files to Media Pool"}

    # 3. Tạo mapping fileName → mediaPoolItem
    media_map = {}
    for item in media_items:
        props = item.GetClipProperty()
        name = props.get("File Name") or props.get("Clip Name") or ""
        if not name:
            path = props.get("File Path", "")
            name = os.path.basename(path)
        if name:
            media_map[name] = item
            print(f"[AutoSubs]   Mapped SFX: {name}")

    # 4. Dùng audio track 1 (không tạo track mới)
    target_track = 1
    label = track_name or "SFX - AutoSubs"
    print(f"[AutoSubs] Using audio track A{target_track} ({label})")

    # 5. Đặt từng SFX clip lên timeline
    added = 0
    skipped = 0

    for i, clip in enumerate(clips):
        file_name = os.path.basename(clip.get("filePath", ""))
        media_item = media_map.get(file_name)

        if not media_item:
            print(f"[AutoSubs] ⚠️ SFX {i}: Không tìm thấy '{file_name}' trong Media Pool")
            skipped += 1
            continue

        start_time = float(clip.get("startTime", 0))
        pos = timeline_start + math.floor(start_time * frame_rate)

        # Lấy FPS gốc của clip
        clip_props = media_item.GetClipProperty()
        clip_fps = float(clip_props.get("FPS", 0)) or frame_rate

        # Tính trim frames
        sfx_start = 0
        sfx_end = -1  # -1 = toàn bộ file

        if clip.get("trimStartSec") or clip.get("trimEndSec"):
            trim_start = float(clip.get("trimStartSec", 0))
            sfx_start = math.floor(trim_start * clip_fps)
            if clip.get("trimEndSec"):
                sfx_end = math.floor(float(clip["trimEndSec"]) * clip_fps)
            print(f"[AutoSubs] SFX {i}: ✂️ Trim: frame {sfx_start} → {sfx_end}")

        sfx_data = {
            "mediaPoolItem": media_item,
            "mediaType": 2,
            "startFrame": sfx_start,
            "endFrame": sfx_end,
            "recordFrame": pos,
            "trackIndex": target_track,
        }

        result = state.media_pool.AppendToTimeline([sfx_data])
        if result and len(result) > 0:
            added += 1
            try:
                result[0].SetClipColor("Orange")
            except Exception:
                pass
            print(f"[AutoSubs] ✅ SFX {i}: '{file_name}' @ {start_time:.2f}s → A{target_track}")
        else:
            print(f"[AutoSubs] ⚠️ SFX {i}: AppendToTimeline failed for '{file_name}'")
            skipped += 1

    # Refresh timeline
    timeline.SetCurrentTimecode(timeline.GetCurrentTimecode())

    print(f"[AutoSubs] SFX done: {added} added, {skipped} skipped, track A{target_track}")
    return {
        "success": True,
        "audioTrack": target_track,
        "clipsAdded": added,
        "skippedCount": skipped,
        "message": f"Added {added}/{len(clips)} SFX clips to Audio Track A{target_track} ({label})",
    }


def add_media_to_timeline(clips, track_index):
    """
    Import video/image files vào timeline đúng vị trí
    Mỗi clip: {filePath, startTime, endTime} (giây)
    
    Hỗ trợ:
    - Video: import cả video + audio
    - Ảnh tĩnh (jpg, png, webp...): chỉ video, dùng timeline FPS
    
    QUAN TRỌNG: ImportMedia() KHÔNG đảm bảo thứ tự →
    phải mapping bằng tên file để tránh gán sai clip
    """
    print(f"[AutoSubs] Adding {len(clips)} media clips to timeline...")

    timeline = state.project.GetCurrentTimeline()
    if not timeline:
        return {"error": True, "message": "No active timeline found"}

    frame_rate = float(timeline.GetSetting("timelineFrameRate"))
    timeline_start = timeline.GetStartFrame()
    track_idx = int(track_index or 1)

    # 1. Thu thập file paths
    file_paths = [clip.get("filePath", "") for clip in clips]

    # 2. Import vào Media Pool
    current_folder = state.media_pool.GetCurrentFolder()
    media_folder = state.media_pool.AddSubFolder(current_folder, "AutoSubs Media Import")
    if media_folder:
        state.media_pool.SetCurrentFolder(media_folder)

    print(f"  Importing {len(file_paths)} files to Media Pool...")
    media_items = state.media_pool.ImportMedia(file_paths)

    if not media_items:
        if current_folder:
            state.media_pool.SetCurrentFolder(current_folder)
        return {"error": True, "message": "Failed to import media files to Media Pool"}

    print(f"  Imported {len(media_items)} items")

    # 2.5. Tạo mapping fileName → mediaPoolItem
    media_map = {}
    for item in media_items:
        props = item.GetClipProperty()
        name = props.get("File Name") or props.get("Clip Name") or ""
        if not name:
            path = props.get("File Path", "")
            name = os.path.basename(path)
        if name:
            media_map[name] = item
            print(f"    Mapped: {name}")

    # 3. Đặt từng clip lên timeline ĐÚNG vị trí
    actual_added = 0

    # Extension ảnh tĩnh
    STILL_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".exr"}

    for i, clip in enumerate(clips):
        file_name = os.path.basename(clip.get("filePath", ""))
        media_item = media_map.get(file_name)

        if not media_item:
            print(f"  ⚠️ Clip {i}: Không tìm thấy '{file_name}' trong Media Pool")
            continue

        start_time = float(clip.get("startTime", 0))
        end_time = float(clip.get("endTime", 0))
        clip_duration = end_time - start_time

        if clip_duration <= 0:
            print(f"  Clip {i}: Skipped (invalid duration: {clip_duration:.2f}s)")
            continue

        pos = timeline_start + math.floor(start_time * frame_rate)

        # Phát hiện ảnh tĩnh
        _, ext = os.path.splitext(file_name.lower())
        is_still = ext in STILL_EXTENSIONS

        # Lấy FPS gốc
        clip_props = media_item.GetClipProperty()
        clip_fps = float(clip_props.get("FPS", 0)) or frame_rate
        if is_still or clip_fps <= 0:
            clip_fps = frame_rate
            print(f"  Clip {i}: 📷 Still image → using timeline FPS={frame_rate}")

        end_frame = math.floor(clip_duration * clip_fps)

        # Video clip
        video_clip = {
            "mediaPoolItem": media_item,
            "mediaType": 1,
            "startFrame": 0,
            "endFrame": end_frame,
            "recordFrame": pos,
            "trackIndex": track_idx,
        }

        if is_still:
            # Ảnh tĩnh: chỉ thêm video (không có audio)
            items = state.media_pool.AppendToTimeline([video_clip])
            if items and len(items) > 0:
                actual_added += 1
                for t_item in items:
                    t_item.SetClipColor("Blue")
        else:
            # Video: thêm cả video + audio
            audio_clip = {
                "mediaPoolItem": media_item,
                "mediaType": 2,
                "startFrame": 0,
                "endFrame": end_frame,
                "recordFrame": pos,
                "trackIndex": track_idx,
            }
            items = state.media_pool.AppendToTimeline([video_clip, audio_clip])
            if items and len(items) > 0:
                actual_added += 1
                for t_item in items:
                    t_item.SetClipColor("Blue")

        print(f"  Clip {i}: {file_name} → {start_time:.2f}s-{end_time:.2f}s "
              f"@ frame {pos} (endFrame={end_frame}, still={is_still})")

    # Quay lại folder gốc
    if current_folder:
        state.media_pool.SetCurrentFolder(current_folder)

    # Refresh timeline
    if actual_added > 0:
        timeline.SetCurrentTimecode(timeline.GetCurrentTimecode())
        print(f"  ✅ Successfully added {actual_added} clips!")
    else:
        print("  ❌ No clips were added.")
        return {"error": True, "message": "No clips were added", "clipsAdded": 0}

    return {
        "success": True,
        "message": f"Added {actual_added}/{len(clips)} clips to track {track_idx}",
        "clipsAdded": actual_added,
    }
