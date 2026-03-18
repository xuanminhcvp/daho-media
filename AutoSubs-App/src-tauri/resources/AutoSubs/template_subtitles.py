# ============================================================
# template_subtitles.py — Thêm phụ đề với nhiều template styles
# Bao gồm: visual styles preset, auto-resize text, SFX đi kèm
# ============================================================

import math
from . import state
from .helpers import to_frames
from .template_manager import (
    get_template_item, get_template_item_by_folder,
    import_title_from_file, walk_media_pool, is_matching_title
)


# ============================================
# TEMPLATE_STYLES: Preset visual style cho từng loại template
# Mỗi template type có font, size, fill color, outline color riêng biệt
# ============================================
TEMPLATE_STYLES = {
    # Location Card: chữ nhỏ, monospace, trắng xám — phong cách phim tài liệu
    "Location Card": {
        "font": "Courier New", "size": 0.042,
        "bold": False, "italic": False,
        "red1": 0.85, "green1": 0.88, "blue1": 0.90,   # Fill: trắng xám nhạt
        "red4": 0.05, "green4": 0.05, "blue4": 0.05,   # Outline: đen nhạt
        "clipColor": "Lime",
    },
    # Impact Number: chữ lớn, bold, vàng gold — gây ấn tượng mạnh
    "Impact Number": {
        "font": "Arial Black", "size": 0.09,
        "bold": True, "italic": False,
        "red1": 0.96, "green1": 0.75, "blue1": 0.04,   # Fill: vàng gold
        "red4": 0.25, "green4": 0.18, "blue4": 0.0,    # Outline: nâu đậm
        "clipColor": "Yellow",
    },
    # Death / Violence: chữ đỏ, bold — cảnh báo nguy hiểm
    "Death / Violence": {
        "font": "Arial Black", "size": 0.08,
        "bold": True, "italic": False,
        "red1": 0.94, "green1": 0.22, "blue1": 0.22,   # Fill: đỏ máu
        "red4": 0.35, "green4": 0.0, "blue4": 0.0,     # Outline: đỏ đậm
        "clipColor": "Red",
    },
    # Document / ID Card: monospace, cyan — phong cách hồ sơ mật
    "Document / ID Card": {
        "font": "Courier New", "size": 0.05,
        "bold": False, "italic": False,
        "red1": 0.02, "green1": 0.71, "blue1": 0.83,   # Fill: cyan tươi
        "red4": 0.0, "green4": 0.22, "blue4": 0.28,    # Outline: cyan đậm
        "clipColor": "Cyan",
    },
    # Quote / Motif: serif italic, trắng — trích dẫn trang trọng
    "Quote / Motif": {
        "font": "Georgia", "size": 0.06,
        "bold": False, "italic": True,
        "red1": 1.0, "green1": 1.0, "blue1": 1.0,      # Fill: trắng tinh
        "red4": 0.18, "green4": 0.18, "blue4": 0.18,   # Outline: xám nhạt
        "clipColor": "Purple",
    },
}

# Clip color cho Title .setting (đã có style sẵn, không cần apply)
TITLE_CLIP_COLORS = {
    "Title 1": "Yellow",
    "Title 2": "Orange",
    "Title 3": "Red",
    "Title 4": "Purple",
}

# Size mặc định cho auto-resize
TITLE_SIZE_DEFAULTS = {
    "Title 1": 0.05, "Title 2": 0.18,
    "Title 3": 0.18, "Title 4": 0.05,
}


def apply_template_style(tool, template_name):
    """
    Set visual properties cho TextPlus Fusion tool
    Dựa vào tên template type → apply font, size, color tương ứng
    """
    style = TEMPLATE_STYLES.get(template_name)
    if not style:
        print(f"[AutoSubs] No custom style for '{template_name}' — keeping defaults")
        return False

    print(f"[AutoSubs] Applying style '{template_name}': "
          f"font={style['font']} size={style['size']}")

    # Set font (có thể không tồn tại trên máy user)
    try:
        tool.SetInput("Font", style["font"])
    except Exception:
        print(f"[AutoSubs] WARNING: Font '{style['font']}' not available")

    # Set size
    try:
        tool.SetInput("Size", style["size"])
    except Exception:
        pass

    # Set fill color (Shading Element 1)
    try:
        tool.SetInput("Red1", style["red1"])
        tool.SetInput("Green1", style["green1"])
        tool.SetInput("Blue1", style["blue1"])
    except Exception:
        pass

    # Set outline color (Shading Element 4)
    try:
        tool.SetInput("Red4", style["red4"])
        tool.SetInput("Green4", style["green4"])
        tool.SetInput("Blue4", style["blue4"])
    except Exception:
        pass

    return True


