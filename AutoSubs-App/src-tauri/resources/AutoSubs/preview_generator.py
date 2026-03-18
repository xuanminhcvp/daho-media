# ============================================================
# preview_generator.py — Tạo preview ảnh cho phụ đề
# Bao gồm: render 1 frame từ Fusion comp, export PNG
# ============================================================

import math
from . import state
from .helpers import join_path
from .template_manager import get_templates, get_template_item
from .subtitle_renderer import set_custom_colors


def extract_frame(comp, export_dir, template_frame_rate):
    """
    Render 1 frame từ Fusion composition ra file PNG
    Dùng Saver tool để export frame ở giữa clip
    
    Flow:
    1. Khoá comp (Lock) để tránh UI refresh
    2. Tạo Saver tool → kết nối với MediaOut
    3. Render 1 frame ở giữa comp
    4. Mở khoá comp (Unlock)
    """
    # Khoá comp để tránh popup
    comp.Lock()

    output_path = ""
    my_saver = comp.AddTool("Saver")

    if my_saver is not None:
        # Cấu hình output cho Saver
        name = my_saver.Name
        settings = my_saver.SaveSettings()

        # Set filename + format
        settings["Tools"][name]["Inputs"]["Clip"]["Value"]["Filename"] = \
            join_path(export_dir, "subtitle-preview-0.png")
        settings["Tools"][name]["Inputs"]["Clip"]["Value"]["FormatID"] = "PNGFormat"
        settings["Tools"][name]["Inputs"]["OutputFormat"]["Value"] = "PNGFormat"
        my_saver.LoadSettings(settings)

        # Kết nối Saver input với MediaOut
        media_out = comp.FindToolByID("MediaOut")
        my_saver.SetInput("Input", media_out)

        # Render frame ở giữa comp
        frame_to_extract = math.floor(comp.GetAttrs()["COMPN_GlobalEnd"] / 2)

        success = comp.Render({
            "Start": frame_to_extract,
            "End": frame_to_extract,
            "Tool": my_saver,
            "Wait": True,  # Chờ render xong
        })

        output_filename = f"subtitle-preview-{frame_to_extract}.png"
        output_path = join_path(export_dir, output_filename)

        if success:
            print(f"[AutoSubs] Frame {frame_to_extract} saved to {output_path}")
        else:
            print(f"[AutoSubs] Failed to save frame {frame_to_extract}")
    else:
        print("[AutoSubs] Saver tool not found in composition")

    # Mở khoá comp
    comp.Unlock()
    return output_path


def generate_preview(speaker, template_name, export_dir):
    """
    Tạo ảnh preview cho phụ đề với theme đã chọn
    
    Flow:
    1. Thêm 1 clip template tạm lên track mới
    2. Set text "Example Subtitle Text" + màu speaker
    3. Render 1 frame PNG
    4. Xoá clip + track tạm
    5. Trả về đường dẫn ảnh PNG
    """
    timeline = state.project.GetCurrentTimeline()
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
        print(f"[AutoSubs] Could not find template '{template_name}'")
        return ""

    template_fps = float(template_item.GetClipProperty().get("FPS", 24))

    # Tạo track video tạm
    timeline.AddTrack("video")
    track_index = timeline.GetTrackCount("video")

    # Thêm clip tạm
    new_clip = {
        "mediaPoolItem": template_item,
        "startFrame": 0,
        "endFrame": template_fps * 2,   # 2 giây
        "recordFrame": 0,
        "trackIndex": track_index,
    }
    timeline_items = state.media_pool.AppendToTimeline([new_clip])

    if not timeline_items:
        print("[AutoSubs] Failed to append preview clip")
        return ""

    item = timeline_items[0]
    output_path = ""

    try:
        if item.GetFusionCompCount() > 0:
            comp = item.GetFusionCompByIndex(1)
            tool = comp.FindToolByID("TextPlus")
            tool.SetInput("StyledText", "Example Subtitle Text")
            set_custom_colors(speaker, tool)
            output_path = extract_frame(comp, export_dir, template_fps)
    except Exception as e:
        print(f"[AutoSubs] Preview generation error: {e}")

    # Xoá clip + track tạm
    timeline.DeleteClips(timeline_items)
    timeline.DeleteTrack("video", track_index)

    return output_path
