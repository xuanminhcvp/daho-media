# 📦 CapCut Auto Import — Tài liệu kỹ thuật cho Daho Media

> Mục tiêu: Tự động tạo CapCut Draft có đầy đủ Footage + Nhạc nền + SFX + Subtitle + Transitions + Khung phim + Text Template + Keyframe Zoom canh đúng timeline, rồi mở bằng CapCut để export TikTok/Reels/Shorts.

---

## 1. Tổng quan kiến trúc

### 1.1 Cách CapCut lưu dự án trên macOS (v8.3.0+)

```
~/Movies/CapCut/User Data/Projects/com.lveditor.draft/
└── <TÊN_DỰ_ÁN>/
    ├── draft_info.json          ← QUAN TRỌNG: Toàn bộ Timeline + Materials
    ├── draft_info.json.bak      ← Bản backup tự động
    ├── draft_meta_info.json     ← Metadata + danh sách file media
    ├── draft_settings           ← Cài đặt canvas (resolution, fps)
    ├── Timelines/
    │   ├── project.json         ← Chứa project ID + timeline ID (⚠️ PHẢI UNIQUE)
    │   └── <UUID>/
    │       ├── draft_info.json  ← ⚠️ Phải ĐỒNG BỘ với file root
    │       └── draft_info.json.bak
    ├── Resources/
    ├── subdraft/                ← Clip ghép (compound clip)
    └── ...
```

### 1.2 CapCut Cache trên macOS

```
CapCut App Store (sandbox):
  ~/Library/Containers/com.lemon.lvoverseas/Data/Movies/CapCut/User Data/Cache/effect/

CapCut Website (non-sandbox):
  ~/Library/Application Support/CapCut/User Data/Cache/effect/

Fallback chung:
  ~/Movies/CapCut/User Data/Cache/effect/
```

> ⚠️ App quét cả 3 paths khi tìm preview images — hỗ trợ mọi cách cài CapCut.

---

## 2. ⚠️ BẪY CHẾT NGƯỜI — Các lỗi sẽ khiến project KHÔNG MỞ ĐƯỢC

### 2.1 UUID PHẢI UNIQUE giữa các project

> **Đây là lỗi nghiêm trọng nhất.** Nếu copy template mà không đổi UUID → CapCut bị conflict → không mở project.

Có **4 UUID cần khác nhau** giữa mọi project:

| UUID | Nằm ở đâu | Quan hệ |
|------|-----------|---------|-
| `timeline_id` | `Timelines/<UUID>/` (tên folder) | = `draft_info.json.id` = `project.json.main_timeline_id` |
| `project_id` | `project.json.id` | Unique per project |
| `draft_id` | `draft_meta_info.json.draft_id` | Unique per project |
| Timeline entry | `project.json.timelines[0].id` | = `timeline_id` |

```python
# ✅ ĐÚNG: Tạo UUID mới cho MỌI project
new_timeline_id = str(uuid.uuid4()).upper()
new_project_id = str(uuid.uuid4()).upper()
new_draft_id = str(uuid.uuid4()).upper()

# Rename folder Timelines/<old_uuid> → Timelines/<new_timeline_id>
os.rename(old_tl_dir, new_tl_dir)

# draft_info.json.id = new_timeline_id (KHÔNG PHẢI new_draft_id!)
draft["id"] = new_timeline_id

# project.json
project["id"] = new_project_id
project["main_timeline_id"] = new_timeline_id
project["timelines"][0]["id"] = new_timeline_id

# draft_meta_info.json
meta["draft_id"] = new_draft_id
```

### 2.2 Material phải có ĐẦY ĐỦ fields (65/62/125 keys)

> **Lỗi phổ biến:** Chỉ truyền 10-15 fields cốt lõi → CapCut crash khi parse.

