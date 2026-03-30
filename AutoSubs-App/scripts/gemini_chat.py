"""
gemini_chat.py — Logic tương tác với Gemini trên trình duyệt (với Debug đầy đủ)
================================================================================
Chức năng chính:
  1. Upload file (ảnh/audio) vào ô chat của Gemini
  2. Gõ prompt phân tích
  3. Chờ Gemini trả lời
  4. Đọc phản hồi text từ DOM

Flow cụ thể:
  upload_file_and_ask(page, file_path, prompt)
    → 1. Bấm nút đính kèm (📎) / nút upload
    → 2. Chọn file từ file chooser
    → 3. Chờ file load xong
    → 4. Gõ prompt vào ô chat
    → 5. Bấm nút gửi (Enter hoặc nút Send)
    → 6. Chờ Gemini sinh xong câu trả lời
    → 7. Trả về text phản hồi
"""

import asyncio
import random
from datetime import datetime


def log(msg, emoji=""):
    """Helper log có timestamp"""
    now = datetime.now().strftime("%H:%M:%S")
    print(f"[{now}] {emoji}  {msg}" if emoji else f"[{now}] {msg}")


# ═══════════════════════════════════════════════════
# CÁC SELECTOR DOM CỦA GEMINI
# ═══════════════════════════════════════════════════
# Gemini thay đổi DOM thỉnh thoảng — tập trung vào các selector ổn định nhất

# Ô nhập prompt (contenteditable)
PROMPT_INPUT_SELECTORS = [
    "div[contenteditable='true']",
    "rich-textarea div[contenteditable='true']",
    "p.textarea-placeholder",
    "[role='textbox']",
]

# Nút upload file / đính kèm
UPLOAD_BTN_SELECTORS = [
    "button[aria-label*='Upload']",
    "button[aria-label*='upload']",
    "button[aria-label*='file']",
    "button[aria-label*='Attach']",
    "button[aria-label*='attach']",
    "button[data-test-id='upload-button']",
    # Nút dấu cộng hoặc đính kèm
    "button[aria-label='Add files and more']",
    "button[aria-label='Add to message']",
    "button.add-file-button",
    "mat-icon[aria-label*='attach']",
]

# Nút gửi message
SEND_BTN_SELECTORS = [
    "button[aria-label='Send message']",
    "button[aria-label='Submit']",
    "button[data-test-id='send-button']",
    "button.send-button",
]

# Phần tử chứa câu trả lời cuối cùng của Gemini
RESPONSE_SELECTORS = [
    # Câu trả lời của model
    "model-response .response-content",
    "model-response",
    ".model-response-text",
    # Fallback: lấy chat bubble cuối cùng
    "message-content",
    ".chat-history model-response:last-child",
]


# ═══════════════════════════════════════════════════
# KIỂM TRA ĐÃ VÀO CHAT GEMINI CHƯA
# ═══════════════════════════════════════════════════
async def ensure_in_chat(page, timeout=15) -> bool:
    """
    Kiểm tra xem trang có ô chat nhập prompt chưa.
    Returns True nếu tìm thấy ô nhập, False nếu timeout.
    """
    log("Kiểm tra trang Gemini chat...", "🔍")
    deadline = asyncio.get_event_loop().time() + timeout

    while asyncio.get_event_loop().time() < deadline:
        for sel in PROMPT_INPUT_SELECTORS:
            try:
                el = page.locator(sel).first
                if await el.count() > 0:
                    log(f"✅ Tìm thấy ô chat: {sel}", "✅")
                    return True
            except Exception:
                pass
        await asyncio.sleep(1)

    log("❌ Không tìm thấy ô chat Gemini", "❌")
    return False


# ═══════════════════════════════════════════════════
# RESET / TẠO NEW CHAT
# ═══════════════════════════════════════════════════
async def start_new_chat(page):
    """
    Tạo chat mới để mỗi lần scan là 1 context sạch.
    Điều này giúp tránh Gemini bị confused bởi context cũ.
    """
    try:
        # Tìm nút "New Chat" / "New conversation"
        new_chat_selectors = [
            "a[href='/']",
            "button[aria-label*='New chat']",
            "button[aria-label*='new']",
            ".new-conversation-button",
            "a[aria-label='New chat']",
        ]
        for sel in new_chat_selectors:
            try:
                btn = page.locator(sel).first
                if await btn.count() > 0:
                    await btn.click()
                    await asyncio.sleep(1.5)
                    log("Đã tạo chat mới", "✨")
                    return True
            except Exception:
                pass

        # Fallback: vào URL / (trang chủ = new chat)
        await page.goto("https://gemini.google.com", wait_until="domcontentloaded", timeout=15000)
        await asyncio.sleep(2)
        log("Đã về trang chủ Gemini (new chat)", "✨")
        return True
    except Exception as e:
        log(f"Lỗi tạo new chat: {e}", "⚠️")
        return False


