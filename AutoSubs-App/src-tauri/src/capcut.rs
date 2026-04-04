// capcut.rs
// Rust backend command để tạo CapCut Draft project
// Copy template folder → inject draft_info.json → sync Timelines/

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;
use tauri::Manager;
use std::collections::{HashMap, HashSet};

/// Lấy đường dẫn CapCut Drafts trên macOS
fn get_capcut_drafts_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Không tìm được thư mục home")?;
    let drafts_dir = home
        .join("Movies")
        .join("CapCut")
        .join("User Data")
        .join("Projects")
        .join("com.lveditor.draft");

    if !drafts_dir.exists() {
        return Err(format!(
            "Thư mục CapCut Drafts không tồn tại: {}",
            drafts_dir.display()
        ));
    }
    Ok(drafts_dir)
}

/// Copy toàn bộ thư mục (recursive)
fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("Không tạo được thư mục {}: {}", dst.display(), e))?;

    for entry in fs::read_dir(src).map_err(|e| format!("Không đọc được thư mục {}: {}", src.display(), e))? {
        let entry = entry.map_err(|e| format!("Lỗi đọc entry: {}", e))?;
        let file_type = entry.file_type().map_err(|e| format!("Lỗi file_type: {}", e))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if file_type.is_dir() {
            copy_dir_all(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path).map_err(|e| {
                format!("Không copy được {} -> {}: {}", src_path.display(), dst_path.display(), e)
            })?;
        }
    }
    Ok(())
}

/// Tìm thư mục Timelines/<UUID>/ bên trong project
fn find_timeline_uuid_dir(project_dir: &Path) -> Option<PathBuf> {
    let timelines_dir = project_dir.join("Timelines");
    if !timelines_dir.exists() {
        return None;
    }
    // Tìm folder con có tên dạng UUID (dài > 10 ký tự)
    if let Ok(entries) = fs::read_dir(&timelines_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.len() > 10 && entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                return Some(entry.path());
            }
        }
    }
    None
}

/// Tìm `subtitle_cache_info` hợp lệ trong JSON (có sentence_list không rỗng), hỗ trợ tìm đệ quy.
fn find_subtitle_cache_info(value: &Value) -> Option<Value> {
    // Trường hợp key nằm trực tiếp ở node hiện tại
    if let Some(cache) = value.get("subtitle_cache_info") {
        if cache
            .get("sentence_list")
            .and_then(|v| v.as_array())
            .map(|arr| !arr.is_empty())
            .unwrap_or(false)
        {
            return Some(cache.clone());
        }
    }

    // Duyệt đệ quy object
    if let Some(obj) = value.as_object() {
        for (_, v) in obj {
            if let Some(found) = find_subtitle_cache_info(v) {
                return Some(found);
            }
        }
    }

    // Duyệt đệ quy array
    if let Some(arr) = value.as_array() {
        for v in arr {
            if let Some(found) = find_subtitle_cache_info(v) {
                return Some(found);
            }
        }
    }

    None
}

/// Đọc `draft_info.json` từ path và cố gắng lấy `subtitle_cache_info`.
fn read_subtitle_cache_from_draft_info(path: &Path) -> Option<Value> {
    let content = fs::read_to_string(path).ok()?;
    let json: Value = serde_json::from_str(&content).ok()?;
    find_subtitle_cache_info(&json)
}

/// Lấy "key type" của track để merge theo loại track.
/// Nếu thiếu type thì dùng "__unknown__" để vẫn có key ổn định.
fn get_track_type_key(track: &Value) -> String {
    track
        .get("type")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "__unknown__".to_string())
}

/// Merge tracks theo type:
/// - Giữ track cũ nếu type đó KHÔNG xuất hiện trong request mới.
/// - Nếu request mới có type đó -> thay toàn bộ track cũ cùng type bằng track mới.
/// Flow này giúp giữ VO/subtitle cũ khi request chỉ gửi video tracks.
fn merge_tracks_by_type(existing_tracks: &[Value], incoming_tracks: &[Value]) -> Vec<Value> {
    let incoming_types: HashSet<String> = incoming_tracks
        .iter()
        .map(get_track_type_key)
        .collect();

    let mut merged = Vec::new();

    // Giữ lại các track cũ thuộc type không bị request mới đụng tới.
    for old_track in existing_tracks {
        let key = get_track_type_key(old_track);
        if !incoming_types.contains(&key) {
            merged.push(old_track.clone());
        }
    }

    // Append toàn bộ track mới.
    for new_track in incoming_tracks {
        merged.push(new_track.clone());
    }

    merged
}

