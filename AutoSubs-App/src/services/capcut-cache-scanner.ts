/**
 * capcut-cache-scanner.ts
 * 
 * Quét CapCut cache trên máy để tìm:
 * - Transitions (hiệu ứng chuyển cảnh)
 * - Video Effects (hiệu ứng video như khung phim)
 * - Text Templates (template phụ đề)
 * 
 * Nguồn dữ liệu:
 * 1. Từ các draft project cũ → lấy tên tiếng Việt/user-friendly
 * 2. Từ cache effect folder → tìm preview images
 * 
 * Kết quả: danh sách effects có tên + preview path + effect_id
 */


import { Store } from '@tauri-apps/plugin-store'
import { exists, readDir } from '@tauri-apps/plugin-fs'
import { join, homeDir } from '@tauri-apps/api/path'

// ======================== TYPES ========================

/** Một effect đã tìm thấy trong cache */
export interface CachedEffect {
    /** ID effect (ví dụ: "6724226861666144779") */
    effectId: string
    /** ID resource (thường giống effectId) */
    resourceId: string
    /** Tên gốc từ CapCut/draft */
    originalName: string
    /** Tên Việt hoá (AI hoặc user đặt) */
    displayName: string
    /** Đường dẫn tuyệt đối tới effect cache */
    cachePath: string
    /** Đường dẫn tới ảnh preview (nếu có) */
    previewPath?: string
    /** Duration mặc định (microseconds, chỉ cho transitions) */
    defaultDuration?: number
    /** Loại effect */
    type: 'transition' | 'video_effect' | 'text_template'
    /** JSON thô nguyên bản từ CapCut (để clone chuẩn xác 100%) */
    rawJson?: any
    /** Text material thô gốc mà text_template đang trỏ tới (để giữ style chữ chuẩn template) */
    textMaterialRawJson?: any
    /** Các material_animations gốc mà template đang tham chiếu */
    linkedMaterialAnimationsRawJson?: any[]
    /** Các effects gốc mà template đang tham chiếu qua extra_material_refs */
    linkedEffectsRawJson?: any[]
}

/** Bundle subtitle đã pin vào local store để không phụ thuộc draft nguồn trên máy */
export interface PinnedSubtitleTemplateBundle {
    /** Version schema của bundle pin để migrate về sau */
    schemaVersion?: number
    effectId: string
    displayName: string
    textTemplateRawJson?: any
    textMaterialRawJson?: any
    linkedMaterialAnimationsRawJson?: any[]
    linkedEffectsRawJson?: any[]
    savedAt: number
}

/** Bundle effect đã pin để fallback khi scan mới không còn thấy effect cũ */
export interface PinnedEffectBundle {
    /** Version schema của bundle pin để migrate về sau */
    schemaVersion?: number
    effectId: string
    type: 'transition' | 'video_effect' | 'text_template'
    displayName: string
    cachePath: string
    defaultDuration?: number
    rawJson?: any
    textMaterialRawJson?: any
    linkedMaterialAnimationsRawJson?: any[]
    linkedEffectsRawJson?: any[]
    savedAt: number
}

/** Settings CapCut effects user đã chọn */
export interface CapCutEffectsSettings {
    /** Version schema settings để migrate an toàn */
    schemaVersion?: number
    /** Effect ID transition đã chọn (empty = không dùng) */
    transitionEffectId: string
    /** Effect ID video effect đã chọn */
    videoEffectId: string
    /** Effect ID text template đã chọn */
    textTemplateEffectId: string
    /** Bật zoom in (Ken Burns) */
    zoomEnabled: boolean
    /** Mức zoom (1.1 = 110%, 1.5 = 150%) */
    zoomLevel: number
    /** Mute video/footage tracks */
    muteVideo: boolean
    /** Mapping tên Việt hoá user đã đặt: effectId → displayName */
    customNames: Record<string, string>
}

// ======================== CONSTANTS ========================

/** Key base lưu settings trong plugin-store */
const STORE_KEY_BASE = 'capcut_effects_settings'

/** Settings mặc định */
const DEFAULT_SETTINGS: CapCutEffectsSettings = {
    schemaVersion: 1,
    transitionEffectId: '',
    videoEffectId: '',
    textTemplateEffectId: '',
    zoomEnabled: true,
    zoomLevel: 1.35,
    muteVideo: true,
    customNames: {},
}

/** Schema version hiện tại cho settings/bundles */
const CAPCUT_EFFECTS_SETTINGS_SCHEMA_VERSION = 1
const PINNED_EFFECT_BUNDLE_SCHEMA_VERSION = 1
const PINNED_SUBTITLE_BUNDLE_SCHEMA_VERSION = 1

