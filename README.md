<div align="center">

# 🎬 AutoSubs Media

### Tự động hoá hậu kỳ video YouTube với DaVinci Resolve + AI

<br>

[![Download for Mac](https://img.shields.io/badge/⬇%20Download%20for%20Mac-AutoSubs%20Media-blue?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/xuanminhcvp/auto-media/releases/latest/download/AutoSubs-Mac-ARM.pkg)

<br>

![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-black?logo=apple)
![DaVinci Resolve](https://img.shields.io/badge/DaVinci%20Resolve-18%2B-red)
![Version](https://img.shields.io/badge/Version-3.0.15-green)

</div>

---

## ✨ Tính năng

| Tính năng | Mô tả |
|---|---|
| 🖼️ **Import Ảnh AI** | Tự động match ảnh AI với timing script → đặt đúng vị trí trên timeline |
| 📝 **Phụ đề tự động** | Whisper transcribe + AI matching → subtitle chính xác từng từ |
| 🎵 **Nhạc nền AI** | AI Sound Director chọn nhạc phù hợp từng phân đoạn kịch bản |
| 🔊 **SFX tự động** | AI phân tích script → gắn Sound Effects đúng thời điểm kịch tính |
| 🎥 **Footage matching** | Tự động match B-roll footage theo nội dung script |
| ✨ **Hiệu ứng video** | Ken Burns zoom/pan + Camera Shake + Fade In/Out cho ảnh tĩnh |
| 🚀 **Auto Media** | Pipeline 1-click: Transcribe → Match → Import Ảnh → Subtitle → Nhạc → SFX → Effects |

---

## 📦 Cài đặt

### Yêu cầu
- **macOS** 13.3+ (Apple Silicon: M1/M2/M3/M4)
- **DaVinci Resolve** 18+ (Free hoặc Studio)

### Hướng dẫn

1. **Tải app** — nhấn nút **Download for Mac** phía trên
2. **Mở file .pkg** → cài đặt theo hướng dẫn (app sẽ vào `/Applications`)
3. **Lần đầu mở**: Chuột phải vào app → chọn **Open** → nhấn **Open** lần nữa
4. **Kết nối DaVinci Resolve**:
   - Mở DaVinci Resolve
   - Vào menu **Workspace** → **Console**
   - Paste đoạn code bên dưới vào Console → nhấn Enter

```lua
-- Paste đoạn này vào DaVinci Resolve Console (Workspace > Console)
local script_path = "/Applications/AutoSubs_Media.app/Contents/Resources/resources/AutoSubs.lua"
dofile(script_path)
```

5. **Xong!** App sẽ kết nối với DaVinci Resolve và sẵn sàng sử dụng.

---

## 🎯 Workflow cơ bản

```
1. Mở DaVinci Resolve → tạo timeline mới (24fps)
2. Import voice narration vào Audio Track A2
3. Mở AutoSubs Media → kết nối DaVinci
4. Paste kịch bản vào ô Script
5. Chọn folder ảnh AI generated
6. Nhấn 🚀 Auto Media → ngồi chờ app tự làm mọi thứ!
```

### Track Layout

| Track | Nội dung |
|---|---|
| V1 | Ảnh AI / Media |
| V2 | Footage (B-roll) |
| V3 | Phụ đề (Subtitles) |
| A1 | SFX (Sound Effects) |
| A2 | Voice Narration ⚠️ |
| A3 | Nhạc nền (BGM) |

---

## 🔧 Dev Setup

1. Clone repo
2. Cài prerequisites: Node.js + Rust toolchain ([Tauri docs](https://tauri.app))
3. Chạy dev:
   ```bash
   cd AutoSubs-App
   npm install
   npm run tauri dev
   ```
4. Kết nối DaVinci Resolve khi dev:
   - Mở `AutoSubs-App/src-tauri/resources/AutoSubs.lua`
   - Set `DEV_MODE = true` (dòng 9)
   - Paste mã vào DaVinci Console

> ⚠️ **Lưu ý**: Khi build production, nhớ set `DEV_MODE = false` trong `AutoSubs.lua`!

---

## 🔧 Cấu trúc thư mục

App sẽ tự tạo folder `Auto_media` trên Desktop khi chạy lần đầu:

```
~/Desktop/Auto_media/
├── music/          ← Nhạc nền (tự chọn từ thư viện)
├── sfx/            ← Sound Effects
├── footage/        ← Video B-roll clips
└── images/         ← Ảnh AI generated (mỗi project 1 folder con)
```

---

## ⚠️ Lưu ý

- App chưa được **code-signed** bởi Apple. Lần đầu mở cần chuột phải → Open
- Chỉ hỗ trợ **macOS Apple Silicon** (M1/M2/M3/M4)
- Cần cài **DaVinci Resolve** trước khi sử dụng
- Timeline nên để **24fps** để track layout hoạt động chính xác

---

<div align="center">

**Made with ❤️ for YouTube Storytelling Creators**

</div>