/// Merge 2 mảng materials theo id:
/// - Có cùng id -> phần tử mới ghi đè phần tử cũ.
/// - Không có id -> append theo thứ tự.
/// Mục tiêu: giữ materials cũ để CapCut không báo Unsupported media.
fn merge_material_items(existing_items: &[Value], incoming_items: &[Value]) -> Vec<Value> {
    let mut merged = Vec::new();
    let mut id_to_index: HashMap<String, usize> = HashMap::new();

    for item in existing_items {
        let idx = merged.len();
        if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
            let key = id.trim().to_lowercase();
            if !key.is_empty() {
                id_to_index.insert(key, idx);
            }
        }
        merged.push(item.clone());
    }

    for item in incoming_items {
        if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
            let key = id.trim().to_lowercase();
            if !key.is_empty() {
                if let Some(&idx) = id_to_index.get(&key) {
                    merged[idx] = item.clone();
                    continue;
                }
                let idx = merged.len();
                merged.push(item.clone());
                id_to_index.insert(key, idx);
                continue;
            }
        }
        merged.push(item.clone());
    }

    merged
}

/// Tạo key merge cho draft_meta_info.draft_materials.value item.
/// Ưu tiên id, fallback theo metetype + file_Path để giảm duplicate.
fn meta_material_key(item: &Value) -> String {
    let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();
    if !id.is_empty() {
        return format!("id:{}", id.to_lowercase());
    }

    let media_type = item
        .get("metetype")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let file_path = item
        .get("file_Path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();

    format!("path:{}|type:{}", file_path, media_type)
}

/// Merge draft_meta_info.draft_materials.value:
/// - Giữ materials cũ
/// - Append/update materials mới
/// Trả về mảng đã merge để ghi ngược lại vào meta.
fn merge_meta_materials(existing_items: &[Value], incoming_items: &[Value]) -> Vec<Value> {
    let mut merged: Vec<Value> = existing_items.to_vec();
    let mut key_to_index: HashMap<String, usize> = HashMap::new();

    for (idx, item) in merged.iter().enumerate() {
        let key = meta_material_key(item);
        if !key.is_empty() {
            key_to_index.insert(key, idx);
        }
    }

    for item in incoming_items {
        let key = meta_material_key(item);
        if !key.is_empty() {
            if let Some(&idx) = key_to_index.get(&key) {
                merged[idx] = item.clone();
                continue;
            }
            let idx = merged.len();
            merged.push(item.clone());
            key_to_index.insert(key, idx);
        } else {
            merged.push(item.clone());
        }
    }

    merged
}

/// Tauri command: Tạo CapCut Draft project từ template + inject data
#[tauri::command]
pub async fn create_capcut_draft(
    app_handle: tauri::AppHandle,
    project_name: String,
    target_draft_path: Option<String>,
    draft_data: String,
    meta_materials: String,
    total_duration: i64,
) -> Result<serde_json::Value, String> {
    // 1) Xác định mode:
    // - target_draft_path có giá trị: ghi đè trực tiếp draft nguồn.
    // - target_draft_path trống: tạo draft mới từ template (logic cũ).
    let target_path_trimmed = target_draft_path
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let is_overwrite_mode = target_path_trimmed.is_some();

    // 2) Xác định thư mục draft đích
    let project_dir: PathBuf = if let Some(target_path) = target_path_trimmed {
        let p = PathBuf::from(target_path);
        if !p.exists() {
            return Err(format!(
                "Draft nguồn không tồn tại: {}",
                p.display()
            ));
        }
        if !p.is_dir() {
            return Err(format!(
                "Draft nguồn không phải thư mục: {}",
                p.display()
            ));
        }
        p
    } else {
        let resource_path = app_handle
            .path()
            .resource_dir()
            .map_err(|e| format!("Không lấy được resource dir: {}", e))?;
        let template_dir = resource_path.join("resources").join("capcut_template");

        if !template_dir.exists() {
            return Err(format!(
                "Template CapCut không tồn tại: {}",
                template_dir.display()
            ));
        }

        let drafts_dir = get_capcut_drafts_dir()?;
        let p = drafts_dir.join(&project_name);

        // Nếu đã tồn tại thì xoá và tạo lại từ template (giữ logic cũ)
        if p.exists() {
            fs::remove_dir_all(&p)
                .map_err(|e| format!("Không xoá được project cũ: {}", e))?;
        }
        copy_dir_all(&template_dir, &p)?;
        p
    };

    // Tên draft thực tế:
    // - Overwrite mode: giữ tên folder draft nguồn.
    // - Create mode: dùng project_name từ request.
    let effective_project_name = if is_overwrite_mode {
        project_dir
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| project_name.clone())
    } else {
        project_name.clone()
    };

    // 3. Parse draft data JSON
    let inject_data: Value =
        serde_json::from_str(&draft_data).map_err(|e| format!("Parse draft_data lỗi: {}", e))?;

    let meta_mats: Value = serde_json::from_str(&meta_materials)
        .map_err(|e| format!("Parse meta_materials lỗi: {}", e))?;

    // 4. Inject vào draft_info.json (root)
    let root_draft_path = project_dir.join("draft_info.json");
    let mut root_data: Value = if root_draft_path.exists() {
        let content = fs::read_to_string(&root_draft_path)
            .map_err(|e| format!("Không đọc được draft_info.json: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Parse draft_info.json lỗi: {}", e))?
    } else {
        return Err("draft_info.json không tồn tại trong template".to_string());
    };

    // Overwrite mode: bảo toàn word timing từ draft nguồn.
    // Lý do:
    // - Một số draft chỉ có `subtitle_cache_info` trong Timelines/<uuid>/draft_info.json
    // - Nếu ghi đè trực tiếp mà không preserve, lần chạy sau sẽ không còn nguồn word timing.
    let preserved_subtitle_cache: Option<Value> = if is_overwrite_mode {
        // 1) Ưu tiên cache ngay trong root draft_info hiện tại
        let mut found = find_subtitle_cache_info(&root_data);

        // 2) Nếu root không có, thử đọc từ timeline draft_info hiện có
        if found.is_none() {
            if let Some(tl_dir) = find_timeline_uuid_dir(&project_dir) {
                let tl_draft_path = tl_dir.join("draft_info.json");
                if tl_draft_path.exists() {
                    found = read_subtitle_cache_from_draft_info(&tl_draft_path);
                }
            }
        }
        found
    } else {
        None
    };

    // Ghi tracks, materials, duration, canvas_config
    if let Some(tracks) = inject_data.get("tracks") {
        if is_overwrite_mode {
            // Overwrite mode: merge theo type để giữ VO/subtitle/audio cũ nếu request không gửi type đó.
            let existing_tracks: Vec<Value> = root_data
                .get("tracks")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let incoming_tracks: Vec<Value> = tracks.as_array().cloned().unwrap_or_default();
            let merged_tracks = merge_tracks_by_type(&existing_tracks, &incoming_tracks);
            root_data["tracks"] = Value::Array(merged_tracks);
        } else {
            root_data["tracks"] = tracks.clone();
        }
    }
    if let Some(duration) = inject_data.get("duration") {
        root_data["duration"] = duration.clone();
    }
    if let Some(canvas) = inject_data.get("canvas_config") {
        root_data["canvas_config"] = canvas.clone();
    }

    // Merge materials:
    // - Create mode: giữ behavior cũ (mảng mới ghi đè mảng cùng key).
    // - Overwrite mode: merge theo id để không làm mất materials đang được track cũ tham chiếu.
    if let Some(mats) = inject_data.get("materials") {
        if let Some(root_mats) = root_data.get_mut("materials") {
            for (key, value) in mats.as_object().unwrap_or(&serde_json::Map::new()) {
                if value.is_array() && !value.as_array().unwrap().is_empty() {
                    if is_overwrite_mode {
                        let existing_arr: Vec<Value> = root_mats
                            .get(key)
                            .and_then(|v| v.as_array())
                            .cloned()
                            .unwrap_or_default();
                        let incoming_arr: Vec<Value> = value.as_array().cloned().unwrap_or_default();
                        let merged_arr = merge_material_items(&existing_arr, &incoming_arr);
                        root_mats[key] = Value::Array(merged_arr);
                    } else {
                        root_mats[key] = value.clone();
                    }
                }
            }
        }
    }

    // Sau khi merge timeline/materials mới, gắn lại subtitle cache cũ (nếu có).
    if let Some(cache) = preserved_subtitle_cache {
        root_data["subtitle_cache_info"] = cache;
    }

    // Create mode: tạo UUID mới để tránh xung đột project/template.
    // Overwrite mode: giữ nguyên UUID hiện có của draft nguồn.
    let mut new_draft_id: Option<String> = None;
    let mut new_timeline_id: Option<String> = None;
    let mut new_project_id: Option<String> = None;
    if !is_overwrite_mode {
        let tl = Uuid::new_v4().to_string().to_uppercase();
        let pj = Uuid::new_v4().to_string().to_uppercase();
        let dr = Uuid::new_v4().to_string().to_uppercase();
        root_data["id"] = Value::String(tl.clone());
        new_timeline_id = Some(tl);
        new_project_id = Some(pj);
        new_draft_id = Some(dr);
    }

    // Ghi draft_info.json (root)
    let root_json = serde_json::to_string(&root_data)
        .map_err(|e| format!("Serialize draft_info.json lỗi: {}", e))?;
    fs::write(&root_draft_path, &root_json)
        .map_err(|e| format!("Ghi draft_info.json lỗi: {}", e))?;
    // Ghi .bak
    let bak_path = project_dir.join("draft_info.json.bak");
    fs::write(&bak_path, &root_json).ok();

    // 5. Sync draft_info.json vào Timelines/
    // - Create mode: rename Timelines/<old_uuid> -> Timelines/<new_timeline_id> + update project.json ids.
    // - Overwrite mode: chỉ sync vào timeline dir hiện có, giữ nguyên ids.
    let timelines_base = project_dir.join("Timelines");
    if timelines_base.exists() {
        if is_overwrite_mode {
            if let Some(tl_dir) = find_timeline_uuid_dir(&project_dir) {
                fs::write(tl_dir.join("draft_info.json"), &root_json)
                    .map_err(|e| format!("Ghi Timelines draft_info.json lỗi: {}", e))?;
                fs::write(tl_dir.join("draft_info.json.bak"), &root_json).ok();
            }
        } else {
            // Tìm folder UUID cũ (template gốc)
            if let (Some(old_tl_dir), Some(new_tl_id)) =
                (find_timeline_uuid_dir(&project_dir), new_timeline_id.as_ref())
            {
                let new_tl_dir = timelines_base.join(new_tl_id);

                // Rename folder
                fs::rename(&old_tl_dir, &new_tl_dir)
                    .map_err(|e| format!("Rename Timelines folder lỗi: {}", e))?;

                // Ghi draft_info.json + .bak vào folder mới
                fs::write(new_tl_dir.join("draft_info.json"), &root_json)
                    .map_err(|e| format!("Ghi Timelines draft_info.json lỗi: {}", e))?;
                fs::write(new_tl_dir.join("draft_info.json.bak"), &root_json).ok();
            }

            // ★ Cập nhật project.json — 3 chỗ cần sửa
            let project_json_path = timelines_base.join("project.json");
            if project_json_path.exists() {
                if let Ok(pj_content) = fs::read_to_string(&project_json_path) {
                    if let Ok(mut pj_data) = serde_json::from_str::<Value>(&pj_content) {
                        if let Some(new_pj_id) = new_project_id.as_ref() {
                            pj_data["id"] = Value::String(new_pj_id.clone());
                        }
                        if let Some(new_tl_id) = new_timeline_id.as_ref() {
                            pj_data["main_timeline_id"] = Value::String(new_tl_id.clone());
                        }

                        // Cập nhật timestamps
                        let now_us = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_micros() as i64;
                        pj_data["create_time"] = Value::Number(serde_json::Number::from(now_us));
                        pj_data["update_time"] = Value::Number(serde_json::Number::from(now_us));

                        // project.json.timelines[0].id = new_timeline_id
                        if let (Some(timelines_arr), Some(new_tl_id)) =
                            (pj_data.get_mut("timelines"), new_timeline_id.as_ref())
                        {
                            if let Some(arr) = timelines_arr.as_array_mut() {
                                for tl in arr.iter_mut() {
                                    tl["id"] = Value::String(new_tl_id.clone());
                                    tl["create_time"] = Value::Number(serde_json::Number::from(now_us));
                                    tl["update_time"] = Value::Number(serde_json::Number::from(now_us));
                                }
                            }
                        }

                        if let Ok(pj_json) = serde_json::to_string(&pj_data) {
                            fs::write(&project_json_path, &pj_json).ok();
                            fs::write(project_json_path.with_extension("json.bak"), &pj_json).ok();
                        }
                    }
                }
            }
        }
    }

    // 6. Cập nhật draft_meta_info.json
    let meta_path = project_dir.join("draft_meta_info.json");
    if meta_path.exists() {
        let meta_content = fs::read_to_string(&meta_path)
            .map_err(|e| format!("Không đọc draft_meta_info.json: {}", e))?;
        let mut meta_data: Value = serde_json::from_str(&meta_content)
            .map_err(|e| format!("Parse draft_meta_info.json lỗi: {}", e))?;

        // Overwrite mode: giữ nguyên tên/ID của draft nguồn.
        // Create mode: cập nhật theo project mới.
        if !is_overwrite_mode {
            meta_data["draft_name"] = Value::String(effective_project_name.clone());
            // ★ draft_meta_info dùng draft_id (KHÁC timeline_id và project_id!)
            if let Some(new_dr_id) = new_draft_id.as_ref() {
                meta_data["draft_id"] = Value::String(new_dr_id.clone());
            }
        }
        meta_data["tm_duration"] = Value::Number(serde_json::Number::from(total_duration));
        meta_data["draft_fold_path"] = Value::String(project_dir.to_string_lossy().to_string());

        // Ghi draft_materials:
        // - Create mode: giữ behavior cũ (set mới hoàn toàn).
        // - Overwrite mode: merge với draft_materials hiện có để không làm mất reference media cũ.
        if is_overwrite_mode {
            let incoming_meta_items: Vec<Value> = meta_mats.as_array().cloned().unwrap_or_default();
            let existing_draft_materials = meta_data
                .get("draft_materials")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            let mut merged_draft_materials = existing_draft_materials.clone();
            let mut merged_into_type0 = false;

            for entry in merged_draft_materials.iter_mut() {
                let entry_type = entry.get("type").and_then(|v| v.as_i64()).unwrap_or(-1);
                if entry_type == 0 {
                    let existing_meta_items: Vec<Value> = entry
                        .get("value")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                    let merged_items = merge_meta_materials(&existing_meta_items, &incoming_meta_items);
                    entry["value"] = Value::Array(merged_items);
                    merged_into_type0 = true;
                    break;
                }
            }

            if !merged_into_type0 {
                merged_draft_materials.push(serde_json::json!({
                    "type": 0,
                    "value": incoming_meta_items
                }));
            }

            meta_data["draft_materials"] = Value::Array(merged_draft_materials);
        } else {
            meta_data["draft_materials"] = serde_json::json!([{
                "type": 0,
                "value": meta_mats
            }]);
        }

        let meta_json = serde_json::to_string(&meta_data)
            .map_err(|e| format!("Serialize draft_meta_info.json lỗi: {}", e))?;
        fs::write(&meta_path, &meta_json)
            .map_err(|e| format!("Ghi draft_meta_info.json lỗi: {}", e))?;
    }

    Ok(serde_json::json!({
        "project_path": project_dir.to_string_lossy().to_string(),
        "project_name": effective_project_name,
    }))
}