// ======================== STORE MANAGEMENT ========================

let _store: Store | null = null

/** Lấy store instance (singleton) */
async function getStore(): Promise<Store> {
    if (!_store) {
        _store = await Store.load('capcut-effects.json')
    }
    return _store
}

/** Đọc settings đã lưu */
function buildEffectsSettingsStoreKey(scopeKey?: string): string {
    const raw = (scopeKey || '').trim()
    if (!raw) return STORE_KEY_BASE
    // Chuẩn hoá key để tránh ký tự lạ làm bẩn store key.
    const normalized = raw.replace(/[^a-zA-Z0-9:_-]/g, '_')
    return `${STORE_KEY_BASE}__${normalized}`
}

function toSafeString(value: unknown): string {
    return typeof value === 'string' ? value : ''
}

function sanitizeCustomNames(input: unknown): Record<string, string> {
    if (!input || typeof input !== 'object') return {}
    const entries = Object.entries(input as Record<string, unknown>)
    const result: Record<string, string> = {}
    for (const [k, v] of entries) {
        if (!k || typeof v !== 'string') continue
        result[k] = v
    }
    return result
}

function sanitizeEffectsSettings(input: unknown): CapCutEffectsSettings {
    const raw = (input && typeof input === 'object') ? (input as Record<string, unknown>) : {}
    const zoomRaw = raw.zoomLevel
    const zoomLevel = Number.isFinite(zoomRaw as number)
        ? Math.max(0.05, Math.min(3, Number(zoomRaw)))
        : DEFAULT_SETTINGS.zoomLevel

    return {
        schemaVersion: CAPCUT_EFFECTS_SETTINGS_SCHEMA_VERSION,
        transitionEffectId: toSafeString(raw.transitionEffectId),
        videoEffectId: toSafeString(raw.videoEffectId),
        textTemplateEffectId: toSafeString(raw.textTemplateEffectId),
        zoomEnabled: typeof raw.zoomEnabled === 'boolean' ? raw.zoomEnabled : DEFAULT_SETTINGS.zoomEnabled,
        zoomLevel,
        muteVideo: typeof raw.muteVideo === 'boolean' ? raw.muteVideo : DEFAULT_SETTINGS.muteVideo,
        customNames: sanitizeCustomNames(raw.customNames),
    }
}

function sanitizePinnedSubtitleBundle(input: unknown): PinnedSubtitleTemplateBundle | null {
    const raw = (input && typeof input === 'object') ? (input as Record<string, unknown>) : null
    if (!raw) return null
    const effectId = toSafeString(raw.effectId)
    if (!effectId) return null

    return {
        schemaVersion: PINNED_SUBTITLE_BUNDLE_SCHEMA_VERSION,
        effectId,
        displayName: toSafeString(raw.displayName) || effectId,
        textTemplateRawJson: raw.textTemplateRawJson,
        textMaterialRawJson: raw.textMaterialRawJson,
        linkedMaterialAnimationsRawJson: Array.isArray(raw.linkedMaterialAnimationsRawJson) ? raw.linkedMaterialAnimationsRawJson : undefined,
        linkedEffectsRawJson: Array.isArray(raw.linkedEffectsRawJson) ? raw.linkedEffectsRawJson : undefined,
        savedAt: Number.isFinite(raw.savedAt as number) ? Number(raw.savedAt) : Date.now(),
    }
}

function sanitizePinnedEffectBundle(input: unknown): PinnedEffectBundle | null {
    const raw = (input && typeof input === 'object') ? (input as Record<string, unknown>) : null
    if (!raw) return null
    const effectId = toSafeString(raw.effectId)
    const type = raw.type
    if (!effectId) return null
    if (type !== 'transition' && type !== 'video_effect' && type !== 'text_template') return null

    const cachePath = toSafeString(raw.cachePath)
    const hasTemplatePayload = !!raw.rawJson || !!raw.textMaterialRawJson
    // transition/video cần cachePath; text_template cho phép fallback bằng raw payload.
    if ((type === 'transition' || type === 'video_effect') && !cachePath) return null
    if (type === 'text_template' && !cachePath && !hasTemplatePayload) return null

    return {
        schemaVersion: PINNED_EFFECT_BUNDLE_SCHEMA_VERSION,
        effectId,
        type,
        displayName: toSafeString(raw.displayName) || effectId,
        cachePath,
        defaultDuration: Number.isFinite(raw.defaultDuration as number) ? Number(raw.defaultDuration) : undefined,
        rawJson: raw.rawJson,
        textMaterialRawJson: raw.textMaterialRawJson,
        linkedMaterialAnimationsRawJson: Array.isArray(raw.linkedMaterialAnimationsRawJson) ? raw.linkedMaterialAnimationsRawJson : undefined,
        linkedEffectsRawJson: Array.isArray(raw.linkedEffectsRawJson) ? raw.linkedEffectsRawJson : undefined,
        savedAt: Number.isFinite(raw.savedAt as number) ? Number(raw.savedAt) : Date.now(),
    }
}