CapCut v8.3.0 yêu cầu:
- **Video material**: **65 keys** (id, path, duration, crop, matting, video_algorithm, beauty_face_auto_preset...)
- **Audio material**: **62 keys** (id, path, duration, wave_points, tone_speaker, copyright_limit_type...)
- **Text material**: **125 keys** (id, content, font, shadow, background, single_char_bg...)
- **Segment**: **50 keys** (id, material_id, timerange, render_timerange, source, state, enable_hsl...)

**Giải pháp duy nhất đúng: CLONE từ template + override id/path/timing.**

```python
# ✅ ĐÚNG: Deep clone từ project mẫu
import copy
mat = copy.deepcopy(REFERENCE_VIDEO_MATERIAL)
mat['id'] = new_id
mat['local_material_id'] = new_id
mat['path'] = actual_file_path
mat['duration'] = duration_us

# ❌ SAI: Build thủ công 14 fields → CapCut crash
mat = {"id": new_id, "path": file_path, "duration": dur, ...}  # THIẾU 51 FIELDS!
```

### 2.3 Bug video thừa timeline: Micro-segments

> **Lỗi đã fix:** AI matching trả về ~35 segment ngắn ≈0.042s. Logic fill-gaps kéo giãn từng segment → video thừa ~72s so với voice over.

**Fix:** Ngưỡng `MIN_CLIP_DURATION = 0.5s` — segment nào < 0.5s → gộp vào clip liền kề thay vì tạo clip riêng.

```typescript
// auto-media-service.ts — Gộp clip ngắn
const MIN_CLIP_DURATION = 0.5 // giây
for (let i = clips.length - 1; i > 0; i--) {
    if ((clips[i].endTime - clips[i].startTime) < MIN_CLIP_DURATION) {
        clips[i - 1].endTime = clips[i].endTime  // Gộp vào clip trước
        clips.splice(i, 1)                        // Xoá clip ngắn
    }
}
```

### 2.4 Segment bắt buộc 50 fields — 17 fields hay bị quên

Ngoài các field cơ bản (id, material_id, timerange...), segment **bắt buộc** phải có:

```json
{
    "caption_info": null,
    "color_correct_alg_result": "",
    "desc": "",
    "digital_human_template_group_id": "",
    "enable_adjust_mask": true,
    "enable_color_adjust_pro": false,
    "enable_hsl": true,
    "enable_hsl_curves": true,
    "enable_mask_shadow": false,
    "enable_mask_stroke": false,
    "enable_video_mask": true,
    "is_loop": false,
    "lyric_keyframes": null,
    "raw_segment_id": "",
    "render_timerange": {"start": 0, "duration": 0},
    "source": "segmentsourcenormal",
    "state": 0
}
```

> Thiếu bất kỳ field nào trong 17 cái trên → CapCut hiện project trong list nhưng **KHÔNG MỞ ĐƯỢC**.

### 2.5 Các field đồng bộ khác

```
draft_info.json.id            = Timelines/<UUID>.folder_name
                              = project.json.main_timeline_id
                              = project.json.timelines[0].id

draft_info.json (root)        = Timelines/<UUID>/draft_info.json (cùng content)

draft_info.json.duration      = draft_meta_info.json.tm_duration
```

### 2.6 Video track PHẢI có `attribute: 1`

```typescript
// buildTrack() — attribute: 1 cho video track
if (type === 'video') {
    track.attribute = 1
}
```

> Thiếu `attribute: 1` → CapCut không nhận diện track video → footage/ảnh không hiển thị.

---

## 3. Hệ thống tính giờ trong CapCut

> **CapCut dùng đơn vị MICROSECOND (µs) cho toàn bộ timeline.**

| Giây | Microsecond |
|------|-------------|
| 1s   | 1,000,000 µs |
| 5s   | 5,000,000 µs |
| 10s  | 10,000,000 µs |

```
Footage A bắt đầu tại giây 0, kéo dài 4 giây:
  target_timerange = { "start": 0, "duration": 4000000 }

SFX nảy lên tại giây 4, kéo dài 2 giây:
  target_timerange = { "start": 4000000, "duration": 2000000 }
```