# ═══════════════════════════════════════════════════
# GÕ PROMPT VÀO Ô CHAT
# ═══════════════════════════════════════════════════
async def type_prompt_text(page, prompt_text: str) -> bool:
    """
    Gõ prompt text vào ô chat Gemini.
    Returns True nếu thành công.
    """
    for sel in PROMPT_INPUT_SELECTORS:
        try:
            el = page.locator(sel).first
            if await el.count() == 0:
                continue

            await el.click()
            await asyncio.sleep(0.3)

            # Clear nội dung cũ (nếu có)
            await el.press("Control+a")
            await asyncio.sleep(0.1)

            # Gõ prompt với tốc độ ngẫu nhiên (giống human)
            # Không gõ từng ký tự (chậm) — dùng fill() cho text thuần
            await el.fill(prompt_text)
            await asyncio.sleep(0.5)

            log(f"Đã gõ prompt ({len(prompt_text)} ký tự)", "✍️")
            return True
        except Exception as e:
            log(f"Thử selector '{sel}' lỗi: {str(e)[:80]}", "⚠️")
            continue

    log("❌ Không tìm thấy ô nhập prompt!", "❌")
    return False


# ═══════════════════════════════════════════════════
# UPLOAD FILE QUA FILE CHOOSER
# ═══════════════════════════════════════════════════
async def upload_file(page, file_path: str) -> bool:
    """
    Upload 1 file (ảnh/audio) vào Gemini qua nút đính kèm.
    Dùng Playwright file_chooser để tránh mở dialog thật.

    Flow:
    1. Bắt sự kiện filechooser
    2. Click nút upload
    3. Set file vào chooser
    4. Chờ preview file xuất hiện

    Returns True nếu upload thành công.
    """
    import os
    if not os.path.exists(file_path):
        log(f"❌ File không tồn tại: {file_path}", "❌")
        return False

    file_name = os.path.basename(file_path)
    log(f"Đang upload: {file_name}", "📎")

    # Thử từng selector nút upload
    for sel in UPLOAD_BTN_SELECTORS:
        try:
            btn = page.locator(sel).first
            if await btn.count() == 0:
                continue

            log(f"  Thử nút upload: {sel}", "🔍")

            # Playwright: bắt file chooser trước khi click
            async with page.expect_file_chooser(timeout=8000) as fc_info:
                await btn.click()
            file_chooser = await fc_info.value
            await file_chooser.set_files(file_path)

            # Chờ file được load vào chat (preview thumbnail xuất hiện)
            await asyncio.sleep(3)
            log(f"  ✅ Upload OK: {file_name}", "✅")
            return True

        except Exception as e:
            log(f"  Selector '{sel}' lỗi: {str(e)[:80]}", "⚠️")
            continue

    log(f"❌ Không upload được file {file_name} (thử hết các selector)", "❌")
    return False


# ═══════════════════════════════════════════════════
# BẤM NÚT GỬI (SEND)
# ═══════════════════════════════════════════════════
async def click_send(page) -> bool:
    """
    Bấm nút Send (hoặc nhấn Enter) để gửi message.
    Returns True nếu thành công.
    """
    # Thử nút Send bằng selector
    for sel in SEND_BTN_SELECTORS:
        try:
            btn = page.locator(sel).first
            if await btn.count() > 0:
                # Kiểm tra nút có enabled không
                is_disabled = await btn.is_disabled()
                if not is_disabled:
                    await btn.click()
                    log("Đã bấm nút Send", "📨")
                    return True
        except Exception:
            continue

    # Fallback: nhấn Enter trong ô chat
    for sel in PROMPT_INPUT_SELECTORS:
        try:
            el = page.locator(sel).first
            if await el.count() > 0:
                await el.press("Enter")
                log("Đã nhấn Enter để gửi", "📨")
                return True
        except Exception:
            continue

    log("❌ Không tìm được nút Send!", "❌")
    return False


