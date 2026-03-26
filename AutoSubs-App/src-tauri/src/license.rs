// license.rs
// ============================================================
// Module xác thực License Key nội bộ bằng HMAC-SHA256
// Không cần server, không cần internet
// Bạn (admin) tạo key bằng script Python, user nhập vào app
// ============================================================
//
// Flow:
// 1. Admin tạo key bằng script: email → HMAC-SHA256(secret, email) → key
// 2. User nhập key vào app
// 3. App kiểm tra: HMAC-SHA256(SECRET_KEY nhúng, email) == key?
// 4. Nếu đúng → lưu vào tauri-plugin-store → lần sau không hỏi lại
//

use hmac::{Hmac, Mac};
use sha2::Sha256;

// ======================== SECRET KEY ========================
// ⚠️ QUAN TRỌNG: Đây là "con dấu bí mật" của bạn
// Chỉ bạn biết key này. Nhúng trong Rust binary → không ai đọc được.
// Khi cần đổi: sửa giá trị này + build lại app + tạo key mới cho team
const SECRET_KEY: &[u8] = b"AutoSubs_Media_2026_Internal_Team_Secret_Key_DO_NOT_SHARE";

// Prefix cho license key (để dễ nhận diện)
const KEY_PREFIX: &str = "ASUBS";

// Alias cho HMAC-SHA256
type HmacSha256 = Hmac<Sha256>;

// ======================== KIỂM TRA KEY ========================
/// Xác thực license key có hợp lệ không
/// Input: license_key = "ASUBS-A1B2C3D4E5F6..." (user nhập)
/// Output: (valid, message)
#[tauri::command]
pub fn validate_license_key(license_key: String) -> Result<LicenseResult, String> {
    let license_key = license_key.trim().to_uppercase();

    // Kiểm tra format: phải bắt đầu bằng ASUBS-
    if !license_key.starts_with(&format!("{}-", KEY_PREFIX)) {
        return Ok(LicenseResult {
            valid: false,
            message: "Key không đúng định dạng. Key phải bắt đầu bằng ASUBS-".to_string(),
        });
    }

    // Tách phần sau prefix: "ASUBS-xxxx-yyyy" → "xxxx-yyyy"
    let key_data = &license_key[KEY_PREFIX.len() + 1..];

    // Tách email hash và signature
    // Format: ASUBS-{email_hex_8chars}-{signature_hex_16chars}
    let parts: Vec<&str> = key_data.split('-').collect();
    if parts.len() < 2 {
        return Ok(LicenseResult {
            valid: false,
            message: "Key không đúng định dạng.".to_string(),
        });
    }

    // Ghép lại thành payload (bỏ prefix ASUBS-)
    let full_payload = key_data.to_string();

    // Tách signature (phần cuối cùng, 16 ký tự hex)
    let signature = parts.last().unwrap_or(&"");
    // Phần data = tất cả trừ phần signature cuối
    let data_parts: Vec<&str> = parts[..parts.len() - 1].to_vec();
    let data = data_parts.join("-");

    // Tạo HMAC từ data
    let mut mac = HmacSha256::new_from_slice(SECRET_KEY)
        .map_err(|e| format!("HMAC error: {}", e))?;
    mac.update(data.as_bytes());
    let result = mac.finalize().into_bytes();

    // Lấy 8 bytes đầu của HMAC → 16 ký tự hex
    let expected_sig = hex::encode(&result[..8]).to_uppercase();

    if expected_sig == signature.to_uppercase() {
        Ok(LicenseResult {
            valid: true,
            message: "✅ License key hợp lệ! Chào mừng bạn đến với AutoSubs Media.".to_string(),
        })
    } else {
        Ok(LicenseResult {
            valid: false,
            message: "❌ License key không hợp lệ. Vui lòng kiểm tra lại.".to_string(),
        })
    }
}

// ======================== RESPONSE TYPE ========================
#[derive(serde::Serialize)]
pub struct LicenseResult {
    pub valid: bool,
    pub message: String,
}
