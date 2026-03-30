"""
gemini_server.py — FastAPI Server điều khiển Gemini qua Playwright (có Debug đầy đủ)
======================================================================================
Chạy: python scripts/gemini_server.py
     (từ thư mục AutoSubs-App/)

Endpoints:
  POST /gemini/start-session     → Mở Chrome + vào gemini.google.com
  POST /gemini/confirm-login     → Xác nhận đã đăng nhập Google
  GET  /gemini/status            → Trạng thái server hiện tại
  POST /gemini/scan-batch        → Scan hàng loạt (SSE stream), có debug screenshot
  POST /gemini/stop              → Dừng scan đang chạy
  POST /gemini/close-session     → Đóng Chrome
  GET  /gemini/debug-sessions    → Liệt kê các debug sessions có sẵn
  GET  /gemini/bug-reports       → Lấy bug reports của session hiện tại

SSE Events trong /gemini/scan-batch:
  - processing: đang xử lý 1 file
  - done: file xong + kết quả
  - error: lỗi 1 file (scan tiếp)
  - debug_step: thumbnail screenshot + DOM info (real-time debug)
  - bug_report: tổng hợp lỗi sau mỗi file
  - stopped: user dừng
  - complete: toàn bộ batch xong + bug report tổng
"""

import asyncio
import json
import os
import sys
from datetime import datetime

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse

# ═══════════════════════════════════════════════════
# THÊM THƯ MỤC scripts/ VÀO PYTHONPATH
# ═══════════════════════════════════════════════════
sys.path.insert(0, os.path.dirname(__file__))

from gemini_config import (
    SERVER_PORT, GEMINI_URL, PROFILE_DIR,
    RESPONSE_TIMEOUT_SEC, DELAY_BETWEEN_SCANS_SEC
)
from gemini_browser import launch_browser, close_browser, is_browser_alive
from gemini_chat import ensure_in_chat, upload_file_and_ask
from gemini_debugger import (
    init_debug_session,
    capture_debug_step,
    debug_step_to_sse,
    GeminiBugReporter,
    DEBUG_DIR,
)


def log(msg, emoji=""):
    """Helper log có timestamp"""
    now = datetime.now().strftime("%H:%M:%S")
    print(f"[{now}] {emoji}  {msg}" if emoji else f"[{now}] {msg}")


# ═══════════════════════════════════════════════════
# KHỞI TẠO APP
# ═══════════════════════════════════════════════════
app = FastAPI(title="Gemini Scan Server", version="1.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ═══════════════════════════════════════════════════
# TRẠNG THÁI TOÀN CỤC
# ═══════════════════════════════════════════════════
server_state = {
    "status": "disconnected",
    "message": "",
    "current_file": None,
    "progress": {"done": 0, "total": 0, "failed": 0},
    "debug_session": None,   # Đường dẫn debug session hiện tại
}

browser_context = None
page = None
playwright_instance = None
stop_requested = False

# Bug reporter hiện tại (tạo mới mỗi batch)
current_bug_reporter: GeminiBugReporter | None = None


# ═══════════════════════════════════════════════════
# ENDPOINT: GET /gemini/status
# ═══════════════════════════════════════════════════
@app.get("/gemini/status")
async def get_status():
    """Trả về trạng thái hiện tại của server"""
    return server_state


# ═══════════════════════════════════════════════════
# ENDPOINT: GET /gemini/debug-sessions
# ═══════════════════════════════════════════════════
@app.get("/gemini/debug-sessions")
async def list_debug_sessions():
    """
    Liệt kê các debug sessions có sẵn trên máy.
    Mỗi session = 1 thư mục trong gemini_debug/
    """
    import glob
    sessions = []
    pattern = os.path.join(DEBUG_DIR, "*")
    for folder in sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True):
        if not os.path.isdir(folder):
            continue
        name = os.path.basename(folder)
        # Đếm files trong session
        screenshots = [f for f in os.listdir(folder) if f.endswith(".png")]
        bug_reports = [f for f in os.listdir(folder) if f.startswith("bug_report")]
        log_exists = os.path.exists(os.path.join(folder, "debug_log.jsonl"))
        sessions.append({
            "name": name,
            "path": folder,
            "screenshots": len(screenshots),
            "has_log": log_exists,
            "bug_reports": len(bug_reports),
        })
    return {"sessions": sessions, "total": len(sessions)}


# ═══════════════════════════════════════════════════
# ENDPOINT: GET /gemini/bug-reports
# ═══════════════════════════════════════════════════
@app.get("/gemini/bug-reports")
async def get_bug_reports():
    """Lấy bug report của session debug hiện tại"""
    global current_bug_reporter
    if current_bug_reporter is None:
        return {"total_errors": 0, "total_warnings": 0, "errors": [], "warnings": []}
    return current_bug_reporter.to_dict()