---

## 4. Phương pháp Clone-and-Override (Chuẩn)

### 4.1 File template material mẫu

App ship file `resources/capcut_template/material_templates.json` chứa 1 mẫu cho mỗi loại:

```
material_templates.json
├── video_material (65 keys)
├── audio_material (62 keys)
├── text_material (125 keys)
├── video_segment (50 keys)
├── audio_segment (50 keys)
├── text_segment (50 keys)
├── speed (5 keys)
├── sound_channel_mapping (4 keys)
├── loudness (6 keys)
└── vocal_separation (8 keys)
```

### 4.2 Workflow tạo project

```
1. Copy template folder → thư mục CapCut Drafts
2. Tạo 3 UUID mới (timeline, project, draft)
3. Rename folder Timelines/<old> → Timelines/<new_timeline_id>
4. Với mỗi clip/audio/text:
   a. Deep clone material template tương ứng
   b. Override: id, path, duration, name
   c. Deep clone segment template tương ứng  
   d. Override: id, material_id, target_timerange, source_timerange
   e. Clone speed/channel/loudness/vocal_sep (mỗi cái cần id unique)
   f. Liên kết segment.extra_material_refs = [speed_id, channel_id, ...]
5. Inject effects (nếu user bật):
   - Mute video tracks → volume = 0.0
   - Keyframe Zoom (Ken Burns) → KFTypeScaleX/Y
   - Transitions giữa video segments
   - Video Effect (khung phim) → track riêng phủ toàn timeline
   - Text Template → gắn vào text material combo_info
6. Gộp tất cả vào draft_info.json:
   - tracks[] = video tracks + audio tracks + text tracks + effect track
   - materials = videos, audios, texts, speeds, transitions, video_effects,
                 text_templates, material_animations, canvases...
   - duration = max(end_time) * 1_000_000
   - id = new_timeline_id
7. Sync: ghi draft_info.json vào cả root + Timelines/<uuid>/
8. Cập nhật project.json — id, main_timeline_id
9. Cập nhật draft_meta_info.json — draft_name, draft_id, tm_duration
```

### 4.3 Override map cho mỗi loại

**Video/Footage material:**
```python
override = {
    'id': new_id,
    'local_material_id': new_id,
    'path': absolute_file_path,    # ⚠️ Phải là đường dẫn tuyệt đối
    'duration': duration_us,
    'width': 1920,
    'height': 1080,
    'material_name': filename,
}
```

**Audio material (BGM / SFX / Voice Over):**
```python
override = {
    'id': new_id,
    'local_material_id': new_id,
    'path': absolute_file_path,
    'name': filename,
    'duration': duration_us,
}
```

**Text material (Subtitle):**
```python
override = {
    'id': new_id,
    'content': json.dumps({"text": "...", "styles": [...]}),
}
```

**Segment (tất cả loại):**
```python
override = {
    'id': new_id,
    'material_id': parent_material_id,
    'target_timerange': {"start": start_us, "duration": dur_us},
    'source_timerange': {"start": src_start_us, "duration": dur_us},
    'extra_material_refs': [speed_id, channel_id, ...],  # phụ thuộc loại
    'volume': volume_value,  # cho audio
}
```

---

## 5. Track layout chuẩn cho Auto Media

```
Track 0: type=video   → Ảnh AI / Video chính (V1) — attribute: 1
Track 1: type=video   → Footage B-roll (V2) — attribute: 1
Track 2: type=audio   → Voice Over giọng đọc (volume 1.0) 
Track 3: type=audio   → BGM nhạc nền (volume 0.3-0.5)
Track 4: type=audio   → SFX hiệu ứng (volume 1.0)
Track 5: type=text    → Phụ đề subtitle (y position = -0.73)
Track 6: type=effect  → Video effect / khung phim (optional)
```

---

## 6. Materials phụ trợ bắt buộc

