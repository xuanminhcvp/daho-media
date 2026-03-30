"""
gemini_config.py — Cấu hình Gemini Browser Server
===================================================
Tập trung tất cả hằng số cấu hình vào 1 file duy nhất.
Khi cần đổi: chỉ sửa file này, không đụng vào code logic.
"""

import os

# ═══════════════════════════════════════════════════
# PORT SERVER
# ═══════════════════════════════════════════════════
# Port FastAPI server lắng nghe — khác với Flow server (5678)
# Frontend sẽ gọi http://localhost:5679/gemini/...
SERVER_PORT = 5679

# ═══════════════════════════════════════════════════
# URL GEMINI
# ═══════════════════════════════════════════════════
# Trang Gemini để mở Chrome
GEMINI_URL = "https://gemini.google.com"

# ═══════════════════════════════════════════════════
# CHROME PROFILE — GIỮ PHIÊN ĐĂNG NHẬP GOOGLE
# ═══════════════════════════════════════════════════
# Profile riêng cho Gemini Scan (tách khỏi profile Flow)
# Thư mục này lưu cookie/session → lần sau không cần đăng nhập lại
PROFILE_DIR = os.path.expanduser(
    "~/Library/Application Support/autosubs_gemini_profile"
)

# ═══════════════════════════════════════════════════
# TIMEOUT
# ═══════════════════════════════════════════════════
# Thời gian tối đa chờ Gemini phản hồi 1 file (giây)
# Gemini đôi khi chậm với file audio lớn
RESPONSE_TIMEOUT_SEC = 120

# Thời gian delay giữa 2 lần scan (giây) — tránh spam
DELAY_BETWEEN_SCANS_SEC = 2
