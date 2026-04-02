# 🔧 BUILD CHECKLIST — DahoMedia (macOS)

> Tài liệu ghi nhớ tất cả các bước khi build app cho user.
> **Mỗi lần build `.pkg`, đọc lại file này trước!**

---

## ✅ Checklist trước khi build

### 1. FFmpeg binary — Patch dylib paths

**Lỗi thường gặp:** App trên máy user báo `Library not loaded: /opt/homebrew/...` vì ffmpeg binary
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

### 1.5. FFmpeg Path trong TypeScript — PHẢI khớp tên app

**Lỗi thường gặp:** `ffmpeg: command not found` trên máy user vì `ffmpeg-path.ts` tham chiếu
tên app cũ (`AutoSubs_Media.app`) thay vì tên app hiện tại (`DahoMedia.app`).

**Quy tắc:**
- File `src/utils/ffmpeg-path.ts` → `FFMPEG_CANDIDATES` và `FFPROBE_CANDIDATES`
- Đường dẫn bundled phải trỏ đúng tên app: `/Applications/DahoMedia.app/Contents/MacOS/...`
- **Mỗi lần đổi tên app**, file này phải được cập nhật theo

**Kiểm tra:**
```bash
grep -n "Applications/" src/utils/ffmpeg-path.ts
# Phải thấy DahoMedia.app (tên app hiện tại)
# Nếu thấy tên app cũ (AutoSubs_Media.app) mà KHÔNG có DahoMedia.app → sai!
```

### 2. FFprobe — Phải bundle cùng app

**Quy tắc:**
- File `binaries/ffprobe-aarch64-apple-darwin` phải tồn tại
- Phải patch dylib paths giống ffmpeg (bước 1)
- Phải có trong `tauri.conf.json` → `externalBin`

**Kiểm tra:**
```bash
ls src-tauri/binaries/ff*
# Phải thấy cả: ffmpeg-aarch64-apple-darwin VÀ ffprobe-aarch64-apple-darwin
```

### 3. AutoSubs.lua — Đường dẫn phải là Production

**Lỗi thường gặp:** Script Lua vẫn để `DEV_MODE = true` → tìm app ở binary dev thay vì `/Applications/`

**Quy tắc:**
- Mở file `src-tauri/resources/AutoSubs.lua`
- Đảm bảo `DEV_MODE = false`
- Đảm bảo `app_executable = "/Applications/DahoMedia.app/Contents/MacOS/DahoMedia"`
- **KHÔNG có đường dẫn cứng** kiểu `/Users/may1/...` trong file

**Kiểm tra:**
```bash
grep -n "DEV_MODE\|/Users/" src-tauri/resources/AutoSubs.lua
# DEV_MODE phải = false
# Không được có /Users/may1 hay bất kỳ đường dẫn cứng nào
```

### 4. BugReporter + Annotation Mode — Phải ẩn trong production

**Quy tắc:**
- File `src/App.tsx` → BugReporterPanel được wrap bằng `import.meta.env.DEV`
- Khi build production → tự động bị loại bỏ
- Debug Panel trong `right-panel-tabs.tsx` cũng chỉ hiện khi DEV

**Kiểm tra sau build:**
```bash
# Tìm BugReporter trong output JS → phải không có hoặc bị tree-shake
grep -r "BugReporter" dist/assets/ | wc -l
# Kết quả nên = 0
```

### 4.5. Theme mặc định — Phải là LIGHT (sáng)

**Quy tắc:**
- File `src/App.tsx` → `<ThemeProvider defaultTheme="light" ...>`
- User lần đầu mở app sẽ thấy giao diện sáng (chuyên nghiệp hơn)
- User tự chuyển sang dark nếu muốn (lưu vào localStorage)

**Kiểm tra:**
```bash
grep 'defaultTheme' src/App.tsx
# Phải thấy: defaultTheme="light"
```

### 5. License System — Thống nhất BLAUTO

**Quy tắc:**
- Chỉ có **1 hệ thống license duy nhất**: `license-gate.tsx` trong `App.tsx`
- **KHÔNG** có license gate cũ trong `main.tsx` (đã xóa)
- Rust backend (`license.rs`): SECRET_KEY = `BlackAuto_2026_Internal_Team_Secret_DO_NOT_SHARE`
- Prefix key: `BLAUTO`
- Key format: `BLAUTO-{email_hex}-{device_fp_8}-{hmac_16}`
- Mỗi key **ràng buộc mã máy** (device fingerprint) — không dùng trên máy khác được

