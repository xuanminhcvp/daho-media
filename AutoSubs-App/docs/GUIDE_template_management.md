# 🔧 Hướng dẫn Quản lý Template Title Package

> Hệ thống mới dùng **Fusion Compositions từ Power Bin** thay vì Title 1-8 (.setting/.comp)

---

## Cấu trúc Power Bin

```
Power Bin/
├── Main/
│   ├── xanh to xuất hiện        (Fusion Composition)
│   ├── xanh to đập xuống        (Fusion Composition)
│   ├── Xanh nhỏ xuất hiện       (Fusion Composition)
│   ├── Xanh nhỏ đánh máy        (Fusion Composition)
│   ├── vàng to xuất hiện        (Fusion Composition)
│   ├── vàng to đập xuống        (Fusion Composition)
│   ├── Vàng nhỏ xuất hiện       (Fusion Composition)
│   ├── Vàng nhỏ đánh máy        (Fusion Composition)
│   ├── đỏ to xuất hiện          (Fusion Composition)
│   ├── đỏ to đập xuống          (Fusion Composition)
│   └── Adjustment Clip           (Generator)
└── SFX/
    ├── Cinematic Hit 3.mp3       (đập xuống)
    └── Click.mp3                 (xuất hiện / đánh máy)
```

---

## THÊM template mới

### Bước 1: Tạo trong DaVinci
1. Mở DaVinci Resolve → Fusion page
2. Tạo Fusion Composition mới với effect mong muốn
3. Đặt tên rõ ràng theo quy tắc: `[màu] [size] [animation]`
   - VD: `trắng to đập xuống`, `xanh nhỏ fade in`
4. Kéo vào Power Bin → Main folder

### Bước 2: Cập nhật code (2 file)

**File 1**: `src/services/template-assignment-service.ts`  
Thêm 1 item vào mảng `DEFAULT_TEMPLATES`:
```typescript
{
    id: "template_11",                    // ID mới (tăng dần)
    displayName: "Tên hiển thị UI",
    description: "Mô tả style cho AI hiểu",
    usageRule: "Khi nào AI nên chọn template này",
    enabled: true,
    badgeColor: "#hex",                   // Màu badge trên UI
    resolveTemplateName: "trắng to đập xuống",  // ← KHỚP CHÍNH XÁC tên trong Power Bin
    sfxName: "Cinematic Hit 3.mp3",       // SFX đi kèm
},
```

**File 2**: `src/prompts/title-assignment-prompt.ts`  
Thêm mô tả template mới vào phần danh sách cho AI chọn.

### Bước 3: Tăng version
Trong `template-assignment-service.ts`, tăng `TEMPLATES_CURRENT_VERSION` lên 1.

---

## SỬA template có sẵn

### Sửa visual (style, animation, font)
→ Sửa trực tiếp trong DaVinci Fusion page  
→ **Không cần sửa code** (tên không đổi thì code tự tìm đúng)

### Sửa khi nào AI sử dụng
→ Sửa `description` và `usageRule` trong `DEFAULT_TEMPLATES`  
→ Và/hoặc sửa prompt trong `title-assignment-prompt.ts`

### Đổi tên template
→ Đổi tên trong Power Bin  
→ Cập nhật `resolveTemplateName` trong `DEFAULT_TEMPLATES` cho khớp

---

## XOÁ template

### Bước 1: 
Đặt `enabled: false` trong `DEFAULT_TEMPLATES` (hoặc xoá item)

### Bước 2: 
Tăng `TEMPLATES_CURRENT_VERSION`

### Bước 3 (tùy chọn): 
Xoá Fusion Composition khỏi Power Bin

---

## THÊM/ĐỔI SFX

1. Import file SFX mới vào Power Bin → SFX folder
2. Trong `DEFAULT_TEMPLATES`, sửa `sfxName` cho template cần đổi SFX
3. Ví dụ: dùng `"Boom Impact.wav"` thay `"Cinematic Hit 3.mp3"`

---

## THÊM/ĐỔI Adjustment Clip

1. Tạo Adjustment Clip mới trong DaVinci (hoặc import)
2. Đặt vào Power Bin → Main folder  
3. Trong Lua config, sửa tên Adjustment Clip cần tìm
4. File: `resources/modules/template_manager.lua` → `ADJUSTMENT_CLIP_NAME`

---

## Quy tắc đặt tên (QUAN TRỌNG)

`resolveTemplateName` trong code **PHẢI KHỚP CHÍNH XÁC** tên clip trong Media Pool/Power Bin.
- Phân biệt hoa/thường: `"Xanh nhỏ"` ≠ `"xanh nhỏ"`
- Có dấu tiếng Việt: `"đỏ to đập xuống"` ← giữ nguyên dấu

---

## Checklist sau khi thay đổi

- [ ] Tên trong Power Bin khớp `resolveTemplateName`
- [ ] `DEFAULT_TEMPLATES` đã cập nhật
- [ ] Prompt AI đã cập nhật (nếu thêm/xoá template)
- [ ] `TEMPLATES_CURRENT_VERSION` đã tăng
- [ ] Reload Lua script → test AddTemplateSubtitles