fn get_non_empty_str<'a>(obj: &'a Value, key: &str) -> Option<&'a str> {
    obj.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn get_effect_id<'a>(obj: &'a Value) -> Option<&'a str> {
    get_non_empty_str(obj, "effect_id")
        .or_else(|| get_non_empty_str(obj, "resource_id"))
}

/// Tauri command: Quét CapCut Drafts để tránh lỗi IPC size limit của Tauri FS
#[tauri::command]
pub async fn scan_capcut_cache_rust(draft_paths: Vec<String>) -> Result<serde_json::Value, String> {
    let mut transitions = Vec::new();
    let mut video_effects = Vec::new();
    let mut text_templates = Vec::new();

    for path in draft_paths {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(draft_data) = serde_json::from_str::<Value>(&content) {
                if let Some(materials) = draft_data.get("materials") {
                    
                    // Transitions
                    if let Some(trs) = materials.get("transitions").and_then(|v| v.as_array()) {
                        for tr in trs {
                            let eid = get_effect_id(tr);
                            let name = get_non_empty_str(tr, "name");
                            let path = tr.get("path").and_then(|v| v.as_str()).unwrap_or("");
                            let duration = tr.get("duration").and_then(|v| v.as_u64()).unwrap_or(466666);
                            
                            if let (Some(eid), Some(name)) = (eid, name) {
                                transitions.push(serde_json::json!({
                                    "effectId": eid,
                                    "resourceId": get_non_empty_str(tr, "resource_id").unwrap_or(eid),
                                    "originalName": name,
                                    "cachePath": path,
                                    "defaultDuration": duration,
                                }));
                            }
                        }
                    }
                    
                    // Video Effects
                    if let Some(ves) = materials.get("video_effects").and_then(|v| v.as_array()) {
                        for ve in ves {
                            let eid = get_effect_id(ve);
                            let name = get_non_empty_str(ve, "name");
                            let path = ve.get("path").and_then(|v| v.as_str()).unwrap_or("");
                            
                            if let (Some(eid), Some(name)) = (eid, name) {
                                video_effects.push(serde_json::json!({
                                    "effectId": eid,
                                    "resourceId": get_non_empty_str(ve, "resource_id").unwrap_or(eid),
                                    "originalName": name,
                                    "cachePath": path,
                                }));
                            }
                        }
                    }
                    
                    // Text Templates
                    if let Some(tts) = materials.get("text_templates").and_then(|v| v.as_array()) {
                        for tt in tts {
                            let eid = get_effect_id(tt);
                            let name = get_non_empty_str(tt, "name");
                            let path = tt.get("path").and_then(|v| v.as_str()).unwrap_or("");

                            // Tìm text material gốc mà template này đang trỏ tới để preserve style chuẩn.
                            // Chuỗi tham chiếu: text_template.text_info_resources[0].text_material_id -> materials.texts[].id
                            let linked_text_material_id = tt
                                .get("text_info_resources")
                                .and_then(|v| v.as_array())
                                .and_then(|arr| arr.get(0))
                                .and_then(|x| x.get("text_material_id"))
                                .and_then(|v| v.as_str());

                            let linked_text_material_raw = linked_text_material_id.and_then(|tmid| {
                                materials
                                    .get("texts")
                                    .and_then(|v| v.as_array())
                                    .and_then(|texts| {
                                        texts
                                            .iter()
                                            .find(|txt| {
                                                txt.get("id")
                                                    .and_then(|v| v.as_str())
                                                    .map(|id| id == tmid)
                                                    .unwrap_or(false)
                                            })
                                            .cloned()
                                    })
                            });

                            // Lấy các material_animations mà text_template đang tham chiếu qua text_info_resources[].extra_material_refs
                            let linked_anim_ids: Vec<String> = tt
                                .get("text_info_resources")
                                .and_then(|v| v.as_array())
                                .and_then(|arr| arr.get(0))
                                .and_then(|x| x.get("extra_material_refs"))
                                .and_then(|v| v.as_array())
                                .map(|refs| {
                                    refs.iter()
                                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                        .collect::<Vec<String>>()
                                })
                                .unwrap_or_default();

                            let linked_material_animations_raw: Vec<Value> = linked_anim_ids
                                .iter()
                                .filter_map(|rid| {
                                    materials
                                        .get("material_animations")
                                        .and_then(|v| v.as_array())
                                        .and_then(|anims| {
                                            anims
                                                .iter()
                                                .find(|a| {
                                                    a.get("id")
                                                        .and_then(|v| v.as_str())
                                                        .map(|id| id == rid)
                                                        .unwrap_or(false)
                                                })
                                                .cloned()
                                        })
                                })
                                .collect();

                            // Lấy các effects mà template tham chiếu qua extra_material_refs.
                            // Một số template subtitle dùng materials.effects (không chỉ material_animations).
                            let linked_effects_raw: Vec<Value> = linked_anim_ids
                                .iter()
                                .filter_map(|rid| {
                                    materials
                                        .get("effects")
                                        .and_then(|v| v.as_array())
                                        .and_then(|effects| {
                                            effects
                                                .iter()
                                                .find(|e| {
                                                    e.get("id")
                                                        .and_then(|v| v.as_str())
                                                        .map(|id| id == rid)
                                                        .unwrap_or(false)
                                                })
                                                .cloned()
                                        })
                                })
                                .collect();
                            
                            if let (Some(eid), Some(name)) = (eid, name) {
                                text_templates.push(serde_json::json!({
                                    "effectId": eid,
                                    "resourceId": get_non_empty_str(tt, "resource_id").unwrap_or(eid),
                                    "originalName": name,
                                    "cachePath": path,
                                    "rawJson": tt, // LƯU GIỮ TOÀN BỘ JSON CỦA CAPCUT ĐỂ TRÁNH LỖI MẤT FIELDS
                                    "textMaterialRawJson": linked_text_material_raw,
                                    "linkedMaterialAnimationsRawJson": linked_material_animations_raw,
                                    "linkedEffectsRawJson": linked_effects_raw
                                }));
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(serde_json::json!({
        "transitions": transitions,
        "videoEffects": video_effects,
        "textTemplates": text_templates
    }))
}

#[cfg(test)]
mod scan_tests {
    use super::*;
    use std::path::PathBuf;
    use std::fs;

    #[tokio::test]
    async fn test_scan_draft_0403_1() {
        let path = "/Users/may1/Movies/CapCut/User Data/Projects/com.lveditor.draft/0403(1)/draft_info.json".to_string();
        println!("TESTING SCAN DRAFT...");
        match scan_capcut_cache_rust(vec![path]).await {
            Ok(val) => {
                let trans_len = val["transitions"].as_array().map(|a| a.len()).unwrap_or(0);
                let text_len = val["textTemplates"].as_array().map(|a| a.len()).unwrap_or(0);
                println!("SUCCESS: {} transitions, {} text_templates", trans_len, text_len);
                if trans_len > 0 {
                    println!("SAMPLE TRANSITION: {:?}", val["transitions"][0]);
                }
                if text_len > 0 {
                    println!("SAMPLE TEXT: {:?}", val["textTemplates"][0]);
                }
            }
            Err(e) => {
                println!("ERROR: {:?}", e);
            }
        }
    }

    /// Test integration cho overwrite merge:
    /// - Draft gốc có audio/text
    /// - Request mới chỉ gửi video tracks/materials
    /// Kỳ vọng:
    /// - Audio/Text tracks cũ vẫn còn
    /// - materials.audios cũ vẫn còn
    /// - draft_meta_info.draft_materials không bị replace trắng
    #[tokio::test(flavor = "multi_thread")]
    async fn test_overwrite_merge_keeps_audio_text_and_meta_materials() {
        let source_dir = PathBuf::from("/Users/may1/Movies/CapCut/User Data/Projects/com.lveditor.draft/0404");
        if !source_dir.exists() {
            println!("SKIP: source draft không tồn tại: {}", source_dir.display());
            return;
        }

        // Tạo bản copy tạm để test an toàn, không phá draft thật.
        let temp_dir = std::env::temp_dir().join(format!(
            "autosubs-capcut-overwrite-test-{}",
            Uuid::new_v4()
        ));
        copy_dir_all(&source_dir, &temp_dir).expect("copy source draft vào temp thất bại");

        let draft_info_path = temp_dir.join("draft_info.json");
        let before_raw = fs::read_to_string(&draft_info_path).expect("read draft_info before");
        let before_json: Value = serde_json::from_str(&before_raw).expect("parse draft_info before");

        let tracks_before = before_json.get("tracks").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let mut before_by_type: HashMap<String, usize> = HashMap::new();
        for t in &tracks_before {
            let k = get_track_type_key(t);
            *before_by_type.entry(k).or_insert(0) += 1;
        }

        let audios_before_len = before_json
            .get("materials")
            .and_then(|m| m.get("audios"))
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);

        let meta_path = temp_dir.join("draft_meta_info.json");
        let meta_before_len = if meta_path.exists() {
            let meta_raw = fs::read_to_string(&meta_path).expect("read meta before");
            let meta_json: Value = serde_json::from_str(&meta_raw).expect("parse meta before");
            meta_json
                .get("draft_materials")
                .and_then(|v| v.as_array())
                .and_then(|arr| {
                    arr.iter()
                        .find(|it| it.get("type").and_then(|v| v.as_i64()) == Some(0))
                        .and_then(|it| it.get("value"))
                        .and_then(|v| v.as_array())
                        .map(|v| v.len())
                })
                .unwrap_or(0)
        } else {
            0
        };

        // Inject data mới: chỉ có 1 video track + 1 video material.
        // Đây là case thực tế khiến code cũ làm mất audio/text.
        let inject_data = serde_json::json!({
            "tracks": [
                {
                    "id": Uuid::new_v4().to_string(),
                    "type": "video",
                    "name": "AutoMedia Video Track",
                    "attribute": 1,
                    "flag": 0,
                    "segments": []
                }
            ],
            "duration": before_json.get("duration").cloned().unwrap_or(Value::from(0)),
            "materials": {
                "videos": [
                    {
                        "id": Uuid::new_v4().to_string(),
                        "type": "photo",
                        "duration": 1_000_000,
                        "path": "/tmp/autosubs-test-image.jpg"
                    }
                ]
            },
            "canvas_config": before_json
                .get("canvas_config")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({"ratio":"original","width":1080,"height":1920}))
        });

        let meta_materials = serde_json::json!([
            {
                "id": Uuid::new_v4().to_string(),
                "file_Path": "/tmp/autosubs-test-image.jpg",
                "metetype": "video",
                "duration": 1_000_000
            }
        ]);

        // Mô phỏng đúng nhánh overwrite trong create_capcut_draft:
        // - merge tracks theo type
        // - merge materials theo id
        let mut after_json = before_json.clone();
        if let Some(tracks) = inject_data.get("tracks") {
            let existing_tracks: Vec<Value> = after_json
                .get("tracks")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let incoming_tracks: Vec<Value> = tracks.as_array().cloned().unwrap_or_default();
            let merged_tracks = merge_tracks_by_type(&existing_tracks, &incoming_tracks);
            after_json["tracks"] = Value::Array(merged_tracks);
        }
        if let Some(mats) = inject_data.get("materials") {
            if let Some(root_mats) = after_json.get_mut("materials") {
                for (key, value) in mats.as_object().unwrap_or(&serde_json::Map::new()) {
                    if value.is_array() && !value.as_array().unwrap().is_empty() {
                        let existing_arr: Vec<Value> = root_mats
                            .get(key)
                            .and_then(|v| v.as_array())
                            .cloned()
                            .unwrap_or_default();
                        let incoming_arr: Vec<Value> = value.as_array().cloned().unwrap_or_default();
                        let merged_arr = merge_material_items(&existing_arr, &incoming_arr);
                        root_mats[key] = Value::Array(merged_arr);
                    }
                }
            }
        }

        let tracks_after = after_json.get("tracks").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let mut after_by_type: HashMap<String, usize> = HashMap::new();
        for t in &tracks_after {
            let k = get_track_type_key(t);
            *after_by_type.entry(k).or_insert(0) += 1;
        }

        // Audio/Text phải được giữ nguyên khi request mới chỉ đụng video.
        let before_audio_tracks = *before_by_type.get("audio").unwrap_or(&0);
        let before_text_tracks = *before_by_type.get("text").unwrap_or(&0);
        let after_audio_tracks = *after_by_type.get("audio").unwrap_or(&0);
        let after_text_tracks = *after_by_type.get("text").unwrap_or(&0);
        assert!(
            after_audio_tracks >= before_audio_tracks,
            "audio tracks bị mất: before={}, after={}",
            before_audio_tracks,
            after_audio_tracks
        );
        assert!(
            after_text_tracks >= before_text_tracks,
            "text tracks bị mất: before={}, after={}",
            before_text_tracks,
            after_text_tracks
        );

        // materials.audios cũng phải còn, không bị replace trắng.
        let audios_after_len = after_json
            .get("materials")
            .and_then(|m| m.get("audios"))
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        assert!(
            audios_after_len >= audios_before_len,
            "materials.audios bị giảm: before={}, after={}",
            audios_before_len,
            audios_after_len
        );

        // draft_meta_info type=0 phải được merge, không bị mất items cũ.
        if meta_path.exists() {
            let meta_before_raw = fs::read_to_string(&meta_path).expect("read meta for merge");
            let mut meta_after_json: Value = serde_json::from_str(&meta_before_raw).expect("parse meta for merge");
            let incoming_meta_items: Vec<Value> = meta_materials.as_array().cloned().unwrap_or_default();
            let existing_draft_materials = meta_after_json
                .get("draft_materials")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let mut merged_draft_materials = existing_draft_materials.clone();
            let mut merged_into_type0 = false;
            for entry in merged_draft_materials.iter_mut() {
                let entry_type = entry.get("type").and_then(|v| v.as_i64()).unwrap_or(-1);
                if entry_type == 0 {
                    let existing_meta_items: Vec<Value> = entry
                        .get("value")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                    let merged_items = merge_meta_materials(&existing_meta_items, &incoming_meta_items);
                    entry["value"] = Value::Array(merged_items);
                    merged_into_type0 = true;
                    break;
                }
            }
            if !merged_into_type0 {
                merged_draft_materials.push(serde_json::json!({
                    "type": 0,
                    "value": incoming_meta_items
                }));
            }
            meta_after_json["draft_materials"] = Value::Array(merged_draft_materials);

            let meta_after_len = meta_after_json
                .get("draft_materials")
                .and_then(|v| v.as_array())
                .and_then(|arr| {
                    arr.iter()
                        .find(|it| it.get("type").and_then(|v| v.as_i64()) == Some(0))
                        .and_then(|it| it.get("value"))
                        .and_then(|v| v.as_array())
                        .map(|v| v.len())
                })
                .unwrap_or(0);
            assert!(
                meta_after_len >= meta_before_len,
                "draft_meta_info.draft_materials[type=0] bị giảm: before={}, after={}",
                meta_before_len,
                meta_after_len
            );
        }

        // Cleanup folder test.
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
