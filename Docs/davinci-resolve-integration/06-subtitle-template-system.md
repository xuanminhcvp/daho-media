# 🎬 Subtitle & Template — Logic Chi Tiết

> **File:** `resources/modules/subtitle_renderer.lua` (702 dòng)
> **File:** `resources/modules/template_manager.lua` (372 dòng)

---

## 1. Template System

### Template files location (macOS)

```
~/Library/Application Support/Blackmagic Design/DaVinci Resolve/
    Fusion/Templates/Edit/Titles/AutoSubs/
        ├── Default Template.setting    ← MacroOperator format
        ├── Title 1.setting
        ├── Title 2.comp                ← Fusion Composition format
        ...
```

### Template import flow

```
1. GetTemplates() — scan Media Pool tìm tất cả Fusion Title type
2. Nếu "Default Template" chưa có → ImportFolderFromFile("subtitle-template.drb")
3. ImportTitleFromFile() — import .setting vào Media Pool
   a. Kiểm tra file tồn tại
   b. Log file size, header
   c. Xóa clip cũ trùng tên (cache DaVinci)
   d. ImportMedia([filePath])
   e. Verify kết quả (!nil, !empty, type == table)
```

### Template lookup

```lua
-- Tìm clip theo tên trong Media Pool (đệ quy)
M.GetTemplateItem(helpers, rootFolder, "Default Template")

-- Tìm theo folder name → lấy Fusion Title đầu tiên
M.GetTemplateItemByFolder(helpers, rootFolder, "Title 1")

-- Đa ngôn ngữ: "Fusion Title" type string khác nhau theo locale
-- Ví dụ: "Generator", "Fusion Title", "Titre Fusion", "Fusionタイトル"...
-- → dùng lookup set O(1) trong helpers.isMatchingTitle()
```

### ImportFusionComp vs ImportMedia

```
⚠️ QUAN TRỌNG:
- ImportFusionComp() CHỈ hỗ trợ file .comp (Fusion Composition format)
- ImportFusionComp() KHÔNG hỗ trợ file .setting (MacroOperator format)
- ImportMedia() hỗ trợ cả .setting và .comp

→ Flow: dùng ImportMedia() cho .setting
→ Hoặc: convert .setting → .comp rồi dùng ImportFusionComp()
```

---

## 2. AddSubtitles (Cơ bản)

### Flow

```
1. Đọc JSON file transcript (segments + speakers)
2. SanitizeTrackIndex — tạo track mới nếu cần
3. Handle conflict modes:
   - "new_track" → tạo Video track mới
   - "replace"   → xóa clip cũ xung đột
   - "skip"      → bỏ qua subtitle xung đột
4. Build clip list (tính frames, gap joining)
5. AppendToTimeline() MỘT LẦN cho tất cả clips
6. Set text vào TextPlus tool (Fusion comp)
7. Set custom colors (fill, outline, border) theo speaker
```

### Gap Joining

```lua
-- Nếu khoảng cách giữa 2 subtitle < 1 giây (< frameRate frames)
-- → nối liền 2 clip (tránh flicker)
if frames_between < joinThreshold then
    clip_timeline_duration = clip_timeline_duration + frames_between + 1
end
```

### Speaker Color System

```lua
-- Speaker có 3 layer color:
-- 1. Fill (Enabled1, Red1/Green1/Blue1)
-- 2. Outline (Enabled2, Red2/Green2/Blue2) 
-- 3. Border/Shadow (Enabled4, Red4/Green4/Blue4)
-- Hex color → RGB 0-1 bằng helpers.hexToRgb()
```

---

## 3. AddTemplateSubtitles V2 (Documentary Style)

### Khác biệt với AddSubtitles cơ bản

- **Nhiều template:** Mỗi câu có template riêng (xanh to, vàng nhỏ, đỏ...)
- **Fusion Composition:** Tìm trực tiếp trong Media Pool (bao gồm Power Bin)
- **Auto SFX:** Tự chọn SFX theo tên template
- **Adjustment Layer:** Tự thêm clip Adjustment ở track dưới