**Kiểm tra:**
```bash
# Đảm bảo không có license gate cũ trong main.tsx
grep -n "LicenseGate\|isLicenseActivated" src/main.tsx
# Kết quả phải TRỐNG

# Đảm bảo Rust dùng đúng SECRET_KEY
grep "SECRET_KEY" src-tauri/src/license.rs
# Phải thấy: BlackAuto_2026_Internal_Team_Secret_DO_NOT_SHARE
```

### 6. Profile Manager — Mật khẩu Admin riêng

**Quy tắc:**
- PasswordGate dùng mật khẩu cố định (không phải license key)
- Mật khẩu: `Daho@2026`
- User bình thường không vào được phần chỉnh sửa Prompt/Profile

### 7. Obfuscation + Xóa debug logs

**Đã cấu hình sẵn (tự động khi build production):**
- ✅ `vite.config.ts` → `vite-plugin-obfuscator`: mã hóa tên biến, string literals
- ✅ `vite.config.ts` → `esbuild.drop`: xóa sạch `console.log()` và `debugger`
- ✅ `debug-logger.ts` → `addDebugLog()` return sớm khi production

---

## 📝 Quy trình build PRODUCTION hoàn chỉnh

```bash
# 1. Kill tiến trình cũ (nếu đang chạy dev)
pkill -f "target/debug/autosubs" 2>/dev/null
pkill -f "target/release/autosubs" 2>/dev/null

# 2. Kiểm tra đường dẫn trong Lua script
grep -n "DEV_MODE\|/Users/" src-tauri/resources/AutoSubs.lua

# 3. Kiểm tra không còn license gate cũ trong main.tsx
grep -n "LicenseGate\|isLicenseActivated" src/main.tsx

# 4. Patch ffmpeg (nếu copy mới từ Homebrew)
./scripts/patch_ffmpeg_macos.sh

# 5. Verify ffmpeg
otool -L src-tauri/binaries/ffmpeg-aarch64-apple-darwin | grep homebrew   # phải trống
otool -L src-tauri/binaries/ffprobe-aarch64-apple-darwin | grep homebrew  # phải trống

# 6. Build production
npm run tauri build

# 7. Tạo file .pkg
pkgbuild \
  --component src-tauri/target/release/bundle/macos/DahoMedia.app \
  --install-location /Applications \
  src-tauri/target/release/bundle/macos/DahoMedia_X.Y.Z.pkg

# 8. Upload lên GitHub Release
gh release upload vX.Y.Z src-tauri/target/release/bundle/macos/DahoMedia_X.Y.Z.pkg --clobber
```

---

## 🔑 Cấp License Key cho user

**Quy trình:**
1. User mở app → thấy **Mã thiết bị** (8 ký tự hex) + nút Copy
2. User gửi **Mã thiết bị** + **Email** cho Admin
3. Admin chạy lệnh tạo key:

```bash
node -e "
const crypto = require('crypto');
const SECRET_KEY = 'BlackAuto_2026_Internal_Team_Secret_DO_NOT_SHARE';
const email = 'EMAIL_CUA_USER';
const deviceFp = 'MA_THIET_BI';
const hex = Buffer.from(email, 'utf8').toString('hex').toUpperCase();
const chunks = [];
for(let i=0; i<hex.length; i+=8) chunks.push(hex.slice(i, i+8));
const dataString = chunks.join('-') + '-' + deviceFp;
const sig = crypto.createHmac('sha256', SECRET_KEY).update(dataString).digest('hex').substring(0, 16).toUpperCase();
console.log('BLAUTO-' + dataString + '-' + sig);
"
```

4. Gửi key cho user → user dán vào app → Kích hoạt

**Lưu ý:**
- Mỗi key chỉ hoạt động trên đúng 1 máy (ràng buộc device fingerprint)
- Key mang sang máy khác → bị chặn
- Nếu user đổi máy → cần cấp key mới với mã máy mới

---

