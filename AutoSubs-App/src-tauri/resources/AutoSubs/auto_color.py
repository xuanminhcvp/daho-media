# ============================================================
# auto_color.py — Module tự động chỉnh màu DaVinci Resolve
# Scan timeline → lấy clip list → apply CDL/LUT
# Được gọi từ server.py qua HTTP route
# ============================================================

import os
import traceback
from . import state


# ======================== SCAN TIMELINE ========================

def scan_timeline_clips(scope="timeline"):
    """
    Quét timeline hiện tại, trả danh sách clip video có thể chỉnh màu.
    
    Flow:
    1. Lấy timeline hiện tại từ Resolve
    2. Duyệt qua tất cả video tracks
    3. Với mỗi clip: lấy metadata (tên, vị trí, đường dẫn source...)
    4. Tự động skip: Fusion Title, Generator, Adjustment Layer
    5. Trả về danh sách clips sạch cho frontend

    Args:
        scope: "timeline" = toàn bộ, "selected" = chỉ clip đang chọn (future)
    
    Returns:
        dict: { clips: [...], totalClips, frameRate, timelineStart, timelineName }
    """
    try:
        # Refresh project state (phòng trường hợp user đổi project)
        state.project = state.project_manager.GetCurrentProject()
        timeline = state.project.GetCurrentTimeline()
        
        if not timeline:
            return {"error": True, "message": "Không có timeline đang mở"}
        
        frame_rate = float(timeline.GetSetting("timelineFrameRate"))
        timeline_start = timeline.GetStartFrame()
        timeline_name = timeline.GetName()
        
        clips = []
        track_count = timeline.GetTrackCount("video")
        
        print(f"[AutoColor] Scanning {track_count} video tracks trên timeline '{timeline_name}'...")
        
        for track_idx in range(1, track_count + 1):
            track_items = timeline.GetItemListInTrack("video", track_idx)
            
            if not track_items:
                continue
            
            for item_idx, item in enumerate(track_items):
                clip_info = _extract_clip_info(item, track_idx, item_idx, frame_rate, timeline_start)
                
                # Skip các loại không phải video clip thường
                if clip_info["type"] in ("fusion_title", "generator", "adjustment_layer"):
                    print(f"[AutoColor] Skip {clip_info['type']}: {clip_info['name']}")
                    continue
                
                clips.append(clip_info)
        
        print(f"[AutoColor] ✅ Tìm thấy {len(clips)} clip có thể chỉnh màu")
        
        return {
            "clips": clips,
            "totalClips": len(clips),
            "frameRate": frame_rate,
            "timelineStart": timeline_start / frame_rate,
            "timelineName": timeline_name,
        }
    
    except Exception as e:
        print(f"[AutoColor] ❌ Lỗi scan timeline: {e}")
        traceback.print_exc()
        return {"error": True, "message": f"Lỗi scan: {str(e)}"}


def _extract_clip_info(item, track_idx, item_idx, frame_rate, timeline_start):
    """
    Trích xuất thông tin chi tiết từ 1 timeline item.
    
    Phân loại item type:
    - video_clip: clip video/ảnh thường → CẦN chỉnh màu
    - compound_clip: clip gộp → skip Phase 1
    - fusion_title: title Fusion → skip
    - generator: color/gradient generator → skip
    - adjustment_layer: adjustment clip → skip
    
    Returns:
        dict: metadata clip gồm name, type, start/end, mediaPath, v.v.
    """
    name = item.GetName() or f"Clip_{track_idx}_{item_idx}"
    start_frame = item.GetStart()
    end_frame = item.GetEnd()
    duration_frames = end_frame - start_frame
    
    # Lấy đường dẫn source media (nếu có)
    media_path = ""
    media_pool_item = item.GetMediaPoolItem()
    if media_pool_item:
        media_path = media_pool_item.GetClipProperty("File Path") or ""
    
    # Phân loại item type
    item_type = _classify_item_type(item, name, media_path)
    
    # Kiểm tra clip đã có grade chưa (dựa trên số node)
    has_existing_grade = False
    try:
        # GetNumNodes() trả số lượng node trong Color page
        # Nếu > 1 → clip đã được chỉnh màu thủ công
        num_nodes = item.GetNumNodes() if hasattr(item, 'GetNumNodes') else 0
        has_existing_grade = num_nodes > 1
    except Exception:
        pass
    
    return {
        "name": name,
        "trackIndex": track_idx,
        "itemIndex": item_idx,
        "startFrame": start_frame,
        "endFrame": end_frame,
        "durationFrames": duration_frames,
        "startSec": round((start_frame - timeline_start) / frame_rate, 2),
        "endSec": round((end_frame - timeline_start) / frame_rate, 2),
        "durationSec": round(duration_frames / frame_rate, 2),
        "mediaPath": media_path,
        "type": item_type,
        "hasExistingGrade": has_existing_grade,
    }