### Config

```lua
local titleTrackIdx     = trackIndex    -- V9 (hoặc V4 tùy setup)
local adjustmentTrackIdx = titleTrackIdx - 1  -- V8 (ngay dưới)
local sfxTrackIdx       = 10             -- A10
```

### SFX Auto-Select

```lua
-- Chọn SFX theo tên template:
if tplName:find("đập xuống") then
    sfx = "Cinematic Hit 3.mp3"        -- Slam impact
elseif tplName:find("đánh máy") then
    sfx = "ComputerDesktop 6103_69_4.WAV" -- Typewriter
else
    sfx = "Click.mp3"                  -- Xuất hiện
end
```

### Clip Color Mapping

```lua
["xanh to xuất hiện"]  = "Teal"
["xanh to đập xuống"]  = "Teal"
["Xanh nhỏ xuất hiện"] = "Cyan"
["Xanh nhỏ đánh máy"]  = "Cyan"
["vàng to xuất hiện"]  = "Yellow"
["vàng to đập xuống"]  = "Orange"
["đỏ to xuất hiện"]    = "Red"
["đỏ to đập xuống"]    = "Red"
```

---

## 4. AddSimpleSubtitles (Batch Mode)

### Batch Processing

```lua
local BATCH_SIZE = 15    -- clips per batch
local BATCH_SLEEP = 1.5  -- seconds between batches

-- Tại sao batch?
-- DaVinci phải tạo Fusion comp cho mỗi Text+ → rất nặng RAM
-- > 30 clips liên tiếp → crash hoặc lag
-- Giải pháp: 15 clips → sleep 1.5s → 15 clips → ...
```

### Fallback (batch fail → individual)

```lua
-- Nếu AppendToTimeline batch fail → thử từng clip 1
if not timelineItems or #timelineItems == 0 then
    for ci, singleClip in ipairs(clipList) do
        local result = mediaPool:AppendToTimeline({ singleClip })
        -- Set text/color cho từng clip thành công
    end
end
```

---

## 5. Template Styles (Programmatic)

Khi Fusion Composition không tìm thấy, dùng programmatic style:

```lua
TEMPLATE_STYLES = {
    ["Location Card"] = {
        font = "Courier New", size = 0.042,
        bold = false, italic = false,
        -- Fill color (white-ish)
        red1 = 0.85, green1 = 0.88, blue1 = 0.90,
        -- Border color (dark)
        red4 = 0.05, green4 = 0.05, blue4 = 0.05,
        clipColor = "Lime",
    },
    ["Impact Number"] = {
        font = "Arial Black", size = 0.09,
        bold = true, italic = false,
        red1 = 0.96, green1 = 0.75, blue1 = 0.04,  -- Gold
        clipColor = "Yellow",
    },
    -- Death/Violence, Document/ID, Quote/Motif...
}
```

---

## 6. Fusion Text+ API Cheat Sheet

```lua
-- Tìm TextPlus tool trong Fusion comp
local comp = timelineItem:GetFusionCompByIndex(1)
local tool = comp:FindToolByID("TextPlus")

-- Set text
tool:SetInput("StyledText", "Hello World")

-- Set font
tool:SetInput("Font", "Arial Black")
tool:SetInput("Size", 0.06)  -- 0-1 scale

-- Set fill color (Layer 1)
tool:SetInput("Enabled1", 1)
tool:SetInput("Red1", 0.96)
tool:SetInput("Green1", 0.75)
tool:SetInput("Blue1", 0.04)

-- Set outline color (Layer 2)
tool:SetInput("Enabled2", 1)
tool:SetInput("Red2", r)
tool:SetInput("Green2", g)
tool:SetInput("Blue2", b)

-- Set border/shadow (Layer 4)
tool:SetInput("Enabled4", 1)
tool:SetInput("Red4", r)
tool:SetInput("Green4", g)
tool:SetInput("Blue4", b)
```
