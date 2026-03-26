# 🚀 Entry Scripts — Cách Lấy Resolve Object

> **Đây là phần QUAN TRỌNG NHẤT và KHÁC BIỆT NHẤT** so với các app khác.
> DaVinci Resolve có cách inject script object rất đặc biệt — sai 1 bước = không chạy.

---

## 1. Lua Entry (`AutoSubs.lua`)

### Vị trí file
```
~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/AutoSubs.lua
```
→ Xuất hiện trong menu: **Workspace > Scripts > AutoSubs**

### Flow lấy Resolve object (5 cách, thử theo thứ tự)

```lua
-- Cách 1: Resolve() function (DaVinci Free inject sẵn global function)
if Resolve then
    local ok, r = pcall(Resolve)
    if ok and r then resolve_obj = r end
end

-- Cách 2: global 'resolve' variable (DaVinci Studio inject sẵn)
if not resolve_obj and resolve then
    resolve_obj = resolve
end

-- Cách 3: fusion:GetResolve() (khi chạy trong Fusion context)
if not resolve_obj and fusion then
    local ok, r = pcall(function() return fusion:GetResolve() end)
    if ok and r then resolve_obj = r end
end

-- Cách 4: fu:GetResolve() (alias của fusion trong một số version)
if not resolve_obj and fu then
    local ok, r = pcall(function() return fu:GetResolve() end)
    if ok and r then resolve_obj = r end
end

-- Cách 5: bmd.scriptapp("Resolve") (fallback cuối cùng)
if not resolve_obj and bmd and bmd.scriptapp then
    local ok, r = pcall(bmd.scriptapp, "Resolve")
    if ok and r then resolve_obj = r end
end
```

### DEV_MODE — Path override

```lua
local DEV_MODE = true  -- ← Set false khi build production

if DEV_MODE then
    -- Dev: chỉ thẳng vào source code folder
    resources_folder = os.getenv("HOME")
        .. "/Documents/src_code/autosubs_documentary/AutoSubs-App/src-tauri/resources"
else
    -- Production: bundle trong .app
    resources_folder = app_executable .. "/Contents/Resources/resources"
end
```

### Clear module cache (QUAN TRỌNG)

```lua
-- Phải clear cached modules để luôn load code mới nhất khi dev
-- Nếu không clear → DaVinci dùng code cũ đã cache!
package.loaded["helpers"] = nil
package.loaded["init"] = nil
package.loaded["server"] = nil
package.loaded["media_import"] = nil
-- ... (tất cả modules)
```

### Khởi động cuối cùng

```lua
local AutoSubs = require("init")
AutoSubs:Init(app_executable, resources_folder, DEV_MODE, resolve_obj)
-- → init.lua setup state → start HTTP server
```

---

## 2. Python Entry (`AutoSubs.py`)

### Vị trí file
```
~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/AutoSubs.py
```

### PHÁT HIỆN QUAN TRỌNG

```
DaVinci chạy .py script trong Fusion context!
→ bmd.getappname() = "FusionScript"
→ bmd.scriptapp("Resolve") trả về None!
→ PHẢI: bmd.scriptapp("Fusion") → fusion.GetResolve() → resolve
```

### Flow lấy Resolve object (3 cách)

```python
bmd_module = globals().get("bmd")

# Cách A: scriptapp("Resolve") — chỉ hoạt động với DaVinci Studio
resolve_obj = bmd_module.scriptapp("Resolve")

# Cách B: scriptapp("Fusion") → GetResolve() — CÁCH ĐÚNG cho free/standard
if not resolve_obj:
    fusion = bmd_module.scriptapp("Fusion")
    resolve_obj = fusion.GetResolve()

# Cách C: scriptapp("FusionScript") — fallback
if not resolve_obj:
    fusion = bmd_module.scriptapp("FusionScript")
    resolve_obj = fusion.GetResolve()
```

---

## 3. init.lua — Setup State & Start Server

### Resolve objects chain

```lua
-- Từ resolve_obj, chain lấy các object cần thiết:
state.resolve        = resolve_obj
state.projectManager = resolve_obj:GetProjectManager()
state.project        = projectManager:GetCurrentProject()
state.mediaPool      = project:GetMediaPool()

-- Log project name để verify kết nối
print("Connected to Resolve project: " .. project:GetName())
```

### External libraries

```lua
-- 3 thư viện bắt buộc (nằm trong resources/modules/)
state.socket    = require("ljsocket")  -- TCP socket cho HTTP server
state.json      = require("dkjson")    -- JSON encode/decode
state.luaresolve = require("libavutil") -- Timecode conversion
```

### Start server

```lua
server.StartServer(
    state, helpers,
    timeline_info, audio_export, subtitle_renderer,
    template_manager, media_import, preview_generator,
    motion_effects
)
-- → Lắng nghe port 56003, loop xử lý request
```

---

## 4. Debugging Entry Script

### Log file
```
~/Desktop/autosubs_resolve.log
```
Mỗi lần chạy script, log ghi lại TỪNG BƯỚC:
- `[Step 1]` OS detection
- `[Step 2]` Resources path
- `[Step 3]` Module path setup
- `[Step 4]` Resolve object acquisition
- `[Step 5]` Init module load
- `[Step 6]` Server start

### Lệnh kiểm tra nhanh

```bash
# Xem log real-time
tail -f ~/Desktop/autosubs_resolve.log

# Kiểm tra script đã copy đúng vị trí chưa
ls -la ~/Library/Application\ Support/Blackmagic\ Design/DaVinci\ Resolve/Fusion/Scripts/Utility/

# Kiểm tra server đang chạy
curl -s -X POST http://localhost:56003/ -H "Content-Type: application/json" -d '{"func":"Ping"}'
# → {"message":"Pong"}
```

---

## 5. Lỗi Thường Gặp & Cách Fix

| Lỗi | Nguyên nhân | Fix |
|-----|-------------|-----|
| "Cannot obtain Resolve object" | Script chạy ngoài DaVinci context | Chạy từ Workspace > Scripts |
| Server không khởi động | Port 56003 bị chiếm bởi server cũ | Script tự gửi Exit rồi retry |
| Module code cũ | Cache module Lua | Set `DEV_MODE = true` + clear `package.loaded` |
| Python trả None | Dùng `scriptapp("Resolve")` thay vì Fusion chain | Dùng cách B: Fusion → GetResolve() |
| Log file rỗng | Script crash trước khi init log | Kiểm tra DaVinci Console output |