export async function loadEffectsSettings(scopeKey?: string): Promise<CapCutEffectsSettings> {
    try {
        const store = await getStore()
        const scopedKey = buildEffectsSettingsStoreKey(scopeKey)
        const saved = await store.get<CapCutEffectsSettings>(scopedKey)
        if (saved) {
            // Luôn sanitize để tránh dữ liệu bẩn phá UI/pipeline.
            return sanitizeEffectsSettings(saved)
        }
        // Backward compatible: nếu scope mới chưa có data thì fallback key cũ/global.
        if (scopeKey) {
            const legacy = await store.get<CapCutEffectsSettings>(STORE_KEY_BASE)
            if (legacy) return sanitizeEffectsSettings(legacy)
        }
    } catch (err) {
        console.warn('[CapCutCache] Không đọc được settings:', err)
    }
    return sanitizeEffectsSettings(DEFAULT_SETTINGS)
}

/** Lưu settings */
export async function saveEffectsSettings(settings: CapCutEffectsSettings, scopeKey?: string): Promise<void> {
    try {
        const store = await getStore()
        const scopedKey = buildEffectsSettingsStoreKey(scopeKey)
        const sanitized = sanitizeEffectsSettings(settings)
        await store.set(scopedKey, sanitized)
        await store.save()
        console.log('[CapCutCache] ✅ Đã lưu settings', scopeKey ? `(scope=${scopeKey})` : '(global)')
    } catch (err) {
        console.error('[CapCutCache] ❌ Lưu settings lỗi:', err)
    }
}

// ======================== SCAN CACHE ========================

/** Key cache kết quả scan trong store */
const SCAN_CACHE_KEY = 'capcut_scan_cache'
/** Key lưu các subtitle template bundle đã pin */
const PINNED_SUBTITLE_BUNDLES_KEY = 'capcut_subtitle_template_bundles'
/** Key lưu bundles cho mọi loại effect (transition/video/text_template) */
const PINNED_EFFECT_BUNDLES_KEY = 'capcut_effect_bundles'
/** Số draft gần nhất để quét (tránh quét hết gây chậm) */
const MAX_DRAFTS_TO_SCAN = 10

/** Kiểu cache kết quả scan */
interface ScanCacheData {
    transitions: CachedEffect[]
    videoEffects: CachedEffect[]
    textTemplates: CachedEffect[]
    /** Timestamp lúc scan (ms) */
    scannedAt: number
}

/**
 * Load kết quả scan đã cache (nếu có)
 * Trả null nếu chưa scan lần nào
 */
export async function loadScanCache(): Promise<ScanCacheData | null> {
    try {
        const store = await getStore()
        const data = await store.get<ScanCacheData>(SCAN_CACHE_KEY)
        return data ?? null
    } catch {
        return null
    }
}

/**
 * Đọc map subtitle bundles đã pin.
 * Dùng để fallback khi draft gốc đã bị xoá nhưng user vẫn muốn xuất đúng style cũ.
 */
export async function loadPinnedSubtitleTemplateBundles(): Promise<Record<string, PinnedSubtitleTemplateBundle>> {
    try {
        const store = await getStore()
        const data = await store.get<Record<string, PinnedSubtitleTemplateBundle>>(PINNED_SUBTITLE_BUNDLES_KEY)
        if (!data || typeof data !== 'object') return {}
        const sanitized: Record<string, PinnedSubtitleTemplateBundle> = {}
        for (const [effectId, bundle] of Object.entries(data)) {
            const safeBundle = sanitizePinnedSubtitleBundle(bundle)
            if (!safeBundle) continue
            sanitized[effectId] = safeBundle
        }
        return sanitized
    } catch {
        return {}
    }
}

/** Đọc map effect bundles đã pin (dùng fallback cross-scan). */
export async function loadPinnedEffectBundles(): Promise<Record<string, PinnedEffectBundle>> {
    try {
        const store = await getStore()
        const data = await store.get<Record<string, PinnedEffectBundle>>(PINNED_EFFECT_BUNDLES_KEY)
        if (!data || typeof data !== 'object') return {}
        const sanitized: Record<string, PinnedEffectBundle> = {}
        for (const [effectId, bundle] of Object.entries(data)) {
            const safeBundle = sanitizePinnedEffectBundle(bundle)
            if (!safeBundle) continue
            sanitized[effectId] = safeBundle
        }
        return sanitized
    } catch {
        return {}
    }
}