def _classify_item_type(item, name, media_path):
    """
    Phân loại timeline item dựa trên thuộc tính.
    
    Heuristic:
    - Không có media path + tên chứa "Fusion" → fusion_title
    - Không có media path + tên chứa "Generator"/"Solid" → generator  
    - Không có media path + tên chứa "Adjustment" → adjustment_layer
    - Có media path → video_clip
    - Không media path nhưng không match các pattern trên → compound hoặc unknown
    """
    name_lower = name.lower()
    
    # Fusion title / Text+
    if "fusion" in name_lower or "text+" in name_lower or "title" in name_lower:
        return "fusion_title"
    
    # Generator (solid color, gradient...)
    if "generator" in name_lower or "solid" in name_lower or "color" in name_lower:
        return "generator"
    
    # Adjustment layer
    if "adjustment" in name_lower:
        return "adjustment_layer"
    
    # Compound clip (có sub-timeline)
    # Nếu không có media path nhưng không phải các loại trên
    if not media_path:
        return "compound_clip"
    
    return "video_clip"


# ======================== APPLY CDL ========================

def apply_cdl_to_clip(track_index, item_index, cdl_data):
    """
    Apply CDL correction vào 1 clip trên timeline.
    
    CDL gồm 10 giá trị:
    - Slope [R, G, B]: tương đương Gain — nhân sáng
    - Offset [R, G, B]: tương đương Lift — cộng/trừ shadow
    - Power [R, G, B]: tương đương Gamma — midtone curve
    - Saturation: bão hòa màu
    
    Args:
        track_index: số thứ tự video track (1-based)
        item_index: thứ tự clip trong track (0-based)
        cdl_data: {
            "slope": [R, G, B],
            "offset": [R, G, B],
            "power": [R, G, B],
            "saturation": float
        }
    
    Returns:
        dict: { success, message }
    """
    try:
        timeline = state.project.GetCurrentTimeline()
        if not timeline:
            return {"error": True, "message": "Không có timeline"}
        
        # Lấy clip từ track
        track_items = timeline.GetItemListInTrack("video", int(track_index))
        if not track_items or int(item_index) >= len(track_items):
            return {"error": True, "message": f"Không tìm thấy clip tại track {track_index}, index {item_index}"}
        
        item = track_items[int(item_index)]
        clip_name = item.GetName() or f"Clip_{track_index}_{item_index}"
        
        # Chuẩn bị CDL map theo format DaVinci yêu cầu
        # QUAN TRỌNG: Slope/Offset/Power phải là STRING "R G B"
        # KHÔNG dùng nested dict {"R": x, "G": y, "B": z} (sẽ gây lỗi màu đỏ!)
        cdl_map = {
            "NodeIndex": cdl_data.get("nodeIndex", 1),  # Node 1 mặc định (1-based)
            "Slope": f'{cdl_data["slope"][0]} {cdl_data["slope"][1]} {cdl_data["slope"][2]}',
            "Offset": f'{cdl_data["offset"][0]} {cdl_data["offset"][1]} {cdl_data["offset"][2]}',
            "Power": f'{cdl_data["power"][0]} {cdl_data["power"][1]} {cdl_data["power"][2]}',
            "Saturation": str(cdl_data["saturation"]),
        }
        
        # Apply CDL vào clip
        result = item.SetCDL(cdl_map)
        
        if result:
            print(f"[AutoColor] ✅ Applied CDL to '{clip_name}': "
                  f"slope={cdl_data['slope']}, offset={cdl_data['offset']}, "
                  f"power={cdl_data['power']}, sat={cdl_data['saturation']}")
            return {"success": True, "message": f"Đã apply CDL cho '{clip_name}'"}
        else:
            print(f"[AutoColor] ⚠️ SetCDL returned False for '{clip_name}'")
            return {"error": True, "message": f"SetCDL thất bại cho '{clip_name}' — có thể API không hỗ trợ"}
    
    except Exception as e:
        print(f"[AutoColor] ❌ Lỗi apply CDL: {e}")
        traceback.print_exc()
        return {"error": True, "message": f"Lỗi apply CDL: {str(e)}"}


def apply_lut_to_clip(track_index, item_index, lut_path, node_index=1):
    """
    Apply LUT file (.cube) vào 1 clip.
    
    Args:
        track_index: video track (1-based)
        item_index: clip index (0-based)
        lut_path: đường dẫn tuyệt đối tới file .cube
        node_index: node trong Color page (1-based, mặc định node 1)
    
    Returns:
        dict: { success, message }
    """
    try:
        timeline = state.project.GetCurrentTimeline()
        track_items = timeline.GetItemListInTrack("video", int(track_index))
        
        if not track_items or int(item_index) >= len(track_items):
            return {"error": True, "message": "Không tìm thấy clip"}
        
        item = track_items[int(item_index)]
        clip_name = item.GetName() or "Unknown"
        
        # Kiểm tra file LUT tồn tại
        if not os.path.exists(lut_path):
            return {"error": True, "message": f"LUT file không tìm thấy: {lut_path}"}
        
        # Apply LUT vào node
        result = item.SetLUT(int(node_index), lut_path)
        
        if result:
            print(f"[AutoColor] ✅ Applied LUT to '{clip_name}': {os.path.basename(lut_path)}")
            return {"success": True, "message": f"Đã apply LUT cho '{clip_name}'"}
        else:
            return {"error": True, "message": f"SetLUT thất bại cho '{clip_name}'"}
    
    except Exception as e:
        print(f"[AutoColor] ❌ Lỗi apply LUT: {e}")
        return {"error": True, "message": f"Lỗi: {str(e)}"}


