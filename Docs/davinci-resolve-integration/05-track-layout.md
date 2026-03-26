# 🎛️ Track Layout Chuẩn — 7V + 5A

> **Bố cục track CỐ ĐỊNH** — không còn dropdown chọn track.
> File: `src/types/auto-media-types.ts`

---

## Bố Cục

```
╔══════════════════════════════════════════════════════════════╗
║                    DaVinci Resolve Timeline                  ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  V7  🎬  Footage B-roll                                      ║
║  V6  🔤  Tên Chương                                          ║
║  V5  #️⃣  Số Chương                                          ║
║  V4  💬  Text Onscreen (Subtitle)                            ║
║  V3  🎚️  Adjustment Layer                                    ║
║  V2  🖼️  Ảnh Thực Tế (Ref Images)                           ║
║  V1  📹  Video AI                          ← Track chính     ║
║                                                              ║
║  ─────────────── AUDIO ──────────────────                    ║
║                                                              ║
║  A1  🔊  SFX Video AI (import cùng video)                    ║
║  A2  🎙️  VO (Voice Over)                                     ║
║  A3  🔔  SFX Text (âm thanh chữ xuất hiện)                   ║
║  A4  📸  SFX Ảnh Ref (âm thanh ảnh xuất hiện)                ║
║  A5  🎵  Nhạc Nền (Background Music)                         ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```

## Code Constants

```typescript
// auto-media-types.ts
export const TRACK_LAYOUT = {
    VIDEO_AI: 1,          // V1 — Video AI (nội dung chính)
    REF_IMAGES: 2,        // V2 — Ảnh minh hoạ thực tế
    ADJUSTMENT: 3,        // V3 — Adjustment Layer (luôn đi kèm text V4)
    TEXT_ONSCREEN: 4,     // V4 — Text Onscreen (subtitle)
    CHAPTER_NUMBER: 5,    // V5 — Số chương
    CHAPTER_TITLE: 6,     // V6 — Tên chương
    FOOTAGE: 7,           // V7 — Footage B-roll
    
    AUDIO_SFX_VIDEO: 1,   // A1 — SFX đi kèm Video AI
    AUDIO_VO: 2,          // A2 — Voice Over
    AUDIO_SFX_TEXT: 3,    // A3 — SFX text xuất hiện
    AUDIO_SFX_REF: 4,     // A4 — SFX ảnh ref xuất hiện
    AUDIO_MUSIC: 5,       // A5 — Nhạc nền
}
```

## Nguyên Tắc Thiết Kế

| Nguyên tắc | Giải thích |
|------------|------------|
| **V1 ở dưới cùng** | Video AI là "nền", mọi thứ khác đặt lên trên |
| **V3 ngay dưới V4** | Adjustment Layer luôn đi kèm Text, thứ tự cố định |
| **A1 đi theo V1** | SFX Video AI được tạo cùng video, import cùng lúc |
| **Không dropdown** | Tất cả tabs đã bỏ selector, hardcode track index |
| **Tối thiểu 7V+5A** | User phải tạo đủ tracks trong DaVinci TRƯỚC KHI chạy pipeline |

## Nơi Hardcode Track

| File | Track | Giá trị |
|------|-------|---------|
| `media-import-panel.tsx` | V1 | `selectedTrack = "1"` |
| `image-import-panel.tsx` | V1 | `selectedTrack = "1"` |
| `subtitle-tab.tsx` | V4 | `TRACK_LAYOUT.TEXT_ONSCREEN` |
| `effects-tab.tsx` | V1 | `TRACK_LAYOUT.VIDEO_AI` |
| `footage-tab.tsx` | V7 | `TRACK_LAYOUT.FOOTAGE` |
| `reference-images-tab.tsx` | V2 | `TRACK_LAYOUT.REF_IMAGES` |
| `template-assignment-tab.tsx` | V4 | `TRACK_LAYOUT.TEXT_ONSCREEN` |
| `auto-media-service.ts` | Multiple | `TRACK_LAYOUT.*` (8 chỗ) |