Mỗi **video segment** cần:
- 1 `speed` material → `extra_material_refs[0]`
- 1 `sound_channel_mapping` → `extra_material_refs[1]`

Mỗi **audio segment** cần:
- 1 `sound_channel_mapping` → `extra_material_refs[0]`
- 1 `loudness` → `extra_material_refs[1]`
- 1 `vocal_separation` → `extra_material_refs[2]`

Mỗi **text segment**:
- 1 `material_animation` (sticker_animation) → `extra_material_refs[0]`

---

## 7. 🆕 Advanced Effects (CapCut Draft Injection)

### 7.1 Mute Video

Khi user bật "Tắt tiếng video/footage":
```typescript
// Đặt volume = 0.0 cho video track segments
if (muteVideo) {
    videoSeg.volume = 0.0
}
```

### 7.2 Keyframe Zoom (Ken Burns Effect)

Zoom dần từ 100% → 135% (hoặc user chọn) trong suốt mỗi clip, tạo chuyển động tự nhiên:

```typescript
// Keyframe zoom: 2 keyframe (đầu clip + cuối clip)
// Dùng KFTypeScaleX / KFTypeScaleY
const randomVariation = 1.0 + (Math.random() * 0.1 - 0.05) // ±5% random
const endScale = zoomLevel * randomVariation

const kf_start = { time_offset: 0, values: [1.0] }       // 100% đầu clip
const kf_end   = { time_offset: durationUs, values: [endScale] }  // 135% cuối clip
```

> Random ±5% giữa các clips → tránh nhàm chán.

### 7.3 Transitions (Chuyển cảnh)

Inject transitions giữa các video segments:

```typescript
// Transition material — clone từ draft cũ (có đủ fields)
const transitionMat = {
    id: new_id,
    effect_id: user_selected_transition_id,
    resource_id: user_selected_transition_id,
    name: "Kéo vào",
    type: 'transition',
    path: cache_path,
    duration: 466666,  // ~0.47 giây
    // ... thêm nhiều fields khác
}
```

### 7.4 Video Effects (Khung phim)

Tạo 1 track `effect` riêng → 1 segment phủ toàn bộ timeline:

```typescript
// Effect track — apply toàn timeline
const effectSeg = {
    material_id: videoEffectMat.id,
    target_timerange: { start: 0, duration: totalDuration },
}
allTracks.push(buildTrack('effect', [effectSeg]))
```

### 7.5 Text Templates (Template phụ đề)

Gắn template phụ đề đòi hỏi phải tạo liên kết bằng `text_info_resources` từ bên trong đối tượng Template, trỏ VỀ dòng phụ đề (KHÔNG gán trực tiếp vào file subtitle gốc):

```typescript
// Text template material
const textTplMat = {
    id: new_id,
    effect_id: user_selected_template_id,
    name: "Khung viền xanh", 
    type: 'text_template_subtitle',
    // Sợi chỉ buộc chặt vào phụ đề:
    text_info_resources: [{
        id: generateId(),
        attach_info: { 
            start_time: 0, 
            duration: secToUs(subEnd - subStart), 
            clip: { scale: { x: 1.0, y: 1.0 }}
        },
        text_material_id: subtitle_mat_id, // Quan trọng: trỏ về ID của dòng phụ đề text!
    }],
    // ...
}

// ❌ SAI LẦM: Không gán trực tiếp vào combo_info của text material (làm crash project)
// mat.combo_info.text_templates = [{ id: textTplMat.id }]
```

---

## 8. 🆕 CapCut Cache Scanner (`capcut-cache-scanner.ts`)

### 8.1 Cách hoạt động