def _auto_resize_text(text, template_name, tool):
    """
    Tự giảm size & xuống dòng khi text dài
    Title 2/3 (chữ to) nhạy hơn, Title 1/4 (chữ nhỏ) ít nhạy hơn
    """
    base_size = TITLE_SIZE_DEFAULTS.get(template_name)
    if not base_size or not text:
        return text  # không auto-resize

    text_len = len(text)
    new_size = base_size
    final_text = text

    if base_size >= 0.15:
        # Title 2, 3 (chữ to): nhạy hơn vì dễ tràn
        if text_len > 25:
            # Quá dài → xuống dòng ở khoảng trắng gần giữa
            mid = text_len // 2
            best_break = mid
            for j in range(mid, 0, -1):
                if final_text[j] == " ":
                    best_break = j
                    break
            final_text = final_text[:best_break] + "\n" + final_text[best_break + 1:]

        if text_len > 20:
            new_size = base_size * 0.75
        elif text_len > 15:
            new_size = base_size * 0.85
    else:
        # Title 1, 4 (chữ nhỏ): ít nhạy hơn
        if text_len > 50:
            mid = text_len // 2
            best_break = mid
            for j in range(mid, 0, -1):
                if final_text[j] == " ":
                    best_break = j
                    break
            final_text = final_text[:best_break] + "\n" + final_text[best_break + 1:]

        if text_len > 40:
            new_size = base_size * 0.8
        elif text_len > 30:
            new_size = base_size * 0.9

    # Set text (có thể đã thêm \n)
    tool.SetInput("StyledText", final_text)

    # Set size (có thể đã giảm)
    if new_size != base_size:
        try:
            tool.SetInput("Size", new_size)
        except Exception:
            pass
        print(f"[AutoSubs] 📏 Auto-resize: {text_len} chars → size {new_size:.4f} (was {base_size:.4f})")

    return final_text