# ═══════════════════════════════════════════════════
# ENDPOINT: POST /gemini/start-session
# ═══════════════════════════════════════════════════
@app.post("/gemini/start-session")
async def start_session():
    """Mở Chrome browser + vào gemini.google.com"""
    global browser_context, page, playwright_instance, server_state

    if browser_context is not None:
        if await is_browser_alive(page):
            server_state["status"] = "ready"
            return {"ok": True, "message": "Session Gemini đã tồn tại, sẵn sàng."}
        else:
            log("Browser cũ đã chết, reset...", "⚠️")
            await close_browser(browser_context)
            browser_context = None
            page = None

    try:
        server_state["status"] = "connecting"
        server_state["message"] = "Đang mở Chrome vào Gemini..."

        if playwright_instance is None:
            from playwright.async_api import async_playwright
            playwright_instance = await async_playwright().start()

        browser_context, page = await launch_browser(
            playwright_instance, PROFILE_DIR, GEMINI_URL
        )
        await asyncio.sleep(2)

        # Chụp screenshot trạng thái ban đầu
        session_dir = init_debug_session()
        server_state["debug_session"] = session_dir
        dbg = await capture_debug_step(
            page, "browser_opened",
            extra_info={"profile_dir": PROFILE_DIR, "url": GEMINI_URL}
        )
        if dbg:
            log(f"  Debug: {dbg['message']}", "📸")

        server_state["status"] = "waiting_login"
        server_state["message"] = "Chrome đã mở Gemini. Hãy đăng nhập Google nếu chưa."
        log("Browser đã mở Gemini. Chờ user đăng nhập...", "👀")

        return {
            "ok": True,
            "message": "Chrome đã mở gemini.google.com. Đăng nhập Google rồi xác nhận.",
            "debug_session": session_dir,
        }
    except Exception as e:
        server_state["status"] = "error"
        server_state["message"] = str(e)
        log(f"Lỗi start-session: {e}", "❌")
        return {"ok": False, "error": str(e)}


# ═══════════════════════════════════════════════════
# ENDPOINT: POST /gemini/confirm-login
# ═══════════════════════════════════════════════════
@app.post("/gemini/confirm-login")
async def confirm_login():
    """Xác nhận đã đăng nhập Google, kiểm tra ô chat Gemini"""
    global server_state
    if browser_context is None:
        return {"ok": False, "error": "Chưa có session. Gọi /gemini/start-session trước."}

    log("Kiểm tra ô chat Gemini...", "🔍")

    # Chụp screenshot trước khi kiểm tra login
    dbg_before = await capture_debug_step(page, "confirm_login_check")
    if dbg_before:
        log(f"  DOM state: {dbg_before['message']}", "📋")

    chat_ok = await ensure_in_chat(page, timeout=10)

    # Chụp screenshot sau
    dbg_after = await capture_debug_step(
        page,
        "login_confirmed" if chat_ok else "login_failed",
        is_error=not chat_ok,
        extra_info={"chat_found": chat_ok},
    )
    if dbg_after:
        log(f"  DOM state: {dbg_after['message']}", "📋")

    if chat_ok:
        server_state["status"] = "ready"
        server_state["message"] = "Sẵn sàng scan file!"
        log("Đã vào Gemini chat → Ready!", "✅")
        return {"ok": True, "message": "Sẵn sàng scan!"}
    else:
        server_state["status"] = "waiting_login"
        server_state["message"] = "Chưa thấy ô chat. Hãy đảm bảo đã đăng nhập và ở trang Gemini."
        return {"ok": False, "error": "Chưa thấy ô chat Gemini. Kiểm tra lại đăng nhập."}


# ═══════════════════════════════════════════════════
# ENDPOINT: POST /gemini/stop
# ═══════════════════════════════════════════════════
@app.post("/gemini/stop")
async def stop_scan():
    """Dừng batch scan đang chạy"""
    global stop_requested
    stop_requested = True
    log("Stop requested!", "⏹")
    return {"ok": True, "message": "Đã yêu cầu dừng."}


# ═══════════════════════════════════════════════════
# ENDPOINT: POST /gemini/close-session
# ═══════════════════════════════════════════════════
@app.post("/gemini/close-session")
async def close_session():
    """Đóng Chrome browser"""
    global browser_context, page, playwright_instance, server_state
    await close_browser(browser_context, playwright_instance)
    browser_context = None
    page = None
    playwright_instance = None
    server_state["status"] = "disconnected"
    server_state["message"] = "Đã đóng Chrome."
    return {"ok": True, "message": "Đã đóng Chrome."}


