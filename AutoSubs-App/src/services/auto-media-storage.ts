// auto-media-storage.ts
// Service trung tâm quản lý đọc/ghi DỮ LIỆU cho toàn app
// Tất cả dữ liệu lưu trong ~/Desktop/Auto_media/
//
// Cấu trúc:
//   ~/Desktop/Auto_media/
//   ├── nhac_nen/          ← file nhạc nền
//   ├── sfx/               ← file SFX
//   ├── footage/           ← file footage
//   ├── data/
//   │   ├── settings.json  ← API keys, folder paths, templates
//   │   ├── session.json   ← session (scriptText, matchingSentences...)
//   │   ├── matching/      ← autosubs_matching.json + cache AI
//   │   └── transcripts/   ← whisper transcript JSON

import { desktopDir, join } from '@tauri-apps/api/path'
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'

// ======================== HẰNG SỐ ========================

/** Tên folder gốc trên Desktop */
const AUTO_MEDIA_ROOT = 'Auto_media'

/** Tên 3 sub-folder media cố định */
const MEDIA_FOLDERS = ['nhac_nen', 'sfx', 'footage'] as const

/** Tên folder data */
const DATA_FOLDER = 'data'

/** Tên các sub-folder trong data */
const DATA_SUBFOLDERS = ['matching', 'transcripts'] as const

/** File settings */
const SETTINGS_FILE = 'settings.json'

/** File session */
const SESSION_FILE = 'session.json'

// ======================== PATHS ========================

/** Cache đường dẫn root (tránh gọi desktopDir() liên tục) */
let _cachedRoot: string | null = null

/**
 * Lấy đường dẫn root: ~/Desktop/Auto_media/
 * Cache lại sau lần gọi đầu tiên
 */
export async function getAutoMediaRoot(): Promise<string> {
    if (_cachedRoot) return _cachedRoot
    const desktop = await desktopDir()
    _cachedRoot = await join(desktop, AUTO_MEDIA_ROOT)
    return _cachedRoot
}

/**
 * Lấy đường dẫn folder data: ~/Desktop/Auto_media/data/
 */
export async function getDataDir(): Promise<string> {
    const root = await getAutoMediaRoot()
    return join(root, DATA_FOLDER)
}

/**
 * Lấy đường dẫn folder transcripts: ~/Desktop/Auto_media/data/transcripts/
 */
export async function getTranscriptsDirPath(): Promise<string> {
    const data = await getDataDir()
    return join(data, 'transcripts')
}

/**
 * Lấy đường dẫn folder matching: ~/Desktop/Auto_media/data/matching/
 */
export async function getMatchingDirPath(): Promise<string> {
    const data = await getDataDir()
    return join(data, 'matching')
}

/**
 * Lấy đường dẫn folder nhạc nền: ~/Desktop/Auto_media/nhac_nen/
 */
export async function getMusicFolderPath(): Promise<string> {
    const root = await getAutoMediaRoot()
    return join(root, 'nhac_nen')
}

/**
 * Lấy đường dẫn folder SFX: ~/Desktop/Auto_media/sfx/
 */
export async function getSfxFolderPath(): Promise<string> {
    const root = await getAutoMediaRoot()
    return join(root, 'sfx')
}

/**
 * Lấy đường dẫn folder footage: ~/Desktop/Auto_media/footage/
 */
export async function getFootageFolderPath(): Promise<string> {
    const root = await getAutoMediaRoot()
    return join(root, 'footage')
}

// ======================== KHỞI TẠO FOLDER ========================

/**
 * Tạo toàn bộ cấu trúc folder nếu chưa có
 * Gọi 1 lần khi app khởi động
 */