def add_template_subtitles(clips, track_index):
    """
    Thêm nhiều câu với nhiều template khác nhau cùng lúc
    Mỗi clip có {start, end, text, template} riêng biệt
    
    Flow:
    1. Cache template items (tránh tìm lại O(N²))
    2. Từng clip: tìm template → append → set text + auto-resize
    3. Thêm SFX hit cho Title 2/3 (nếu có file SFX)
    """
    print(f"[AutoSubs] Running AddTemplateSubtitles with {len(clips)} clips...")

    if not clips:
        return {"error": True, "message": "No clips provided"}

    timeline = state.project.GetCurrentTimeline()
    if not timeline:
        return {"error": True, "message": "No active timeline found"}

    frame_rate = float(timeline.GetSetting("timelineFrameRate"))
    timeline_start = timeline.GetStartFrame()
    root_folder = state.media_pool.GetRootFolder()

    # DEBUG: Liệt kê templates trong Media Pool
    print("[AutoSubs] DEBUG - Scanning Media Pool for all templates...")
    all_templates = []

    def log_template(clip):
        props = clip.GetClipProperty()
        if is_matching_title(props.get("Type", "")):
            name = props.get("Clip Name", "")
            all_templates.append(name)
            print(f"[AutoSubs] Media Pool template found: '{name}'")
        return False

    walk_media_pool(root_folder, log_template)
    print(f"[AutoSubs] Total templates in Media Pool: {len(all_templates)}")

    # ===== TEMPLATE CACHE =====
    template_cache = {}

    def get_cached_tpl(tpl_name):
        if not tpl_name:
            tpl_name = "Default Template"
        if tpl_name not in template_cache:
            is_title_setting = tpl_name in ("Title 1", "Title 2", "Title 3", "Title 4")
            t = None

            if is_title_setting:
                # Title 1-4: LUÔN import fresh từ file .setting
                print(f"[AutoSubs] Force fresh import for: '{tpl_name}'")
                t = import_title_from_file(tpl_name)
            else:
                # Template thường: tìm Media Pool trước
                t = get_template_item_by_folder(root_folder, tpl_name)
                if not t:
                    print(f"[AutoSubs] Not in Media Pool — trying file: '{tpl_name}'")
                    t = import_title_from_file(tpl_name)

            # Fallback cuối cùng → Default Template
            if not t:
                print(f"[AutoSubs] WARNING: '{tpl_name}' NOT FOUND. Falling back to Default Template.")
                t = get_template_item(root_folder, "Default Template")
                if not t:
                    t = import_title_from_file("Title 1")
            else:
                props = t.GetClipProperty()
                print(f"[AutoSubs] Found template: '{tpl_name}' → "
                      f"clip '{props.get('Clip Name', '?')}' (FPS={props.get('FPS', '?')})")

            template_cache[tpl_name] = t
        return template_cache[tpl_name]

    # ===== THÊM TỪNG CLIP =====
    added_count = 0

    for i, clip_data in enumerate(clips):
        requested_tpl = clip_data.get("template", "(nil)")
        print(f"[AutoSubs] Clip {i}: template='{requested_tpl}' "
              f"text='{(clip_data.get('text', ''))[:40]}'")

        tpl_item = get_cached_tpl(clip_data.get("template"))
        if not tpl_item:
            print(f"[AutoSubs] ERROR: No template found for clip {i}")
            return {"error": True, "message": "Missing default templates in Media Pool"}

        tpl_props = tpl_item.GetClipProperty()
        tpl_fps = float(tpl_props.get("FPS", frame_rate))

        start_frame = to_frames(clip_data["start"], frame_rate)
        end_frame = to_frames(clip_data["end"], frame_rate)
        timeline_pos = timeline_start + start_frame
        duration = end_frame - start_frame

        # Gap joining: nối khoảng hở gần nhau (< 1 giây)
        if i < len(clips) - 1:
            next_start = timeline_start + to_frames(clips[i + 1]["start"], frame_rate)
            gap = next_start - (timeline_pos + duration)
            if gap < frame_rate:
                duration = duration + gap + 1

        clip_dur = (duration / frame_rate) * tpl_fps

        new_clip = {
            "mediaPoolItem": tpl_item,
            "mediaType": 1,
            "startFrame": 0,
            "endFrame": clip_dur,
            "recordFrame": timeline_pos,
            "trackIndex": int(track_index or 1),
        }

        # Append từng clip riêng lẻ (để DaVinci tôn trọng recordFrame)
        timeline_items = state.media_pool.AppendToTimeline([new_clip])
        if timeline_items and len(timeline_items) > 0:
            added_count += 1
            item = timeline_items[0]
            try:
                text = clip_data.get("text", "")
                tpl_name = clip_data.get("template", "Default Template")

                fusion_count = item.GetFusionCompCount()
                if fusion_count > 0:
                    comp = item.GetFusionCompByIndex(1)
                    tool = comp.FindToolByID("TextPlus")

                    if tool:
                        # Auto-resize cho Title 1-4
                        if tpl_name in TITLE_SIZE_DEFAULTS:
                            _auto_resize_text(text, tpl_name, tool)
                        else:
                            tool.SetInput("StyledText", text)
                        print(f"[AutoSubs] Clip {i}: ✅ TextPlus set text='{text[:30]}'")
                    else:
                        print(f"[AutoSubs] Clip {i}: ⚠️ TextPlus NOT FOUND in comp!")
            except Exception as e:
                print(f"[AutoSubs] Clip {i} error: {e}")
        else:
            print(f"[AutoSubs] WARNING: AppendToTimeline returned nil for clip {i}")

    print(f"[AutoSubs] AddTemplateSubtitles done. Added: {added_count}/{len(clips)}")

    # ===== SFX: Thêm hit-sfx.WAV cho Title 2 và Title 3 =====
    import os
    SFX_PATH = os.path.expanduser("~/Desktop/hit-sfx.WAV")
    SFX_TEMPLATES = {"Title 2", "Title 3"}

    sfx_clips = [
        {"index": i, "clipData": cd}
        for i, cd in enumerate(clips)
        if cd.get("template") in SFX_TEMPLATES
    ]

    if sfx_clips and os.path.exists(SFX_PATH):
        print(f"[AutoSubs] SFX: {len(sfx_clips)} clips cần hit-sfx.WAV")

        # Tìm hoặc import SFX trong Media Pool
        sfx_item = None

        def find_sfx(clip):
            nonlocal sfx_item
            props = clip.GetClipProperty()
            name = (props.get("File Name") or props.get("Clip Name") or "").lower()
            if "hit-sfx" in name:
                sfx_item = clip
            return False

        walk_media_pool(root_folder, find_sfx)

        if not sfx_item:
            imported = state.media_pool.ImportMedia([SFX_PATH])
            if imported:
                sfx_item = imported[0]
                print("[AutoSubs] SFX: ✅ Imported hit-sfx.WAV")
            else:
                print(f"[AutoSubs] SFX: ❌ Cannot import {SFX_PATH}")

        if sfx_item:
            audio_track_idx = max(1, int(track_index or 1))
            sfx_added = 0

            for entry in sfx_clips:
                cd = entry["clipData"]
                start_frame = to_frames(cd["start"], frame_rate)
                pos = timeline_start + start_frame

                sfx_data = {
                    "mediaPoolItem": sfx_item,
                    "mediaType": 2,
                    "startFrame": 0,
                    "endFrame": -1,  # toàn bộ file
                    "recordFrame": pos,
                    "trackIndex": audio_track_idx,
                }
                result = state.media_pool.AppendToTimeline([sfx_data])
                if result and len(result) > 0:
                    sfx_added += 1

            print(f"[AutoSubs] SFX done: {sfx_added}/{len(sfx_clips)} clips added")

    # Refresh timeline
    timeline.SetCurrentTimecode(timeline.GetCurrentTimecode())
    return {"success": True, "added": added_count}