/**
 * Pin 1 effect bundle để lần scan sau vẫn resolve được effect cũ.
 * - transition/video_effect: cần effectId + cachePath.
 * - text_template: ưu tiên giữ thêm raw json để export ổn định.
 */
export async function pinEffectBundle(effect: CachedEffect): Promise<void> {
    if (!effect?.effectId || !effect?.type) return

    // transition/video cần cachePath để export được. text_template có thể fallback qua raw json.
    if ((effect.type === 'transition' || effect.type === 'video_effect') && !effect.cachePath) return
    if (effect.type === 'text_template' && !effect.rawJson && !effect.textMaterialRawJson && !effect.cachePath) return

    try {
        const store = await getStore()
        const bundles = await loadPinnedEffectBundles()
        const candidate: PinnedEffectBundle = {
            schemaVersion: PINNED_EFFECT_BUNDLE_SCHEMA_VERSION,
            effectId: effect.effectId,
            type: effect.type,
            displayName: effect.displayName || effect.originalName || effect.effectId,
            cachePath: effect.cachePath || '',
            defaultDuration: effect.defaultDuration,
            rawJson: effect.rawJson,
            textMaterialRawJson: effect.textMaterialRawJson,
            linkedMaterialAnimationsRawJson: effect.linkedMaterialAnimationsRawJson,
            linkedEffectsRawJson: effect.linkedEffectsRawJson,
            savedAt: Date.now(),
        }
        const safeCandidate = sanitizePinnedEffectBundle(candidate)
        if (!safeCandidate) return
        bundles[effect.effectId] = safeCandidate
        await store.set(PINNED_EFFECT_BUNDLES_KEY, bundles)
        await store.save()
    } catch (err) {
        console.warn('[CapCutCache] ⚠️ Pin effect bundle lỗi:', err)
    }
}

/**
 * Lưu/pin subtitle template bundle theo effectId vào local store.
 * Sau khi pin, việc generate draft không còn phụ thuộc vào project draft nguồn còn tồn tại hay không.
 */
export async function pinSubtitleTemplateBundle(effect: CachedEffect): Promise<void> {
    if (effect.type !== 'text_template' || !effect.effectId) return
    if (!effect.rawJson && !effect.textMaterialRawJson) return

    try {
        const store = await getStore()
        const bundles = await loadPinnedSubtitleTemplateBundles()
        const candidate: PinnedSubtitleTemplateBundle = {
            schemaVersion: PINNED_SUBTITLE_BUNDLE_SCHEMA_VERSION,
            effectId: effect.effectId,
            displayName: effect.displayName || effect.originalName || effect.effectId,
            textTemplateRawJson: effect.rawJson,
            textMaterialRawJson: effect.textMaterialRawJson,
            linkedMaterialAnimationsRawJson: effect.linkedMaterialAnimationsRawJson,
            linkedEffectsRawJson: effect.linkedEffectsRawJson,
            savedAt: Date.now(),
        }
        const safeCandidate = sanitizePinnedSubtitleBundle(candidate)
        if (!safeCandidate) return
        bundles[effect.effectId] = safeCandidate
        await store.set(PINNED_SUBTITLE_BUNDLES_KEY, bundles)
        await store.save()
        console.log(`[CapCutCache] 📌 Đã pin subtitle bundle: ${effect.effectId} (${bundles[effect.effectId].displayName})`)
    } catch (err) {
        console.warn('[CapCutCache] ⚠️ Pin subtitle bundle lỗi:', err)
    }
}

/**
 * Xoá 1 subtitle template bundle đã pin theo effectId.
 * Dùng khi user muốn dọn danh sách template đã ghim.
 */
export async function removePinnedSubtitleTemplateBundle(effectId: string): Promise<void> {
    if (!effectId) return
    try {
        const store = await getStore()
        const bundles = await loadPinnedSubtitleTemplateBundles()
        if (bundles[effectId]) {
            delete bundles[effectId]
            await store.set(PINNED_SUBTITLE_BUNDLES_KEY, bundles)
            await store.save()
            console.log(`[CapCutCache] 🗑️ Đã xoá pinned subtitle bundle: ${effectId}`)
        }
    } catch (err) {
        console.warn('[CapCutCache] ⚠️ Xoá pinned subtitle bundle lỗi:', err)
    }
}

/**
 * Quét 10 draft gần nhất trong CapCut để thu thập effects đã dùng
 * Cache kết quả → lần sau không cần quét lại
 * 
 * @param forceRefresh - true = quét lại, false = dùng cache nếu có
 */
