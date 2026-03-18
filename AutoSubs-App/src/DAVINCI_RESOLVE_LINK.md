# 🔗 Hướng dẫn kết nối AutoSubs ↔ DaVinci Resolve

> Tài liệu này giải thích chi tiết cách 2 bên (AutoSubs App + DaVinci Resolve) giao tiếp với nhau,
> file nào nằm ở đâu, và cách khắc phục khi mất kết nối.

---

## 📐 Kiến trúc tổng quan

```
┌─────────────────────────┐         HTTP (port 56003)        ┌──────────────────────────┐
│     AutoSubs App        │ ◄──────────────────────────────► │    DaVinci Resolve       │
│     (Tauri + React)     │     JSON request/response        │    (Lua HTTP Server)     │
│                         │                                  │                          │
│  src/api/resolve-api.ts │ ───► POST http://127.0.0.1:56003 │  modules/server.lua      │
│                         │ ◄─── JSON response               │  (lắng nghe port 56003)  │
└─────────────────────────┘                                  └──────────────────────────┘
```

### Luồng hoạt động:

1. **User mở DaVinci Resolve** → mở Console → paste mã Lua → nhấn Ctrl+Enter
2. **Lua script** (`AutoSubs.lua`) chạy bên trong DaVinci → lấy object `resolve` → khởi động HTTP server trên **port 56003**
3. **AutoSubs App** (Tauri) gửi HTTP POST đến `127.0.0.1:56003` với JSON body `{ "func": "GetTimelineInfo" }`
4. **Lua server** nhận request → gọi DaVinci Resolve API → trả JSON response
5. App hiển thị kết quả (timeline info, tracks, templates...)

**Quan trọng:** Lua server chạy **bên trong process của DaVinci Resolve**, nên nó có toàn quyền truy cập Resolve API. AutoSubs App chỉ là client gửi lệnh qua HTTP.

---

## 📁 Cấu trúc file — Bên nào cần gì

### 1. Phía DaVinci Resolve (Lua scripts)

```
AutoSubs-App/src-tauri/resources/
├── AutoSubs.lua              ← ⭐ ENTRY SCRIPT (load từ Console hoặc Script Menu)
│                                Nhiệm vụ: lấy `resolve` object → gọi init.lua
│
├── modules/                  ← Thư mục chứa tất cả module Lua
│   ├── init.lua              ← Trung tâm: require modules, tạo shared state, start server
│   ├── helpers.lua           ← Hàm tiện ích: join_path, sleep, hexToRgb, safe_json...
│   ├── server.lua            ← HTTP server + router (18+ endpoints)
│   ├── timeline_info.lua     ← Thông tin timeline, tracks, seek, jump
│   ├── template_manager.lua  ← Quản lý Fusion Title templates
│   ├── audio_export.lua      ← Export audio, progress tracking, cancel
│   ├── subtitle_renderer.lua ← Thêm phụ đề lên timeline (3 kiểu)
│   ├── media_import.lua      ← Import video/audio/SFX vào timeline
│   ├── preview_generator.lua ← Tạo preview subtitle, extract frame
│   │
│   ├── ljsocket.lua          ← [Thư viện] TCP socket cho Lua (HTTP server)
│   ├── dkjson.lua            ← [Thư viện] JSON encode/decode
│   ├── libavutil.lua         ← [Thư viện] Timecode ↔ Frame conversion
│   └── animate.lua           ← [Thư viện] Animation utilities
│
└── AutoSubs/                 ← Assets (subtitle-template.drb, fonts...)
```

**File DaVinci cần tìm thấy:**
- `AutoSubs.lua` — script chính
- `modules/*.lua` — tất cả module con

**Cách DaVinci tìm modules:** `AutoSubs.lua` set `package.path` trỏ đến thư mục `modules/`:
```lua
package.path = modules_path .. "/?.lua;" .. package.path
```

### 2. Phía AutoSubs App (TypeScript)

