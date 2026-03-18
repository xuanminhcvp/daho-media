# ============================================================
# autosubs package — Python bridge cho DaVinci Resolve
# Thay thế autosubs_core.lua (2788 dòng) bằng các module nhỏ
# ============================================================


def init(resolve_obj, executable_path, resources_folder, dev_mode=False):
    """
    Khởi tạo toàn bộ package:
    1. Lưu resolve object vào shared state
    2. Cấu hình đường dẫn OS
    3. Khởi động HTTP server lắng nghe lệnh từ Tauri app
    """
    from . import state
    from .server import start_server

    # Lưu Resolve object và các biến toàn cục
    state.resolve = resolve_obj
    state.dev_mode = dev_mode
    state.resources_path = resources_folder
    state.main_app = executable_path

    # Khởi tạo Resolve objects (project, media pool)
    state.project_manager = resolve_obj.GetProjectManager()
    state.project = state.project_manager.GetCurrentProject()
    state.media_pool = state.project.GetMediaPool()

    project_name = state.project.GetName() or "unknown"
    print(f"[AutoSubs] Connected to Resolve project: {project_name}")

    # Cấu hình đường dẫn assets
    import os
    state.assets_path = os.path.join(resources_folder, "AutoSubs")

    # Cấu hình lệnh mở app theo OS
    import platform
    os_name = platform.system()
    if os_name == "Darwin":  # macOS
        state.command_open = f"open {executable_path}"
    elif os_name == "Windows":
        state.command_open = f'start "" "{executable_path}"'
    else:  # Linux
        state.command_open = f"'{executable_path}' &"

    # Khởi động HTTP server (blocking — chạy cho đến khi nhận lệnh Exit)
    start_server()