export async function scanCapCutCache(forceRefresh = false): Promise<{
    transitions: CachedEffect[]
    videoEffects: CachedEffect[]
    textTemplates: CachedEffect[]
    /** Trạng thái scan — cho UI hiện thông báo phù hợp */
    scanStatus: 'ok' | 'capcut_not_installed' | 'no_drafts' | 'cached'
    /** Message hướng dẫn (nếu cần) */
    scanMessage?: string
}> {
    // ---- Kiểm tra cache trước (nếu không force refresh) ----
    if (!forceRefresh) {
        const cached = await loadScanCache()
        if (cached) {
            console.log(`[CapCutCache] 📦 Dùng cache (${cached.transitions.length}T, ${cached.videoEffects.length}E, ${cached.textTemplates.length}S) — scan lúc ${new Date(cached.scannedAt).toLocaleTimeString()}`)
            return {
                transitions: cached.transitions,
                videoEffects: cached.videoEffects,
                textTemplates: cached.textTemplates,
                scanStatus: 'cached',
            }
        }
    }

    console.log(`[CapCutCache] 🔍 Quét ${MAX_DRAFTS_TO_SCAN} draft gần nhất...`)

    const transitions = new Map<string, CachedEffect>()
    const videoEffects = new Map<string, CachedEffect>()
    const textTemplates = new Map<string, CachedEffect>()

    try {
        // Tìm thư mục drafts CapCut
        const home = await homeDir()
        const draftsDir = await join(home, 'Movies', 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft')

        // Kiểm tra folder tồn tại → CapCut chưa cài hoặc chưa mở lần nào
        const dirExists = await exists(draftsDir)
        if (!dirExists) {
            console.warn('[CapCutCache] ⚠️ Không tìm thấy folder drafts CapCut')
            return {
                transitions: [], videoEffects: [], textTemplates: [],
                scanStatus: 'capcut_not_installed',
                scanMessage: 'Chưa tìm thấy CapCut. Hãy cài CapCut Desktop và mở ít nhất 1 lần.',
            }
        }

        // Đọc danh sách projects
        const entries = await readDir(draftsDir)

        // ===== CHỈ LẤY 10 DRAFT GẦN NHẤT =====
        // Sort theo tên giảm dần (draft mới thường có tên/timestamp lớn hơn)
        // Hoặc dùng draft_info.json modified time nếu có
        const dirEntries = entries.filter(e => e.isDirectory)

        // Lấy modified time cho mỗi draft folder bằng cách check draft_info.json
        const draftsMeta: Array<{ name: string; mtime: number }> = []
        console.log(`[CapCutCache] Đang kiểm tra ${dirEntries.length} folder...`)
        for (const entry of dirEntries) {
            try {
                const draftPath = await join(draftsDir, entry.name, 'draft_info.json')
                const draftExists = await exists(draftPath)
                if (!draftExists) {
                    console.log(`[CapCutCache] ⚠️ Bỏ qua ${entry.name} vì không có draft_info.json`)
                    continue
                }
                draftsMeta.push({ name: entry.name, mtime: 0 })
            } catch (err) {
                console.log(`[CapCutCache] ⚠️ Lỗi kiểm tra ${entry.name}:`, err)
            }
        }

        // Sort: tên số lớn hơn = mới hơn (MMDD format), fallback alphabetical desc
        draftsMeta.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
        console.log(`[CapCutCache] Danh sách drafts sau khi sort:`, draftsMeta.map(d => d.name))

        // Chỉ lấy MAX_DRAFTS_TO_SCAN draft gần nhất
        const recentDrafts = draftsMeta.slice(0, MAX_DRAFTS_TO_SCAN)
        console.log(`[CapCutCache] Chọn ${recentDrafts.length} drafts để scan:`, recentDrafts.map(d => d.name))

        // Load settings để lấy custom names
        const settings = await loadEffectsSettings()

        // Delegate toàn bộ việc đọc và phân tích JSON cho Rust backend để tránh lỗi IPC size limit của Tauri FS
        const draftPaths = await Promise.all(recentDrafts.map(async draft => await join(draftsDir, draft.name, 'draft_info.json')));

        console.log('[CapCutCache] 🚀 Gửi xuống Rust scan draft_paths:', draftPaths);
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const result: any = await invoke('scan_capcut_cache_rust', { draftPaths });
            console.log(`[CapCutCache] 🔙 Rust trả về result: transitions=${result?.transitions?.length}, videoEffects=${result?.videoEffects?.length}, textTemplates=${result?.textTemplates?.length}`);

            // Xả log json để bắt lỗi rỗng
            if (!result) console.error("[CapCutCache] LỖI: Rust trả về NULL/undefined");
            if (result?.transitions?.length === 0) console.warn("[CapCutCache] CẢNH BÁO: Không tìm thấy transition nào từ Rust!");
            if (result?.textTemplates?.length === 0) console.warn("[CapCutCache] CẢNH BÁO: Không tìm thấy text_template nào từ Rust!");

            const fakeNames = ['Transition', 'Video Effect', 'Text Template'];
            // Các tên dịch tự động rác từ AI cần bị bỏ qua nếu gặp tên xịn
            const junkTranslations = ['Chuyển cảnh', 'Hiệu ứng video', 'Mẫu văn bản'];

            for (const tr of result.transitions || []) {
                const eid = tr.effectId || tr.resourceId;
                if (!eid) continue;
                const existing = transitions.get(eid);

                // Nếu chưa có, HOẶC đang bị lưu đè bởi tên fake -> Cập nhật
                if (!existing || fakeNames.includes(existing.originalName)) {
                    // Nếu tên custom lấy từ cache đang là chữ dịch vô nghĩa -> Bỏ qua, lấy tên gốc
                    const savedCustom = settings.customNames[eid];
                    const isJunkCustom = savedCustom && (junkTranslations.includes(savedCustom) || fakeNames.includes(savedCustom));

                    transitions.set(eid, {
                        ...tr,
                        displayName: (!isJunkCustom && savedCustom) ? savedCustom : tr.originalName,
                        resourceId: tr.resourceId || eid,
                        type: 'transition'
                    });
                }
            }

            for (const ve of result.videoEffects || []) {
                const eid = ve.effectId || ve.resourceId;
                if (!eid) continue;
                const existing = videoEffects.get(eid);
                if (!existing || fakeNames.includes(existing.originalName)) {
                    const savedCustom = settings.customNames[eid];
                    const isJunkCustom = savedCustom && (junkTranslations.includes(savedCustom) || fakeNames.includes(savedCustom));

                    videoEffects.set(eid, {
                        ...ve,
                        displayName: (!isJunkCustom && savedCustom) ? savedCustom : ve.originalName,
                        resourceId: ve.resourceId || eid,
                        type: 'video_effect'
                    });
                }
            }

            for (const tt of result.textTemplates || []) {
                const eid = tt.effectId || tt.resourceId;
                if (!eid) continue;
                const existing = textTemplates.get(eid);
                if (!existing || fakeNames.includes(existing.originalName)) {
                    const savedCustom = settings.customNames[eid];
                    const isJunkCustom = savedCustom && (junkTranslations.includes(savedCustom) || fakeNames.includes(savedCustom));

                    textTemplates.set(eid, {
                        ...tt,
                        displayName: (!isJunkCustom && savedCustom) ? savedCustom : tt.originalName,
                        resourceId: tt.resourceId || eid,
                        type: 'text_template',
                        rawJson: tt.rawJson,
                        textMaterialRawJson: tt.textMaterialRawJson,
                        linkedMaterialAnimationsRawJson: tt.linkedMaterialAnimationsRawJson,
                        linkedEffectsRawJson: tt.linkedEffectsRawJson,
                    });
                }
            }

            console.log(`[CapCutCache] 🔍 Dữ liệu CHUẨN sau khi lọc trùng (Size Tran=${transitions.size}):`, Array.from(transitions.values()).map(x => `ID: ${x.effectId} | Gốc: ${x.originalName} | Hiển thị: ${x.displayName}`));
            console.log(`[CapCutCache] 🔍 Dữ liệu CHUẨN Text (Size=${textTemplates.size}):`, Array.from(textTemplates.values()).map(x => `ID: ${x.effectId} | Gốc: ${x.originalName} | Hiển thị: ${x.displayName}`));

        } catch (err) {
            console.warn('[CapCutCache] ⚠️ Rust backend scan lỗi:', err);
        }

        // Tìm preview images từ cache effect
        await findPreviewImages(transitions, home)
        await findPreviewImages(videoEffects, home)
        await findPreviewImages(textTemplates, home)

    } catch (err) {
        console.error('[CapCutCache] ❌ Quét cache lỗi:', err)
    }

    const resultEffects = {
        transitions: Array.from(transitions.values()),
        videoEffects: Array.from(videoEffects.values()),
        textTemplates: Array.from(textTemplates.values()),
    }

    // Kiểm tra 0 effects → hướng dẫn first-time
    const totalEffects = resultEffects.transitions.length + resultEffects.videoEffects.length + resultEffects.textTemplates.length
    const scanStatus = totalEffects === 0 ? 'no_drafts' as const : 'ok' as const
    const scanMessage = totalEffects === 0
        ? 'Chưa tìm thấy effects. Hãy mở CapCut → tạo 1 project → thêm hiệu ứng chuyển cảnh, khung phim, template chữ → save → quét lại.'
        : undefined

    // ===== CACHE KẾT QUẢ vào store =====
    try {
        const store = await getStore()
        await store.set(SCAN_CACHE_KEY, {
            ...resultEffects,
            scannedAt: Date.now(),
        } as ScanCacheData)
        await store.save()
        console.log('[CapCutCache] 💾 Đã cache kết quả scan')
    } catch (err) {
        console.warn('[CapCutCache] ⚠️ Cache scan lỗi:', err)
    }

    console.log(`[CapCutCache] ✅ Tìm thấy: ${resultEffects.transitions.length} transitions, ${resultEffects.videoEffects.length} video effects, ${resultEffects.textTemplates.length} text templates`)
    return { ...resultEffects, scanStatus, scanMessage }
}

