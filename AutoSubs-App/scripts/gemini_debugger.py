"""
gemini_debugger.py — Hệ thống Debug & Giám sát cho Gemini Scan
===============================================================
Chuyên phụ trách:
  - Chụp screenshot tại mỗi bước thao tác trên Gemini chat
  - Quét DOM (buttons, inputs, images, spinner) để ghi nhật ký
  - Tạo thumbnail nhỏ gửi qua SSE stream về frontend
  - Quản lý debug session (tạo folder, xoá session cũ)
  - Ghi log JSONL (1 dòng = 1 bước) → dễ đọc, dễ search

Pattern giống flow_debugger.py từ dự án 3d-documentary.
"""

import os
import io
import base64
import time
import json
import glob
import shutil
from pathlib import Path
from datetime import datetime

from gemini_config import SERVER_PORT  # dùng để xác định thư mục debug

# ═══════════════════════════════════════════════════
# CẤU HÌNH DEBUG
# ═══════════════════════════════════════════════════
# Thư mục chứa tất cả debug sessions
DEBUG_DIR = os.path.join(os.path.dirname(__file__), "..", "gemini_debug")
# Giữ tối đa N sessions gần nhất (session cũ tự xoá)
DEBUG_MAX_SESSIONS = 10
# Width thumbnail gửi SSE (px) — nhỏ để ít bandwidth
DEBUG_THUMBNAIL_WIDTH = 360
# Chất lượng JPEG thumbnail
DEBUG_THUMBNAIL_QUALITY = 72

# PIL dùng để resize thumbnail
try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False
    print("⚠️  PIL chưa cài. Chạy: pip install Pillow (để resize screenshot thumbnail)")


def log(msg, emoji=""):
    """Helper log có timestamp"""
    now = datetime.now().strftime("%H:%M:%S")
    print(f"[{now}] {emoji}  {msg}" if emoji else f"[{now}] {msg}")


# ═══════════════════════════════════════════════════
# TRẠNG THÁI DEBUG (module-level)
# ═══════════════════════════════════════════════════
debug_session_dir = None   # Folder session hiện tại
debug_step_counter = 0     # Đếm số bước trong session


# ═══════════════════════════════════════════════════
# KHỞI TẠO SESSION DEBUG MỚI
# ═══════════════════════════════════════════════════
def init_debug_session():
    """
    Tạo folder debug mới cho batch hiện tại.
    Xoá auto các session cũ nếu vượt quá giới hạn.
    Trả về đường dẫn folder session mới.
    """
    global debug_session_dir, debug_step_counter
    Path(DEBUG_DIR).mkdir(parents=True, exist_ok=True)

    # Xoá sessions cũ (giữ DEBUG_MAX_SESSIONS gần nhất)
    existing = sorted(glob.glob(os.path.join(DEBUG_DIR, "*")), key=os.path.getmtime)
    while len(existing) >= DEBUG_MAX_SESSIONS:
        oldest = existing.pop(0)
        shutil.rmtree(oldest, ignore_errors=True)
        log(f"  Xoá debug session cũ: {os.path.basename(oldest)}", "🗑️")

    # Tạo folder mới theo timestamp
    session_name = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    debug_session_dir = os.path.join(DEBUG_DIR, session_name)
    Path(debug_session_dir).mkdir(exist_ok=True)
    debug_step_counter = 0
    log(f"  Debug session: {debug_session_dir}", "📸")
    return debug_session_dir


