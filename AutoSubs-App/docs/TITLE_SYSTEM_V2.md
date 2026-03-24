# 📋 Title System V2 — Fusion Compositions từ Power Bin

> **Trạng thái**: ✅ ĐANG HOẠT ĐỘNG — 24/03/2026
> **Kết quả test**: 80/80 clips added thành công

---

## Tổng quan Flow

```
User nhấn "Add Titles"
  → AI chọn template theo cảm xúc (10 Fusion Compositions)
  → Frontend gửi clips[] tới Lua (func=AddTemplateSubtitles)
  → Mỗi clip có: template="vàng to đập xuống", sfxName="Cinematic Hit 3.mp3"
  → Lua: Tìm Fusion Composition trong Media Pool bằng tên
  → Lua: AppendToTimeline TRỰC TIẾP (không cần ImportFusionComp)
  → Lua: Set text vào TextPlus
  → Lua: Append Adjustment Clip ở V8 (cùng duration)
  → Lua: Append SFX ở A10
```

---

## Fusion Composition lấy từ đâu?

### Nguồn gốc
Fusion Compositions được **tạo tay trong DaVinci Resolve** (Fusion page), rồi lưu vào **Power Bin**.

### Cách tạo 1 Fusion Composition mới
1. Mở DaVinci Resolve → **Edit page**
2. Tạo **Fusion Composition** mới (Effects Library → Toolbox → Fusion Composition)
3. Kéo vào timeline → double-click vào clip để mở **Fusion page**
4. Trong Fusion: thêm nodes (TextPlus, Background, animation keyframes…) → thiết kế effect
5. Quay về Edit page → kéo clip từ timeline vào **Power Bin** (Main folder)
6. Đặt tên theo quy tắc: `[màu] [size] [animation]` (VD: `xanh to đập xuống`)

### Cách script tìm được
Script Lua duyệt **toàn bộ Media Pool** (bao gồm Power Bin) bằng `walk_media_pool()`:
```lua
helpers.walk_media_pool(rootFolder, function(clip)
    if clip:GetName() == "vàng to đập xuống" then
        found = clip  -- Đây là MediaPoolItem, append trực tiếp được
    end
end)
```

### Cách import vào timeline
**KHÔNG cần import file** — Fusion Compositions đã là MediaPoolItem trong Media Pool.
Script gọi `AppendToTimeline()` trực tiếp:
```lua
local newClip = {
    mediaPoolItem = tplItem,   -- MediaPoolItem tìm được ở trên
    mediaType = 1,
    startFrame = 0,
    endFrame = duration,
    recordFrame = timeline_pos,
    trackIndex = 9              -- V9
}
state.mediaPool:AppendToTimeline({ newClip })
```

**So với V1**: V1 phải convert `.setting` → `.comp`, rồi dùng `ImportFusionComp()`.
V2 đơn giản hơn nhiều — append thẳng MediaPoolItem.

---

## 10 Template hiện tại

| # | ID | Tên Media Pool | Màu | Size | Animation | SFX | Dùng cho |
|---|---|---|---|---|---|---|---|
| 1 | template_1 | `xanh to xuất hiện` | 🔵 | To | Xuất hiện | Click | Chapter nhẹ, location lớn |
| 2 | template_2 | `xanh to đập xuống` | 🔵 | To | Đập xuống | Cinematic Hit | Chapter SLAM, reveal |
| 3 | template_3 | `Xanh nhỏ xuất hiện` | 🔵 | Nhỏ | Xuất hiện | Click | Location, thời gian |
| 4 | template_4 | `Xanh nhỏ đánh máy` | 🔵 | Nhỏ | Đánh máy | Click | Document, pháp lý |
| 5 | template_5 | `vàng to xuất hiện` | 🟡 | To | Xuất hiện | Click | Main title (1 lần) |
| 6 | template_6 | `vàng to đập xuống` | 🟡 | To | Đập xuống | Cinematic Hit | Fact/stat impact |
| 7 | template_7 | `Vàng nhỏ xuất hiện` | 🟡 | Nhỏ | Xuất hiện | Click | Quote, motif |
| 8 | template_8 | `Vàng nhỏ đánh máy` | 🟡 | Nhỏ | Đánh máy | Click | ID card, nhân vật |
| 9 | template_9 | `đỏ to xuất hiện` | 🔴 | To | Xuất hiện | Click | Death nặng nề |
| 10 | template_10 | `đỏ to đập xuống` | 🔴 | To | Đập xuống | Cinematic Hit | Death SLAM |

---

## Mỗi Title = Gói 3 thành phần

| Thành phần | Track | Tìm bằng tên | Duration |
|---|---|---|---|
| **Title** (Fusion Composition) | V9 | Tên template (VD: `vàng to đập xuống`) | Theo subtitle timing |
| **Adjustment Clip** | V8 | `"Adjustment Clip"` (Generator) | = Title duration |
| **SFX** | A10 | `"Cinematic Hit 3.mp3"` hoặc `"Click.mp3"` | Full clip length |

**SFX tự chọn**: "đập xuống" → Cinematic Hit 3, còn lại → Click

---

## Files cần biết

### TypeScript (Frontend)
- `src/services/template-assignment-service.ts` — `DEFAULT_TEMPLATES` (10 items), version 5
- `src/prompts/title-assignment-prompt.ts` — Prompt AI chọn template
- `src/types/title-types.ts` — Types + field `sfxName`
- `src/components/postprod/template-assignment-tab.tsx` — Gửi clips[] kèm sfxName

### Lua Backend
- `resources/modules/subtitle_renderer.lua` — `AddTemplateSubtitles V2`
- `resources/modules/helpers.lua` — `walk_media_pool()`

---

## Lỗi đã biết

| Template | Vấn đề | Cách fix |
|---|---|---|
| `Xanh nhỏ đánh máy` | Fallback → Default | Kiểm tra tên chính xác trong Power Bin |
| `đỏ to xuất hiện` | Fallback → Default | Kiểm tra tên chính xác trong Power Bin |

---

## So sánh V1 vs V2

| | V1 (Title 1-8) | V2 (Fusion Compositions) |
|---|---|---|
| Template source | `.setting` / `.comp` files | Power Bin MediaPoolItems |
| Import method | ImportFusionComp() | AppendToTimeline() trực tiếp |
| Adjustment | Không có | Tự động V8 |
| SFX | Chỉ Title 2/3 | Tất cả template (2 loại SFX) |
| Số template | 8 | 10 |

---

## Rollback về V1
Xem `docs/BACKUP_title_system_v1.md` và git revert các file đã sửa.
