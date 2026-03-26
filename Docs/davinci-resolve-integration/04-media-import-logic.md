# 📦 Media Import — Logic Chi Tiết

> **Đây là phần phức tạp nhất** của integration — nhiều edge case, fallback, và gotcha.
> File: `resources/modules/media_import.lua` (828 dòng)

---

## 1. Hàm Cốt Lõi: `AppendToTimeline()`

Đây là hàm DUY NHẤT của DaVinci API để đặt clip lên timeline theo vị trí chính xác.

### Cú pháp

```lua
local result = mediaPool:AppendToTimeline({
    {
        mediaPoolItem = item,       -- MediaPoolItem object (đã import vào pool)
        mediaType     = 1,          -- 1 = video, 2 = audio
        startFrame    = 0,          -- Frame bắt đầu trên SOURCE clip
        endFrame      = 120,        -- Frame kết thúc trên SOURCE clip
        recordFrame   = 86400,      -- Frame đặt trên TIMELINE (86400 = 1h * 24fps = đầu timeline)
        trackIndex    = 1,          -- Track đích (1-based)
    }
})
-- result = array of TimelineItem objects (hoặc nil/empty nếu fail)
```

### Tính toán frames

```lua
local frame_rate    = timeline:GetSetting("timelineFrameRate")  -- VD: 24, 25, 30
local timelineStart = timeline:GetStartFrame()                   -- Thường = 86400 (1h offset)

-- Chuyển giây → frame trên timeline
local recordFrame = timelineStart + math.floor(startTimeSeconds * frame_rate)

-- Chuyển duration giây → số frames source
local durationFrames = math.floor(durationSeconds * clipFPS)
```

### ⚠️ Lưu Ý Quan Trọng

1. **`timelineStart`** KHÔNG phải 0! Mặc định DaVinci offset 01:00:00:00 = 86400 frames (ở 24fps)
2. **`startFrame`/`endFrame`** tham chiếu SOURCE clip, KHÔNG phải timeline
3. **`recordFrame`** tham chiếu TIMELINE — đây là vị trí đặt clip
4. **Ảnh tĩnh** (jpg, png): `startFrame=0, endFrame=durationFrames` — source clip giả

---

## 2. AddMediaToTimeline (Video Import)

### Flow chi tiết

```
1. Thu thập file paths từ clips array
2. Import vào Media Pool (subfolder "AutoSubs Media Import")
3. Tạo mapping: fileName → MediaPoolItem
4. Với mỗi clip:
   a. Tìm mediaItem theo fileName
   b. Tính recordFrame = timelineStart + floor(startTime * frameRate)
   c. Detect still image (jpg, png, webp...)
   d. AppendToTimeline()
   e. Set clip color (Blue/Orange)
   f. [Footage] Thêm Fusion Transform zoom 110%
```

### Still Image Detection

```lua
local lowerName = fileName:lower()
local isStillImage = lowerName:match("%.jpe?g$")
    or lowerName:match("%.png$")
    or lowerName:match("%.webp$")
    or lowerName:match("%.bmp$")
    or lowerName:match("%.tiff?$")
    or lowerName:match("%.exr$")
```

### Footage VideoOnly Mode

Khi `videoOnly = true`:
- `mediaType = 1` (chỉ video)
- Hỗ trợ `trimStart`/`trimEnd` trên SOURCE clip
- Thêm Fusion Transform zoom 110% để che viền đen
- Fallback: nếu `mediaType=1` fail → thử bỏ `mediaType`

```lua
-- Fusion zoom 110% cho footage
local comp = tItem:AddFusionComp()
local mediaIn  = comp:FindTool("MediaIn1")
local mediaOut = comp:FindTool("MediaOut1")
local transform = comp:AddTool("Transform")
transform:ConnectInput("Input", mediaIn)
mediaOut:ConnectInput("Input", transform)
transform:SetInput("Size", 1.1)  -- 110% zoom
```

---

## 3. AddRefImagesToTimeline (Ảnh Tham Khảo)

### Hiệu ứng Fusion phức tạp

```
Node graph:
  MediaIn1 → imgTransform → borderMerge → finalMerge → MediaOut1
  bgWhite  → whiteTransform ↗             ↑
  bgDim  ──────────────────────────────────┘
```