```
[scanCapCutCache()]
    │
    ├─ Kiểm tra cache store → có kết quả cũ? → Dùng ngay (không IO)
    │
    ├─ Sort draft folders theo tên giảm dần (MMDD format)
    ├─ Chỉ lấy 10 draft gần nhất → tránh quét hết
    │
    ├─ Đọc draft_info.json mỗi draft:
    │   ├─ materials.transitions → collect effect_id, name, path, duration
    │   ├─ materials.video_effects → collect effect_id, name, path
    │   └─ materials.text_templates → collect effect_id, name, path
    │
    ├─ findPreviewImages() → quét 3 cache folder paths (fallback)
    │
    ├─ Cache kết quả → plugin-store (capcut-effects.json)
    │
    └─ scanStatus: 'ok' | 'capcut_not_installed' | 'no_drafts' | 'cached'
```

### 8.2 AI Việt hoá tên

- Tự động chạy sau scan (background, không block UI)
- Phát hiện tên Trung Quốc (CJK `[\u4e00-\u9fff]`) hoặc thuần Latin → gọi Gemini AI dịch
- Kết quả lưu vào `customNames` → nhớ lần sau, không gọi AI lại
- Unique check: nếu trùng tên → thêm (1), (2)

### 8.3 Canvas Text Preview

Vì CapCut **KHÔNG lưu preview images local** (render realtime từ shader):
- App tạo CanvasTextPreview component → render tên effect lên canvas 64×36px
- Mỗi effect có **màu gradient riêng** (hash từ effectId → 8 palettes)
- Glow effect giả lập style CapCut
- Tự truncate nếu tên quá dài

---

## 9. 🆕 UI: CapCut Effects Settings Panel

### 9.1 Component: `capcut-effects-settings.tsx`

Hiện khi user chọn CapCut mode trong Auto Media panel:

```
⚙️ CapCut Effects [T·E·S·Z·M]    ▼
┌──────────────────────────────────┐
│ 🎬 Chuyển cảnh                   │  ← Combobox + search
│ [Kéo vào              × ]       │
│                                  │
│ 🎞️ Khung hình                    │  ← Combobox + search
│ [Không dùng           ▼ ]       │
│                                  │
│ ✏️ Template phụ đề               │  ← Combobox + search + canvas preview
│ [Khung viền xanh      × ]       │
│                                  │
│ 🔍 Zoom in          135%  [ON]  │  ← Toggle + slider 110-150%
│ ▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░          │
│                                  │
│ 🔇 Tắt tiếng video     [ON]    │  ← Toggle
│                                  │
│ 🔄 Quét cache  🤖 Việt hoá  8fx │  ← Action buttons
│ ⚠️ helpful message if needed    │
└──────────────────────────────────┘
```

### 9.2 Data flow

```
UI (capcut-effects-settings.tsx)
  │
  ├─ onMount → loadEffectsSettings() → hydrate state
  ├─ onMount → scanCapCutCache(false) → dùng cache nếu có
  ├─ Auto Việt hoá → generateVietnameseNames() [background]
  │
  ├─ onChange → updateSettings() → auto saveEffectsSettings()
  ├─ onChange → onSettingsChange(resolved) → parent ref
  │
  └─ Parent (auto-media-panel.tsx)
      ├─ capCutEffectsRef.current = resolved settings
      └─ deps.capCutEffectsSettings = { effectId, cachePath, name, ... }
          └─ generateCapCutDraft(input) → inject effects vào draft_info.json
```

### 9.3 Settings persistence

```
capcut-effects.json (plugin-store)
├── capcut_effects_settings:
│   ├── transitionEffectId: string
│   ├── videoEffectId: string
│   ├── textTemplateEffectId: string
│   ├── zoomEnabled: boolean (default: true)
│   ├── zoomLevel: number (default: 1.35)
│   ├── muteVideo: boolean (default: true)
│   └── customNames: { effectId → viName }
│
└── capcut_scan_cache:
    ├── transitions: CachedEffect[]
    ├── videoEffects: CachedEffect[]
    ├── textTemplates: CachedEffect[]
    └── scannedAt: timestamp (ms)
```

---

## 10. macOS Sandbox & Liên kết media

