# ============================================================
# ui_color_automation.py — UI Automation cho DaVinci Resolve
#
# Dùng AppleScript + System Events để set 5 thông số Primaries
# trực tiếp vào Color page của DaVinci Resolve.
#
# Flow mỗi clip:
#   1. DaVinci API: chọn clip (navigate timeline)
#   2. DaVinci API: chuyển sang Color page
#   3. AppleScript: set 5 giá trị Contrast, Pivot, Saturation, Lift, Gain
#
# Yêu cầu:
#   - macOS Accessibility permission cho DaVinci Resolve
#   - DaVinci layout cố định (Primaries panel mở sẵn)
#   - User KHÔNG đụng máy trong khi chạy
#
# Được gọi từ auto_color.py qua server.py HTTP route
# ============================================================

import subprocess
import time
import traceback
from . import state


# ======================== CẤU HÌNH ========================

# Delay giữa các thao tác UI (giây) — để DaVinci kịp render
UI_DELAY = 0.5

# Delay giữa việc apply 2 clip liên tiếp (giây)
CLIP_DELAY = 1.5

# Retry tối đa cho mỗi clip
MAX_RETRY = 2

# Tên process DaVinci Resolve trên macOS
RESOLVE_PROCESS = "DaVinci Resolve"


# ======================== APPLESCRIPT HELPERS ========================

def run_applescript(script):
    """
    Chạy AppleScript và trả kết quả.
    Dùng subprocess gọi osascript — đây là cách chuẩn trên macOS.
    
    Args:
        script: Nội dung AppleScript (string)
    
    Returns:
        str: stdout từ osascript, hoặc None nếu lỗi
    """
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=15  # 15 giây timeout
        )
        if result.returncode != 0:
            print(f"[UIAuto] ⚠️ AppleScript stderr: {result.stderr.strip()}")
            return None
        return result.stdout.strip()
    except subprocess.TimeoutExpired:
        print("[UIAuto] ❌ AppleScript timeout 15s")
        return None
    except Exception as e:
        print(f"[UIAuto] ❌ AppleScript error: {e}")
        return None


def bring_resolve_to_front():
    """Đưa DaVinci Resolve lên foreground — đảm bảo nó active"""
    script = f'''
    tell application "{RESOLVE_PROCESS}"
        activate
    end tell
    '''
    run_applescript(script)
    time.sleep(0.3)


# ======================== NAVIGATE CLIP ========================

def navigate_to_clip(track_index, item_index):
    """
    Chọn clip trên timeline và chuyển sang Color page.
    Dùng DaVinci API nội bộ (Python Resolve scripting).
    
    Args:
        track_index: Video track (1-based)
        item_index: Clip index trong track (0-based)
    
    Returns:
        timeline_item hoặc None nếu lỗi
    """
    try:
        # Refresh project state
        state.project = state.project_manager.GetCurrentProject()
        timeline = state.project.GetCurrentTimeline()
        
        if not timeline:
            print("[UIAuto] ❌ Không có timeline")
            return None
        
        # Lấy clip từ track
        track_items = timeline.GetItemListInTrack("video", int(track_index))
        if not track_items or int(item_index) >= len(track_items):
            print(f"[UIAuto] ❌ Không tìm thấy clip: track={track_index}, index={item_index}")
            return None
        
        item = track_items[int(item_index)]
        clip_name = item.GetName() or f"Clip_{track_index}_{item_index}"
        
        # Chuyển sang Color page
        resolve = state.resolve
        resolve.OpenPage("color")
        time.sleep(UI_DELAY)
        
        # Navigate playhead đến đầu clip (để DaVinci focus đúng clip)
        start_frame = item.GetStart()
        timeline.SetCurrentTimecode(str(start_frame))
        time.sleep(UI_DELAY)
        
        print(f"[UIAuto] ✅ Navigated to '{clip_name}' (track {track_index}, frame {start_frame})")
        return item
    
    except Exception as e:
        print(f"[UIAuto] ❌ navigate_to_clip error: {e}")
        traceback.print_exc()
        return None


# ======================== SET PRIMARIES VIA APPLESCRIPT ========================
# 
# QUAN TRỌNG: Phần này sẽ cần cập nhật sau khi chạy Accessibility Inspector
# để xác định chính xác tên UI elements trong DaVinci Color page.
#
# Hiện tại dùng 2 cách tiếp cận:
#   1. Primary: System Events → tìm UI element theo tên
#   2. Fallback: Keyboard shortcut (Tab navigation + nhập giá trị)
#