**7 bước Fusion:**

| Step | Tool | Chức năng |
|------|------|-----------|
| 1 | `Background` (bgDim) | Nền đen 65% alpha (dim overlay) |
| 2 | `Background` (bgWhite) | Viền trắng |
| 3 | `Transform` (whiteTransform) | Ken Burns cho viền (zoom S→E) |
| 4 | `Transform` (imgTransform) | Ken Burns cho ảnh (zoom S→E) |
| 5 | `Merge` (borderMerge) | Ảnh over viền trắng |
| 6 | `Merge` (finalMerge) | (Ảnh+viền) over nền tối |
| 7 | `MediaOut` connection | Output cuối |
| 8 | `AddTransition` | Cross Dissolve 0.3s |

### Kích thước theo priority

```lua
-- Full-frame (high priority + portrait/headline/evidence)
local framesizeS = 1.04  -- viền trắng start
local framesizeE = 1.09  -- viền trắng end
local imgsizeS   = 0.97  -- ảnh start
local imgsizeE   = 1.02  -- ảnh end

-- Overlay (medium/low priority)
local framesizeS = 0.78
local framesizeE = 0.83
local imgsizeS   = 0.72
local imgsizeE   = 0.77
```

### Track V4 Safety Checks

```lua
-- 1. Đảm bảo V4 tồn tại
ensureVideoTrack(timeline, 4)  -- Tạo track nếu chưa đủ

-- 2. Unlock + Enable
if not timeline:GetIsTrackEnabled("video", 4) then
    timeline:SetTrackEnable("video", 4, true)
end
if timeline:GetIsTrackLocked("video", 4) then
    timeline:SetTrackLock("video", 4, false)
end

-- 3. Build map theo CẢ File Name VÀ File Path
-- (tránh miss khi Resolve đổi tên clip)

-- 4. Fallback 3 lần:
--    Lần 1: mediaType=1
--    Lần 2: mediaType=nil  
--    Lần 3: endFrame=1
```

---

## 4. AddSfxClipsToTimeline (Sound Effects)

### Flow

```
1. Thu thập unique file paths (deduplicate)
2. Import vào Media Pool (subfolder "AutoSubs SFX")
3. Tạo audio track MỚI ở cuối timeline
4. AppendToTimeline từng clip với mediaType=2
5. Hỗ trợ trim: trimStartSec/trimEndSec
```

### Fallback khi ImportMedia fail

```lua
-- File đã import trước đó → scan Media Pool tìm lại
if not mediaPoolItems or #mediaPoolItems == 0 then
    helpers.walk_media_pool(mediaPool:GetRootFolder(), function(clip)
        local props = clip:GetClipProperty()
        if props["File Path"] == path or props["File Name"] == filename then
            foundItem = clip
            return true  -- stop walking
        end
    end)
end
```

---

## 5. AddAudioToTimeline (BGM/Voice)

### Flow đơn giản

```
1. Import 1 file vào Media Pool
2. Tạo audio track MỚI
3. Đặt clip ở frame 0 (đầu timeline)
4. Set clip color Purple
```

---

## 6. Common Gotchas & Fixes

### ImportMedia trả về nil
```lua
-- Nguyên nhân: file path sai, file đang bị lock, hoặc format không hỗ trợ
-- Fix: kiểm tra file tồn tại + log lỗi chi tiết
```

### AppendToTimeline trả về nil/empty
```lua
-- Nguyên nhân phổ biến:
-- 1. Track bị locked → SetTrackLock(false)
-- 2. Track bị disabled → SetTrackEnable(true)
-- 3. mediaType không phù hợp → thử bỏ mediaType
-- 4. endFrame = 0 → thử endFrame = 1
-- 5. Track chưa tồn tại → AddTrack("video")
```

### Clip color mapping
```lua
-- Blue = video import thông thường
-- Orange = footage (videoOnly)
-- Pink = ref image
-- Purple = audio/BGM
-- Green = subtitle
-- Yellow/Red/Cyan... = template subtitle styles
```

### Timeline refresh sau khi import
```lua
-- QUAN TRỌNG: refresh timeline display sau khi thêm clips
timeline:SetCurrentTimecode(timeline:GetCurrentTimecode())
-- → Buộc DaVinci re-render timeline view
```
