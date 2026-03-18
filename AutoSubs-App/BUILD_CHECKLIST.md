# 🔧 BUILD CHECKLIST — AutoSubs Media (macOS)

> Tài liệu ghi nhớ các lỗi đã gặp khi build app cho máy khác.
> **Mỗi lần build `.pkg` cho người dùng, đọc lại file này trước!**

---

## ✅ Checklist trước khi build

### 1. FFmpeg binary — Patch dylib paths

**Lỗi gặp:** App trên máy user báo `Library not loaded: /opt/homebrew/...` vì ffmpeg binary
vẫn trỏ tới đường dẫn Homebrew của máy dev.

**Quy tắc:**
- File `binaries/ffmpeg-aarch64-apple-darwin` phải được patch bằng `install_name_tool`
- Tất cả dylib phải trỏ tới `@executable_path/../Frameworks/` thay vì `/opt/homebrew/...`
- **KHÔNG được `codesign --remove-signature` trước khi patch** (sẽ hỏng `__LINKEDIT`)
- Chạy script: `./scripts/patch_ffmpeg_macos.sh`

**Kiểm tra:**
```bash
otool -L src-tauri/binaries/ffmpeg-aarch64-apple-darwin | grep homebrew
# Kết quả phải TRỐNG (không còn /opt/homebrew)
```

### 2. FFprobe — Phải bundle cùng app

**Lỗi gặp:** Frontend không tìm thấy `ffprobe` → footage scan hiện `0s / Unknown`,
audio convert .wav → .mp3 thất bại.

**Quy tắc:**
- File `binaries/ffprobe-aarch64-apple-darwin` phải tồn tại
- Phải patch dylib paths giống ffmpeg (bước 1)
- Phải có trong `tauri.conf.json` → `externalBin`:
  ```json
  "externalBin": [
    "binaries/ffmpeg",
    "binaries/ffprobe"
  ]
  ```

**Kiểm tra:**
```bash
ls src-tauri/binaries/ff*
# Phải thấy cả: ffmpeg-aarch64-apple-darwin VÀ ffprobe-aarch64-apple-darwin

otool -L src-tauri/binaries/ffprobe-aarch64-apple-darwin | grep homebrew
# Kết quả phải TRỐNG
```

### 3. Frontend ffmpeg path — Phải có đường dẫn bundled

**Lỗi gặp:** `src/utils/ffmpeg-path.ts` chỉ tìm Homebrew paths → máy user không có Homebrew
→ `command not found`.

**Quy tắc:**
- `FFMPEG_CANDIDATES` phải có: `/Applications/AutoSubs_Media.app/Contents/MacOS/ffmpeg`
- `FFPROBE_CANDIDATES` phải có: `/Applications/AutoSubs_Media.app/Contents/MacOS/ffprobe`
- Đường dẫn bundled phải đứng **ĐẦU TIÊN** trong danh sách (ưu tiên cao nhất)

### 4. VAD — Không feed audio quá dài vào 1 lần

**Lỗi gặp:** Audio 53 phút (3210s) → `segments_from_samples()` treo vô hạn trên máy mới.
Máy dev chạy được vì đã có cache/model compiled sẵn.

**Quy tắc:**
- VAD phải chia audio thành chunks (hiện tại: 5 phút / chunk)
- Mỗi chunk phải emit progress về frontend
- Code nằm trong `src-tauri/crates/transcription-engine/src/vad.rs`

### 5. Dylib frameworks — Phải đầy đủ

**Quy tắc:**
- Tất cả `.dylib` mà ffmpeg/ffprobe cần phải có trong `tauri.conf.json` → `frameworks`
- Kiểm tra bằng:
  ```bash
  otool -L src-tauri/binaries/ffmpeg-aarch64-apple-darwin
  # Mỗi lib @executable_path/../Frameworks/xxx.dylib phải tồn tại trong binaries/ffmpeg-dylibs/
  ```

---

## 📝 Quy trình build hoàn chỉnh

```bash
# 1. Kill tiến trình cũ
pkill -f "target/debug/autosubs" 2>/dev/null

# 2. Patch ffmpeg (nếu copy mới từ Homebrew)
./scripts/patch_ffmpeg_macos.sh

# 3. Verify
otool -L src-tauri/binaries/ffmpeg-aarch64-apple-darwin | grep homebrew  # phải trống
otool -L src-tauri/binaries/ffprobe-aarch64-apple-darwin | grep homebrew # phải trống

# 4. Build
npm run tauri build -- --target aarch64-apple-darwin

# 5. Verify app bundle
ls src-tauri/target/aarch64-apple-darwin/release/bundle/macos/AutoSubs_Media.app/Contents/MacOS/
# Phải thấy: autosubs, ffmpeg, ffprobe

# 6. Tạo .pkg
pkgbuild \
  --root src-tauri/target/aarch64-apple-darwin/release/bundle/macos/AutoSubs_Media.app \
  --install-location /Applications/AutoSubs_Media.app \
  --identifier com.autosubs-media \
  --version X.Y.Z \
  ~/Downloads/AutoSubs-Mac-ARM.X.Y.Z.pkg
```

---

## ⚠️ Lỗi thường gặp & cách tránh

| Lỗi | Nguyên nhân | Cách tránh |
|-----|------------|------------|
| `Library not loaded: /opt/homebrew/...` | ffmpeg chưa patch dylib | Chạy `patch_ffmpeg_macos.sh` |
| `__LINKEDIT segment` error | Strip signature trước khi patch | **KHÔNG** strip signature trước |
| `ffprobe: command not found` | Chưa bundle ffprobe | Thêm vào `externalBin` + patch |
| `durationSec: 0` trên máy user | Thiếu ffprobe | Bundle ffprobe |
| VAD treo với audio dài | Feed cả file vào 1 lần | Chia chunks 5 phút |
| Progress event x2 | Listener đăng ký 2 lần | Check unlisten() khi unmount |
| `install_name_tool` im lặng | File read-only | `chmod u+w` trước |

---

## 📅 Lịch sử lỗi

| Version | Ngày | Lỗi | Fix |
|---------|------|------|-----|
| 3.0.10 | 2026-03-16 | ffmpeg dylib trỏ Homebrew | Patch install_name_tool |
| 3.0.12 | 2026-03-17 | Không có log debug transcription | Thêm log chi tiết |
| 3.0.13 | 2026-03-17 | VAD treo 53 phút audio | Không đủ log |
| 3.0.14 | 2026-03-17 | VAD treo + thiếu ffprobe | Chunk VAD + bundle ffprobe |
| 3.0.15 | 2026-03-17 | Tổng hợp tất cả fix | Build ổn định |
