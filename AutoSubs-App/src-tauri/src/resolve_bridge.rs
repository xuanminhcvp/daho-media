// src-tauri/src/resolve_bridge.rs
// ============================================================
// Tauri Command để proxy HTTP request từ frontend đến Lua server
// Tại sao dùng Rust thay vì @tauri-apps/plugin-http?
// → plugin-http v2.5.1 bị mismatch với Rust crate → lỗi streamChannel
// → reqwest chạy trong Rust process (không qua WebView) → không bị
//   CSP, CORS, ATS (macOS App Transport Security) hay version mismatch
// ============================================================

use reqwest::Client;
use serde_json::Value;
use std::time::Duration;

/// Gọi Lua HTTP server (DaVinci Resolve) với bất kỳ payload JSON nào.
/// Frontend gọi bằng: invoke('call_lua_server', { params: { func: "Ping" } })
/// Trả về JSON response dưới dạng Value
#[tauri::command]
pub async fn call_lua_server(params: Value) -> Result<Value, String> {
    let client = Client::builder()
        .no_proxy()           // Không đi qua proxy — gọi thẳng localhost
        .tcp_nodelay(true)   // Giảm latency
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Không tạo được HTTP client: {}", e))?;

    let response = client
        .post("http://127.0.0.1:56003/")
        .header("Content-Type", "application/json")
        .json(&params)
        .send()
        .await
        .map_err(|e| format!("Lỗi gửi request đến Lua server: {}", e))?;

    let status = response.status();

    // Parse response thành JSON
    let data: Value = response
        .json()
        .await
        .map_err(|e| format!("Lỗi parse JSON response (status {}): {}", status, e))?;

    Ok(data)
}