// ======================== PREVIEW IMAGES ========================

/**
 * Tìm ảnh preview cho mỗi effect từ cache folder
 * CapCut lưu preview ở dạng .png/.jpg trong folder effect
 * Quét nhiều path khả dĩ để hỗ trợ cả App Store + Website version
 */
async function findPreviewImages(
    effects: Map<string, CachedEffect>,
    home: string
): Promise<void> {
    // ===== FALLBACK PATHS: App Store (sandbox) + Website (non-sandbox) =====
    const cachePaths = [
        // App Store version (sandbox container)
        await join(home, 'Library', 'Containers', 'com.lemon.lvoverseas',
            'Data', 'Movies', 'CapCut', 'User Data', 'Cache', 'effect'),
        // Website version (Application Support)
        await join(home, 'Library', 'Application Support', 'CapCut', 'User Data', 'Cache', 'effect'),
        // Fallback: Movies folder chung
        await join(home, 'Movies', 'CapCut', 'User Data', 'Cache', 'effect'),
    ]

    // Tìm path nào tồn tại
    let activeCachePaths: string[] = []
    for (const p of cachePaths) {
        if (await exists(p)) activeCachePaths.push(p)
    }
    if (activeCachePaths.length === 0) return

    for (const [effectId, effect] of effects) {
        if (effect.previewPath) continue // Đã có preview → skip
        // Thử tìm trong mỗi cache path
        for (const cacheBase of activeCachePaths) {
            try {
                const effectDir = await join(cacheBase, effectId)
                const dirExists = await exists(effectDir)
                if (!dirExists) continue

                // Quét folder tìm file ảnh preview
                const files = await readDir(effectDir)
                for (const entry of files) {
                    if (entry.isDirectory) {
                        // Quét subfolder
                        try {
                            const subDir = await join(effectDir, entry.name)
                            const subFiles = await readDir(subDir)
                            for (const sf of subFiles) {
                                const name = sf.name.toLowerCase()
                                // Tìm các file preview phổ biến
                                if (name.includes('preview') || name.includes('thumb') || name.includes('icon')) {
                                    if (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.webp')) {
                                        effect.previewPath = await join(subDir, sf.name)
                                        break
                                    }
                                }
                            }
                            // Không có file preview rõ ràng → tìm file .png đầu tiên
                            if (!effect.previewPath) {
                                for (const sf of subFiles) {
                                    const name = sf.name.toLowerCase()
                                    if (name.endsWith('.png') || name.endsWith('.jpg')) {
                                        effect.previewPath = await join(subDir, sf.name)
                                        break
                                    }
                                }
                            }
                        } catch { /* skip */ }
                    }
                    if (effect.previewPath) break
                }
                if (effect.previewPath) break // Tìm thấy → không cần quét path khác
            } catch { /* skip */ }
        }
    }
}