## 🧹 Xóa sạch app trên máy user (nếu cần cài lại)

```bash
# Xóa app
sudo rm -rf /Applications/DahoMedia.app

# Xóa dữ liệu hệ thống (License, config)
rm -rf ~/Library/Application\ Support/com.dahomedia.app
rm -rf ~/Library/Caches/com.dahomedia.app
rm -rf ~/Library/WebKit/com.dahomedia.app
rm -f ~/Library/Preferences/com.dahomedia.app.plist

# Xóa script DaVinci Resolve (nếu có)
rm -f ~/Library/Application\ Support/Blackmagic\ Design/DaVinci\ Resolve/Fusion/Scripts/Utility/AutoSubs.lua
rm -f ~/Library/Application\ Support/Blackmagic\ Design/DaVinci\ Resolve/Fusion/Scripts/Utility/AutoSubs.py

# (TÙY CHỌN) Xóa thư mục Media — CẢNH BÁO: mất hết ảnh/nhạc đã lưu
# rm -rf ~/Desktop/Auto_media
```

---

## ⚠️ Lỗi thường gặp & cách tránh

| Lỗi | Nguyên nhân | Cách tránh |
|-----|------------|------------|
| `Library not loaded: /opt/homebrew/...` | ffmpeg chưa patch dylib | Chạy `patch_ffmpeg_macos.sh` |
| `ffmpeg: command not found` trên máy user | `ffmpeg-path.ts` trỏ tên app cũ | Kiểm tra mục 1.5 — đường dẫn bundled phải khớp tên app hiện tại |
| Footage scan hiện "Chưa scan" dù đã scan | ffmpeg path sai → duration=0, extractFrames fail → metadata Error | Fix ffmpeg path (mục 1.5) xong scan lại |
| `__LINKEDIT segment` error | Strip signature trước khi patch | **KHÔNG** strip signature trước |
| BugReporter hiện trên màn hình user | Quên wrap `import.meta.env.DEV` | Kiểm tra `App.tsx` dòng BugReporterPanel |
| User phải nhập license 2 lần | Có 2 LicenseGate (main.tsx + App.tsx) | Xóa LicenseGate cũ trong `main.tsx` |
| Key không khớp máy | SECRET_KEY khác nhau giữa script và Rust | Đảm bảo cùng 1 SECRET_KEY |
| `DEV_MODE = true` trong Lua | Quên đổi sang production | Grep kiểm tra trước build |
| Đường dẫn cứng `/Users/may1/...` | Hardcode path máy dev | Dùng `os.getenv("HOME")` hoặc dynamic path |
| Profile Manager hỏi license lần 2 | PasswordGate dùng validateLicenseKey cũ | Dùng mật khẩu cứng `Daho@2026` |
| App mặc định dark mode | `defaultTheme="system"` hoặc `"dark"` | Đổi thành `defaultTheme="light"` trong App.tsx |

---

## 📅 Lịch sử build

| Version | Ngày | Thay đổi |
|---------|------|----------|
| 3.0.15 | 2026-04-02 | Fix lỗi Production văng TypeError 'text/html' ở AutoMedia pipeline bằng inlineDynamicImports, gỡ bỏ khai báo thừa getAudioScanApiKey cũ |
| 3.0.14 | 2026-04-02 | Sửa tab Manual Scan: dùng chung helper hasUsableAiMetadata thư viện đồng bộ Footage, sửa lỗi đè chưa scan và lọc |
| 3.0.13 | 2026-04-02 | Fix hoàn toàn bug liên quan đến quét thủ công Footage (sửa parse JSON RegExp, đổi key map thành fileName, dùng hasUsableAiMetadata, bỏ check fileHash) |
| 3.0.12 | 2026-04-02 | Tắt mặc định Nhạc Nền + SFX trong Auto Media |
| 3.0.11 | 2026-04-02 | Fix ffmpeg path mismatch (DahoMedia.app thay vì AutoSubs_Media.app), đổi theme mặc định sang light, cập nhật checklist |
| 3.0.10 | 2026-04-02 | Thống nhất License BLAUTO + device fingerprint, ẩn BugReporter production, sửa 2 cổng license, tách PasswordGate dùng mật khẩu admin riêng |
