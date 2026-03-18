# ============================================================
# state.py — Shared state dùng chung cho tất cả module
# Các biến ở đây được set 1 lần trong __init__.py → init()
# Sau đó tất cả module khác import state để dùng
# ============================================================

# ===== DaVinci Resolve objects =====
resolve = None           # Resolve object chính (gốc mọi API call)
project_manager = None   # ProjectManager — quản lý projects
project = None           # Project hiện tại đang mở
media_pool = None        # MediaPool — quản lý media clips

# ===== Cấu hình app =====
dev_mode = False         # True = dev mode (không mở app, dùng path local)
port = 56003             # Port cho HTTP server lắng nghe

# ===== Đường dẫn =====
resources_path = ""      # Thư mục resources (chứa modules, assets)
assets_path = ""         # Thư mục AutoSubs assets (template .drb...)
main_app = ""            # Đường dẫn tới app executable
command_open = ""        # Lệnh OS để mở app

# ===== Cờ điều khiển server =====
quit_server = False      # True → server loop dừng lại

# ===== Trạng thái export audio =====
current_export_job = {
    "active": False,          # Đang export hay không
    "pid": None,              # Render job ID
    "progress": 0,            # Tiến độ (0-100)
    "cancelled": False,       # User huỷ export
    "start_time": None,       # Thời gian bắt đầu
    "audio_info": {           # Thông tin audio đã export
        "path": "",
        "mark_in": 0,
        "mark_out": 0,
        "offset": 0,
    },
    "track_states": None,     # Trạng thái gốc các audio track (để restore)
    "individual_clips": None, # Danh sách clip riêng lẻ cho segment transcription
    "clip_boundaries": None,  # Phạm vi clip (start, end frames)
}


def reset_export_job():
    """Reset trạng thái export job về mặc định"""
    global current_export_job
    current_export_job = {
        "active": False,
        "pid": None,
        "progress": 0,
        "cancelled": False,
        "start_time": None,
        "audio_info": {"path": "", "mark_in": 0, "mark_out": 0, "offset": 0},
        "track_states": None,
        "individual_clips": None,
        "clip_boundaries": None,
    }
