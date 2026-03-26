# 🏗️ Kiến Trúc Tổng Quan — AutoSubs ↔ DaVinci Resolve

> **Mục đích:** Ghi lại TOÀN BỘ cách AutoSubs kết nối và điều khiển DaVinci Resolve.
> Tài liệu này là "sổ tay cứu nguy" khi gặp bug liên quan đến DaVinci.

---

## 1. Kiến Trúc Hệ Thống

```
┌────────────────────────────┐     HTTP POST (JSON)     ┌──────────────────────────┐
│   Tauri Desktop App        │ ◄──────────────────────► │   Lua HTTP Server        │
│   (React + TypeScript)     │     Port 56003            │   (Chạy TRONG DaVinci)   │
│                            │                           │                          │
│ ┌────────────────────────┐ │                           │ ┌──────────────────────┐ │
│ │ resolve-api.ts         │ │ ── fetch() ──────────────►│ │ server.lua (router)  │ │
│ │ (API client)           │ │                           │ │                      │ │
│ └────────────────────────┘ │                           │ │ ┌──────────────────┐ │ │
│                            │                           │ │ │ media_import.lua │ │ │
│ ┌────────────────────────┐ │                           │ │ │ subtitle_render  │ │ │
│ │ ResolveContext.tsx     │ │                           │ │ │ timeline_info    │ │ │
│ │ (React Context/Hook)   │ │                           │ │ │ template_mgr     │ │ │
│ └────────────────────────┘ │                           │ │ │ audio_export     │ │ │
│                            │                           │ │ │ motion_effects   │ │ │
│ ┌────────────────────────┐ │                           │ │ │ preview_gen      │ │ │
│ │ auto-media-service.ts  │ │                           │ │ │ helpers.lua      │ │ │
│ │ (Pipeline logic)       │ │                           │ │ └──────────────────┘ │ │
│ └────────────────────────┘ │                           │ └──────────────────────┘ │
└────────────────────────────┘                           └──────────────────────────┘
```

## 2. Flow Kết Nối

### 2.1. User Mở DaVinci Resolve

1. **Mở dự án** trong DaVinci Resolve
2. **Chạy script:** `Workspace > Scripts > AutoSubs`
3. Script entry point: `AutoSubs.lua` (hoặc `AutoSubs.py`)
4. Script khởi tạo **Lua HTTP Server** trên `127.0.0.1:56003`
5. Server lắng nghe request từ Tauri app

### 2.2. Tauri App Kết Nối

1. `ResolveContext.tsx` gọi `getTimelineInfo()` khi mount
2. `resolve-api.ts` gửi `POST { func: "GetTimelineInfo" }` → port 56003
3. Nếu thành công → app biết timeline đang mở, lấy track list, template list
4. Nếu fail → app hiển thị offline, user cần chạy lại script

### 2.3. Ping Keep-Alive

```typescript
// resolve-api.ts
pingResolve() → POST { func: "Ping" }
// Server trả: { message: "Pong" }
// Timeout 3 giây → trả false nếu offline
```

## 3. Files Quan Trọng

### Frontend (TypeScript)

| File | Chức năng |
|------|-----------|
| `src/api/resolve-api.ts` | **API client** — 15+ hàm HTTP call tới Lua server |
| `src/contexts/ResolveContext.tsx` | **React Context** — share timeline info + export logic |
| `src/services/auto-media-service.ts` | **Pipeline** — orchestrate import media theo bước |
| `src/types/auto-media-types.ts` | **Track layout** — TRACK_LAYOUT (7V+5A) cố định |

### Backend (Lua — chạy TRONG DaVinci)

| File | Chức năng |
|------|-----------|
| `resources/AutoSubs.lua` | **Entry script** — lấy Resolve object, load modules |
| `resources/modules/init.lua` | **Init** — setup state, require modules, start server |
| `resources/modules/server.lua` | **HTTP server + Router** — xử lý request JSON |
| `resources/modules/media_import.lua` | **Import media** — video, audio, SFX, ref images |
| `resources/modules/subtitle_renderer.lua` | **Subtitle** — thêm text, template subtitles |
| `resources/modules/timeline_info.lua` | **Timeline** — track info, seek, scan clips |
| `resources/modules/template_manager.lua` | **Template** — tìm, import, tạo template set |
| `resources/modules/helpers.lua` | **Utils** — join_path, sleep, hexToRgb, safe_json |
| `resources/modules/audio_export.lua` | **Audio export** — xuất audio từ timeline |
| `resources/modules/motion_effects.lua` | **Motion** — hiệu ứng chuyển động |
| `resources/modules/preview_generator.lua` | **Preview** — render preview subtitle |

### Entry Script (Python — backup)

| File | Chức năng |
|------|-----------|
| `resources/AutoSubs.py` | **Python entry** — lấy Resolve object qua `bmd` module |

## 4. Cổng & Protocol

- **Port:** `56003` (hardcoded trong `init.lua` dòng 29 + `resolve-api.ts` dòng 7)
- **Protocol:** HTTP/1.1 POST, Content-Type: application/json
- **Server:** Non-blocking socket (ljsocket), single-threaded loop
- **Timeout:** Tùy function: 3s (Ping), 60s (SFX), 120s (Media/RefImages)

## 5. Shared State (Lua)

```lua
-- init.lua — state object chia sẻ cho TẤT CẢ module
state = {
    resolve       = resolve_obj,          -- Resolve API object
    projectManager = resolve:GetProjectManager(),
    project       = projectManager:GetCurrentProject(),
    mediaPool     = project:GetMediaPool(),
    
    PORT          = 56003,
    DEV_MODE      = true,
    resources_path = "...",
    assets_path    = ".../AutoSubs",
    
    socket        = require("ljsocket"),  -- TCP socket library
    json          = require("dkjson"),    -- JSON encoder/decoder
    luaresolve    = require("libavutil"), -- Timecode converter
}
```

## 6. Lưu Ý Quan Trọng

### ⚠️ DaVinci API Gotchas

1. **AppendToTimeline** là hàm DUY NHẤT để đặt clip lên timeline theo vị trí chính xác
   - Cần: `mediaPoolItem`, `recordFrame` (frame chính xác trên timeline)
   - `mediaType`: 1 = video, 2 = audio
   
2. **Track index** bắt đầu từ **1** (Lua 1-based)
   - Frontend gửi string "1", "2"... Lua convert bằng `tonumber()`

3. **Frame rate** ảnh hưởng TOÀN BỘ tính toán
   - Luôn lấy từ `timeline:GetSetting("timelineFrameRate")`
   - `recordFrame = timelineStart + floor(seconds * frameRate)`

4. **ImportMedia** có thể fail âm thầm
   - Trả về `nil` hoặc table rỗng
   - Phải kiểm tra kết quả kỹ lưỡng

5. **Fusion Comp** rất nặng RAM
   - Batch 15 clips + sleep 1.5s giữa batches
   - Tránh tạo > 50 Fusion comps liên tiếp

6. **Track locked/disabled** → AppendToTimeline fail âm thầm
   - Luôn check + unlock/enable trước khi append
`,
<parameter name="Description">Tài liệu kiến trúc tổng quan AutoSubs ↔ DaVinci Resolve integration