// ======================== AI NAMING ========================

/**
 * Dùng AI tạo tên Việt cho effects chưa có tên user-friendly
 * Gọi 1 lần cho tất cả effects cần đặt tên → tiết kiệm API
 * 
 * @param effects Danh sách effects cần đặt tên (name gốc Trung/Anh)  
 * @returns Mapping effectId → tên Việt
 */
export async function generateVietnameseNames(
    effects: CachedEffect[]
): Promise<Record<string, string>> {
    // Filter effects chưa có tên Việt (tên gốc chứa CJK hoặc tiếng Anh)
    const needNaming = effects.filter(e => {
        // Đã có custom name → skip
        if (e.displayName !== e.originalName) return false
        // Tên chứa ký tự CJK hoặc không phải tiếng Việt → cần đặt tên
        return /[\u4E00-\u9FFF]/.test(e.originalName) || /^[a-zA-Z0-9_\s-]+$/.test(e.originalName)
    })

    if (needNaming.length === 0) return {}

    try {
        // Gọi AI để dịch/đặt tên
        const namesToTranslate = needNaming.map(e => ({
            id: e.effectId,
            name: e.originalName,
            type: e.type,
        }))

        // Dùng Gemini API (đã có sẵn trong app)
        const prompt = `Dịch các tên hiệu ứng CapCut sau sang tiếng Việt ngắn gọn, dễ hiểu. Trả về JSON object mapping id → tên Việt. Không trùng tên, nếu trùng thêm (1)(2):
${JSON.stringify(namesToTranslate, null, 2)}

Trả JSON thuần, không markdown:
{"id1": "Tên Việt 1", "id2": "Tên Việt 2"}`

        const { callAIMultiProvider } = await import('@/utils/ai-provider')
        const response = await callAIMultiProvider(prompt, 'CapCut Naming', 'auto', 30000)

        // Parse AI response
        const jsonMatch = response.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
            const mapping = JSON.parse(jsonMatch[0]) as Record<string, string>

            // Ensure unique names
            const usedNames = new Set<string>()
            const result: Record<string, string> = {}
            for (const [id, name] of Object.entries(mapping)) {
                let finalName = name
                let counter = 1
                while (usedNames.has(finalName)) {
                    finalName = `${name} (${counter})`
                    counter++
                }
                usedNames.add(finalName)
                result[id] = finalName
            }

            console.log(`[CapCutCache] 🤖 AI đặt tên ${Object.keys(result).length} effects`)
            return result
        }
    } catch (err) {
        console.warn('[CapCutCache] ⚠️ AI naming lỗi:', err)
    }

    return {}
}

