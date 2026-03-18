# ============================================================
# timeline_info.py — Truy vấn thông tin timeline & tracks
# Bao gồm: lấy timeline info, danh sách video/audio tracks
# ============================================================

from . import state
from .template_manager import get_templates


def get_timeline_info():
    """
    Lấy thông tin timeline hiện tại đang mở trong DaVinci Resolve
    Frontend gọi hàm này khi kết nối lần đầu hoặc refresh
    
    Trả về dict chứa:
    - name: tên timeline
    - timelineId: ID duy nhất
    - timelineStart: thời điểm bắt đầu (giây)
    - projectName: tên project
    - outputTracks: danh sách video tracks
    - inputTracks: danh sách audio tracks
    - templates: danh sách templates có sẵn
    """
    # Refresh project và media pool (có thể đã đổi project)
    state.project = state.project_manager.GetCurrentProject()
    state.media_pool = state.project.GetMediaPool()

    timeline_info = {}
    try:
        timeline = state.project.GetCurrentTimeline()
        frame_rate = float(timeline.GetSetting("timelineFrameRate"))
        timeline_info = {
            "name": timeline.GetName(),
            "timelineId": timeline.GetUniqueId(),
            "timelineStart": timeline.GetStartFrame() / frame_rate,
            "projectName": state.project.GetName() or "unknown",
        }
    except Exception as e:
        print(f"[AutoSubs] Error retrieving timeline info: {e}")
        timeline_info = {
            "timelineId": "",
            "name": "No timeline selected",
        }
        return timeline_info

    # Thêm tracks và templates
    timeline_info["outputTracks"] = get_video_tracks()
    timeline_info["inputTracks"] = get_audio_tracks()
    timeline_info["templates"] = get_templates()

    return timeline_info


def get_video_tracks():
    """
    Lấy danh sách video tracks để user chọn track đặt phụ đề
    Track "0" = tạo track mới
    """
    tracks = [{"value": "0", "label": "Add to New Track"}]
    try:
        timeline = state.project.GetCurrentTimeline()
        track_count = timeline.GetTrackCount("video")
        for i in range(1, track_count + 1):
            tracks.append({
                "value": str(i),
                "label": timeline.GetTrackName("video", i),
            })
    except Exception as e:
        print(f"[AutoSubs] Error getting video tracks: {e}")
    return tracks


def get_audio_tracks():
    """
    Lấy danh sách audio tracks để user chọn track export audio
    """
    tracks = []
    try:
        timeline = state.project.GetCurrentTimeline()
        track_count = timeline.GetTrackCount("audio")
        for i in range(1, track_count + 1):
            tracks.append({
                "value": str(i),
                "label": timeline.GetTrackName("audio", i),
            })
    except Exception as e:
        print(f"[AutoSubs] Error getting audio tracks: {e}")
    return tracks


def reset_tracks():
    """
    Khôi phục trạng thái enable/disable gốc cho tất cả audio tracks
    Gọi sau khi export audio xong hoặc bị cancel
    """
    try:
        state.resolve.OpenPage("edit")
        timeline = state.project.GetCurrentTimeline()
        audio_tracks = timeline.GetTrackCount("audio")
        track_states = state.current_export_job.get("track_states")
        if track_states:
            for i in range(1, audio_tracks + 1):
                if i in track_states:
                    timeline.SetTrackEnable("audio", i, track_states[i])
    except Exception as e:
        print(f"[AutoSubs] Error resetting tracks: {e}")

    # Xoá clip boundaries
    state.current_export_job["clip_boundaries"] = None


def check_track_empty(track_index, mark_in, mark_out):
    """
    Kiểm tra track có trống không trong khoảng mark_in → mark_out
    Dùng để cảnh báo user trước khi ghi đè
    """
    track_index = int(track_index)
    timeline = state.project.GetCurrentTimeline()
    track_items = timeline.GetItemListInTrack("video", track_index)

    if not track_items:
        return True

    for item in track_items:
        item_start = item.GetStart()
        item_end = item.GetEnd()
        # Kiểm tra overlap
        if (item_start <= mark_in and item_end >= mark_in) or \
           (item_start <= mark_out and item_end >= mark_out):
            return False
        if item_start > mark_out:
            break

    return len(track_items) == 0
