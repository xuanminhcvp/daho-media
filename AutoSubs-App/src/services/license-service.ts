// license-service.ts
// ============================================================
// Service quản lý license key — giao tiếp với Rust backend
// Flow: Kiểm tra local store → nếu chưa có → hiện màn hình nhập key
//       → gửi key lên Rust kiểm tra HMAC → lưu vào store
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";

// Tên file store lưu license (trong app data directory)
const LICENSE_STORE_PATH = "license.json";

// Key trong store
const LICENSE_KEY = "license_key";
const LICENSE_ACTIVATED_AT = "license_activated_at";

// ======================== TYPES ========================
export interface LicenseResult {
    valid: boolean;
    message: string;
}

export interface LicenseInfo {
    key: string;
    activatedAt: string; // ISO date string
}

// ======================== API ========================

/**
 * Kiểm tra xem app đã được kích hoạt (có license) chưa
 * Đọc từ local store — KHÔNG cần internet
 */
export async function checkLicenseExists(): Promise<LicenseInfo | null> {
    try {
        const store = await Store.load(LICENSE_STORE_PATH);
        const key = await store.get<string>(LICENSE_KEY);
        const activatedAt = await store.get<string>(LICENSE_ACTIVATED_AT);

        if (key && activatedAt) {
            return { key, activatedAt };
        }
        return null;
    } catch (error) {
        console.log("[License] Chưa có license trong store:", error);
        return null;
    }
}

/**
 * Xác thực license key bằng Rust backend (HMAC-SHA256)
 * Gọi Tauri command → Rust kiểm tra → trả về kết quả
 */
export async function validateLicenseKey(licenseKey: string): Promise<LicenseResult> {
    try {
        // Gọi Rust command validate_license_key
        const result = await invoke<LicenseResult>("validate_license_key", {
            licenseKey: licenseKey.trim(),
        });
        return result;
    } catch (error) {
        console.error("[License] Lỗi xác thực:", error);
        return {
            valid: false,
            message: `Lỗi hệ thống: ${error}`,
        };
    }
}

/**
 * Lưu license key hợp lệ vào local store
 * Sau khi lưu: lần mở app tiếp theo sẽ không hỏi key nữa
 */
export async function saveLicenseKey(licenseKey: string): Promise<void> {
    try {
        const store = await Store.load(LICENSE_STORE_PATH);
        await store.set(LICENSE_KEY, licenseKey.trim().toUpperCase());
        await store.set(LICENSE_ACTIVATED_AT, new Date().toISOString());
        await store.save();
        console.log("[License] ✅ Đã lưu license key vào store");
    } catch (error) {
        console.error("[License] Lỗi lưu key:", error);
        throw error;
    }
}

/**
 * Xóa license key khỏi store (deactivate)
 * Dùng khi admin muốn thu hồi license trên máy cụ thể
 */
export async function removeLicenseKey(): Promise<void> {
    try {
        const store = await Store.load(LICENSE_STORE_PATH);
        await store.delete(LICENSE_KEY);
        await store.delete(LICENSE_ACTIVATED_AT);
        await store.save();
        console.log("[License] 🗑️ Đã xóa license key");
    } catch (error) {
        console.error("[License] Lỗi xóa key:", error);
        throw error;
    }
}
