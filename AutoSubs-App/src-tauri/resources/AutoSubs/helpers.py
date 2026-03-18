# ============================================================
# helpers.py — Các hàm tiện ích dùng chung
# Bao gồm: chuyển đổi màu, frame/timecode, đọc JSON, tạo HTTP response
# ============================================================

import os
import json
import time
import math


def hex_to_rgb(hex_color):
    """
    Chuyển mã màu HEX sang RGB (0.0 - 1.0)
    DaVinci Resolve dùng giá trị 0-1 thay vì 0-255
    Ví dụ: "#FF0000" → {"r": 1.0, "g": 0.0, "b": 0.0}
    """
    if not hex_color:
        return None
    hex_color = hex_color.lstrip("#")
    if len(hex_color) != 6:
        return None
    try:
        r = int(hex_color[0:2], 16) / 255
        g = int(hex_color[2:4], 16) / 255
        b = int(hex_color[4:6], 16) / 255
        return {"r": r, "g": g, "b": b}
    except ValueError:
        return None


def to_frames(seconds, frame_rate):
    """Chuyển giây sang số frame (ví dụ: 1.5s × 24fps = 36 frames)"""
    return seconds * frame_rate


def join_path(dir_path, filename):
    """Nối đường dẫn thư mục + tên file"""
    return os.path.join(dir_path, filename)


def read_json_file(file_path):
    """
    Đọc file JSON và trả về dict/list
    Trả về None nếu file không tồn tại hoặc JSON lỗi
    """
    try:
        # errors='replace': tránh crash khi file JSON chứa ký tự non-UTF-8
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"[AutoSubs] File not found: {file_path}")
        return None
    except json.JSONDecodeError as e:
        print(f"[AutoSubs] JSON parse error: {e}")
        return None
    except Exception as e:
        print(f"[AutoSubs] Error reading file: {e}")
        return None


def create_response(body):
    """
    Tạo HTTP response string (header + body)
    Dùng cho server trả về kết quả cho Tauri app
    """
    header = (
        "HTTP/1.1 200 OK\r\n"
        "Server: autosubs-python/1.0\r\n"
        "Content-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Connection: close\r\n"
        "\r\n"
    )
    return header + body


def safe_json(obj):
    """
    Encode dict thành JSON string an toàn
    Nếu json.dumps() lỗi → trả về fallback đơn giản
    """
    try:
        return json.dumps(obj, ensure_ascii=False)
    except Exception:
        if obj and "message" in obj:
            msg = str(obj["message"]).replace('"', '\\"')
            return f'{{"message":"{msg}"}}'
        return "{}"


def timecode_from_frame(frame, fps):
    """
    Chuyển số frame thành timecode string HH:MM:SS:FF
    Ví dụ: frame 3624 ở 24fps → "00:02:31:00"
    """
    fps = int(fps)
    if fps <= 0:
        fps = 24
    total_frames = int(frame)
    ff = total_frames % fps
    total_seconds = total_frames // fps
    ss = total_seconds % 60
    total_minutes = total_seconds // 60
    mm = total_minutes % 60
    hh = total_minutes // 60
    return f"{hh:02d}:{mm:02d}:{ss:02d}:{ff:02d}"


def frame_from_timecode(timecode, fps):
    """
    Chuyển timecode string HH:MM:SS:FF thành số frame
    Ví dụ: "00:02:31:00" ở 24fps → 3624
    """
    fps = int(fps)
    parts = timecode.split(":")
    if len(parts) == 4:
        hh, mm, ss, ff = [int(p) for p in parts]
        return ((hh * 3600 + mm * 60 + ss) * fps) + ff
    return 0


def jump_to_time(seconds):
    """
    Di chuyển playhead đến vị trí (giây) trên timeline
    Dùng khi user click vào 1 câu trong danh sách phụ đề
    """
    from . import state

    timeline = state.project.GetCurrentTimeline()
    frame_rate = float(timeline.GetSetting("timelineFrameRate"))
    frames = to_frames(seconds, frame_rate) + timeline.GetStartFrame() + 1
    timecode = timecode_from_frame(frames, frame_rate)
    timeline.SetCurrentTimecode(timecode)
