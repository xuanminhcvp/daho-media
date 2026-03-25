/**
 * saved-folders-service.ts
 *
 * Service quản lý lưu trữ đường dẫn thư mục "tái sử dụng"
 * ĐÃ CHUYỂN: từ localStorage → ~/Desktop/Auto_media/data/settings.json
 *
 * Các thư mục tái sử dụng:
 * - musicFolder: thư mục nhạc nền (BGM) — mặc định: Auto_media/nhac_nen/
 * - sfxFolder: thư mục hiệu ứng âm thanh (SFX) — mặc định: Auto_media/sfx/
 * - footageFolder: thư mục footage — mặc định: Auto_media/footage/
 * - matchingFolder: thư mục chứa autosubs_matching.json
 *
 * LƯU Ý: Không lưu thư mục ảnh/video — chúng thay đổi theo từng project.
 */

import {
    readSettings,
    saveSettings,
    type AppSettings,
} from '@/services/auto-media-storage'

// Kiểu dữ liệu — giữ nguyên interface cũ để không break code khác
export interface SavedFolders {
    /** Thư mục nhạc nền (BGM) */
    musicFolder?: string
    /** Thư mục hiệu ứng âm thanh (SFX) */
    sfxFolder?: string
    /** Thư mục chứa autosubs_matching.json */
    matchingFolder?: string
    /** Thư mục chứa footage (video clip minh hoạ) */
    footageFolder?: string
}

// ======================== ĐỌC/GHI FOLDER PATHS ========================

/**
 * Đọc toàn bộ thư mục đã lưu từ settings.json
 * ⚠️ ASYNC — khác với bản cũ (localStorage là sync)
 */
export async function loadSavedFolders(): Promise<SavedFolders> {
    try {
        const settings = await readSettings()
        return {
            musicFolder: settings.musicFolder,
            sfxFolder: settings.sfxFolder,
            matchingFolder: settings.matchingFolder,
            footageFolder: settings.footageFolder,
        }
    } catch (error) {
        console.error('[SavedFolders] Lỗi đọc settings.json:', error)
        return {}
    }
}

/**
 * Lưu 1 thư mục cụ thể vào settings.json (merge)
 * @param key - tên thư mục (musicFolder, sfxFolder, matchingFolder, footageFolder)
 * @param path - đường dẫn thư mục
 */
export async function saveFolderPath(key: keyof SavedFolders, path: string): Promise<void> {
    try {
        await saveSettings({ [key]: path } as Partial<AppSettings>)
        console.log(`[SavedFolders] Đã lưu ${key}: ${path}`)
    } catch (error) {
        console.error('[SavedFolders] Lỗi lưu folder path:', error)
    }
}

/**
 * Đọc 1 thư mục cụ thể đã lưu
 * ⚠️ ASYNC — khác với bản cũ (localStorage là sync)
 * @param key - tên thư mục cần đọc
 * @returns đường dẫn hoặc undefined nếu chưa lưu
 */
export async function getSavedFolder(key: keyof SavedFolders): Promise<string | undefined> {
    const folders = await loadSavedFolders()
    return folders[key]
}

/**
 * Xoá 1 thư mục đã lưu — set undefined trong settings.json
 * @param key - tên thư mục cần xoá
 */
export async function removeSavedFolder(key: keyof SavedFolders): Promise<void> {
    try {
        // Đọc settings hiện tại, xoá key, ghi lại
        const settings = await readSettings()
        delete settings[key as keyof AppSettings]
        // Ghi toàn bộ settings (không dùng saveSettings vì cần overwrite)
        const { join } = await import('@tauri-apps/api/path')
        const { writeTextFile } = await import('@tauri-apps/plugin-fs')
        const { getDataDir } = await import('@/services/auto-media-storage')
        const dataDir = await getDataDir()
        const filePath = await join(dataDir, 'settings.json')
        await writeTextFile(filePath, JSON.stringify(settings, null, 2))
        console.log(`[SavedFolders] Đã xoá ${key}`)
    } catch (error) {
        console.error('[SavedFolders] Lỗi xoá folder path:', error)
    }
}

// ======================== GEMINI API KEYS (ROUND-ROBIN) ========================

/** Bộ đếm round-robin — tự tăng mỗi lần lấy key */
let geminiKeyIndex = 0

/**
 * Lưu danh sách Gemini API keys vào settings.json
 * Thay thế toàn bộ danh sách cũ
 * @param keys - Mảng API keys cần lưu
 */
export async function saveGeminiApiKeys(keys: string[]): Promise<void> {
    try {
        // Lọc bỏ key rỗng
        const validKeys = keys.filter(k => k.trim().length > 0)
        await saveSettings({ geminiApiKeys: validKeys })
        console.log(`[SavedFolders] Đã lưu ${validKeys.length} Gemini API keys`)
    } catch (error) {
        console.error('[SavedFolders] Lỗi lưu Gemini API keys:', error)
    }
}

/**
 * Đọc danh sách Gemini API keys đã lưu
 * @returns Mảng keys hoặc mảng rỗng nếu chưa lưu
 */
export async function getGeminiApiKeys(): Promise<string[]> {
    try {
        const settings = await readSettings()
        // Ưu tiên mảng keys mới, fallback về key đơn cũ
        if (settings.geminiApiKeys && settings.geminiApiKeys.length > 0) {
            return settings.geminiApiKeys
        }
        // Backward compatible: nếu có key đơn cũ → wrap thành mảng
        if (settings.audioScanApiKey) {
            return [settings.audioScanApiKey]
        }
        return []
    } catch (error) {
        console.error('[SavedFolders] Lỗi đọc Gemini API keys:', error)
        return []
    }
}

/**
 * Lấy 1 Gemini API key theo round-robin
 * Mỗi lần gọi sẽ trả key khác nhau → phân tải tránh rate limit
 * @returns API key hoặc chuỗi rỗng nếu không có key
 */
export async function getAudioScanApiKey(): Promise<string> {
    try {
        const keys = await getGeminiApiKeys()
        if (keys.length === 0) return ''
        // Round-robin: xoay vòng qua danh sách keys
        const key = keys[geminiKeyIndex % keys.length]
        geminiKeyIndex++
        console.log(`[SavedFolders] 🔑 Gemini key #${((geminiKeyIndex - 1) % keys.length) + 1}/${keys.length}`)
        return key
    } catch (error) {
        console.error('[SavedFolders] Lỗi đọc API key:', error)
        return ''
    }
}

/**
 * Lưu API key cho Audio Scan (Gemini) vào settings.json
 * Legacy: lưu 1 key đơn — dùng saveGeminiApiKeys() cho nhiều key
 * @param apiKey - API key cần lưu
 */
export async function saveAudioScanApiKey(apiKey: string): Promise<void> {
    try {
        await saveSettings({ audioScanApiKey: apiKey })
        console.log('[SavedFolders] Đã lưu Audio Scan API key')
    } catch (error) {
        console.error('[SavedFolders] Lỗi lưu API key:', error)
    }
}
