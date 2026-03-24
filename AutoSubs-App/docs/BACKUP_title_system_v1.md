# 📋 BACKUP: Hệ thống Import Title hiện tại (Title 1-8)

> **Trạng thái**: ✅ ĐANG HOẠT ĐỘNG — ngày 24/03/2026
> Lưu doc này để rollback nếu hệ thống mới bị lỗi.

---

## Tổng quan Flow

```
User nhấn "Add Titles" 
  → AI gán template_1 ... template_8 cho từng câu
  → Frontend gửi clips[] tới Lua server (func=AddTemplateSubtitles)
  → Mỗi clip có template="Title 1" ... "Title 8"
  → Lua: AppendToTimeline bằng "Default Template" (base)
  → Lua: ImportFusionComp(.comp) để thay thế comp bằng custom style
  → Lua: SetInput("StyledText", text) để đặt nội dung chữ
```

---

## File quan trọng

### TypeScript (Frontend)

| File | Vai trò |
|---|---|
| `src/services/template-assignment-service.ts` | `DEFAULT_TEMPLATES` (8 items), gọi AI, gửi clips tới Lua |
| `src/prompts/title-assignment-prompt.ts` | Prompt cho AI chọn template phù hợp |
| `src/types/title-types.ts` | Types: `TextTemplate`, `TitleCue`, `AITitleCueResult` |
| `src/components/postprod/template-assignment-tab.tsx` | UI tab "Add Title" |

### Lua Backend

| File | Vai trò |
|---|---|
| `resources/modules/subtitle_renderer.lua` | `AddTemplateSubtitles()` — vòng lặp chính add 51 clips |
| `resources/modules/template_manager.lua` | `ApplySettingToTimelineItem()` — import .comp vào clip |

### Template Files

| File | Nội dung |
|---|---|
| `resources/Titles/Title 1.setting` ... `Title 8.setting` | MacroOperator templates (gốc) |
| `resources/Titles/Title 1.comp` ... `Title 8.comp` | Fusion Composition (đã convert ✅) |

### DaVinci Templates (Effects Library)

```
~/Library/Application Support/Blackmagic Design/DaVinci Resolve/
  Fusion/Templates/Edit/Titles/AutoSubs/
    Title 1.setting ... Title 8.setting  (+ .comp copies)
```

---

## Cách ImportFusionComp hoạt động

1. Clip được tạo từ **"Default Template"** (MediaPoolItem trong Media Pool)
2. `ImportFusionComp(path_to_comp)` **thay thế** (replace) comp hiện tại bằng nội dung file `.comp`
3. Comp count vẫn = 1 (không tạo thêm, chỉ thay thế)
4. Tool list bên trong comp thay đổi → style đúng template custom
5. Sau đó set text: `tool:SetInput("StyledText", text)`

> **Lưu ý**: `.setting` files KHÔNG hoạt động với `ImportFusionComp()`. Phải dùng `.comp`.

---

## Template Mapping (Title 1-8)

| Template | resolveTemplateName | Phong cách | Dùng cho |
|---|---|---|---|
| template_1 | Title 1 | Vàng gold Serif, fade-in | Document / ID Card |
| template_2 | Title 2 | Vàng lớn SLAM | Location / Impact |
| template_3 | Title 3 | Đỏ crimson SLAM | Death / Violence |
| template_4 | Title 4 | Trắng xanh Italic | Quote / Motif |
| template_5 | Title 5 | Trắng lớn Serif Bold | Main Title (1 lần duy nhất) |
| template_6 | Title 6 | Full/half screen divider | Chapter / Scene |
| template_7 | Title 7 | Card nền đậm + chữ to | Fact / Stat Card |
| template_8 | Title 8 | Text lớn nổi bật | Emphasis / Key Text |

---

## Cách rollback

Nếu hệ thống mới bị lỗi, khôi phục bằng:

1. **Git revert** các file TypeScript + Lua đã sửa
2. File `.comp` và `.setting` vẫn còn nguyên trong `resources/Titles/`
3. Reload Lua script trong DaVinci Console
4. Chạy lại AddTemplateSubtitles → sẽ dùng lại flow cũ