# ═══════════════════════════════════════════════════
# ENDPOINT: POST /gemini/scan-batch — SCAN HÀNG LOẠT (SSE + DEBUG)
# ═══════════════════════════════════════════════════
@app.post("/gemini/scan-batch")
async def scan_batch(http_request: Request):
    """
    Scan hàng loạt file ảnh/audio qua Gemini.
    Trả kết quả real-time qua SSE stream.
    Mỗi bước đều chụp screenshot debug + quét DOM.

    SSE Events:
    - processing: đang xử lý file
    - done: file xong
    - error: lỗi 1 file
    - debug_step: thumbnail screenshot + DOM state (debug real-time)
    - bug_report: report lỗi sau mỗi file
    - stopped: user dừng
    - complete: xong + bug report tổng
    """
    global server_state, stop_requested, browser_context, page, current_bug_reporter

    if page is None:
        return JSONResponse(status_code=400, content={"error": "Chưa có session."})
    if not await is_browser_alive(page):
        return JSONResponse(status_code=400, content={"error": "Chrome đã đóng."})
    if server_state["status"] == "scanning":
        return JSONResponse(status_code=409, content={"error": "Đang có scan chạy."})

    try:
        raw_bytes = await http_request.body()
        payload = json.loads(raw_bytes.decode("utf-8"))
    except Exception as e:
        return JSONResponse(status_code=422, content={"error": f"JSON lỗi: {e}"})

    scan_type = payload.get("scan_type", "audio")
    jobs = payload.get("jobs", [])
    total = len(jobs)

    if total == 0:
        return JSONResponse(status_code=400, content={"error": "Không có file nào."})

    log(f"Nhận batch scan {total} file ({scan_type})", "🚀")
    stop_requested = False
    server_state["status"] = "scanning"
    server_state["progress"] = {"done": 0, "total": total, "failed": 0}

    # Tạo Bug Reporter cho batch này
    current_bug_reporter = GeminiBugReporter()

    async def event_generator():
        global stop_requested, current_bug_reporter
        done_count = 0
        fail_count = 0

        for i, job in enumerate(jobs):
            # ── Kiểm tra dừng ──
            if stop_requested:
                yield {
                    "event": "stopped",
                    "data": json.dumps({
                        "message": "Đã dừng scan.",
                        "done": done_count,
                        "total": total,
                    }),
                }
                break

            job_id = job.get("job_id", f"file_{i}")
            file_path = job.get("file_path", "")
            file_name = job.get("file_name", os.path.basename(file_path))
            prompt = job.get("prompt", "")

            log(f"[{i+1}/{total}] Bắt đầu: {file_name}", "🔍")
            server_state["current_file"] = file_name

            # Event: đang xử lý
            yield {
                "event": "processing",
                "data": json.dumps({
                    "job_id": job_id,
                    "file_name": file_name,
                    "index": i + 1,
                    "total": total,
                }),
            }

            # ── DEBUG STEP 1: Trước khi upload ──
            dbg1 = await capture_debug_step(
                page, "before_upload",
                job_id=job_id,
                extra_info={"file_name": file_name, "file_path": file_path}
            )
            if dbg1:
                sse1 = debug_step_to_sse(dbg1)
                if sse1:
                    yield sse1
                # Kiểm tra có ô chat không
                if not any(inp.get("visible") for inp in dbg1["dom_info"].get("inputs", [])):
                    current_bug_reporter.report_warning(
                        "no_chat_input_before_upload",
                        f"Không thấy ô chat Gemini trước khi upload [{file_name}]",
                        {"dom_buttons": len(dbg1["dom_info"].get("buttons", []))}
                    )

            try:
                # ── Gọi Gemini upload + prompt + đọc kết quả ──
                result = await upload_file_and_ask(
                    page, file_path, prompt,
                    timeout_sec=RESPONSE_TIMEOUT_SEC,
                )

                # ── DEBUG STEP 2: Sau khi Gemini phản hồi ──
                dbg2 = await capture_debug_step(
                    page, "after_gemini_response",
                    job_id=job_id,
                    extra_info={
                        "ok": result.get("ok"),
                        "response_length": len(result.get("response_text", "")),
                        "error": result.get("error"),
                    },
                    is_error=not result.get("ok", False),
                )
                if dbg2:
                    sse2 = debug_step_to_sse(dbg2)
                    if sse2:
                        yield sse2

                if result["ok"] and result["response_text"]:
                    done_count += 1
                    server_state["progress"]["done"] = done_count

                    yield {
                        "event": "done",
                        "data": json.dumps({
                            "job_id": job_id,
                            "file_path": file_path,
                            "file_name": file_name,
                            "scan_type": scan_type,
                            "response_text": result["response_text"],
                            "done": done_count,
                            "total": total,
                        }),
                    }
                    log(f"  ✅ [{job_id}] Done ({len(result['response_text'])} chars)", "✅")

                else:
                    # Lỗi file → ghi bug + tiếp tục
                    fail_count += 1
                    server_state["progress"]["failed"] = fail_count
                    err_msg = result.get("error", "Unknown error")
                    current_bug_reporter.report_error(
                        "scan_failed",
                        f"[{file_name}] {err_msg}",
                        {"job_id": job_id, "file_path": file_path}
                    )
                    yield {
                        "event": "error",
                        "data": json.dumps({
                            "job_id": job_id,
                            "file_name": file_name,
                            "error": err_msg,
                            "done": done_count,
                            "total": total,
                        }),
                    }
                    log(f"  ❌ [{job_id}] Error: {err_msg}", "❌")

                    # ── DEBUG STEP ERROR: Chụp khi lỗi ──
                    dbg_err = await capture_debug_step(
                        page, f"error_{job_id}",
                        job_id=job_id,
                        extra_info={"error": err_msg},
                        is_error=True,
                    )
                    if dbg_err:
                        sse_err = debug_step_to_sse(dbg_err)
                        if sse_err:
                            yield sse_err

            except Exception as e:
                fail_count += 1
                server_state["progress"]["failed"] = fail_count
                current_bug_reporter.report_error(
                    "exception_during_scan",
                    f"[{file_name}] Exception: {str(e)}",
                    {"job_id": job_id, "exception_type": type(e).__name__}
                )
                log(f"  ❌ [{job_id}] Exception: {e}", "❌")
                yield {
                    "event": "error",
                    "data": json.dumps({
                        "job_id": job_id,
                        "file_name": file_name,
                        "error": str(e),
                        "done": done_count,
                        "total": total,
                    }),
                }
                # Chụp screenshot khi có exception
                try:
                    dbg_exc = await capture_debug_step(
                        page, f"exception_{job_id}",
                        job_id=job_id,
                        extra_info={"exception": str(e)[:200]},
                        is_error=True,
                    )
                    if dbg_exc:
                        sse_exc = debug_step_to_sse(dbg_exc)
                        if sse_exc:
                            yield sse_exc
                except Exception:
                    pass

            # ── Gửi bug report sau mỗi file (nếu có lỗi/warning) ──
            if current_bug_reporter and (current_bug_reporter.bugs or current_bug_reporter.warnings):
                yield {
                    "event": "bug_report",
                    "data": json.dumps({
                        "job_id": job_id,
                        "file_name": file_name,
                        "report": current_bug_reporter.to_dict(),
                    }),
                }

            # Delay giữa 2 file
            if i < total - 1 and not stop_requested:
                await asyncio.sleep(DELAY_BETWEEN_SCANS_SEC)

        # ── Lưu bug report cuối batch ──
        if current_bug_reporter:
            report_path = current_bug_reporter.save()
            if report_path:
                log(f"Bug report đã lưu: {report_path}", "📝")

        # Hoàn tất batch
        server_state["status"] = "ready"
        server_state["current_file"] = None

        # Chụp screenshot cuối
        dbg_final = await capture_debug_step(
            page, "batch_complete",
            extra_info={
                "done": done_count,
                "failed": fail_count,
                "total": total,
            }
        )
        if dbg_final:
            sse_final = debug_step_to_sse(dbg_final)
            if sse_final:
                yield sse_final

        yield {
            "event": "complete",
            "data": json.dumps({
                "done": done_count,
                "failed": fail_count,
                "total": total,
                "message": f"Hoàn tất! {done_count}/{total} file scan thành công.",
                "bug_report": current_bug_reporter.to_dict() if current_bug_reporter else {},
            }),
        }
        log(f"Batch hoàn tất: {done_count}/{total} OK, {fail_count} lỗi", "🎉")

    return EventSourceResponse(event_generator())


# ═══════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════
if __name__ == "__main__":
    import uvicorn
    log(f"🚀 Gemini Scan Server đang khởi động trên port {SERVER_PORT}...", "🚀")
    log(f"   Profile Chrome: {PROFILE_DIR}", "📁")
    log(f"   Debug dir:      {DEBUG_DIR}", "📁")
    log(f"   API docs:       http://localhost:{SERVER_PORT}/docs", "📖")
    uvicorn.run(app, host="127.0.0.1", port=SERVER_PORT)
