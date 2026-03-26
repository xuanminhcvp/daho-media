# 🔌 API Reference — Frontend ↔ Lua Server

> **Tất cả 20+ API endpoints** giữa Tauri app và DaVinci Resolve Lua server.
> File TypeScript: `src/api/resolve-api.ts`
> File Lua router: `resources/modules/server.lua`

---

## 1. Giao Thức

```
Method:  POST
URL:     http://127.0.0.1:56003/
Headers: Content-Type: application/json
Body:    { "func": "FunctionName", ...params }
Response: JSON
```

Tất cả request đều gửi đến CÙNG MỘT URL, phân biệt bằng field `func`.

---

## 2. API Endpoints

### 🔵 Kết Nối & Timeline

#### `Ping`
Kiểm tra server còn sống không.
```json
// Request
{ "func": "Ping" }
// Response  
{ "message": "Pong" }
```
- **Timeout:** 3 giây
- **Dùng khi:** Kiểm tra kết nối, heartbeat

#### `GetTimelineInfo`
Lấy thông tin timeline hiện tại (tên, ID, tracks, templates).
```json
// Request
{ "func": "GetTimelineInfo" }
// Response
{
  "name": "Timeline 1",
  "timelineId": "abc123-def456",
  "timelineStart": 0,
  "projectName": "Documentary",
  "outputTracks": [
    { "value": "0", "label": "Add to New Track" },
    { "value": "1", "label": "Video 1" },
    ...
  ],
  "inputTracks": [
    { "value": "1", "label": "Audio 1" },
    ...
  ],
  "templates": [
    { "label": "Default Template", "value": "Default Template" },
    ...
  ]
}
```
- **Dùng khi:** App khởi động, user mở timeline mới

#### `JumpToTime`
Di chuyển playhead đến vị trí (giây).
```json
// Request
{ "func": "JumpToTime", "seconds": 42.5 }
// Response
{ "message": "Jumped to time" }
```

#### `SeekToTime`
Giống JumpToTime nhưng dùng timecode format khác.
```json
// Request
{ "func": "SeekToTime", "seconds": 42.5 }
// Response
{ "success": true, "timecode": "00:00:42:12" }
```

#### `Exit`
Tắt Lua server.
```json
// Request
{ "func": "Exit" }
// Response
{ "message": "Server shutting down" }
```

---

### 🟢 Media Import

#### `AddMediaToTimeline`
Import video clips lên VIDEO TRACK.
```json
// Request
{
  "func": "AddMediaToTimeline",
  "clips": [
    { "filePath": "/path/to/scene_1.mp4", "startTime": 0, "endTime": 5.5 },
    { "filePath": "/path/to/scene_2.mp4", "startTime": 5.5, "endTime": 12.3 }
  ],
  "trackIndex": "1",
  "videoOnly": true  // optional: chỉ lấy hình, bỏ audio
}
// Response
{ "success": true, "clipsAdded": 2, "message": "Added 2/2 clips" }
```
- **Timeout:** 120 giây
- **Flow Lua:**
  1. Import files vào Media Pool (subfolder "AutoSubs Media Import")
  2. Map fileName → MediaPoolItem
  3. Tính `recordFrame = timelineStart + floor(startTime * frameRate)`
  4. `AppendToTimeline()` từng clip
  5. Set clip color (Blue mặc định, Orange cho footage)
  6. Footage (`videoOnly=true`): thêm Fusion Transform zoom 110%

#### `AddAudioToTimeline`
Import 1 file audio vào AUDIO TRACK MỚI.
```json
// Request
{
  "func": "AddAudioToTimeline",
  "filePath": "/path/to/final_bgm.wav",
  "trackName": "BGM - AutoSubs"
}
// Response
{ "success": true, "audioTrack": 6, "trackName": "BGM - AutoSubs" }
```
- **Flow Lua:** Tạo track audio mới → import → đặt ở frame 0

#### `AddSfxClipsToTimeline`
Import nhiều SFX clips vào 1 AUDIO TRACK.
```json
// Request
{
  "func": "AddSfxClipsToTimeline",
  "clips": [
    { "filePath": "/path/sfx1.wav", "startTime": 5.0 },
    { "filePath": "/path/sfx2.wav", "startTime": 12.3, "trimStartSec": 0.5, "trimEndSec": 2.0 }
  ],
  "trackName": "SFX - AutoSubs"
}
// Response
{ "success": true, "audioTrack": 7, "clipsAdded": 2 }
```
- **Timeout:** 60 giây
- **Fallback:** Nếu ImportMedia fail → scan Media Pool tìm file đã import trước

#### `AddRefImagesToTimeline`
Import ảnh tham khảo lên Track V4 với hiệu ứng.
```json
// Request
{
  "func": "AddRefImagesToTimeline",
  "clips": [
    {
      "filePath": "/path/to/ref_1.jpg",
      "startTime": 5.0, "endTime": 8.5,
      "priority": "high",
      "imageType": "portrait"  // portrait|headline|evidence|event
    }
  ],
  "sfxClips": [
    { "filePath": "/path/sfx.wav", "startTime": 5.0 }
  ]
}
// Response
{ "success": true, "clipsAdded": 1, "sfxAdded": 1 }
```
- **Timeout:** 120 giây
- **Hiệu ứng Fusion:** Dim overlay + White border + Ken Burns zoom + Cross Dissolve
- **Full-frame:** Khi `priority=high` + `imageType` = portrait/headline/evidence