# ═══════════════════════════════════════════════════
# QUÉT DOM — Thu thập thông tin giao diện hiện tại
# ═══════════════════════════════════════════════════
async def scan_dom_state(pg):
    """
    Quét toàn bộ DOM trang Gemini → trả dict chứa:
    - buttons: danh sách nút (text, aria, vị trí, enabled)
    - inputs: các ô nhập text (contenteditable, textbox)
    - file_inputs: ô upload file
    - large_images: ảnh lớn (>150px) + src preview
    - popups: dialog/modal đang mở
    - has_spinner: có loading/generating không
    - url, title, viewport
    """
    result = {
        "url": "",
        "title": "",
        "viewport": {"w": 0, "h": 0},
        "buttons": [],
        "inputs": [],
        "file_inputs": [],
        "large_images": 0,
        "large_images_detail": [],
        "popups": [],
        "has_spinner": False,
    }

    try:
        result["url"] = pg.url
        result["title"] = await pg.title()
        result["viewport"] = await pg.evaluate("({w: window.innerWidth, h: window.innerHeight})")
    except Exception:
        pass

    # ── Scan buttons ──
    try:
        all_btns = await pg.query_selector_all("button")
        for btn in all_btns:
            try:
                box = await btn.bounding_box()
                if not box:
                    continue
                txt = (await btn.inner_text()).strip()[:200]
                visible = await btn.is_visible()
                enabled = await btn.is_enabled()
                aria = (await btn.get_attribute("aria-label") or "")[:200]
                cls = (await btn.get_attribute("class") or "")[:100]
                btn_id = (await btn.get_attribute("id") or "")[:50]
                result["buttons"].append({
                    "text": txt,
                    "aria": aria,
                    "class": cls,
                    "id": btn_id,
                    "visible": visible,
                    "enabled": enabled,
                    "x": int(box["x"]),
                    "y": int(box["y"]),
                    "w": int(box["width"]),
                    "h": int(box["height"]),
                })
                if len(result["buttons"]) >= 30:
                    break
            except Exception:
                continue
    except Exception:
        pass

    # ── Scan text inputs (contenteditable, textarea...) ──
    try:
        for sel_name, sel in [
            ("contenteditable", "div[contenteditable='true']"),
            ("textbox", "div[role='textbox']"),
            ("textarea", "textarea"),
            ("input_text", "input[type='text'], input:not([type])"),
        ]:
            els = await pg.query_selector_all(sel)
            for el in els:
                try:
                    visible = await el.is_visible()
                    text = ""
                    try:
                        text = (await el.inner_text()).strip()[:500]
                    except Exception:
                        pass
                    cls = (await el.get_attribute("class") or "")[:100]
                    el_id = (await el.get_attribute("id") or "")[:50]
                    result["inputs"].append({
                        "type": sel_name,
                        "visible": visible,
                        "text_length": len(text),
                        "text_preview": text[:200],
                        "class": cls,
                        "id": el_id,
                    })
                except Exception:
                    continue

        # File inputs riêng (upload ảnh/audio)
        file_inputs = await pg.query_selector_all("input[type='file']")
        for el in file_inputs:
            try:
                visible = await el.is_visible()
                accept = (await el.get_attribute("accept") or "")
                result["file_inputs"].append({
                    "visible": visible,
                    "accept": accept,
                })
            except Exception:
                continue
    except Exception:
        pass

    # ── Scan ảnh lớn (>150px) + src preview ──
    try:
        imgs = await pg.query_selector_all("img")
        for img in imgs:
            try:
                box = await img.bounding_box()
                if box and box["width"] > 150 and box["height"] > 150:
                    result["large_images"] += 1
                    if len(result["large_images_detail"]) < 8:
                        src = (await img.get_attribute("src") or "")[:300]
                        alt = (await img.get_attribute("alt") or "")[:100]
                        result["large_images_detail"].append({
                            "w": int(box["width"]),
                            "h": int(box["height"]),
                            "x": int(box["x"]),
                            "y": int(box["y"]),
                            "src_preview": src[:80],
                            "alt": alt,
                        })
            except Exception:
                continue
    except Exception:
        pass

    # ── Scan popup/modal ──
    try:
        for sel in ["[role='dialog']", "[role='alertdialog']", "[class*='modal']"]:
            els = await pg.query_selector_all(sel)
            for el in els:
                try:
                    if await el.is_visible():
                        txt = (await el.inner_text()).strip()[:500]
                        cls = (await el.get_attribute("class") or "")[:100]
                        result["popups"].append(f"[{cls}] {txt[:200]}")
                except Exception:
                    continue
    except Exception:
        pass

    # ── Detect spinner/generating/loading ──
    try:
        for sel in [
            "[class*='spinner']", "[class*='loading']",
            "[class*='generating']", "[aria-busy='true']",
            "mat-progress-bar", "[class*='progress']",
            "model-response.in-progress",
        ]:
            els = await pg.query_selector_all(sel)
            for el in els:
                try:
                    if await el.is_visible():
                        result["has_spinner"] = True
                        break
                except Exception:
                    continue
            if result["has_spinner"]:
                break
    except Exception:
        pass

    # ── Lấy text phản hồi cuối cùng của Gemini ──
    try:
        response_text = await pg.evaluate("""() => {
            const els = document.querySelectorAll('model-response, .model-response, .response-content');
            if (!els.length) return '';
            const last = els[els.length - 1];
            return (last.innerText || last.textContent || '').trim().slice(0, 500);
        }""")
        if response_text:
            result["gemini_response_preview"] = response_text
    except Exception:
        pass

    return result