- CapCut Mac chạy sandbox → không tự truy cập `~/Downloads`
- Lần đầu mở project → bấm **"Liên kết tệp phương tiện"** → chọn folder chứa media
- CapCut nhớ quyền, không cần làm lại cho folder đã grant
- Đường dẫn trong material **phải là absolute path** (không relative)
- App dùng `homeDir()` API Tauri → **đường dẫn động** trên mọi máy Mac

---

## 11. Checklist tạo CapCut Draft tự động

- [x] Template project trắng ship trong `resources/capcut_template/`
- [x] Material templates (65/62/125 keys) ship trong `material_templates.json`
- [x] Clone material + override id/path/duration (KHÔNG build thủ công)
- [x] Clone segment + override id/material_id/timerange (50 keys đầy đủ)
- [x] Tạo 3 UUID unique mới: timeline_id, project_id, draft_id
- [x] Rename folder `Timelines/<old>` → `Timelines/<new_timeline_id>`
- [x] `draft_info.json.id` = `timeline_id` (KHÔNG phải draft_id)
- [x] `project.json.main_timeline_id` = `timeline_id`
- [x] Sync `draft_info.json` cả root + Timelines/
- [x] `draft_meta_info.json` cập nhật draft_name, draft_id, tm_duration
- [x] Overwrite mode: merge `tracks` theo `type` (không replace trắng)
- [x] Overwrite mode: giữ `audio/text` tracks cũ nếu request mới chỉ gửi `video`
- [x] Overwrite mode: merge `materials.*` theo `id` để không rớt reference media
- [x] Overwrite mode: merge `draft_meta_info.draft_materials[type=0].value` theo `id/file_Path`
- [x] Preserve `subtitle_cache_info` khi ghi đè draft nguồn
- [x] Mọi đường dẫn file media là absolute path (dynamic via `homeDir()`)
- [x] Mọi duration tính bằng microsecond (× 1,000,000)
- [x] Video track có `attribute: 1`
- [x] Micro-segments < 0.5s được gộp (fix bug video thừa)
- [x] Mute video tracks (volume = 0.0) — tuỳ chọn
- [x] Keyframe Zoom (Ken Burns) — tuỳ chọn, slider 110-150%
- [x] Transitions giữa video segments — tuỳ chọn, combobox
- [x] Video Effect (khung phim) track — tuỳ chọn, combobox
- [x] Text Template gắn vào subtitle — tuỳ chọn, combobox + canvas preview
- [x] Cache scanner quét 10 draft gần nhất + cache kết quả
- [x] Auto Việt hoá tên effects (AI background, không block)
- [x] Fallback 3 cache paths (App Store + Website + Movies)

---

## 12. Kiến trúc trong Daho Media App

```
[Auto Media Pipeline]
    │
    ├─ AI Match: Image + Footage + Music + SFX + Subtitle
    │     └─ Output: clips[], bgm[], sfx[], subtitles[]
    │     └─ Fix: micro-segments < 0.5s gộp vào clip liền kề
    │
    ├─ capcut-effects-settings.tsx (UI Panel)
    │     ├─ Combobox chọn transition / khung phim / text template
    │     ├─ Canvas text preview (hash-based color)
    │     ├─ Slider zoom + toggles mute/zoom
    │     ├─ Auto Việt hoá tên (AI background)
    │     └─ Settings persist qua plugin-store
    │
    ├─ capcut-cache-scanner.ts (Scanner Service)
    │     ├─ Quét 10 draft gần nhất
    │     ├─ Cache kết quả → không quét lại mỗi lần
    │     ├─ Fallback 3 cache paths (App Store/Website/Movies)
    │     └─ AI naming + unique check
    │
    ├─ capcut-draft-service.ts (Draft Builder)
    │     ├─ Load material_templates.json
    │     ├─ Clone + override cho từng clip
    │     ├─ Inject: mute, zoom keyframes, transitions, video effects, text templates
    │     ├─ Build tracks + materials JSON
    │     └─ Gọi Rust command: create_capcut_draft
    │
    ├─ capcut.rs (Rust backend)
    │     ├─ Copy template folder → ~/Movies/CapCut/Drafts/
    │     ├─ Tạo UUIDs mới, rename Timelines folder
    │     ├─ Merge materials arrays (dynamic keys) vào draft_info.json
    │     ├─ Sync root + Timelines/ + draft_meta_info
    │     └─ Return project_path
    │
    └─ Output: Project sẵn sàng trong CapCut
```

