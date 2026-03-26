#!/usr/bin/env python3
"""
generate_license_key.py
============================================================
Script tạo License Key cho AutoSubs Media (dành cho Admin)
Không cần server, không cần internet

Cách dùng:
    python3 generate_license_key.py <tên_người_dùng>
    python3 generate_license_key.py "Nguyen Van A"
    python3 generate_license_key.py team_editor_01

Ví dụ output:
    ✅ License Key cho "Nguyen Van A":
    ASUBS-4E47-5545-4E56-414E41-8A3B2C1D4E5F6A7B
============================================================
"""

import hmac
import hashlib
import sys
import os

# ⚠️ QUAN TRỌNG: Secret key phải GIỐNG HỆT với key trong license.rs
# Nếu đổi ở đây → phải đổi ở license.rs và build lại app
SECRET_KEY = b"AutoSubs_Media_2026_Internal_Team_Secret_Key_DO_NOT_SHARE"

# Prefix cho license key
KEY_PREFIX = "ASUBS"


def generate_key(identifier: str) -> str:
    """
    Tạo license key từ identifier (tên/email/mã nhận dạng)
    
    Flow:
    1. Chuyển identifier thành HEX (để nhúng vào key)
    2. Tính HMAC-SHA256 của phần HEX
    3. Lấy 8 bytes đầu làm signature
    4. Ghép lại: ASUBS-{hex_chunks}-{signature}
    """
    # Bước 1: Chuyển identifier thành hex
    identifier_hex = identifier.encode('utf-8').hex().upper()
    
    # Chia hex thành chunks 4 ký tự (dễ đọc)
    hex_chunks = [identifier_hex[i:i+4] for i in range(0, len(identifier_hex), 4)]
    data_part = "-".join(hex_chunks)
    
    # Bước 2: Tính HMAC-SHA256
    h = hmac.new(SECRET_KEY, data_part.encode('utf-8'), hashlib.sha256)
    signature = h.hexdigest()[:16].upper()  # Lấy 8 bytes = 16 hex chars
    
    # Bước 3: Ghép thành key hoàn chỉnh
    license_key = f"{KEY_PREFIX}-{data_part}-{signature}"
    
    return license_key


def main():
    if len(sys.argv) < 2:
        print("❌ Thiếu tham số!")
        print(f"   Cách dùng: python3 {os.path.basename(__file__)} <tên_người_dùng>")
        print(f"   Ví dụ:     python3 {os.path.basename(__file__)} \"Nguyen Van A\"")
        print(f"   Ví dụ:     python3 {os.path.basename(__file__)} team_editor_01")
        sys.exit(1)
    
    identifier = " ".join(sys.argv[1:])
    
    # Tạo key
    key = generate_key(identifier)
    
    print()
    print(f"  ✅ License Key cho \"{identifier}\":")
    print(f"  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"  {key}")
    print(f"  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print()
    print(f"  📋 Gửi key này cho người dùng.")
    print(f"  📌 Key chỉ hoạt động với app AutoSubs Media.")
    print()


if __name__ == "__main__":
    main()