# ═══════════════════════════════════════════════════
# CHỤP SCREENSHOT + QUÉT DOM TẠI 1 BƯỚC
# ═══════════════════════════════════════════════════
async def capture_debug_step(pg, step_name, job_id="", extra_info=None, is_error=False):
    """
    Chụp screenshot + quét DOM → lưu file + trả dict để gửi SSE.

    Args:
        pg: Playwright page đang mở
        step_name: Tên bước (VD: 'before_upload', 'after_type_prompt', 'error_no_chat')
        job_id: File đang xử lý (tên file hoặc job index)
        extra_info: Dict thông tin thêm (tuỳ bước)
        is_error: True nếu là screenshot lỗi → prefix "ERROR_"

    Returns:
        dict: { step, screenshot_path, thumbnail_base64, dom_info, timestamp, message }
    """
    global debug_step_counter

    if not debug_session_dir or not pg:
        return None

    debug_step_counter += 1
    prefix = "ERROR" if is_error else f"{debug_step_counter:02d}"
    filename = f"{prefix}_{step_name}.png"
    filepath = os.path.join(debug_session_dir, filename)
    html_filename = f"{prefix}_{step_name}.html"
    html_filepath = os.path.join(debug_session_dir, html_filename)

    timestamp = datetime.now().strftime("%H:%M:%S")
    result = {
        "step": step_name,
        "step_index": debug_step_counter,
        "job_id": job_id,
        "timestamp": time.time(),
        "timestamp_str": timestamp,
        "screenshot_path": filepath,
        "thumbnail_base64": None,
        "dom_info": {},
        "extra": extra_info or {},
        "is_error": is_error,
        "message": "",
    }

    try:
        # 1. Chụp screenshot full resolution
        await pg.screenshot(path=filepath, full_page=False)

        # Lưu HTML snapshot để debug DOM
        try:
            page_html = await pg.content()
            with open(html_filepath, "w", encoding="utf-8") as f:
                f.write(page_html)
            log(f"  📸 [{prefix}_{step_name}] Screenshot + HTML saved", "📸")
        except Exception as e:
            log(f"  ⚠️ Lỗi lưu HTML snapshot: {e}", "⚠️")

        # 2. Tạo thumbnail nhỏ gửi SSE (giảm bandwidth)
        thumbnail_b64 = None
        if HAS_PIL and os.path.exists(filepath):
            try:
                img = Image.open(filepath)
                ratio = DEBUG_THUMBNAIL_WIDTH / img.width
                new_h = int(img.height * ratio)
                img_resized = img.resize((DEBUG_THUMBNAIL_WIDTH, new_h), Image.LANCZOS)
                buf = io.BytesIO()
                img_resized.save(buf, format="JPEG", quality=DEBUG_THUMBNAIL_QUALITY)
                buf.seek(0)
                b64 = base64.b64encode(buf.read()).decode("utf-8")
                thumbnail_b64 = f"data:image/jpeg;base64,{b64}"
                img.close()
                img_resized.close()
            except Exception as e:
                log(f"  Thumbnail resize lỗi: {e}", "⚠️")
                # Fallback: gửi full PNG
                with open(filepath, "rb") as f:
                    b64 = base64.b64encode(f.read()).decode("utf-8")
                thumbnail_b64 = f"data:image/png;base64,{b64}"
        elif os.path.exists(filepath):
            # Không có PIL → gửi PNG thô
            with open(filepath, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("utf-8")
            thumbnail_b64 = f"data:image/png;base64,{b64}"

        result["thumbnail_base64"] = thumbnail_b64

        # 3. Quét DOM đầy đủ
        dom_info = await scan_dom_state(pg)
        result["dom_info"] = dom_info

        # 4. Tạo message mô tả ngắn
        msg_parts = []
        if dom_info.get("inputs"):
            visible_inputs = [i for i in dom_info["inputs"] if i.get("visible")]
            msg_parts.append(f"{len(visible_inputs)} ô nhập")
        if dom_info.get("buttons"):
            enabled_btns = [b for b in dom_info["buttons"] if b.get("enabled")]
            msg_parts.append(f"{len(enabled_btns)}/{len(dom_info['buttons'])} nút enabled")
        msg_parts.append(f"{dom_info.get('large_images', 0)} ảnh lớn")
        if dom_info.get("popups"):
            msg_parts.append(f"⚠️ {len(dom_info['popups'])} popup")
        if dom_info.get("has_spinner"):
            msg_parts.append("⏳ generating...")
        if dom_info.get("gemini_response_preview"):
            preview = dom_info["gemini_response_preview"][:80]
            msg_parts.append(f'💬 "{preview}..."')
        result["message"] = " | ".join(msg_parts)

        # 5. Ghi log JSONL (1 dòng = 1 bước)
        log_entry = {
            "step": step_name,
            "ts": timestamp,
            "job_id": job_id,
            "screenshot": filename,
            "html_snapshot": html_filename,
            "is_error": is_error,
            "ok": not is_error,
            "extra": extra_info or {},
            "dom": {
                "url": dom_info.get("url", ""),
                "title": dom_info.get("title", ""),
                "buttons_count": len(dom_info.get("buttons", [])),
                "buttons": dom_info.get("buttons", []),
                "inputs": dom_info.get("inputs", []),
                "file_inputs": dom_info.get("file_inputs", []),
                "large_images": dom_info.get("large_images", 0),
                "large_images_detail": dom_info.get("large_images_detail", []),
                "popups": dom_info.get("popups", []),
                "has_spinner": dom_info.get("has_spinner", False),
                "gemini_response_preview": dom_info.get("gemini_response_preview", ""),
            },
            "message": result["message"],
        }
        log_path = os.path.join(debug_session_dir, "debug_log.jsonl")
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(log_entry, ensure_ascii=False) + "\n")

        log(f"  [{prefix}] {step_name}: {result['message']}", "📋")

    except Exception as e:
        log(f"  capture_debug_step lỗi: {e}", "⚠️")
        result["message"] = f"Capture lỗi: {str(e)[:100]}"

    return result


