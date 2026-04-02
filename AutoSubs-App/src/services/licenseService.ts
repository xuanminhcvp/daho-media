/**
 * licenseService.ts
 * ============================================================
 * Xác thực License Key + Device Fingerprint Binding
 *
 * Key chỉ hợp lệ trên ĐÚNG thiết bị được cấp phép.
 * Máy khác → fingerprint khác → key không hợp lệ.
 *
 * Flow:
 *  1. User mở app → thấy "Mã thiết bị: ABC12345"
 *  2. Gửi mã cho Admin qua Zalo
 *  3. Admin chạy server tạo key
 *  4. Key được tạo ra đã nhúng fingerprint vào trong
 *  5. User nhập key → App kiểm tra fingerprint trong key == máy này
 * ============================================================
 */

// ======================== SECRET KEY ========================
const SECRET_KEY = "BlackAuto_2026_Internal_Team_Secret_DO_NOT_SHARE";
const KEY_PREFIX = "BLAUTO";
const STORAGE_KEY = "auto_media_license_v2"; 

// ======================== DEVICE FINGERPRINT ========================
/**
 * Tạo fingerprint ổn định từ thông số trình duyệt/máy tính
 * Dùng các giá trị ít thay đổi: timezone, ngôn ngữ, CPU, màn hình, OS
 */
export async function getDeviceFingerprint(): Promise<string> {
    const components = [
        // Múi giờ (ổn định)
        Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
        // Ngôn ngữ hệ thống
        navigator.language || 'unknown',
        // Số nhân CPU
        String(navigator.hardwareConcurrency || 0),
        // Độ phân giải màn hình
        `${screen.width}x${screen.height}`,
        // Độ sâu màu
        String(screen.colorDepth || 0),
        // Nền tảng OS
        navigator.platform || 'unknown',
    ].join('|');

    // Hash bằng SHA-256 → lấy 8 ký tự đầu (hex uppercase)
    const encoder = new TextEncoder();
    const data = encoder.encode(components);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hexFull = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hexFull.substring(0, 8).toUpperCase();
}

// ======================== HELPER: TEXT → ArrayBuffer ========================
function strToBuffer(str: string): ArrayBuffer {
    return new TextEncoder().encode(str).buffer as ArrayBuffer;
}

// ======================== TÍNH HMAC-SHA256 ========================
async function computeHMAC(data: string): Promise<string> {
    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        strToBuffer(SECRET_KEY),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, strToBuffer(data));
    const hashArray = Array.from(new Uint8Array(signature));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("").substring(0, 16).toUpperCase();
}

// ======================== XÁC THỰC KEY ========================
/**
 * Kiểm tra license key có hợp lệ và đúng thiết bị này không
 * Format key: BLAUTO-{name_hex_chunks}-{device_fp_8}-{hmac_16}
 */
export async function validateLicenseKey(licenseKey: string): Promise<{ valid: boolean; message: string }> {
    const key = licenseKey.trim().toUpperCase();

    if (!key.startsWith(`${KEY_PREFIX}-`)) {
        return { valid: false, message: "Key không đúng định dạng. Phải bắt đầu bằng BLAUTO-" };
    }

    const keyData = key.slice(KEY_PREFIX.length + 1); // bỏ "BLAUTO-"
    const parts = keyData.split("-");

    // Cần ít nhất 3 phần: [name_hex...], [device_fp_8], [hmac_16]
    if (parts.length < 3) {
        return { valid: false, message: "Key không đúng định dạng." };
    }

    const signature = parts[parts.length - 1];        // Chunk cuối = HMAC
    const deviceFpInKey = parts[parts.length - 2];    // Chunk áp cuối = fingerprint thiết bị
    const dataParts = parts.slice(0, parts.length - 1); // Tất cả trừ HMAC
    const data = dataParts.join("-");

    // Bước 1: Kiểm tra fingerprint thiết bị
    const currentFp = await getDeviceFingerprint();
    if (deviceFpInKey !== currentFp) {
        return {
            valid: false,
            message: `❌ Key không dành cho thiết bị này.\nMã thiết bị của bạn: ${currentFp}\nKey này được cấp cho thiết bị: ${deviceFpInKey}`
        };
    }

    // Bước 2: Kiểm tra chữ ký HMAC
    const expectedSig = await computeHMAC(data);
    if (expectedSig !== signature) {
        return { valid: false, message: "❌ License key không hợp lệ." };
    }

    return { valid: true, message: "✅ Xác thực thành công! Chào mừng đến với Auto Media." };
}

// ======================== KIỂM TRA ĐÃ KÍCH HOẠT CHƯA ========================
export function isLicenseActivated(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) === "activated";
    } catch {
        return false;
    }
}

// ======================== LƯU TRẠNG THÁI ========================
export function saveLicenseActivated(): void {
    try {
        localStorage.setItem(STORAGE_KEY, "activated");
    } catch { /* ignore */ }
}

// ======================== XOÁ KÍCH HOẠT ========================
export function clearLicense(): void {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch { /* ignore */ }
}
