#!/bin/bash
# Script bundle FFmpeg + tất cả dylib dependencies vào Tauri app
set -e

FFMPEG_SRC="/opt/homebrew/bin/ffmpeg"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
BINARIES_DIR="$SCRIPT_DIR/../src-tauri/binaries"
FFMPEG_DST="$BINARIES_DIR/ffmpeg-aarch64-apple-darwin"
DYLIB_DIR="$BINARIES_DIR/ffmpeg-dylibs"

echo "🔧 Bundling FFmpeg + dylibs..."

# Xóa cũ
rm -f "$FFMPEG_DST"
rm -rf "$DYLIB_DIR"
mkdir -p "$DYLIB_DIR"

# Copy ffmpeg binary
cp "$FFMPEG_SRC" "$FFMPEG_DST"
chmod +x "$FFMPEG_DST"

# ===== PHASE 1: Copy tất cả dylibs (recursive) =====
echo "📦 Phase 1: Collecting all homebrew dylibs..."

collect_dylibs() {
    local binary="$1"
    otool -L "$binary" 2>/dev/null | grep "\.dylib" | grep "/opt/homebrew/" | awk '{print $1}' | while read lib; do
        local libname=$(basename "$lib")
        if [ ! -f "$DYLIB_DIR/$libname" ]; then
            echo "  → $libname"
            cp "$lib" "$DYLIB_DIR/$libname"
            chmod 755 "$DYLIB_DIR/$libname"
            # Recursive: tìm sub-dependencies
            collect_dylibs "$DYLIB_DIR/$libname"
        fi
    done
}

collect_dylibs "$FFMPEG_SRC"

# ===== PHASE 2: Relink tất cả =====
echo ""
echo "🔄 Phase 2: Relinking all references..."

# Relink ffmpeg binary
for lib in "$DYLIB_DIR"/*.dylib; do
    libname=$(basename "$lib")
    # Tìm original path trong otool output
    original=$(otool -L "$FFMPEG_DST" | grep "$libname" | awk '{print $1}' | head -1)
    if [ -n "$original" ]; then
        install_name_tool -change "$original" "@executable_path/../Frameworks/$libname" "$FFMPEG_DST" 2>/dev/null || true
    fi
done

# Relink mỗi dylib — đổi ID + sửa references tới dylib khác
for lib in "$DYLIB_DIR"/*.dylib; do
    libname=$(basename "$lib")
    # Đổi ID
    install_name_tool -id "@executable_path/../Frameworks/$libname" "$lib" 2>/dev/null || true
    
    # Sửa references tới homebrew
    otool -L "$lib" 2>/dev/null | grep "\.dylib" | grep "/opt/homebrew/" | awk '{print $1}' | while read ref; do
        refname=$(basename "$ref")
        install_name_tool -change "$ref" "@executable_path/../Frameworks/$refname" "$lib" 2>/dev/null || true
    done
done

# ===== PHASE 3: Ad-hoc sign =====
echo ""
echo "✍️ Phase 3: Signing..."
codesign --force --sign - "$FFMPEG_DST" 2>/dev/null
for lib in "$DYLIB_DIR"/*.dylib; do
    codesign --force --sign - "$lib" 2>/dev/null
done

# ===== VERIFY =====
echo ""
DYLIB_COUNT=$(ls "$DYLIB_DIR"/*.dylib 2>/dev/null | wc -l | tr -d ' ')
echo "✅ Done! FFmpeg + $DYLIB_COUNT dylibs bundled"

REMAINING=$(otool -L "$FFMPEG_DST" | grep "/opt/homebrew/" | wc -l | tr -d ' ')
if [ "$REMAINING" -gt 0 ]; then
    echo "❌ Còn $REMAINING references tới homebrew!"
    otool -L "$FFMPEG_DST" | grep "/opt/homebrew/"
else
    echo "✅ Clean! Không còn references tới homebrew"
fi

echo ""
echo "📁 Binary: $FFMPEG_DST"
echo "📁 Dylibs: $DYLIB_DIR/"
ls -lh "$DYLIB_DIR/"
