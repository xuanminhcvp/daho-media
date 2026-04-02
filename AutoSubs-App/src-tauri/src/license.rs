// license.rs
// ============================================================
// Module xác thực License Key nội bộ bằng HMAC-SHA256
// Có ràng buộc Device Fingerprint — mỗi key chỉ dùng được trên 1 máy
// ============================================================
//
// Key Format: BLAUTO-{email_hex_chunks}-{device_fp_8}-{hmac_16}
//
// Flow:
//   1. User mở app → thấy "Mã thiết bị: XXXXXXXX"
//   2. User gửi mã máy + email cho Admin
//   3. Admin chạy script tạo key (node generate_license.js)
//   4. Key nhúng sẵn fingerprint bên trong
//   5. App kiểm tra: fingerprint trong key == fingerprint máy hiện tại?
//      + HMAC signature hợp lệ?
//   6. Nếu cả 2 OK → lưu vào Tauri Store → lần sau không hỏi lại
//

use hmac::{Hmac, Mac};
use sha2::{Sha256, Digest};

// ======================== SECRET KEY ========================
// ⚠️ QUAN TRỌNG: Phải khớp với SECRET_KEY trong script tạo key (Node.js)
// Key cũ: "AutoSubs_Media_2026_..."
// Key mới (đồng bộ với hệ thống BLAUTO):
const SECRET_KEY: &[u8] = b"BlackAuto_2026_Internal_Team_Secret_DO_NOT_SHARE";

// Prefix cho license key
const KEY_PREFIX: &str = "BLAUTO";

// Alias cho HMAC-SHA256
type HmacSha256 = Hmac<Sha256>;

// ======================== DEVICE FINGERPRINT ========================
/// Tính fingerprint từ thông số hệ thống (phải khớp với frontend JS)
/// Components: timezone|language|cpu_cores|screen_WxH|color_depth|platform
/// → SHA-256 → lấy 8 ký tự hex đầu (UPPERCASE)
///
/// LƯU Ý: Hàm này chạy trên Rust/Tauri backend, nên dùng Tauri command
/// để frontend gọi lấy fingerprint hiển thị cho user.
/// Nhưng việc KIỂM TRA fingerprint khi validate key thì dùng fingerprint
/// mà FRONTEND gửi lên (vì frontend mới có access đến navigator/screen).
#[tauri::command]
pub fn get_device_fingerprint() -> String {
    // Rust backend không có access trực tiếp đến browser APIs
    // (navigator, screen, Intl...) nên mã máy được tính ở frontend JS
    // và truyền vào khi validate. Hàm này chỉ là placeholder.
    // Frontend sẽ tự tính fingerprint bằng Web Crypto API.
    "USE_FRONTEND".to_string()
}

// ======================== KIỂM TRA KEY ========================
/// Xác thực license key có hợp lệ + đúng thiết bị không
///
/// Input:
///   - license_key: "BLAUTO-6D696E68-40676D61-...-0E3B638D-3197DC0B576D7975"
///   - device_fingerprint: "0E3B638D" (frontend tính và gửi lên)
///
/// Kiểm tra:
///   1. Format key đúng (bắt đầu bằng BLAUTO-)
///   2. Fingerprint trong key == fingerprint máy hiện tại
///   3. HMAC signature hợp lệ
#[tauri::command]
pub fn validate_license_key(license_key: String, device_fingerprint: String) -> Result<LicenseResult, String> {
    let license_key = license_key.trim().to_uppercase();
    let device_fp = device_fingerprint.trim().to_uppercase();

    // Bước 0: Kiểm tra format prefix
    let prefix_with_dash = format!("{}-", KEY_PREFIX);
    if !license_key.starts_with(&prefix_with_dash) {
        return Ok(LicenseResult {
            valid: false,
            message: format!("Key không đúng định dạng. Key phải bắt đầu bằng {}-", KEY_PREFIX),
        });
    }

    // Tách phần sau prefix: "BLAUTO-xxxx-yyyy-zzzz" → "xxxx-yyyy-zzzz"
    let key_data = &license_key[KEY_PREFIX.len() + 1..];

    // Tách thành các phần bằng dấu '-'
    let parts: Vec<&str> = key_data.split('-').collect();
    // Cần ít nhất 3 phần: [email_hex...], [device_fp_8], [hmac_16]
    if parts.len() < 3 {
        return Ok(LicenseResult {
            valid: false,
            message: "Key không đúng định dạng (thiếu thành phần).".to_string(),
        });
    }

    // Phần cuối = HMAC signature (16 ký tự hex)
    let signature = parts.last().unwrap_or(&"");

    // Phần áp cuối = Device Fingerprint (8 ký tự hex)
    let fp_in_key = parts[parts.len() - 2];

    // Bước 1: Kiểm tra device fingerprint
    // Fingerprint trong key phải khớp với fingerprint máy hiện tại
    if fp_in_key.to_uppercase() != device_fp {
        return Ok(LicenseResult {
            valid: false,
            message: format!(
                "❌ Key không dành cho thiết bị này.\nMã thiết bị của bạn: {}\nKey này được cấp cho thiết bị: {}",
                device_fp, fp_in_key
            ),
        });
    }

    // Bước 2: Kiểm tra HMAC signature
    // Data = tất cả các phần TRỪ phần HMAC cuối (giống lúc tạo key)
    let data_parts: Vec<&str> = parts[..parts.len() - 1].to_vec();
    let data = data_parts.join("-");

    // Tính HMAC-SHA256
    let mut mac = HmacSha256::new_from_slice(SECRET_KEY)
        .map_err(|e| format!("HMAC error: {}", e))?;
    mac.update(data.as_bytes());
    let result = mac.finalize().into_bytes();

    // Lấy 8 bytes đầu → 16 ký tự hex (khớp với script Node.js)
    let expected_sig = hex::encode(&result[..8]).to_uppercase();

    if expected_sig == signature.to_uppercase() {
        Ok(LicenseResult {
            valid: true,
            message: "✅ License key hợp lệ! Chào mừng bạn đến với DahoMedia.".to_string(),
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
