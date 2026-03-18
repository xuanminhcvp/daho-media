#!/usr/bin/env python3
# ============================================================
# AutoSubs.py — Entry script cho DaVinci Resolve Script Menu
# 
# PHÁT HIỆN quan trọng:
# - DaVinci chạy script này trong Fusion context (bmd.getappname() = "FusionScript")
# - Không thể dùng bmd.scriptapp("Resolve") → trả None
# - Phải lấy Fusion object trước, rồi gọi GetResolve() từ đó
# ============================================================

import os
import sys
import traceback

DEV_MODE = True
LOG_PATH = os.path.join(os.path.expanduser("~"), "Desktop", "autosubs_resolve.log")

def log(*args):
    import datetime
    ts = datetime.datetime.now().strftime("[%Y-%m-%d %H:%M:%S]")
    line = ts + " " + " ".join(str(a) for a in args)
    try:
        with open(LOG_PATH, "a", encoding="utf-8", errors="replace") as f:
            f.write(line + "\n")
    except Exception:
        pass
    print(line)


def main():
    log("========== AutoSubs Python LOADING ==========")

    # ===== BƯỚC 1: Thêm path TRƯỚC KHI làm gì khác =====
    # (autosubs package nằm trong resources/)
    if DEV_MODE:
        resources_folder = os.path.join(
            os.path.expanduser("~"),
            "Desktop", "auto", "auto-subs-main",
            "AutoSubs-App", "src-tauri", "resources"
        )
    else:
        resources_folder = "/Applications/AutoSubs_Media.app/Contents/Resources/resources"

    if resources_folder not in sys.path:
        sys.path.insert(0, resources_folder)
    log(f"[Step 1] resources_folder: {resources_folder}")

    # ===== BƯỚC 2: Lấy resolve object =====
    # DaVinci chạy script trong Fusion context → bmd = fusionscript module
    # Cần: bmd.scriptapp("Fusion") → fusion obj → fusion.GetResolve() → resolve
    log("[Step 2] Getting resolve object...")
    resolve_obj = None
    bmd_module = globals().get("bmd")

    if bmd_module:
        app_name = bmd_module.getappname() if hasattr(bmd_module, "getappname") else "unknown"
        log(f"[Step 2] bmd app: {app_name}")

        # Cách A: Nếu app là Resolve (Studio version) → dùng trực tiếp
        try:
            resolve_obj = bmd_module.scriptapp("Resolve")
            log(f"[Step 2.A] scriptapp('Resolve') → {resolve_obj}")
        except Exception as e:
            log(f"[Step 2.A] failed: {e}")

        # Cách B: Lấy Fusion object trước → GetResolve()
        # Đây là cách đúng khi app đang chạy trong Fusion context
        if not resolve_obj:
            try:
                fusion = bmd_module.scriptapp("Fusion")
                log(f"[Step 2.B] scriptapp('Fusion') → {fusion}")
                if fusion:
                    # GetResolve() trả về Resolve app object từ Fusion
                    resolve_obj = fusion.GetResolve()
                    log(f"[Step 2.B] fusion.GetResolve() → {resolve_obj}")
            except Exception as e:
                log(f"[Step 2.B] failed: {e}")

        # Cách C: Thử "FusionScript" app name
        if not resolve_obj:
            try:
                fusion = bmd_module.scriptapp("FusionScript")
                log(f"[Step 2.C] scriptapp('FusionScript') → {fusion}")
                if fusion:
                    resolve_obj = fusion.GetResolve()
                    log(f"[Step 2.C] fusion.GetResolve() → {resolve_obj}")
            except Exception as e:
                log(f"[Step 2.C] failed: {e}")

    if not resolve_obj:
        log("[FATAL] Cannot get resolve object!")
        return

    log(f"[Step 2] ✅ resolve: {resolve_obj}")

    # ===== BƯỚC 3: Khởi tạo autosubs server =====
    log("[Step 3] Starting autosubs server...")
    app_executable = "/Applications/AutoSubs_Media.app"
    import autosubs
    autosubs.init(resolve_obj, app_executable, resources_folder, DEV_MODE)
    log("========== AutoSubs Python READY ==========")


# ============================================================
# ENTRY POINT — DaVinci exec() script trực tiếp
# ============================================================
try:
    main()
except Exception as e:
    log(f"[FATAL] {e}")
    log(traceback.format_exc())
    log("========== AutoSubs Python CRASHED ==========")