```
AutoSubs-App/src/
├── api/
│   └── resolve-api.ts        ← ⭐ Gửi HTTP request đến Lua server
│                                Các hàm: getTimelineInfo(), exportAudio(), 
│                                addSubtitlesToTimeline(), addMediaToTimeline()...
│
├── contexts/
│   └── ResolveContext.tsx     ← React context quản lý state kết nối Resolve
│
├── components/layout/
│   └── davinci-console-panel.tsx  ← Nút "Copy mã kết nối" trong UI
```

---

## 🔌 Chi tiết giao thức kết nối

### Port: `56003` (hardcoded cả 2 bên)

- **Lua side:** `init.lua` → `state.PORT = 56003`
- **TypeScript side:** `resolve-api.ts` → `http://127.0.0.1:56003`

### Format request (App → Lua):

```http
POST / HTTP/1.1
Host: 127.0.0.1:56003
Content-Type: application/json

{"func": "GetTimelineInfo"}
```

### Format response (Lua → App):

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"name":"My Timeline","timelineId":"abc123","templates":[...],"inputTracks":[...]}
```

### Danh sách endpoints (func):

| func                   | Mô tả                                    | Module xử lý          |
|------------------------|-------------------------------------------|------------------------|
| `Ping`                 | Kiểm tra server còn sống                  | server.lua             |
| `Exit`                 | Tắt server                                | server.lua             |
| `GetTimelineInfo`      | Lấy thông tin timeline + tracks           | timeline_info.lua      |
| `JumpToTime`           | Di chuyển playhead                        | timeline_info.lua      |
| `SeekToTime`           | Seek preview                              | timeline_info.lua      |
| `GetTrackClipNumbers`  | Quét track lấy số clip                    | timeline_info.lua      |
| `ExportAudio`          | Export audio từ track                     | audio_export.lua       |
| `GetExportProgress`    | Kiểm tra tiến độ export                   | audio_export.lua       |
| `CancelExport`         | Hủy export                                | audio_export.lua       |
| `AddSubtitles`         | Thêm phụ đề chính                         | subtitle_renderer.lua  |
| `AddSimpleSubtitles`   | Thêm phụ đề stories                       | subtitle_renderer.lua  |
| `AddTemplateSubtitles` | Thêm phụ đề nhiều template                | subtitle_renderer.lua  |
| `CheckTrackConflicts`  | Kiểm tra xung đột track                   | subtitle_renderer.lua  |
| `GeneratePreview`      | Tạo preview phụ đề                        | preview_generator.lua  |
| `CreateTemplateSet`    | Tạo bộ template                           | template_manager.lua   |
| `AddMediaToTimeline`   | Import video/ảnh vào timeline             | media_import.lua       |
| `AddAudioToTimeline`   | Import audio (BGM) vào timeline           | media_import.lua       |
| `AddSfxClipsToTimeline`| Import SFX clips vào timeline             | media_import.lua       |

---

## 🚀 Cách kết nối (3 cách)

### Cách 1: Copy mã từ App (Khuyên dùng — nhanh nhất)

1. Mở **AutoSubs App** → chuyển sang tab **Timeline** (logo DaVinci)
2. Bấm nút **"Copy mã kết nối DaVinci"** (viền vàng)
3. Mở **DaVinci Resolve** → **Workspace → Console**
4. Chọn tab **Lua** (⚠️ KHÔNG phải Python!)
5. Paste mã → nhấn **Ctrl+Enter** (hoặc Cmd+Enter trên Mac)
6. Thấy `"AutoSubs server is listening on port: 56003"` → ✅ thành công

### Cách 2: Script Menu (chỉ hoạt động khi file đã copy vào Utility/)

1. Copy `AutoSubs.lua` vào:
   ```
   ~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/AutoSubs.lua
   ```
2. DaVinci → **Workspace → Scripts → AutoSubs**
3. Thấy `"listening on port 56003"` → ✅ thành công

### Cách 3: dofile() thủ công trong Console

Paste trực tiếp vào Console (tab Lua):
```lua
dofile("/Users/may1/Desktop/auto/auto-subs-main/AutoSubs-App/src-tauri/resources/AutoSubs.lua")
```

---

## 🔧 Khắc phục sự cố

### ❌ "Link to Resolve is offline" trong App

**Nguyên nhân:** Lua server chưa chạy hoặc đã tắt.

**Cách fix:**
1. Kiểm tra DaVinci Resolve có đang mở không
2. Paste lại mã Lua vào Console → Ctrl+Enter
3. Đảm bảo chọn tab **Lua** (không phải Python)

### ❌ Console báo lỗi "cannot open ... .lua: No such file"

**Nguyên nhân:** `package.path` không tìm thấy thư mục `modules/`.

**Cách fix:**
1. Kiểm tra thư mục tồn tại:
   ```bash
   ls ~/Desktop/auto/auto-subs-main/AutoSubs-App/src-tauri/resources/modules/
   ```
2. Phải có ít nhất: `init.lua`, `helpers.lua`, `server.lua`, `ljsocket.lua`, `dkjson.lua`
3. Nếu thiếu file → copy lại từ `_lua_archive/modules/`:
   ```bash
   cp _lua_archive/modules/ljsocket.lua modules/
   cp _lua_archive/modules/dkjson.lua modules/
   cp _lua_archive/modules/libavutil.lua modules/
   ```

### ❌ "Address already in use" (port 56003 bận)

**Nguyên nhân:** Server cũ chưa tắt.

**Cách fix — Tự động:** Script mới sẽ gửi lệnh `Exit` cho server cũ rồi bind lại.

**Cách fix — Thủ công:**
```bash
# Kiểm tra ai đang dùng port 56003
lsof -i :56003

