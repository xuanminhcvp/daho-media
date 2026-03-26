# 📚 DaVinci Resolve Integration — Tài Liệu Tham Khảo

> **Folder này chứa TẤT CẢ tài liệu** về cách AutoSubs kết nối và điều khiển DaVinci Resolve.
> Khi gặp bug hoặc cần mở rộng tính năng → đọc docs này TRƯỚC khi code.

---

## Danh Sách Tài Liệu

| # | File | Nội dung | Khi nào đọc |
|---|------|----------|-------------|
| 01 | [architecture-overview.md](01-architecture-overview.md) | Kiến trúc tổng quan, diagram, file mapping | Khi mới bắt đầu, cần hiểu big picture |
| 02 | [entry-scripts.md](02-entry-scripts.md) | Cách lấy Resolve object (Lua + Python) | Khi script không chạy, hoặc cần sửa entry |
| 03 | [api-reference.md](03-api-reference.md) | 20+ API endpoints, request/response format | Khi thêm tính năng mới hoặc debug API call |
| 04 | [media-import-logic.md](04-media-import-logic.md) | AppendToTimeline, Fusion effects, fallbacks | Khi import media bị lỗi |
| 05 | [track-layout.md](05-track-layout.md) | Bố cục 7V+5A chuẩn, nơi hardcode | Khi thay đổi track setup |
| 06 | [subtitle-template-system.md](06-subtitle-template-system.md) | TextPlus API, template styles, batch | Khi subtitle/text bị lỗi |
| 07 | [troubleshooting.md](07-troubleshooting.md) | Lỗi thường gặp + cách fix | **ĐỌC ĐẦU TIÊN** khi gặp bug! |

---

## Quick Start — Đọc Nhanh

### Gặp bug? → Bắt đầu từ:
1. **[07-troubleshooting.md](07-troubleshooting.md)** — Fix nhanh các lỗi phổ biến
2. Xem log: `tail -f ~/Desktop/autosubs_resolve.log`
3. Test kết nối: `curl localhost:56003 -d '{"func":"Ping"}'`

### Thêm tính năng mới?
1. **[01-architecture-overview.md](01-architecture-overview.md)** — Hiểu flow tổng quan
2. **[03-api-reference.md](03-api-reference.md)** — Xem API có sẵn
3. **[04-media-import-logic.md](04-media-import-logic.md)** — Pattern AppendToTimeline

### Code structure:
```
Frontend (TypeScript)           Backend (Lua — trong DaVinci)
├── resolve-api.ts              ├── AutoSubs.lua (entry)
├── ResolveContext.tsx           ├── modules/
├── auto-media-service.ts       │   ├── init.lua
└── auto-media-types.ts         │   ├── server.lua (router)
                                │   ├── media_import.lua
                                │   ├── subtitle_renderer.lua
                                │   ├── timeline_info.lua
                                │   ├── template_manager.lua
                                │   ├── helpers.lua
                                │   └── ...
                                └── AutoSubs.py (Python entry)
```