---

### 🟡 Subtitle

#### `AddSubtitles`
Thêm phụ đề từ file JSON (cơ bản, 1 template).
```json
// Request
{
  "func": "AddSubtitles",
  "filePath": "/path/to/transcript.json",
  "templateName": "Default Template",
  "trackIndex": "4"
}
```

#### `AddTemplateSubtitles`
Thêm phụ đề với NHIỀU template khác nhau (Documentary style).
```json
// Request
{
  "func": "AddTemplateSubtitles",
  "clips": [
    { "start": 0, "end": 3, "text": "Câu 1", "template": "xanh to xuất hiện" },
    { "start": 3, "end": 6, "text": "Câu 2", "template": "vàng nhỏ đánh máy" }
  ],
  "trackIndex": "4"
}
// Response
{ "success": true, "added": 2, "total": 2 }
```
- **Flow Lua:**
  1. Tìm Fusion Composition theo template name trong Media Pool
  2. AppendToTimeline trực tiếp
  3. Set text vào TextPlus
  4. Thêm Adjustment Clip ở track dưới
  5. Thêm SFX auto-select (đập xuống → Cinematic Hit, đánh máy → Typewriter, khác → Click)

#### `AddSimpleSubtitles`
Thêm phụ đề batch (stories mode, 1 template, batch processing).
```json
// Request
{
  "func": "AddSimpleSubtitles",
  "clips": [...],
  "templateName": "Default Template",
  "trackIndex": "4",
  "fontSize": 0.04
}
```
- **Batch:** 15 clips/batch, sleep 1.5s giữa batches (tránh RAM spike)

#### `CheckTrackConflicts`
Kiểm tra xung đột clip trên track.
```json
// Request
{ "func": "CheckTrackConflicts", "filePath": "...", "trackIndex": "4" }
// Response
{ "hasConflicts": true, "conflictingClips": [...], "totalConflicts": 5 }
```

---

### 🟠 Template

#### `CreateTemplateSet`
Tạo folder template trong Media Pool.
```json
// Request
{ "func": "CreateTemplateSet", "templateNames": ["Title 1", "Title 2", "Title 3"] }
// Response
{ "success": true, "results": [{ "name": "Title 1", "status": "created" }] }
```

---

### 🔴 Audio Export

#### `ExportAudio`
Bắt đầu xuất audio từ timeline (non-blocking).
```json
// Request
{ "func": "ExportAudio", "outputDir": "/Users/me/Downloads", "inputTracks": ["1"] }
// Response
{ "started": true }
```

#### `GetExportProgress`
Poll tiến trình xuất audio.
```json
// Response
{ "progress": 65.5, "completed": false }
// Hoặc khi xong:
{ "progress": 100, "completed": true, "audioInfo": { "path": "...", "offset": 0 } }
```

#### `CancelExport`
Hủy xuất audio.
```json
{ "func": "CancelExport" }
```

---

### 🟣 Motion Effects & Color

#### `ApplyMotionEffects`
Thêm hiệu ứng chuyển động cho clips.
```json
{
  "func": "ApplyMotionEffects",
  "trackIndex": "1", "effectType": "zoom", 
  "intensity": 1.1, "fadeDuration": 0.5
}
```

#### `AutoColorScan`
Quét tất cả clip trên timeline để chuẩn bị color grading.

#### `AutoColorApplyCDL`
Apply CDL correction cho 1 clip.

#### `AutoColorApplyBatch`
Apply CDL cho nhiều clip cùng lúc.

#### `AutoColorBackup`
Duplicate timeline làm backup trước khi color grade.

---

### 🔵 Khác

#### `GetTrackClipNumbers`
Quét track → trả về danh sách clip + time ranges.
```json
// Request
{ "func": "GetTrackClipNumbers", "trackIndex": "1" }
// Response
{
  "clipNumbers": [1, 2, 3, 5],
  "clipRanges": [
    { "start": 0, "endTime": 5.5, "name": "scene_1.mp4" },
    ...
  ],
  "totalClips": 4
}
```

#### `GeneratePreview`
Render preview subtitle.
```json
{ "func": "GeneratePreview", "speaker": {...}, "templateName": "...", "exportPath": "..." }
```

#### `AutoRelinkMedia`
Relink clip bị offline trong Media Pool.
```json
// Request
{ "func": "AutoRelinkMedia", "folderPath": "/Users/me/Desktop/Auto_media" }
// Response
{ "success": true, "relinkedCount": 5, "offlineCount": 0 }
```

---

## 3. Error Handling

Mọi response lỗi đều có format:
```json
{ "error": true, "message": "Mô tả lỗi" }
```

Frontend check:
```typescript
const result = await addMediaToTimeline(clips, trackIndex);
if (result.error) {
    setErrorMessage("Lỗi: " + result.message);
}
```