/**
 * Lưu tên Việt hoá vào settings (nhớ lại lần sau)
 */
export async function saveCustomNames(names: Record<string, string>): Promise<void> {
    const settings = await loadEffectsSettings()
    settings.customNames = { ...settings.customNames, ...names }
    await saveEffectsSettings(settings)
}

// ======================== GET SELECTED EFFECT ========================

/**
 * Lấy effect chi tiết đã chọn từ settings
 * Trả null nếu chưa chọn hoặc effect không còn trong cache
 */
export async function getSelectedEffect(
    type: 'transition' | 'video_effect' | 'text_template',
    allEffects: CachedEffect[]
): Promise<CachedEffect | null> {
    const settings = await loadEffectsSettings()
    let selectedId: string

    switch (type) {
        case 'transition': selectedId = settings.transitionEffectId; break
        case 'video_effect': selectedId = settings.videoEffectId; break
        case 'text_template': selectedId = settings.textTemplateEffectId; break
    }

    if (!selectedId) return null

    // Ưu tiên effect hiện có trong scan/cache hiện tại.
    const found = allEffects.find(e => e.effectId === selectedId) || null
    if (found) return found

    // Fallback 1: đọc từ effect bundles đã pin cho mọi loại effect.
    const pinnedEffects = await loadPinnedEffectBundles()
    const pinnedEffect = pinnedEffects[selectedId]
    if (pinnedEffect && pinnedEffect.type === type) {
        return {
            effectId: pinnedEffect.effectId,
            resourceId: pinnedEffect.effectId,
            originalName: pinnedEffect.displayName || pinnedEffect.effectId,
            displayName: pinnedEffect.displayName || pinnedEffect.effectId,
            cachePath: pinnedEffect.cachePath || '',
            type: pinnedEffect.type,
            defaultDuration: pinnedEffect.defaultDuration,
            rawJson: pinnedEffect.rawJson,
            textMaterialRawJson: pinnedEffect.textMaterialRawJson,
            linkedMaterialAnimationsRawJson: pinnedEffect.linkedMaterialAnimationsRawJson,
            linkedEffectsRawJson: pinnedEffect.linkedEffectsRawJson,
        }
    }

    // Fallback 2 (legacy): text_template pin cũ.
    if (type === 'text_template') {
        const bundles = await loadPinnedSubtitleTemplateBundles()
        const pinned = bundles[selectedId]
        if (pinned) {
            return {
                effectId: pinned.effectId,
                resourceId: pinned.effectId,
                originalName: pinned.displayName || pinned.effectId,
                displayName: pinned.displayName || pinned.effectId,
                cachePath: '',
                type: 'text_template',
                rawJson: pinned.textTemplateRawJson,
                textMaterialRawJson: pinned.textMaterialRawJson,
                linkedMaterialAnimationsRawJson: pinned.linkedMaterialAnimationsRawJson,
                linkedEffectsRawJson: pinned.linkedEffectsRawJson,
            }
        }
    }
    return null
}
