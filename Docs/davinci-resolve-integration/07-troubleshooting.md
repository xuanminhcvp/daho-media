# 🐛 Troubleshooting — Lỗi Thường Gặp & Cách Fix

> **Sổ tay cứu nguy** khi gặp bug liên quan DaVinci Resolve.
> Mỗi lỗi đều kèm nguyên nhân gốc + giải pháp đã verify.

---

## 1. Kết Nối

### ❌ "Link to Resolve is offline"
**Triệu chứng:** App không thấy timeline, không import được  
**Nguyên nhân:**
- Lua server chưa chạy
- Port 56003 bị chiếm bởi instance cũ
- DaVinci chưa mở script

**Fix:**
```bash
# Kiểm tra port
lsof -i :56003

# Nếu bị chiếm → kill process
kill -9 $(lsof -ti :56003)

# Chạy lại script trong DaVinci: Workspace > Scripts > AutoSubs
```

### ❌ "Cannot obtain Resolve object"
**Triệu chứng:** Script crash ngay khi chạy  
**Nguyên nhân:** Chạy script ngoài DaVinci context  
**Fix:** Phải chạy từ **Workspace > Scripts menu** bên trong DaVinci

### ❌ Server cũ vẫn chạy (port busy)
**Nguyên nhân:** DaVinci không kill Lua process khi đóng script  
**Fix tự động (đã có trong code):**
```lua
-- server.lua tự gửi Exit cho server cũ rồi bind lại
local success, err = pcall(function() assert(server:bind(info)) end)
if not success then
    send_exit_via_socket(state)   -- Gửi Exit cho server cũ
    helpers.sleep(0.5)
    assert(server:bind(info))     -- Bind lại
end
```

---

## 2. Media Import

### ❌ "Failed to import media files" (ImportMedia trả nil)
**Nguyên nhân:**
- File path sai (chứa ký tự Unicode)
- File đang bị lock bởi process khác
- DaVinci không hỗ trợ format file

**Fix:**
- Kiểm tra file path bằng `ls "filepath"`
- Đóng tất cả app khác đang dùng file
- Convert sang MP4/MOV chuẩn

### ❌ AppendToTimeline trả về nil/empty
**Nguyên nhân TOP 5:**

| # | Nguyên nhân | Fix |
|---|------------|-----|
| 1 | Track bị locked | `SetTrackLock("video", trackIdx, false)` |
| 2 | Track bị disabled | `SetTrackEnable("video", trackIdx, true)` |
| 3 | `mediaType` không phù hợp | Bỏ `mediaType` field |
| 4 | `endFrame = 0` | Set `endFrame = 1` |
| 5 | Track chưa tồn tại | `AddTrack("video")` trước |

### ❌ Clip đặt sai vị trí trên timeline
**Nguyên nhân:** Tính `recordFrame` sai  
**Fix:**
```lua
-- ĐÚNG: recordFrame = timelineStart + floor(seconds * frameRate)
local recordFrame = timelineStart + math.floor(startTime * frame_rate)

-- SAI: quên cộng timelineStart (86400)
local recordFrame = math.floor(startTime * frame_rate)  -- ❌ WRONG!
```

### ❌ Footage zoom 110% không hoạt động
**Nguyên nhân:** AddFusionComp() trả nil  
**Fix:** Dùng pcall để an toàn, không crash pipeline
```lua
pcall(function()
    local comp = tItem:AddFusionComp()
    if comp then ... end
end)
```

---

## 3. Subtitle

### ❌ "Template not found"
**Nguyên nhân:** Template chưa import vào Media Pool  
**Fix:**
```lua
-- Tự import Default Template
mediaPool:ImportFolderFromFile(join_path(assets_path, "subtitle-template.drb"))
```

### ❌ TextPlus SetInput không có hiệu lực
**Nguyên nhân:** Sai tool ID hoặc chưa mở comp  
**Fix:**
```lua
-- Kiểm tra comp count
local compCount = timelineItem:GetFusionCompCount()
-- Lấy comp cuối cùng (mới nhất)
local comp = timelineItem:GetFusionCompByIndex(compCount)
-- Tìm TextPlus bằng ID
local tool = comp:FindToolByID("TextPlus")
-- KHÔNG dùng FindTool("TextPlus") — có thể sai tool name
```

### ❌ Subtitle batch crash DaVinci (RAM)
**Nguyên nhân:** Tạo quá nhiều Fusion comp liên tiếp  
**Fix:** Batch 15 clips + sleep 1.5s
```lua
local BATCH_SIZE = 15
local BATCH_SLEEP = 1.5
```

### ❌ ImportFusionComp fail cho .setting file
**Nguyên nhân:** ImportFusionComp CHỈ hỗ trợ .comp format  
**Fix:** Convert .setting → .comp, hoặc dùng ImportMedia thay thế

---

## 4. Ref Images

### ❌ Ảnh không hiện trên V4
**Debug checklist:**
```
□ V4 đã tồn tại? (GetTrackCount >= 4?)
□ V4 đã enabled? (GetIsTrackEnabled)
□ V4 đã unlocked? (not GetIsTrackLocked)
□ MediaPoolItem tìm được? (check map by name + path)
□ endFrame > 0? (still image cần tính: duration * frameRate)
□ recordFrame đúng? (timelineStart + seconds * fps)
```

### ❌ Fusion effects (dim/border/kenburns) không áp dụng
**Nguyên nhân:** AddFusionComp() hoặc AddTool() trả nil  
**Fix:** Kiểm tra từng step, log chi tiết
```lua
-- Code đã có debug log cho TẤT CẢ 8 steps
-- Mỗi step kiểm tra nil trước khi tiếp tục
if not bgDim then print("STEP 1: FAILED") return end
```

---

## 5. Color Grading (AutoColor)

### ❌ SetCDL trả false
**Nguyên nhân:** CDL format sai — DaVinci yêu cầu STRING  
**Fix:**
```lua
-- ❌ SAI: dùng table
local cdlMap = { Slope = {1.0, 0.9, 1.1} }

-- ✅ ĐÚNG: dùng string "R G B"
local cdlMap = { 
    Slope = "1.0000 0.9000 1.1000",
    Offset = "0.00000 0.00000 0.00000",
    Power = "1.0000 1.0000 1.0000",
    Saturation = "1.0000"
}
```

---

## 6. General

### 💡 Timeline refresh trick
```lua
-- Sau khi thêm/xóa clip, buộc DaVinci redraw:
timeline:SetCurrentTimecode(timeline:GetCurrentTimecode())
```

### 💡 MediaPool folder management
```lua
-- Luôn lưu folder hiện tại → set subfolder → restore
local currentFolder = mediaPool:GetCurrentFolder()
local newFolder = mediaPool:AddSubFolder(currentFolder, "AutoSubs Import")
if newFolder then mediaPool:SetCurrentFolder(newFolder) end
-- ... import ...
if currentFolder then mediaPool:SetCurrentFolder(currentFolder) end
```

### 💡 Debug checklist khi không hiểu lỗi
```
1. Xem log: tail -f ~/Desktop/autosubs_resolve.log
2. Kiểm tra kết nối: curl localhost:56003 -d '{"func":"Ping"}'
3. Kiểm tra timeline: curl localhost:56003 -d '{"func":"GetTimelineInfo"}'
4. Thử bằng tay: import 1 file trong DaVinci → verify track/timing
5. So sánh: frontendRequest vs luaLog → tìm mismatch
```