export async function ensureAutoMediaFolders(): Promise<void> {
    const root = await getAutoMediaRoot()

    // Tạo folder gốc
    if (!(await exists(root))) {
        await mkdir(root, { recursive: true })
        console.log('[AutoMediaStorage] Đã tạo folder gốc:', root)
    }

    // Tạo 3 folder media
    for (const folder of MEDIA_FOLDERS) {
        const path = await join(root, folder)
        if (!(await exists(path))) {
            await mkdir(path, { recursive: true })
            console.log(`[AutoMediaStorage] Đã tạo folder: ${folder}`)
        }
    }

    // Tạo folder data + sub-folders
    const dataPath = await join(root, DATA_FOLDER)
    if (!(await exists(dataPath))) {
        await mkdir(dataPath, { recursive: true })
    }
    for (const sub of DATA_SUBFOLDERS) {
        const subPath = await join(dataPath, sub)
        if (!(await exists(subPath))) {
            await mkdir(subPath, { recursive: true })
            console.log(`[AutoMediaStorage] Đã tạo folder: data/${sub}`)
        }
    }

    console.log('[AutoMediaStorage] ✅ Cấu trúc folder đã sẵn sàng')
}

// ======================== SETTINGS ========================

/**
 * Kiểu dữ liệu Settings — lưu tất cả config của app
 */
export interface AppSettings {
    /** Đường dẫn folder nhạc nền (mặc định: Auto_media/nhac_nen) */
    musicFolder?: string
    /** Đường dẫn folder SFX (mặc định: Auto_media/sfx) */
    sfxFolder?: string
    /** Đường dẫn folder footage (mặc định: Auto_media/footage) */
    footageFolder?: string
    /** Đường dẫn folder matching */
    matchingFolder?: string
    /** Gemini API key cho Audio Scan */
    audioScanApiKey?: string
    /** Cấu hình templates (4 template highlight text) */
    templates?: any[]
    /** Version templates (để detect thay đổi) */
    templatesVersion?: string
}

/**
 * Đọc settings từ file
 * Trả về object rỗng nếu file chưa tồn tại
 */
export async function readSettings(): Promise<AppSettings> {
    try {
        const dataDir = await getDataDir()
        const filePath = await join(dataDir, SETTINGS_FILE)

        if (!(await exists(filePath))) {
            return {}
        }

        const raw = await readTextFile(filePath)
        return JSON.parse(raw) as AppSettings
    } catch (error) {
        console.error('[AutoMediaStorage] Lỗi đọc settings:', error)
        return {}
    }
}

/**
 * Ghi settings vào file (merge với data hiện có)
 * @param updates - Các field cần cập nhật (merge, không overwrite toàn bộ)
 */
export async function saveSettings(updates: Partial<AppSettings>): Promise<void> {
    try {
        const dataDir = await getDataDir()
        const filePath = await join(dataDir, SETTINGS_FILE)

        // Đọc settings hiện tại
        let current: AppSettings = {}
        if (await exists(filePath)) {
            const raw = await readTextFile(filePath)
            current = JSON.parse(raw)
        }

        // Merge updates
        const merged = { ...current, ...updates }

        // Ghi file
        await writeTextFile(filePath, JSON.stringify(merged, null, 2))
        console.log('[AutoMediaStorage] ✅ Đã lưu settings:', Object.keys(updates).join(', '))
    } catch (error) {
        console.error('[AutoMediaStorage] Lỗi ghi settings:', error)
    }
}

/**
 * Đọc 1 field settings cụ thể
 */
export async function getSettingsValue<K extends keyof AppSettings>(key: K): Promise<AppSettings[K]> {
    const settings = await readSettings()
    return settings[key]
}

// ======================== SESSION ========================

/**
 * Kiểu dữ liệu Session — trạng thái làm việc hiện tại
 */
export interface AppSession {
    /** Script text đã paste */
    scriptText?: string
    /** Folder ảnh đã chọn */
    imageFolder?: string
    /** Danh sách file ảnh */
    imageFiles?: string[]
    /** Kết quả AI matching */
    matchingSentences?: any[]
    /** Timeline đang kết nối */
    lastTimelineId?: string
    /** Thời gian lưu */
    savedAt?: string
}

/**
 * Đọc session từ file
 */
export async function readSession(): Promise<AppSession> {
    try {
        const dataDir = await getDataDir()
        const filePath = await join(dataDir, SESSION_FILE)

        if (!(await exists(filePath))) {
            return {}
        }

        const raw = await readTextFile(filePath)
        return JSON.parse(raw) as AppSession
    } catch (error) {
        console.error('[AutoMediaStorage] Lỗi đọc session:', error)
        return {}
    }
}