---

## 13. Schema version compatibility

| Phiên bản | File chính | Template |
|-----------|-----------|---------| 
| v3-v5 | `draft_content.json` | pyCapCut (cũ) |
| v8.3.0+ | `draft_info.json` + `Timelines/` | Clone từ project thật |

> **QUAN TRỌNG:** Khi CapCut update → cần tạo project trắng mới → export lại `material_templates.json`. Schema có thể thay đổi giữa các bản.

---

## 14. Troubleshooting

| Vấn đề | Nguyên nhân | Fix |
|--------|-------------|-----|
| Project không mở | UUID trùng / thiếu 17 segment fields | Kiểm tra 4 UUID unique + 50 fields segment |
| Video thừa timeline | Micro-segments bị fill-gaps kéo giãn | `MIN_CLIP_DURATION = 0.5s` gộp clips |
| Không có effects chọn | User mới, chưa dùng effects trong CapCut | Hướng dẫn: tạo 1 project → thêm effects → save |
| CapCut chưa cài | Folder drafts không tồn tại | `scanStatus: 'capcut_not_installed'` + thông báo UI |
| Preview images thiếu | CapCut render realtime, không lưu ảnh | Canvas text preview thay thế |
| Tên effects tiếng Trung | CapCut gốc Trung Quốc | Auto AI Việt hoá sau scan |
| Template resource thiếu | Build app quên bundle `resources/capcut_template/` | Check `tauri.conf.json > resources` |
| Overwrite xong mất VO/subtitle + báo Unsupported media | Replace trắng `tracks/materials/draft_materials` làm lệch liên kết id/path | Đổi sang merge: `tracks` theo type + `materials` theo id + `draft_materials` theo id/file_Path |

## 15. Kỷ yếu fix lỗi: Pipeline Stalls & Bộ nhớ ảo

### 15.1 Payload Limit (Tauri IPC chặn WebKit)
- **Vấn đề**: File `draft_info.json` của CapCut (nhất là video dài) phình to >15MB. Hàm đọc file bằng Webview của Tauri `readTextFile` đi qua chuẩn IPC Payload bắn lỗi Out Of Memory hoặc Data Format Error.
- **Giải pháp**: Xây dựng lại lệnh quét bộ nhớ ở tầng Rust `scan_capcut_cache_rust`. Backend đọc siêu tốc và chỉ nén xuất ra những ID Transition/Text Template thay vì chuyển nguyên file dung lượng khủng lên TypeScript.

### 15.2 Lỗi Mất tích "Kéo vào" (Masking Deduplication Bug)
- **Vấn đề**: Nếu làm video thủ công, một loại chuyển cảnh dùng trên 600 cuts sẽ đẻ ra 600 cái `transitions` mang chung một ID. Giao diện Filter sẽ quét và gom lại lấy 1 cái. Tuy nhiên, nếu bot Auto Media vừa đẻ ra draft mẫu có tên "Transition", bộ lọc TypeScript sẽ ưu tiên giữ tên "Transition" đầu tiên vào làm key, và ném hết tất cả các dự án tìm thấy sau đó có chữ "Kéo vào" chính hãng đi! Do trùng ID nhưng sai tên!
- **Giải pháp**: Thuật toán `Map.set` giờ đây tích hợp sẵn blacklist nhận dạng rác `['Transition', 'Video Effect', 'Chuyển cảnh']`. Nếu tên đang lưu trong map là rác, nó tự động **Ghi đè (Overwrite)** bằng tên tiếng Việt cực chuẩn moi được từ các draft cũ hơn của người dùng.