# ═══════════════════════════════════════════════════
# CONVERT DEBUG RESULT → SSE EVENT
# ═══════════════════════════════════════════════════
def debug_step_to_sse(debug_result):
    """
    Convert kết quả capture_debug_step → SSE event dict.
    Bỏ screenshot_path (không cần gửi client), giữ thumbnail_base64.
    Frontend nhận event này để hiển thị Debug Timeline.
    """
    if not debug_result:
        return None
    return {
        "event": "debug_step",
        "data": json.dumps({
            "step": debug_result["step"],
            "step_index": debug_result["step_index"],
            "job_id": debug_result["job_id"],
            "timestamp": debug_result["timestamp"],
            "screenshot_base64": debug_result["thumbnail_base64"],
            "dom_info": debug_result["dom_info"],
            "extra": debug_result["extra"],
            "is_error": debug_result["is_error"],
            "message": debug_result["message"],
        }, ensure_ascii=False),
    }


# ═══════════════════════════════════════════════════
# BUG REPORTER — Ghi bug tự động vào file riêng
# ═══════════════════════════════════════════════════
class GeminiBugReporter:
    """
    Bắt và ghi mọi lỗi/cảnh báo trong quá trình scan.
    Xuất file JSON dạng bug_report_TIMESTAMP.json trong debug session.

    Usage:
        reporter = GeminiBugReporter()
        reporter.report_error("upload_failed", "Không tìm thấy nút upload", {...})
        reporter.report_warning("slow_response", "Gemini phản hồi sau 90s", {...})
        reporter.save()  # Ghi file
    """

    def __init__(self):
        self.bugs: list[dict] = []
        self.warnings: list[dict] = []
        self.session_start = datetime.now().isoformat()

    def report_error(self, code: str, message: str, context: dict | None = None):
        """Ghi 1 lỗi nghiêm trọng (có thể khiến scan thất bại)"""
        entry = {
            "type": "error",
            "code": code,
            "message": message,
            "context": context or {},
            "ts": datetime.now().strftime("%H:%M:%S"),
            "timestamp": time.time(),
        }
        self.bugs.append(entry)
        log(f"[BugReport] ❌ ERROR [{code}]: {message}", "🐛")

    def report_warning(self, code: str, message: str, context: dict | None = None):
        """Ghi 1 cảnh báo (scan vẫn tiếp tục nhưng kết quả có thể không đúng)"""
        entry = {
            "type": "warning",
            "code": code,
            "message": message,
            "context": context or {},
            "ts": datetime.now().strftime("%H:%M:%S"),
            "timestamp": time.time(),
        }
        self.warnings.append(entry)
        log(f"[BugReport] ⚠️ WARN [{code}]: {message}", "⚠️")

    def save(self) -> str | None:
        """
        Lưu bug report vào file JSON trong debug session.
        Trả về đường dẫn file đã lưu (hoặc None nếu không có gì).
        """
        if not debug_session_dir:
            return None
        if not self.bugs and not self.warnings:
            return None

        report = {
            "session_start": self.session_start,
            "session_end": datetime.now().isoformat(),
            "total_errors": len(self.bugs),
            "total_warnings": len(self.warnings),
            "errors": self.bugs,
            "warnings": self.warnings,
        }
        fname = f"bug_report_{datetime.now().strftime('%H-%M-%S')}.json"
        fpath = os.path.join(debug_session_dir, fname)
        with open(fpath, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)

        log(f"[BugReport] 📝 Đã lưu {len(self.bugs)} errors + {len(self.warnings)} warnings → {fname}", "📝")
        return fpath

    def to_dict(self) -> dict:
        """Trả về report dưới dạng dict (để gửi SSE cho frontend)"""
        return {
            "total_errors": len(self.bugs),
            "total_warnings": len(self.warnings),
            "errors": self.bugs,
            "warnings": self.warnings,
        }