# ═══════════════════════════════════════════════════
# CHỜ VÀ ĐỌC PHẢN HỒI GEMINI
# ═══════════════════════════════════════════════════
async def wait_and_read_response(page, timeout_sec=120) -> str | None:
    """
    Chờ Gemini sinh xong câu trả lời rồi đọc text.

    Cơ chế phát hiện "xong":
    - Gemini thường hiển thị spinner/loading khi đang sinh
    - Khi xong: spinner biến mất, text không thay đổi trong 2 giây liên tiếp

    Returns text phản hồi hoặc None nếu timeout.
    """
    log(f"Đang chờ Gemini phân tích (tối đa {timeout_sec}s)...", "⏳")

    # Selector spinner / loading của Gemini
    loading_selectors = [
        "model-response .loading",
        ".response-loading",
        "[aria-label*='loading']",
        ".pending",
        "model-response.in-progress",
        # Gemini dùng animation class
        ".loading-indicator",
        "mat-progress-bar",
    ]

    deadline = asyncio.get_event_loop().time() + timeout_sec
    last_text = ""
    stable_count = 0  # Số lần text không đổi liên tiếp

    while asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(2)

        # 1. Kiểm tra spinner còn không
        is_loading = False
        for sel in loading_selectors:
            try:
                el = page.locator(sel).first
                if await el.count() > 0:
                    visible = await el.is_visible()
                    if visible:
                        is_loading = True
                        break
            except Exception:
                pass

        # 2. Đọc text hiện tại
        current_text = await read_last_response(page)

        if not current_text:
            continue

        # 3. Text ổn định + không loading → xong!
        if current_text == last_text and not is_loading:
            stable_count += 1
            if stable_count >= 2:  # Ổn định 2 lần check (4 giây)
                log(f"✅ Gemini đã phản hồi ({len(current_text)} ký tự)", "✅")
                return current_text
        else:
            stable_count = 0
            last_text = current_text

    log(f"❌ Timeout {timeout_sec}s — Gemini chưa phản hồi xong", "❌")
    return None


async def read_last_response(page) -> str:
    """
    Đọc text từ câu trả lời cuối cùng của Gemini trên DOM.
    Thử nhiều selector theo thứ tự ưu tiên.
    """
    for sel in RESPONSE_SELECTORS:
        try:
            elements = page.locator(sel)
            count = await elements.count()
            if count > 0:
                # Lấy phần tử cuối cùng (câu trả lời mới nhất)
                last_el = elements.nth(count - 1)
                text = await last_el.inner_text()
                text = text.strip()
                if text and len(text) > 20:  # Bỏ qua text rỗng hoặc quá ngắn
                    return text
        except Exception:
            continue

    # Fallback: dùng JS để lấy toàn bộ text trong chat
    try:
        text = await page.evaluate("""() => {
            // Tìm tất cả model-response elements
            const responses = document.querySelectorAll('model-response, .model-response');
            if (responses.length === 0) return '';
            const last = responses[responses.length - 1];
            return last.innerText || last.textContent || '';
        }""")
        if text and len(text.strip()) > 20:
            return text.strip()
    except Exception:
        pass

    return ""


# ═══════════════════════════════════════════════════
# FUNCTION CHÍNH: UPLOAD FILE + HỎI + ĐỌC KẾT QUẢ
# ═══════════════════════════════════════════════════
async def upload_file_and_ask(
    page,
    file_path: str,
    prompt_text: str,
    timeout_sec: int = 120,
) -> dict:
    """
    Flow đầy đủ: upload file → gõ prompt → gửi → chờ → đọc kết quả.

    Returns dict:
    {
        "ok": True/False,
        "response_text": "...",   # Text Gemini trả về
        "error": "..."            # Lỗi nếu có
    }
    """
    import os
    file_name = os.path.basename(file_path)

    try:
        # 1. Tạo chat mới (context sạch cho mỗi file)
        await start_new_chat(page)
        await asyncio.sleep(1)

        # 2. Đảm bảo ô chat hiện hữu
        chat_ok = await ensure_in_chat(page, timeout=10)
        if not chat_ok:
            return {"ok": False, "response_text": "", "error": "Không tìm thấy ô chat Gemini"}

        # 3. Upload file
        upload_ok = await upload_file(page, file_path)
        if not upload_ok:
            # Thử gõ prompt không có file (fallback)
            log(f"⚠️ Upload thất bại, thử gõ prompt không file...", "⚠️")

        # 4. Gõ prompt
        typed = await type_prompt_text(page, prompt_text)
        if not typed:
            return {"ok": False, "response_text": "", "error": "Không gõ được prompt"}

        # 5. Gửi message
        await asyncio.sleep(0.5)
        sent = await click_send(page)
        if not sent:
            return {"ok": False, "response_text": "", "error": "Không gửi được message"}

        # 6. Chờ và đọc phản hồi
        response_text = await wait_and_read_response(page, timeout_sec=timeout_sec)
        if not response_text:
            return {"ok": False, "response_text": "", "error": f"Timeout {timeout_sec}s — không có phản hồi"}

        return {
            "ok": True,
            "response_text": response_text,
            "error": None,
        }

    except Exception as e:
        log(f"❌ Lỗi upload_file_and_ask [{file_name}]: {e}", "❌")
        return {"ok": False, "response_text": "", "error": str(e)}
