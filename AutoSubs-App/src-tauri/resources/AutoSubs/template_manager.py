# ============================================================
# template_manager.py — Quản lý templates trong Media Pool
# Bao gồm: tìm template, import template, tạo template set
# ============================================================

import os
from . import state
from .helpers import join_path

# ===== Danh sách các chuỗi nhận diện Fusion Title theo ngôn ngữ =====
# DaVinci Resolve hiển thị Type khác nhau tuỳ ngôn ngữ hệ thống
TITLE_STRINGS = {
    "Título – Fusion",      # Spanish
    "Título Fusion",         # Portuguese
    "Generator",             # English (older versions)
    "Fusion Title",          # English
    "Titre Fusion",          # French
    "Титры на стр. Fusion",  # Russian
    "Fusion Titel",          # German
    "Titolo Fusion",         # Italian
    "Fusionタイトル",          # Japanese
    "Fusion标题",             # Chinese
    "퓨전 타이틀",              # Korean
    "Tiêu đề Fusion",       # Vietnamese
    "Fusion Titles",         # Thai
}

# ===== Đường dẫn folder chứa .setting templates trên macOS =====
# DaVinci Resolve đọc từ thư mục này để hiển thị trong Effects Library → Titles
TITLES_FOLDER_PATH = os.path.join(
    os.path.expanduser("~"),
    "Library/Application Support/Blackmagic Design/DaVinci Resolve/"
    "Fusion/Templates/Edit/Titles/AutoSubs"
)


def is_matching_title(title):
    """Kiểm tra xem Type của clip có phải là Fusion Title không"""
    return title in TITLE_STRINGS


def walk_media_pool(folder, on_clip):
    """
    Duyệt đệ quy toàn bộ Media Pool (folder + subfolder)
    Gọi on_clip(clip) cho mỗi clip tìm được
    Nếu on_clip trả về True → dừng duyệt sớm (early exit)
    """
    # Duyệt subfolder trước (đệ quy)
    subfolders = folder.GetSubFolderList()
    if subfolders:
        for subfolder in subfolders:
            stop = walk_media_pool(subfolder, on_clip)
            if stop:
                return True

    # Duyệt tất cả clip trong folder hiện tại
    clips = folder.GetClipList()
    if clips:
        for clip in clips:
            stop = on_clip(clip)
            if stop:
                return True

    return False


def get_templates():
    """
    Lấy danh sách tất cả Text+ templates trong Media Pool
    Trả về: [{"label": "Template Name", "value": "Template Name"}, ...]
    """
    root_folder = state.media_pool.GetRootFolder()
    templates = []
    has_default = False

    def check_clip(clip):
        nonlocal has_default
        props = clip.GetClipProperty()
        clip_type = props.get("Type", "")
        if is_matching_title(clip_type):
            clip_name = props.get("Clip Name", "")
            templates.append({"label": clip_name, "value": clip_name})
            if clip_name == "Default Template":
                has_default = True
        return False  # tiếp tục duyệt

    walk_media_pool(root_folder, check_clip)

    # Nếu chưa có Default Template → import từ file .drb
    if not has_default:
        try:
            version = state.resolve.GetVersion()
            if version and int(version[0]) >= 19:
                print("[AutoSubs] Default template not found. Importing...")
                drb_path = join_path(state.assets_path, "subtitle-template.drb")
                state.media_pool.ImportFolderFromFile(drb_path)
                templates.append({"label": "Default Template", "value": "Default Template"})
        except Exception as e:
            print(f"[AutoSubs] Failed to import default template: {e}")

    return templates


def get_template_item(folder, template_name):
    """
    Tìm template theo tên clip trong Media Pool
    Duyệt toàn bộ folder + subfolder
    Trả về MediaPoolItem hoặc None
    """
    found = [None]  # dùng list để có thể gán trong closure

    def check_clip(clip):
        props = clip.GetClipProperty()
        if props.get("Clip Name") == template_name:
            found[0] = clip
            return True  # dừng duyệt
        return False

    walk_media_pool(folder, check_clip)
    return found[0]


def get_template_item_by_folder(root_folder, template_name):
    """
    Tìm template bằng TÊN FOLDER trong Media Pool
    Ưu tiên 1: tìm clip có tên trùng (nhanh nhất)
    Ưu tiên 2: tìm folder có tên trùng → lấy Fusion Title đầu tiên bên trong
    """
    # Bước 1: thử tìm bằng tên clip trước
    found = get_template_item(root_folder, template_name)
    if found:
        return found

    # Bước 2: tìm folder có tên khớp
    def find_folder_by_name(parent, name):
        subfolders = parent.GetSubFolderList()
        if subfolders:
            for subfolder in subfolders:
                if subfolder.GetName() == name:
                    return subfolder
                deeper = find_folder_by_name(subfolder, name)
                if deeper:
                    return deeper
        return None

    target_folder = find_folder_by_name(root_folder, template_name)
    if not target_folder:
        print(f"[AutoSubs] Folder '{template_name}' not found in Media Pool")
        return None

    # Quét folder tìm Fusion Title đầu tiên
    print(f"[AutoSubs] Scanning folder '{template_name}' for usable clip...")
    first_fusion_title = [None]
    first_any_clip = [None]

    def check_clip(clip):
        props = clip.GetClipProperty()
        clip_type = props.get("Type", "?")
        clip_name = props.get("Clip Name", "?")
        print(f"[AutoSubs]   Found clip: '{clip_name}' (Type='{clip_type}')")

        # Ưu tiên 1: Fusion Title
        if is_matching_title(clip_type) and first_fusion_title[0] is None:
            first_fusion_title[0] = clip

        # Ưu tiên 2: bất kỳ clip nào (fallback)
        if first_any_clip[0] is None:
            first_any_clip[0] = clip

        return False  # không dừng sớm — in log hết

    walk_media_pool(target_folder, check_clip)

    # Chọn clip tốt nhất
    title_item = first_fusion_title[0] or first_any_clip[0]

    if first_fusion_title[0]:
        props = first_fusion_title[0].GetClipProperty()
        print(f"[AutoSubs] Using Fusion Title: '{props.get('Clip Name', '?')}' "
              f"for template '{template_name}'")
    elif first_any_clip[0]:
        props = first_any_clip[0].GetClipProperty()
        print(f"[AutoSubs] WARNING: No Fusion Title found — using fallback clip: "
              f"'{props.get('Clip Name', '?')}' (Type='{props.get('Type', '?')}')")
    else:
        print(f"[AutoSubs] ERROR: Folder '{template_name}' is completely empty!")

    return title_item