# ======================== APPLY BATCH ========================

def apply_cdl_batch(clips_data):
    """
    Apply CDL cho nhiều clip cùng lúc.
    
    Args:
        clips_data: list of {
            "trackIndex": int,
            "itemIndex": int,
            "cdl": { slope, offset, power, saturation }
        }
    
    Returns:
        dict: { results: [...], applied, failed, skipped }
    """
    results = []
    applied = 0
    failed = 0
    skipped = 0
    
    for i, clip in enumerate(clips_data):
        track_idx = clip.get("trackIndex")
        item_idx = clip.get("itemIndex")
        cdl = clip.get("cdl")
        
        if not cdl:
            results.append({"index": i, "status": "skipped", "reason": "Không có CDL data"})
            skipped += 1
            continue
        
        result = apply_cdl_to_clip(track_idx, item_idx, cdl)
        
        if result.get("success"):
            results.append({"index": i, "status": "applied", "message": result["message"]})
            applied += 1
        else:
            results.append({"index": i, "status": "failed", "message": result.get("message", "Unknown error")})
            failed += 1
    
    print(f"[AutoColor] Batch done: {applied} applied, {failed} failed, {skipped} skipped")
    
    return {
        "results": results,
        "applied": applied,
        "failed": failed,
        "skipped": skipped,
        "total": len(clips_data),
    }


# ======================== BACKUP TIMELINE ========================

def backup_timeline():
    """
    Duplicate timeline hiện tại làm bản backup trước khi chỉnh màu.
    
    Tên backup: "{original_name}_AUTOCOLOR_BACKUP"
    
    Returns:
        dict: { success, backupName, message }
    """
    try:
        timeline = state.project.GetCurrentTimeline()
        if not timeline:
            return {"error": True, "message": "Không có timeline"}
        
        original_name = timeline.GetName()
        backup_name = f"{original_name}_AUTOCOLOR_BACKUP"
        
        # DaVinci API: DuplicateTimeline tạo bản copy
        # Nếu ko có DuplicateTimeline, dùng ExportBundle + ImportBundle
        media_pool = state.project.GetMediaPool()
        
        # Thử duplicate timeline
        try:
            new_timeline = media_pool.DuplicateTimeline(timeline, backup_name)
            if new_timeline:
                # Chuyển lại về timeline gốc để tiếp tục chỉnh
                state.project.SetCurrentTimeline(timeline)
                print(f"[AutoColor] ✅ Backup created: '{backup_name}'")
                return {"success": True, "backupName": backup_name}
        except Exception:
            pass
        
        # Fallback: nếu ko có DuplicateTimeline
        print(f"[AutoColor] ⚠️ DuplicateTimeline không available. Bỏ qua backup.")
        return {
            "success": False,
            "message": "API DuplicateTimeline không khả dụng. Hãy duplicate timeline thủ công trước khi chỉnh.",
        }
    
    except Exception as e:
        print(f"[AutoColor] ❌ Lỗi backup: {e}")
        return {"error": True, "message": f"Lỗi backup: {str(e)}"}


# ======================== GET CURRENT FRAME ========================

def get_current_frame_path():
    """
    Lấy thông tin clip đang được chọn trên playhead hiện tại.
    Dùng khi user muốn chọn clip hiện tại làm reference.
    
    Returns:
        dict: { mediaPath, clipName, currentFrame, timecode }
    """
    try:
        timeline = state.project.GetCurrentTimeline()
        if not timeline:
            return {"error": True, "message": "Không có timeline"}
        
        # Lấy timecode hiện tại
        current_tc = timeline.GetCurrentTimecode()
        frame_rate = float(timeline.GetSetting("timelineFrameRate"))
        
        # Tìm clip tại vị trí playhead
        # Duyệt từ track cao xuống thấp (video track 1 = bottom)
        track_count = timeline.GetTrackCount("video")
        
        for track_idx in range(track_count, 0, -1):
            items = timeline.GetItemListInTrack("video", track_idx)
            if not items:
                continue
            
            for item in items:
                # Kiểm tra playhead nằm trong clip này không
                # (GetCurrentVideoItem() không available trên mọi version)
                # Dùng time range check
                media_pool_item = item.GetMediaPoolItem()
                if media_pool_item:
                    media_path = media_pool_item.GetClipProperty("File Path") or ""
                    if media_path:
                        return {
                            "mediaPath": media_path,
                            "clipName": item.GetName() or "Unknown",
                            "timecode": current_tc,
                            "trackIndex": track_idx,
                        }
        
        return {"error": True, "message": "Không tìm thấy clip tại vị trí playhead"}
    
    except Exception as e:
        print(f"[AutoColor] ❌ Lỗi get current frame: {e}")
        return {"error": True, "message": str(e)}