def set_primaries_value_via_ui(control_name, value):
    """
    Set 1 giá trị control Primaries bằng AppleScript.
    
    ⚠️ TẠM THỜI: Script dưới đây dùng tên element giả định.
    Cần chạy Accessibility Inspector để lấy tên thực tế,
    sau đó cập nhật CONTROL_MAP bên dưới.
    
    Args:
        control_name: "contrast" | "pivot" | "saturation" | "lift_master" | "gain_master"
        value: Giá trị cần set
    
    Returns:
        bool: True nếu thành công
    """
    # Map tên control → tên UI element trong DaVinci
    # ⚠️ CẦN CẬP NHẬT SAU KHI DÒ ACCESSIBILITY INSPECTOR ⚠️
    CONTROL_MAP = {
        "contrast":    {"ax_description": "Contrast", "tab_order": 1},
        "pivot":       {"ax_description": "Pivot",    "tab_order": 2},
        "saturation":  {"ax_description": "Sat",      "tab_order": 3},
        "lift_master": {"ax_description": "Lift",     "tab_order": 4},
        "gain_master": {"ax_description": "Gain",     "tab_order": 5},
    }
    
    control = CONTROL_MAP.get(control_name)
    if not control:
        print(f"[UIAuto] ❌ Unknown control: {control_name}")
        return False
    
    # Format giá trị (DaVinci dùng dấu . cho decimal)
    formatted_value = f"{value:.4f}" if isinstance(value, float) else str(value)
    # Saturation hiển thị dạng nguyên (50.0 → "50")
    if control_name == "saturation":
        formatted_value = f"{value:.1f}"
    
    # ===== CÁC 1: Thử set qua System Events (chính xác nhất) =====
    ax_desc = control["ax_description"]
    
    script = f'''
    tell application "System Events"
        tell process "{RESOLVE_PROCESS}"
            -- Tìm text field hoặc slider có description chứa "{ax_desc}"
            -- ⚠️ Tên element CẦN CẬP NHẬT sau Accessibility Inspector
            try
                set frontmost to true
                
                -- Tìm trong tất cả windows → groups → text fields
                set allWindows to every window
                repeat with w in allWindows
                    try
                        -- Tìm theo AXDescription
                        set targetField to (first text field of w whose description contains "{ax_desc}")
                        set focused of targetField to true
                        delay 0.1
                        -- Select all rồi gõ giá trị mới
                        keystroke "a" using command down
                        delay 0.05
                        keystroke "{formatted_value}"
                        delay 0.1
                        -- Enter để confirm
                        key code 36
                        return "OK"
                    on error
                        -- Thử tìm sâu hơn trong groups
                        try
                            set allGroups to every group of w
                            repeat with g in allGroups
                                try
                                    set targetField to (first text field of g whose description contains "{ax_desc}")
                                    set focused of targetField to true
                                    delay 0.1
                                    keystroke "a" using command down
                                    delay 0.05
                                    keystroke "{formatted_value}"
                                    delay 0.1
                                    key code 36
                                    return "OK"
                                end try
                            end repeat
                        end try
                    end try
                end repeat
                return "NOT_FOUND"
            on error errMsg
                return "ERROR:" & errMsg
            end try
        end tell
    end tell
    '''
    
    result = run_applescript(script)
    
    if result == "OK":
        print(f"[UIAuto] ✅ Set {control_name} = {formatted_value} (via System Events)")
        return True
    
    # ===== CÁCH 2: Fallback — Click vào vị trí cố định (nếu System Events fail) =====
    print(f"[UIAuto] ⚠️ System Events không tìm thấy {ax_desc} — thử fallback keyboard")
    return set_primaries_value_via_keyboard(control_name, value)


def set_primaries_value_via_keyboard(control_name, value):
    """
    Fallback: Set giá trị bằng keyboard shortcut.
    Cách này ít chính xác hơn nhưng không phụ thuộc UI element names.
    
    ⚠️ Cần DaVinci đang focus đúng panel, đúng clip.
    """
    formatted_value = f"{value:.4f}" if isinstance(value, float) else str(value)
    if control_name == "saturation":
        formatted_value = f"{value:.1f}"
    
    # DaVinci không có keyboard shortcut trực tiếp cho từng field
    # Ghi nhận: cần Accessibility Inspector để xác định cách chính xác
    print(f"[UIAuto] ⚠️ Keyboard fallback chưa implement cho {control_name} = {formatted_value}")
    print(f"[UIAuto]    → Cần chạy Accessibility Inspector trước (Phase 0)")
    return False


# ======================== APPLY PRIMARIES TOÀN BỘ ========================

