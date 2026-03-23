# ============================================================
# server.py — HTTP server lắng nghe lệnh từ Tauri app
# Nhận HTTP POST JSON → dispatch tới các module → trả về JSON
# Thay thế hoàn toàn ljsocket.lua + server loop trong Lua
# ============================================================

import json
import os
import time
import socket
import subprocess
import platform
from http.server import HTTPServer, BaseHTTPRequestHandler

from . import state
from .helpers import safe_json, jump_to_time
from .timeline_info import get_timeline_info
from .audio_export import export_audio, get_export_progress, cancel_export
from .subtitle_renderer import (
    check_track_conflicts, add_subtitles, add_simple_subtitles,
    seek_to_time, get_track_clip_numbers,
)
from .template_subtitles import add_template_subtitles
from .template_manager import create_template_set
from .media_import import add_audio_to_timeline, add_sfx_clips_to_timeline, add_media_to_timeline, auto_relink_autosubs_media
from .preview_generator import generate_preview


def route_request(data):
    """
    Router: nhận dict từ HTTP body → gọi hàm tương ứng → trả về dict
    Mỗi func name map đến 1 hàm nghiệp vụ cụ thể
    
    Các func được hỗ trợ:
    - Ping                    → heartbeat check
    - GetTimelineInfo         → thông tin timeline
    - JumpToTime              → di chuyển playhead
    - ExportAudio             → export audio từ tracks
    - GetExportProgress       → poll tiến độ export
    - CancelExport            → huỷ export
    - CheckTrackConflicts     → kiểm tra xung đột trên track
    - AddSubtitles            → thêm phụ đề từ file JSON
    - AddSimpleSubtitles      → thêm phụ đề stories (batch)
    - AddTemplateSubtitles    → thêm phụ đề với nhiều templates
    - GeneratePreview         → tạo ảnh preview
    - SeekToTime              → di chuyển playhead đến giây
    - GetTrackClipNumbers     → quét track lấy số clip
    - AddMediaToTimeline      → import video/image vào timeline
    - AddAudioToTimeline      → import audio BGM vào timeline
    - AddSfxClipsToTimeline   → import SFX clips vào timeline
    - CreateTemplateSet       → tạo template folders
    - Exit                    → tắt server
    """
    func = data.get("func", "")

    if func == "Ping":
        return {"message": "Pong"}

    elif func == "GetTimelineInfo":
        print("[AutoSubs Server] Retrieving Timeline Info...")
        return get_timeline_info()

    elif func == "JumpToTime":
        print("[AutoSubs Server] Jumping to time...")
        jump_to_time(data.get("seconds", 0))
        return {"message": "Jumped to time"}

    elif func == "ExportAudio":
        print("[AutoSubs Server] Exporting audio...")
        return export_audio(data.get("outputDir", ""), data.get("inputTracks", []))

    elif func == "GetExportProgress":
        return get_export_progress()

    elif func == "CancelExport":
        print("[AutoSubs Server] Cancelling export...")
        return cancel_export()

    elif func == "CheckTrackConflicts":
        print("[AutoSubs Server] Checking track conflicts...")
        return check_track_conflicts(data.get("filePath", ""), data.get("trackIndex", "0"))

    elif func == "AddSubtitles":
        print("[AutoSubs Server] Adding subtitles to timeline...")
        result = add_subtitles(
            data.get("filePath", ""),
            data.get("trackIndex", "0"),
            data.get("templateName", ""),
            data.get("conflictMode"),
        )
        return {"message": "Job completed", "result": result}

    elif func == "AddSimpleSubtitles":
        print("[AutoSubs Server] Adding Simple Subtitles...")
        return add_simple_subtitles(
            data.get("clips", []),
            data.get("templateName", ""),
            data.get("trackIndex", "0"),
            data.get("fontSize", 0.04),
        )

    elif func == "AddTemplateSubtitles":
        print("[AutoSubs Server] Adding Template Subtitles...")
        return add_template_subtitles(data.get("clips", []), data.get("trackIndex", "1"))

    elif func == "GeneratePreview":
        print("[AutoSubs Server] Generating preview...")
        path = generate_preview(
            data.get("speaker", {}),
            data.get("templateName", ""),
            data.get("exportPath", ""),
        )
        return path  # trả về string path

    elif func == "SeekToTime":
        return seek_to_time(data.get("seconds", 0))

    elif func == "GetTrackClipNumbers":
        print("[AutoSubs Server] Getting track clip numbers...")
        return get_track_clip_numbers(data.get("trackIndex", "1"))

    elif func == "AddMediaToTimeline":
        print("[AutoSubs Server] Adding media to timeline...")
        return add_media_to_timeline(data.get("clips", []), data.get("trackIndex", "1"))

    elif func == "AddAudioToTimeline":
        print("[AutoSubs Server] Adding audio to new track...")
        return add_audio_to_timeline(data.get("filePath", ""), data.get("trackName"))

    elif func == "AddSfxClipsToTimeline":
        print("[AutoSubs Server] Adding SFX clips to timeline...")
        return add_sfx_clips_to_timeline(data.get("clips", []), data.get("trackName"))

    elif func == "CreateTemplateSet":
        print("[AutoSubs Server] Creating Template Set...")
        return create_template_set(data.get("templateNames", []))

    elif func == "AutoRelinkMedia":
        # Relink lại mọi clip offline trong Media Pool
        # Gọi khi mở project lại mà bị 'Media not found'
        print("[AutoSubs Server] Auto Relinking offline media...")
        return auto_relink_autosubs_media(data.get("folderPath"))

    elif func == "Exit":
        state.quit_server = True
        return {"message": "Server shutting down"}

    else:
        print(f"[AutoSubs Server] Invalid function name: {func}")
        return {"message": f"Unknown function: {func}"}


