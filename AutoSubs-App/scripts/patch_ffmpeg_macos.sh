#!/usr/bin/env bash
# ============================================================
# patch_ffmpeg_macos.sh
# Mục đích: Sửa rpath của ffmpeg binary nguồn (binaries/)
#           để khi build app, ffmpeg tìm .dylib trong Frameworks
#           thay vì Homebrew.
#
# QUAN TRỌNG:
#   - KHÔNG strip signature trước (install_name_tool tự xử lý)
#   - Nếu strip trước → cấu trúc __LINKEDIT bị hỏng → patch fail
#   - Cần chmod u+w vì file copy từ Homebrew là read-only
#
# Cách dùng:
#   1. Copy ffmpeg mới: cp /opt/homebrew/bin/ffmpeg binaries/ffmpeg-aarch64-apple-darwin
#   2. Chạy: ./scripts/patch_ffmpeg_macos.sh
#   3. Build: cargo tauri build
# ============================================================
set -euo pipefail

FFMPEG="src-tauri/binaries/ffmpeg-aarch64-apple-darwin"

# --- Kiểm tra ---
if [[ ! -f "$FFMPEG" ]]; then
  echo "❌ Không tìm thấy: $FFMPEG"
  exit 1
fi
if [[ -L "$FFMPEG" ]]; then
  echo "❌ ffmpeg vẫn là symlink! Copy file thật trước:"
  echo "   cp /opt/homebrew/bin/ffmpeg $FFMPEG"
  exit 1
fi

echo "🔧 FFMPEG = $FFMPEG"
echo ""

# --- Bước 0: Thêm quyền write (file Homebrew là read-only) ---
echo "== [Bước 0] Chuẩn bị file =="
chmod u+w "$FFMPEG"
echo "  ✅ chmod u+w OK"
echo ""

# --- Danh sách patch: đường_dẫn_cũ|tên_dylib ---
# KHÔNG strip signature trước! install_name_tool tự invalidate.
PATCHES=(
  # FFmpeg core (từ Cellar)
  "/opt/homebrew/Cellar/ffmpeg/8.0.1_4/lib/libavdevice.62.dylib|libavdevice.62.dylib"
  "/opt/homebrew/Cellar/ffmpeg/8.0.1_4/lib/libavfilter.11.dylib|libavfilter.11.dylib"
  "/opt/homebrew/Cellar/ffmpeg/8.0.1_4/lib/libavformat.62.dylib|libavformat.62.dylib"
  "/opt/homebrew/Cellar/ffmpeg/8.0.1_4/lib/libavcodec.62.dylib|libavcodec.62.dylib"
  "/opt/homebrew/Cellar/ffmpeg/8.0.1_4/lib/libswresample.6.dylib|libswresample.6.dylib"
  "/opt/homebrew/Cellar/ffmpeg/8.0.1_4/lib/libswscale.9.dylib|libswscale.9.dylib"
  "/opt/homebrew/Cellar/ffmpeg/8.0.1_4/lib/libavutil.60.dylib|libavutil.60.dylib"

  # OpenSSL
  "/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib|libssl.3.dylib"
  "/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib|libcrypto.3.dylib"

  # Codec/lib phụ
  "/opt/homebrew/opt/libvpx/lib/libvpx.12.dylib|libvpx.12.dylib"
  "/opt/homebrew/opt/dav1d/lib/libdav1d.7.dylib|libdav1d.7.dylib"
  "/opt/homebrew/opt/lame/lib/libmp3lame.0.dylib|libmp3lame.0.dylib"
  "/opt/homebrew/opt/opus/lib/libopus.0.dylib|libopus.0.dylib"
  "/opt/homebrew/opt/svt-av1/lib/libSvtAv1Enc.4.dylib|libSvtAv1Enc.4.dylib"
  "/opt/homebrew/opt/x264/lib/libx264.165.dylib|libx264.165.dylib"
  "/opt/homebrew/opt/x265/lib/libx265.215.dylib|libx265.215.dylib"
)

# === Bước 1: Patch ===
echo "== [Bước 1] Patch ffmpeg dependencies =="
for entry in "${PATCHES[@]}"; do
  old="${entry%%|*}"
  lib="${entry##*|}"
  new="@executable_path/../Frameworks/$lib"
  echo "  ✏️  $lib"
  install_name_tool -change "$old" "$new" "$FFMPEG" 2>/dev/null || true
done
echo ""

# === Bước 2: Verify ===
echo "== [Bước 2] Verify =="
otool -L "$FFMPEG"
echo ""

if otool -L "$FFMPEG" | grep -q "/opt/homebrew"; then
  echo "⚠️  Vẫn còn đường dẫn /opt/homebrew:"
  otool -L "$FFMPEG" | grep "/opt/homebrew"
  exit 1
else
  echo "✅ Không còn đường dẫn Homebrew!"
fi
echo ""

# === Bước 3: Re-sign ===
echo "== [Bước 3] Re-sign =="
codesign --force --sign - --timestamp=none "$FFMPEG"
echo "  ✅ Đã ký lại ffmpeg"
echo ""

echo "🎉 PATCH HOÀN TẤT!"
echo ""
echo "Bước tiếp:"
echo "  cargo tauri build"
echo "  → Tauri sẽ bundle ffmpeg đã patch + dylibs vào app"