def apply_primaries_via_ui(track_index, item_index, primaries):
    """
    Apply 5 Primaries values vào 1 clip bằng UI automation.
    
    Luồng:
    1. Navigate đến clip (DaVinci API)
    2. Đưa DaVinci lên foreground
    3. Set từng giá trị Primaries qua AppleScript
    4. Log kết quả
    
    Args:
        track_index: Video track (1-based)
        item_index: Clip index (0-based)
        primaries: dict { contrast, pivot, saturation, lift_master, gain_master }
    
    Returns:
        dict: { success, message, details }
    """
    try:
        # 1. Navigate đến clip
        item = navigate_to_clip(track_index, item_index)
        if not item:
            return {"error": True, "message": "Không navigate được đến clip"}
        
        clip_name = item.GetName() or f"Clip_{track_index}_{item_index}"
        
        # 2. Đưa DaVinci lên foreground
        bring_resolve_to_front()
        time.sleep(UI_DELAY)
        
        # 3. Set từng giá trị
        controls = [
            ("contrast",    primaries.get("contrast", 1.0)),
            ("pivot",       primaries.get("pivot", 0.5)),
            ("saturation",  primaries.get("saturation", 50)),
            ("lift_master", primaries.get("lift_master", 0.0)),
            ("gain_master", primaries.get("gain_master", 1.0)),
        ]
        
        success_count = 0
        details = []
        
        for name, value in controls:
            ok = set_primaries_value_via_ui(name, value)
            details.append({"control": name, "value": value, "success": ok})
            if ok:
                success_count += 1
            time.sleep(UI_DELAY)
        
        # 4. Kết quả
        all_ok = success_count == len(controls)
        
        if all_ok:
            print(f"[UIAuto] ✅ Applied ALL Primaries to '{clip_name}'")
            return {
                "success": True,
                "message": f"Đã apply {success_count}/{len(controls)} controls cho '{clip_name}'",
                "details": details,
            }
        else:
            print(f"[UIAuto] ⚠️ Partial apply '{clip_name}': {success_count}/{len(controls)} controls OK")
            return {
                "success": success_count > 0,
                "message": f"Chỉ apply được {success_count}/{len(controls)} controls cho '{clip_name}'",
                "details": details,
            }
    
    except Exception as e:
        print(f"[UIAuto] ❌ apply_primaries_via_ui error: {e}")
        traceback.print_exc()
        return {"error": True, "message": f"Lỗi UI automation: {str(e)}"}


def apply_primaries_batch_via_ui(clips_data, delay_between=None):
    """
    Apply Primaries cho nhiều clip hàng loạt.
    Chạy tuần tự (1 clip tại 1 thời điểm) vì UI automation cần focus window.
    
    Args:
        clips_data: list of {
            "trackIndex": int,
            "itemIndex": int,
            "primaries": { contrast, pivot, saturation, lift_master, gain_master }
        }
        delay_between: Delay giữa các clip (giây), mặc định CLIP_DELAY
    
    Returns:
        dict: { results, applied, failed, total }
    """
    if delay_between is None:
        delay_between = CLIP_DELAY
    
    results = []
    applied = 0
    failed = 0
    
    total = len(clips_data)
    print(f"[UIAuto] 🎨 Batch apply: {total} clips (delay={delay_between}s)")
    
    # Đưa DaVinci lên foreground 1 lần trước
    bring_resolve_to_front()
    time.sleep(1.0)
    
    for i, clip_data in enumerate(clips_data):
        track_idx = clip_data.get("trackIndex")
        item_idx = clip_data.get("itemIndex")
        primaries = clip_data.get("primaries", {})
        
        print(f"[UIAuto] [{i+1}/{total}] Processing track={track_idx} item={item_idx}...")
        
        # Apply cho clip này
        retry_count = 0
        result = None
        
        while retry_count <= MAX_RETRY:
            result = apply_primaries_via_ui(track_idx, item_idx, primaries)
            
            if result.get("success") or result.get("error"):
                break
            
            retry_count += 1
            print(f"[UIAuto] 🔄 Retry {retry_count}/{MAX_RETRY} cho clip [{i}]")
            time.sleep(1.0)
        
        if result and result.get("success"):
            results.append({"index": i, "status": "applied", "message": result.get("message", "")})
            applied += 1
        else:
            results.append({"index": i, "status": "failed", "message": result.get("message", "Unknown error") if result else "No result"})
            failed += 1
        
        # Delay giữa các clip
        if i < total - 1:
            time.sleep(delay_between)
    
    print(f"[UIAuto] 📊 Batch done: {applied} applied, {failed} failed / {total} total")
    
    return {
        "results": results,
        "applied": applied,
        "failed": failed,
        "total": total,
    }
