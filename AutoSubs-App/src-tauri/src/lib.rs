// Learn more about Tauri commands at https://tauri.app/v1/guides/features/command

// Module xác thực license key nội bộ (HMAC-SHA256)
mod license;
// Module tạo CapCut Draft project tự động
mod capcut;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            // Command xác thực license key — gọi từ frontend
            license::validate_license_key,
            // Command lấy device fingerprint (placeholder, frontend tự tính)
            license::get_device_fingerprint,
            // Command tạo CapCut Draft project từ template
            capcut::create_capcut_draft,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
