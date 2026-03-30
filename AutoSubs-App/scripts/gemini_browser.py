"""
gemini_browser.py — Quản lý Chrome qua Playwright cho Gemini Scan
===================================================================
Chức năng:
  - Mở Chrome với profile giữ phiên đăng nhập Google
  - Đóng Chrome / giải phóng bộ nhớ
  - Kiểm tra Chrome còn sống hay đã chết

Tái sử dụng pattern từ flow_browser.py (dự án 3d-documentary).
"""

import asyncio
import os
import platform
import subprocess
from datetime import datetime

try:
    import psutil
except Exception:
    psutil = None

from gemini_config import GEMINI_URL, PROFILE_DIR


def log(msg, emoji=""):
    """Helper log có timestamp"""
    now = datetime.now().strftime("%H:%M:%S")
    print(f"[{now}] {emoji}  {msg}" if emoji else f"[{now}] {msg}")


# ═══════════════════════════════════════════════════
# TÌM ĐƯỜNG DẪN CHROME TRÊN MÁY
# ═══════════════════════════════════════════════════
def detect_chrome():
    """
    Tự động dò tìm file thực thi Chrome trên máy.
    Hỗ trợ: macOS, Windows, Linux.
    Trả về đường dẫn chrome hoặc None (dùng Chromium mặc định của Playwright).
    """
    os_name = platform.system()
    paths = {
        "Darwin": [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            os.path.expanduser(
                "~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            ),
        ],
        "Windows": [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ],
        "Linux": [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium-browser",
        ],
    }
    for p in paths.get(os_name, []):
        if os.path.exists(p):
            log(f"Tìm thấy Chrome: {p}", "✅")
            return p
    log("Không tìm thấy Chrome — dùng Chromium của Playwright.", "⚠️")
    return None


# ═══════════════════════════════════════════════════
# KILL CHROME ĐANG DÙNG CÙNG PROFILE
# ═══════════════════════════════════════════════════
async def kill_chrome_for_profile(profile_dir):
    """
    Kill các Chrome process đang dùng cùng profile_dir.
    Tránh lỗi "Opening in existing browser session".
    Không đụng gì tới file trong profile_dir.
    """
    profile_dir = os.path.abspath(os.path.expanduser(profile_dir))
    killed_any = False

    # 1) Dùng psutil (chính xác theo cmdline)
    if psutil is not None:
        victims = []
        current_pid = os.getpid()
        for proc in psutil.process_iter(attrs=["pid", "name", "cmdline"]):
            try:
                info = proc.info
                pid = info.get("pid")
                name = (info.get("name") or "").lower()
                cmdline = info.get("cmdline") or []
                if pid == current_pid:
                    continue
                joined = " ".join(str(x) for x in cmdline).lower()
                looks_like_chrome = (
                    "chrome" in name or "chromium" in name or "chrome.app" in joined
                )
                if not looks_like_chrome:
                    continue
                joined_full = " ".join(str(x) for x in cmdline if x)
                if profile_dir in joined_full:
                    victims.append(proc)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

        if victims:
            log(f"Tìm thấy {len(victims)} Chrome process dùng profile này, đang terminate...", "🧹")
            for proc in victims:
                try:
                    proc.terminate()
                    killed_any = True
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            gone, alive = psutil.wait_procs(victims, timeout=2.0)
            if alive:
                for proc in alive:
                    try:
                        proc.kill()
                        killed_any = True
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
                psutil.wait_procs(alive, timeout=2.0)

    # 2) Fallback: pkill -f profile_dir
    try:
        result = subprocess.run(
            ["pkill", "-f", profile_dir],
            capture_output=True, text=True, check=False,
        )
        if result.returncode == 0:
            killed_any = True
            log("Đã pkill các process còn bám profile_dir.", "🧹")
    except Exception as e:
        log(f"pkill thất bại: {str(e)[:120]}", "⚠️")

    # 3) Đợi Chrome nhả lock
    await asyncio.sleep(1.5 if killed_any else 0.5)


# ═══════════════════════════════════════════════════
# MỞ CHROME VỚI PROFILE CỤ THỂ
# ═══════════════════════════════════════════════════
async def launch_browser(playwright_instance, profile_dir=PROFILE_DIR, url=GEMINI_URL):
    """
    Mở Chrome với profile đã lưu (giữ cookie Google login).
    Logic:
    1) Kill mọi Chrome process đang dùng cùng profile_dir
    2) Chờ nhả lock
    3) launch_persistent_context → vào GEMINI_URL
    4) Nếu dính lỗi existing session → kill lại + retry 1 lần
    """
    chrome_exe = detect_chrome()
    profile_dir = os.path.abspath(os.path.expanduser(profile_dir))

    # Tạo thư mục profile nếu chưa tồn tại
    os.makedirs(profile_dir, exist_ok=True)

    launch_args = dict(
        user_data_dir=profile_dir,
        headless=False,
        args=[
            "--start-maximized",
            "--disable-blink-features=AutomationControlled",  # Tránh bị detect là bot
            "--no-first-run",
            "--no-default-browser-check",
            "--no-sandbox",
        ],
        ignore_default_args=["--enable-automation"],
        accept_downloads=True,
        viewport={"width": 1440, "height": 900},
    )
    if chrome_exe:
        launch_args["executable_path"] = chrome_exe
    else:
        launch_args["channel"] = "chrome"

    async def _do_launch():
        browser_context = await playwright_instance.chromium.launch_persistent_context(
            **launch_args
        )
        # Lấy tab đầu tiên hoặc tạo mới
        page = browser_context.pages[0] if browser_context.pages else await browser_context.new_page()
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        log(f"Chrome đã mở thành công, đang vào {url}...", "🌐")
        return browser_context, page

    # Lần 1: dọn profile trước khi launch
    await kill_chrome_for_profile(profile_dir)
    try:
        return await _do_launch()
    except Exception as e:
        err_str = str(e).lower()
        suspected = (
            "opening in existing browser session" in err_str
            or "target page, context or browser has been closed" in err_str
            or "browser has been closed" in err_str
        )
        if not suspected:
            raise
        log("Phát hiện Chrome forward sang existing session, kill lại + retry...", "⚠️")
        try:
            subprocess.run(["pkill", "-f", profile_dir], capture_output=True, text=True, check=False)
        except Exception:
            pass
        await asyncio.sleep(1.5)
        return await _do_launch()


# ═══════════════════════════════════════════════════
# ĐÓNG CHROME
# ═══════════════════════════════════════════════════
async def close_browser(browser_context, playwright_instance=None):
    """Đóng Chrome browser và giải phóng Playwright."""
    if browser_context:
        try:
            await browser_context.close()
            log("Đã đóng Chrome Context.", "🔒")
        except Exception as e:
            err_str = str(e)
            if "EPERM" in err_str or "Target page" in err_str or "browser has been closed" in err_str:
                log(f"Chrome đã đóng trước (bình thường): {err_str[:80]}", "⚠️")
            else:
                log(f"Lỗi khi đóng browser: {err_str[:100]}", "⚠️")
    if playwright_instance:
        try:
            await playwright_instance.stop()
            log("Đã stop Playwright instance.", "🔒")
        except Exception as e:
            log(f"Lỗi khi stop Playwright: {str(e)[:100]}", "⚠️")


# ═══════════════════════════════════════════════════
# KIỂM TRA CHROME CÒN SỐNG KHÔNG
# ═══════════════════════════════════════════════════
async def is_browser_alive(page):
    """
    Test nhanh xem tab Chrome còn phản hồi không.
    Returns True nếu page còn sống.
    """
    if page is None:
        return False
    try:
        await page.title()
        return True
    except Exception:
        return False