class AutoSubsHandler(BaseHTTPRequestHandler):
    """
    HTTP request handler cho AutoSubs server
    Nhận POST request → parse JSON → route → trả JSON response
    """

    def do_POST(self):
        """Xử lý POST request từ Tauri app"""
        try:
            # Đọc request body
            content_length = int(self.headers.get("Content-Length", 0))
            # errors='replace': thay ký tự UTF-8 lỗi bằng '�' thay vì crash
            # Nguyên nhân: file SFX/audio có tên chứa encoding khác (Latin-1, CP1252...)
            body = self.rfile.read(content_length).decode("utf-8", errors="replace")
            print(f"[AutoSubs Server] Received: {body[:200]}")

            # Parse JSON
            data = json.loads(body) if body else {}

            # Route request → gọi hàm xử lý
            try:
                result = route_request(data)
            except Exception as e:
                print(f"[AutoSubs Server] Error: {e}")
                result = {"message": f"Job failed with error: {e}"}

            # Encode response
            response_body = safe_json(result) if isinstance(result, dict) else json.dumps(result)

        except json.JSONDecodeError:
            # JSON parse lỗi — kiểm tra có phải Exit command không
            if body and '"Exit"' in body:
                state.quit_server = True
                response_body = safe_json({"message": "Server shutting down"})
            else:
                response_body = safe_json({"message": "Invalid JSON data"})
        except Exception as e:
            response_body = safe_json({"message": f"Server error: {e}"})

        # Gửi HTTP response
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response_body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(response_body.encode("utf-8"))
        except Exception as e:
            print(f"[AutoSubs Server] Send failed: {e}")

    def log_message(self, format, *args):
        """Override log_message để không spam console"""
        pass  # Bỏ qua access log mặc định


def send_exit_via_socket():
    """
    Gửi lệnh Exit đến server đang chạy trước đó (nếu có)
    Dùng khi cần restart: gửi Exit → đợi → bind lại port
    """
    try:
        body = '{"func":"Exit"}'
        request = (
            f"POST / HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{state.port}\r\n"
            f"Connection: close\r\n"
            f"Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"\r\n{body}"
        )
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(2)
        sock.connect(("127.0.0.1", state.port))
        sock.sendall(request.encode())
        sock.close()
        print("[AutoSubs] Sent Exit to existing server")
    except Exception:
        pass  # Server cũ không chạy — bỏ qua


def launch_app():
    """
    Mở AutoSubs app (Tauri) nếu không phải DEV_MODE
    macOS: open /Applications/AutoSubs.app
    Windows: start "" "path/to/AutoSubs.exe"
    """
    try:
        os_name = platform.system()
        if os_name == "Darwin":
            subprocess.Popen(["open", state.main_app])
        elif os_name == "Windows":
            subprocess.Popen(["start", "", state.main_app], shell=True)
        else:
            subprocess.Popen([state.main_app], start_new_session=True)
        print("[AutoSubs] App launched successfully")
    except Exception as e:
        print(f"[AutoSubs] Failed to launch app: {e}")


def start_server():
    """
    Khởi động HTTP server trên port 56003
    Chạy blocking loop cho đến khi nhận lệnh Exit
    
    Nếu port đã bị chiếm → gửi Exit cho server cũ → đợi → thử lại
    """
    port = state.port

    # Thử bind — nếu lỗi thì gửi Exit cho server cũ
    try:
        server = HTTPServer(("127.0.0.1", port), AutoSubsHandler)
    except OSError:
        print(f"[AutoSubs] Port {port} is in use — sending Exit to old server...")
        send_exit_via_socket()
        time.sleep(0.5)
        server = HTTPServer(("127.0.0.1", port), AutoSubsHandler)

    server.timeout = 0.1  # Non-blocking accept (100ms timeout)
    print(f"[AutoSubs] Server is listening on port: {port}")

    # Mở app nếu không phải dev mode
    if not state.dev_mode:
        launch_app()

    # ===== SERVER LOOP =====
    # Dùng handle_request() thay vì serve_forever()
    # để có thể check quit_server flag mỗi vòng lặp
    while not state.quit_server:
        server.handle_request()

    print("[AutoSubs] Shutting down server...")
    server.server_close()
    print("[AutoSubs] Server shut down.")