# Kill process
kill -9 <PID>
```

### ❌ DaVinci Free không chạy Python scripts

**Lý do chọn Lua:** DaVinci Resolve Free trên macOS **chặn Python** khi gọi từ Script Menu
(`bmd.scriptapp('Resolve')` trả `None`). Lua **không bị chặn** — `resolve` object luôn có sẵn.

**Đừng chuyển sang Python** trừ khi dùng DaVinci Resolve **Studio** (bản trả tiền).

### ❌ Console không có tab "Lua"

DaVinci Resolve 18+ đều có tab Lua. Nếu không thấy:
1. **Workspace → Console** (hoặc tổ hợp phím mở Console)
2. Nhìn phía dưới cửa sổ Console — có 2 tab: **Py3** và **Lua**
3. Click vào tab **Lua**

---

## 📝 Lưu ý khi phát triển (Dev Mode)

### Hot reload Lua code:

Mã Lua (`modules/*.lua`) **không cần restart DaVinci**. Chỉ cần:
1. Sửa file `.lua` trong VSCode
2. Paste lại mã vào Console → Ctrl+Enter (sẽ clear cache + reload tất cả modules)

Script đã clear cache tự động:
```lua
package.loaded["init"] = nil
package.loaded["helpers"] = nil
-- ... (tất cả modules)
```

### DEV_MODE flag:

Trong `AutoSubs.lua` dòng 8:
```lua
local DEV_MODE = true
```
- `true`: Load resources từ source code (`~/Desktop/auto/auto-subs-main/...`)
- `false`: Load từ app bundle (`/Applications/AutoSubs.app/Contents/Resources/...`)

### Log file:

Mọi log ghi ra: `~/Desktop/autosubs_resolve.log`
```bash
tail -f ~/Desktop/autosubs_resolve.log
```

---

## 🗂️ Tóm tắt nhanh

| Thành phần | Vị trí | Vai trò |
|---|---|---|
| Entry script | `resources/AutoSubs.lua` | Lấy `resolve` → gọi `init.lua` |
| Modules | `resources/modules/*.lua` | Logic xử lý (9 module + 4 thư viện) |
| DaVinci Utility | `~/Library/.../Scripts/Utility/AutoSubs.lua` | Copy của entry script (cho Script Menu) |
| API client | `src/api/resolve-api.ts` | App gửi HTTP request |
| UI nút copy | `src/components/layout/davinci-console-panel.tsx` | Nút copy mã kết nối |
| Port | `56003` | Cố định, hardcoded cả 2 bên |
| Giao thức | HTTP POST + JSON | Request/Response |
| Log | `~/Desktop/autosubs_resolve.log` | Debug file |