def import_title_from_file(template_name):
    """
    Import file .setting từ folder hệ thống vào Media Pool
    File .setting nằm ở ~/Library/.../Titles/AutoSubs/
    
    QUAN TRỌNG: Xoá clip cũ cùng tên trước → import fresh
    (DaVinci cache clip theo filename, nên phải xoá trước)
    """
    file_path = os.path.join(TITLES_FOLDER_PATH, f"{template_name}.setting")
    print(f"[AutoSubs] Trying to import title from: {file_path}")

    # Kiểm tra file có tồn tại không
    if not os.path.exists(file_path):
        print(f"[AutoSubs] ⚠ File not found: {file_path}")
        return None

    # ===== XOÁ CLIP CŨ CÙNG TÊN TRONG MEDIA POOL =====
    root_folder = state.media_pool.GetRootFolder()
    old_clips = []

    def find_old(clip):
        props = clip.GetClipProperty()
        if props.get("Clip Name") == template_name:
            old_clips.append(clip)
        return False

    walk_media_pool(root_folder, find_old)

    if old_clips:
        print(f"[AutoSubs] 🗑 Deleting {len(old_clips)} old cached clip(s) "
              f"named '{template_name}' from Media Pool...")
        try:
            delete_ok = state.media_pool.DeleteClips(old_clips)
            if delete_ok:
                print("[AutoSubs] ✅ Old clips deleted successfully")
            else:
                print("[AutoSubs] ⚠ DeleteClips returned false — may still be cached")
        except Exception as e:
            print(f"[AutoSubs] ⚠ DeleteClips error: {e}")

    # Import fresh từ file .setting mới nhất
    state.media_pool.SetCurrentFolder(root_folder)
    try:
        imported = state.media_pool.ImportMedia([file_path])
    except Exception as e:
        print(f"[AutoSubs] ❌ ImportMedia failed: {e}")
        return None

    if not imported or len(imported) == 0:
        print(f"[AutoSubs] ❌ ImportMedia failed for: {file_path}")
        return None

    # Trả về item đầu tiên import được
    item = imported[0]
    props = item.GetClipProperty()
    print(f"[AutoSubs] ✅ Imported FRESH title: '{props.get('Clip Name', '?')}' from {file_path}")
    return item


def create_template_set(template_names):
    """
    Tạo nhiều template folder trong Media Pool
    Mỗi folder chứa 1 bản copy của Default Template (import từ .drb)
    User sau đó vào DaVinci Resolve để customize mỗi template riêng
    """
    print("[AutoSubs] Creating template set...")
    root_folder = state.media_pool.GetRootFolder()
    current_folder = state.media_pool.GetCurrentFolder()

    # Đảm bảo Default Template tồn tại trước
    default_tpl = get_template_item(root_folder, "Default Template")
    if not default_tpl:
        print("[AutoSubs] Importing Default Template from .drb...")
        try:
            state.media_pool.SetCurrentFolder(root_folder)
            drb_path = join_path(state.assets_path, "subtitle-template.drb")
            state.media_pool.ImportFolderFromFile(drb_path)
        except Exception:
            pass
        default_tpl = get_template_item(root_folder, "Default Template")

    if not default_tpl:
        return {"error": True, "message": "Cannot find or import Default Template"}

    results = []
    drb_path = join_path(state.assets_path, "subtitle-template.drb")

    for name in template_names:
        # Kiểm tra đã tồn tại chưa
        existing = get_template_item_by_folder(root_folder, name)
        if existing:
            print(f"[AutoSubs] Template '{name}' already exists — skipping")
            results.append({"name": name, "status": "exists"})
        else:
            # Tạo subfolder mới
            print(f"[AutoSubs] Creating folder '{name}'...")
            subfolder = state.media_pool.AddSubFolder(root_folder, name)
            if subfolder:
                state.media_pool.SetCurrentFolder(subfolder)
                try:
                    state.media_pool.ImportFolderFromFile(drb_path)
                    imported = get_template_item_by_folder(root_folder, name)
                    if imported:
                        print(f"[AutoSubs] ✅ Template '{name}' created successfully!")
                        results.append({"name": name, "status": "created"})
                    else:
                        print(f"[AutoSubs] ⚠ Folder created but no template for '{name}'")
                        results.append({"name": name, "status": "error", "message": "Import failed"})
                except Exception:
                    print(f"[AutoSubs] ❌ Failed to import .drb into folder '{name}'")
                    results.append({"name": name, "status": "error", "message": "Import failed"})
            else:
                print(f"[AutoSubs] ❌ Could not create folder '{name}'")
                results.append({"name": name, "status": "error", "message": "Folder creation failed"})

    # Quay lại folder gốc
    if current_folder:
        state.media_pool.SetCurrentFolder(current_folder)

    print("[AutoSubs] Template set creation done.")
    return {"success": True, "results": results}
