// ai_stream.rs
// ============================================================
// Tauri Command gọi Claude API với stream: true qua Rust reqwest
//
// Tại sao không dùng @tauri-apps/plugin-http (frontend)?
// → plugin-http dùng ReadableStream → reader.read() bị treo vĩnh viễn
//   trong Tauri WebView (đã confirm qua testing)
// → reqwest trong Rust hỗ trợ stream native, ổn định 100%
//
// Flow:
// 1. Frontend gọi invoke('call_claude_stream', { params })
// 2. Rust gửi POST tới Claude API với stream: true
// 3. Rust đọc từng SSE chunk (data: {...}\n\n)
// 4. Parse delta.content từ mỗi chunk → nối vào full_text
// 5. Trả full_text về frontend khi stream kết thúc (data: [DONE])
//
// Lợi ích so với stream: false:
// - Tránh Cloudflare 524 timeout (connection alive liên tục)
// - Nhanh hơn với response dài (nhận data sớm hơn)
// - Ổn định hơn khi network chậm
// ============================================================

use futures_util::StreamExt; // Trait cần thiết cho bytes_stream()
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Payload nhận từ frontend qua invoke()
#[derive(Deserialize)]
pub struct ClaudeStreamParams {
    /// URL API endpoint (VD: https://ezaiapi.com/v1/chat/completions)
    pub url: String,
    /// API key (Bearer token)
    pub api_key: String,
    /// Model name (VD: claude-sonnet-4-6)
    pub model: String,
    /// Nội dung prompt
    pub prompt: String,
    /// Max tokens cho response
    pub max_tokens: u32,
    /// Temperature (0.0 - 1.0)
    pub temperature: f64,
    /// Timeout tính bằng giây
    pub timeout_secs: u64,
}

/// Body gửi lên Claude API (OpenAI-compatible format)
#[derive(Serialize)]
struct ChatRequestBody {
    model: String,
    messages: Vec<ChatMessage>,
    max_tokens: u32,
    temperature: f64,
    stream: bool,
}

#[derive(Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

/// Response trả về cho frontend
#[derive(Serialize)]
pub struct ClaudeStreamResult {
    /// Full text đã nối từ tất cả chunks
    pub text: String,
    /// HTTP status code
    pub status: u16,
    /// Số chunks đã nhận
    pub chunk_count: u32,
}

// ============================================================
// TAURI COMMAND: gọi Claude API streaming, trả full text
// ============================================================
#[tauri::command]
pub async fn call_claude_stream(
    params: ClaudeStreamParams,
) -> Result<ClaudeStreamResult, String> {
    // Tạo HTTP client với timeout
    let client = Client::builder()
        .timeout(Duration::from_secs(params.timeout_secs))
        .tcp_nodelay(true) // Giảm latency
        .build()
        .map_err(|e| format!("Không tạo được HTTP client: {}", e))?;

    // Build request body — stream: true là điểm quan trọng
    let body = ChatRequestBody {
        model: params.model,
        messages: vec![ChatMessage {
            role: "user".to_string(),
            content: params.prompt,
        }],
        max_tokens: params.max_tokens,
        temperature: params.temperature,
        stream: true, // ← BẮT BUỘC TRUE
    };

    // Gửi request
    let response = client
        .post(&params.url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", params.api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Lỗi gửi request Claude: {}", e))?;

    let status = response.status().as_u16();

    // Xử lý lỗi HTTP trước khi đọc stream
    if status != 200 {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, error_text));
    }

    // ═══ ĐỌC SSE STREAM ═══
    // Format: mỗi chunk là 1+ dòng "data: {JSON}\n\n"
    // Chunk cuối: "data: [DONE]\n\n"
    //
    // JSON mỗi chunk dạng:
    // {"choices": [{"delta": {"content": "text..."}}]}
    let mut full_text = String::new();
    let mut chunk_count: u32 = 0;
    let mut buffer = String::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk_result) = stream.next().await {
        let bytes = chunk_result.map_err(|e| format!("Stream read error: {}", e))?;
        let text = String::from_utf8_lossy(&bytes);
        buffer.push_str(&text);

        // Parse từng dòng SSE trong buffer
        // SSE format: "data: {...}\n\n" — mỗi message kết thúc bằng 2 newlines
        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            // Bỏ dòng trống (phân cách giữa các SSE messages)
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            // Stream kết thúc
            if trimmed == "data: [DONE]" {
                // Drain buffer — stream đã xong
                buffer.clear();
                break;
            }

            // Parse "data: {json}" → lấy delta.content
            if let Some(json_str) = trimmed.strip_prefix("data: ") {
                if let Ok(chunk_data) = serde_json::from_str::<serde_json::Value>(json_str) {
                    // Trích xuất delta.content (OpenAI-compatible format)
                    if let Some(delta_content) = chunk_data
                        .get("choices")
                        .and_then(|c| c.get(0))
                        .and_then(|c| c.get("delta"))
                        .and_then(|d| d.get("content"))
                        .and_then(|c| c.as_str())
                    {
                        full_text.push_str(delta_content);
                        chunk_count += 1;
                    }
                }
            }
        }
    }

    Ok(ClaudeStreamResult {
        text: full_text,
        status,
        chunk_count,
    })
}