/**
 * Ghi session vào file (merge)
 */
export async function saveSession(updates: Partial<AppSession>): Promise<void> {
    try {
        const dataDir = await getDataDir()
        const filePath = await join(dataDir, SESSION_FILE)

        let current: AppSession = {}
        if (await exists(filePath)) {
            const raw = await readTextFile(filePath)
            current = JSON.parse(raw)
        }

        const merged = { ...current, ...updates, savedAt: new Date().toISOString() }
        await writeTextFile(filePath, JSON.stringify(merged, null, 2))
        console.log('[AutoMediaStorage] ✅ Đã lưu session')
    } catch (error) {
        console.error('[AutoMediaStorage] Lỗi ghi session:', error)
    }
}

// ======================== MIGRATION HELPER ========================

/**
 * Migrate dữ liệu cũ từ localStorage sang file
 * Gọi 1 lần khi app detect chưa có settings.json
 */
export async function migrateFromLocalStorage(): Promise<void> {
    const dataDir = await getDataDir()
    const settingsPath = await join(dataDir, SETTINGS_FILE)

    // Nếu đã có settings.json → skip (đã migrate rồi)
    if (await exists(settingsPath)) {
        console.log('[AutoMediaStorage] Settings.json đã tồn tại — skip migration')
        return
    }

    console.log('[AutoMediaStorage] 🔄 Bắt đầu migrate dữ liệu từ localStorage...')

    const settings: AppSettings = {}

    // Migrate folder paths
    try {
        const raw = localStorage.getItem('autosubs_saved_folders')
        if (raw) {
            const parsed = JSON.parse(raw)
            if (parsed.musicFolder) settings.musicFolder = parsed.musicFolder
            if (parsed.sfxFolder) settings.sfxFolder = parsed.sfxFolder
            if (parsed.footageFolder) settings.footageFolder = parsed.footageFolder
            if (parsed.matchingFolder) settings.matchingFolder = parsed.matchingFolder
        }
    } catch { /* ignore */ }

    // Migrate API key
    try {
        const apiKey = localStorage.getItem('autosubs_audio_scan_api_key')
        if (apiKey) settings.audioScanApiKey = apiKey
    } catch { /* ignore */ }

    // Migrate templates config
    try {
        const templates = localStorage.getItem('autosubs_text_templates')
        if (templates) settings.templates = JSON.parse(templates)
        const version = localStorage.getItem('autosubs_text_templates_v')
        if (version) settings.templatesVersion = version
    } catch { /* ignore */ }

    // Ghi ra file nếu có dữ liệu
    if (Object.keys(settings).length > 0) {
        await writeTextFile(settingsPath, JSON.stringify(settings, null, 2))
        console.log('[AutoMediaStorage] ✅ Migrate thành công:', Object.keys(settings).join(', '))
    }

    // Set default folder paths nếu chưa có
    const root = await getAutoMediaRoot()
    if (!settings.musicFolder) {
        settings.musicFolder = await join(root, 'nhac_nen')
    }
    if (!settings.sfxFolder) {
        settings.sfxFolder = await join(root, 'sfx')
    }
    if (!settings.footageFolder) {
        settings.footageFolder = await join(root, 'footage')
    }

    // Ghi lại với default paths
    await writeTextFile(settingsPath, JSON.stringify(settings, null, 2))
    console.log('[AutoMediaStorage] ✅ Default folder paths đã được set')
}

// ======================== INIT — GỌI KHI APP KHỞI ĐỘNG ========================

/**
 * Khởi tạo toàn bộ hệ thống storage
 * Gọi 1 lần duy nhất khi app mount (trong App.tsx hoặc main context)
 */
export async function initAutoMediaStorage(): Promise<void> {
    console.log('[AutoMediaStorage] 🚀 Khởi tạo...')

    // Bước 1: Tạo cấu trúc folder
    await ensureAutoMediaFolders()

    // Bước 2: Migrate từ localStorage (nếu lần đầu)
    await migrateFromLocalStorage()

    console.log('[AutoMediaStorage] ✅ Sẵn sàng')
}