### 15.3 Permissions Tauri & Error Hidden Folders
- **Vấn đề**: Hàm `fs.readDir` của hệ thống thỉnh thoảng sẽ gặp cảnh báo đỏ `forbidden path` khi quét trúng một số thư mục khởi đầu bằng dấu chấm (`.cloud_cache_xxx`, `.recycle_bin`). Đây là do chính sách an ninh File-System của Tauri không cho phép chạm vào thư mục hệ thống trừ phi người dùng xin quyền Explicit Scope.
- **Giải pháp**: Cảnh báo này đã được Try-Catch ôm trọn nên không throw văng app. Tuy nhiên để làm sạch bóng Debugger Console, chúng ta có thể chèn dòng `if(entry.name.startsWith('.')) continue;` vào vòng lặp `for (const entry of entries)` trong file cấu hình quét là an toàn và tuyệt đối sạch sẽ rác Console.

### 15.4 Overwrite Draft an toàn (Fix mất VO/Sub + Unsupported media)
- **Triệu chứng thực tế**:
  - Pipeline log báo đã ghi đúng số clip (ví dụ 189 ảnh + 5 footage),
  - nhưng mở CapCut thấy mất VO/subtitle hoặc hiện `Unsupported media`.
- **Nguyên nhân gốc**:
  - Backend overwrite theo kiểu replace trắng:
    - `root_data["tracks"] = tracks.clone()`
    - `materials` bị ghi đè từng mảng
    - `draft_meta_info.draft_materials` bị set mới hoàn toàn
  - Hậu quả:
    - request mới chỉ có video -> audio/text track cũ biến mất,
    - liên kết giữa `tracks ↔ materials ↔ draft_materials` bị lệch -> CapCut coi media là unsupported.
- **Giải pháp đã áp dụng**:
  - Merge `tracks` theo `type`:
    - nếu request có type nào thì thay type đó,
    - type không gửi lên (audio/text) giữ nguyên track cũ.
  - Merge `materials` theo `id`:
    - id trùng -> update,
    - id mới -> append,
    - không làm mất materials cũ đang được segment tham chiếu.
  - Merge `draft_meta_info.draft_materials[type=0].value` theo `id`, fallback `metetype + file_Path`.
  - Preserve `subtitle_cache_info` trong overwrite mode để không mất nguồn word timing cho lần chạy sau.
- **Luồng API (dễ hiểu)**:
  - Request frontend gửi vào `create_capcut_draft`:
    - `projectName`, `targetDraftPath`, `draftData`, `metaMaterials`, `totalDuration`.
  - Backend xử lý:
    - đọc draft cũ -> merge dữ liệu mới vào đúng phần -> ghi lại root + timeline + meta.
  - Response trả về:
    - `project_path`: đường dẫn draft vừa ghi,
    - `project_name`: tên draft thực tế.
- **Cách verify nhanh sau khi ghi**:
  - `tracks` còn đủ type cần giữ (`audio`, `text`) nếu request không thay các type này.
  - `segments.material_id` và `extra_material_refs` đều tồn tại trong `materials.*.id`.
  - `draft_meta_info.draft_materials[type=0]` còn media cũ + có media mới.
  - `materials.videos[].path` tồn tại thật trên disk.
- **Test đã chạy**:
  - `cargo check` pass.
  - Unit test overwrite merge pass:
    - `test_overwrite_merge_keeps_audio_text_and_meta_materials` (đảm bảo không mất audio/text/materials/meta khi request mới chỉ có video).

---

*Tài liệu được tổng hợp từ reverse-engineering + test thực tế trên CapCut Mac v8.3.0.*
*Cập nhật: 04/2026 — Thêm: Text Template attach_info injection, Khắc phục Masking Deduplication Bug, Chống tràn bộ IPC bằng Rust Backend, Fix overwrite draft giữ VO/Sub và đồng bộ tracks-materials-meta.*
