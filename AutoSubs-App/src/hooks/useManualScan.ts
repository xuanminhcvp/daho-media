/**
 * useManualScan.ts
 * ================
 * Hook quản lý state cho tab Scan Thủ Công.
 * Không cần Python server hay Chrome automation.
 *
 * Luồng:
 *   1. User chọn file → app show prompt
 *   2. User mở Gemini thủ công, upload file, paste prompt
 *   3. User copy JSON từ Gemini → paste vào app
 *   4. App parse + preview → user bấm "Lưu vào Metadata"
 */

import { useState, useCallback } from 'react';
import { writeTextFile, readTextFile, exists } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
// Prompts được load DYNAMIC theo profile đang chọn (không hardcode documentary)
// Sử dụng getActiveProfileId() + dynamic import() để lấy đúng prompt theo profile.

// ─── Types ─────────────────────────────────────────
export type ManualScanType = 'music' | 'sfx' | 'image' | 'footage';

export interface ManualScanItem {
    id: string;               // UUID tạm
    filePath: string;         // Đường dẫn tuyệt đối
    fileName: string;         // Tên file ngắn
    scanType: ManualScanType; // Loại scan
    prompt: string;           // Prompt đã tạo sẵn
    rawJson: string;          // JSON user paste vào
    parsedData: any | null;   // Kết quả parse
    parseError: string | null;// Lỗi parse (nếu có)
    savedOk: boolean;         // Đã lưu metadata chưa
}

// Tên file metadata (đồng bộ với auto-scan)
const AUDIO_METADATA_FILE = 'autosubs_audio_metadata.json';
const IMAGE_METADATA_FILE  = 'autosubs_image_metadata.json';
const FOOTAGE_METADATA_FILE = 'autosubs_footage_metadata.json';

// ─── Tạo hash từ tên file (cho đồng nhất với auto-scan) ──────────
function simpleFileHash(fileName: string): string {
    let hash = 0;
    for (let i = 0; i < fileName.length; i++) {
        hash = ((hash << 5) - hash) + fileName.charCodeAt(i);
        hash |= 0; // Convert to 32-bit int
    }
    return Math.abs(hash).toString(36);
}

// ─── Parse JSON từ text Gemini (bỏ markdown code block) ───────
function parseGeminiJson(text: string): { data: any | null; error: string | null } {
    try {
        let cleaned = text.trim();
        // Bỏ <thinking>...</thinking>
        cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
        // Bỏ markdown code block ```json ... ```
        const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlock) cleaned = codeBlock[1].trim();
        // Tìm object JSON đầu tiên
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { data: null, error: 'Không tìm thấy JSON object trong text' };
        const data = JSON.parse(jsonMatch[0]);
        return { data, error: null };
    } catch (e: any) {
        return { data: null, error: `JSON parse lỗi: ${e.message}` };
    }
}

// ─── Lưu audio metadata ────────────────────────────
async function saveAudioMeta(filePath: string, fileName: string, data: any, scanType: ManualScanType = 'music'): Promise<boolean> {
    try {
        const folder = filePath.substring(0, filePath.lastIndexOf('/'));
        const metaPath = await join(folder, AUDIO_METADATA_FILE);

        let existing: any = { version: '2.0', lastScanned: '', itemCount: 0, items: [] };
        if (await exists(metaPath)) {
            existing = JSON.parse(await readTextFile(metaPath));
        }

        const item = {
            filePath, fileName,
            fileHash: simpleFileHash(fileName), // Dùng fileName + Math.abs giống hệt auto-scan
            durationSec: data.totalDurationSec || 0,
            type: scanType,  // 'music' hoặc 'sfx' tuỳ tab đang scan
            aiMetadata: {
                emotion: data.emotion || ['Không xác định'],
                intensity: data.intensity || 'Trung bình',
                description: data.description || '',
                tags: data.tags || [],
                bestFor: data.bestFor || [],
                hasDrop: data.hasDrop ?? undefined,
                hasBuildUp: data.hasBuildUp ?? undefined,
                totalDurationSec: data.totalDurationSec ?? undefined,
                timeline: data.timeline || [],
                beats: data.beats || [],
                trimSuggestions: data.trimSuggestions || [],
            },
            scannedAt: new Date().toISOString(),
            scannedBy: 'manual',  // Đánh dấu scan thủ công
        };

        const items: any[] = existing.items || [];
        const idx = items.findIndex((i: any) => i.filePath === filePath);
        if (idx >= 0) items[idx] = item; else items.push(item);

        await writeTextFile(metaPath, JSON.stringify({
            ...existing,
            lastScanned: new Date().toISOString(),
            itemCount: items.length,
            items,
        }, null, 2));
        return true;
    } catch (e) {
        console.error('[ManualScan] Lỗi lưu audio meta:', e);
        return false;
    }
}

// ─── Lưu image metadata ────────────────────────────
async function saveImageMeta(filePath: string, fileName: string, data: any): Promise<boolean> {
    try {
        const folder = filePath.substring(0, filePath.lastIndexOf('/'));
        const metaPath = await join(folder, IMAGE_METADATA_FILE);

        let existing: any = { version: '1.0', lastScanned: '', itemCount: 0, items: [] };
        if (await exists(metaPath)) {
            existing = JSON.parse(await readTextFile(metaPath));
        }

        const item = {
            filePath, fileName,
            scanType: 'image',
            aiMetadata: data,
            scannedAt: new Date().toISOString(),
            scannedBy: 'manual',
        };

        const items: any[] = existing.items || [];
        const idx = items.findIndex((i: any) => i.filePath === filePath);
        if (idx >= 0) items[idx] = item; else items.push(item);

        await writeTextFile(metaPath, JSON.stringify({
            ...existing,
            lastScanned: new Date().toISOString(),
            itemCount: items.length,
            items,
        }, null, 2));
        return true;
    } catch (e) {
        console.error('[ManualScan] Lỗi lưu image meta:', e);
        return false;
    }
}

// ─── Lưu footage metadata ────────────────────────────
async function saveFootageMeta(filePath: string, fileName: string, data: any): Promise<boolean> {
    try {
        const folder = filePath.substring(0, filePath.lastIndexOf('/'));
        const metaPath = await join(folder, FOOTAGE_METADATA_FILE);

        let existing: any = { version: '2.0', lastScanned: '', itemCount: 0, items: [] };
        if (await exists(metaPath)) {
            existing = JSON.parse(await readTextFile(metaPath));
        }

        const item = {
            filePath, fileName,
            fileHash: simpleFileHash(fileName), // Dùng fileName + Math.abs giống hệt auto-scan
            durationSec: 0, // Sẽ lấy sau nếu cần
            aiDescription: data.description || '',
            aiTags: data.tags || [],
            aiMood: data.mood || 'Unknown',
            scannedAt: new Date().toISOString(),
            scannedBy: 'manual',
        };

        const items: any[] = existing.items || [];
        const idx = items.findIndex((i: any) => i.filePath === filePath);
        if (idx >= 0) {
            items[idx] = { ...items[idx], ...item, durationSec: items[idx].durationSec || 0 };
        } else {
            items.push(item);
        }

        await writeTextFile(metaPath, JSON.stringify(existing.version ? {
            ...existing,
            lastScanned: new Date().toISOString(),
            itemCount: items.length,
            items,
        } : items, null, 2));
        return true;
    } catch (e) {
        console.error('[ManualScan] Lỗi lưu footage meta:', e);
        return false;
    }
}

// ═══════════════════════════════════════════════════
// HOOK CHÍNH
// ═══════════════════════════════════════════════════
export function useManualScan() {
    // Danh sách item đang chờ xử lý (hỗ trợ batch)
    const [items, setItems] = useState<ManualScanItem[]>([]);
    // ID item đang chọn để xem/paste JSON
    const [activeItemId, setActiveItemId] = useState<string | null>(null);
    // Loại scan mặc định
    const [defaultScanType, setDefaultScanType] = useState<ManualScanType>('music');

    // ── Build 1 ManualScanItem từ filePath + scanType (async để load prompt theo profile) ─────
    const buildItem = async (fp: string, scanType: ManualScanType): Promise<ManualScanItem> => {
        const fileName = fp.split('/').pop() || fp;

        // Load prompt đúng theo profile đang chọn (documentary | stories | tiktok)
        let prompt = '';
        try {
            const { getActiveProfileId } = await import('@/config/activeProfile');
            const profileId = getActiveProfileId();

            if (scanType === 'music') {
                // /* @vite-ignore */
                const mod = await import(/* @vite-ignore */ `../prompts/${profileId}/gemini-browser-audio-scan-prompt`);
                prompt = mod.buildGeminiBrowserAudioPrompt();
            } else if (scanType === 'sfx') {
                const mod = await import(/* @vite-ignore */ `../prompts/${profileId}/gemini-browser-audio-scan-prompt`);
                prompt = mod.buildGeminiBrowserSfxPrompt();
            } else if (scanType === 'image') {
                const mod = await import(/* @vite-ignore */ `../prompts/${profileId}/gemini-browser-image-scan-prompt`);
                prompt = mod.buildGeminiBrowserImagePrompt();
            } else if (scanType === 'footage') {
                const mod = await import(/* @vite-ignore */ `../prompts/${profileId}/gemini-browser-footage-scan-prompt`);
                prompt = mod.buildGeminiBrowserFootagePrompt();
            }
            console.log(`[ManualScan] Đã load prompt profile "${profileId}" cho type "${scanType}"`);
        } catch (e) {
            console.warn('[ManualScan] Không load được prompt theo profile, dùng fallback documentary:', e);
            // Fallback an toàn về documentary nếu profile chưa có file prompt
            try {
                if (scanType === 'music' || scanType === 'sfx') {
                    const mod = await import('@/prompts/documentary/gemini-browser-audio-scan-prompt');
                    prompt = scanType === 'music' ? mod.buildGeminiBrowserAudioPrompt() : mod.buildGeminiBrowserSfxPrompt();
                } else if (scanType === 'footage') {
                    const mod = await import('@/prompts/documentary/gemini-browser-footage-scan-prompt');
                    prompt = mod.buildGeminiBrowserFootagePrompt();
                } else if (scanType === 'image') {
                    const mod = await import('@/prompts/documentary/gemini-browser-image-scan-prompt');
                    prompt = mod.buildGeminiBrowserImagePrompt();
                }
            } catch { prompt = '(Không tải được prompt fallback)'; }
        }

        return {
            id: `manual_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            filePath: fp, fileName, scanType, prompt,
            rawJson: '', parsedData: null, parseError: null, savedOk: false,
        };
    };

    /**
     * addFiles: CỘng thêm file vào list (KHÔNG xoá type khác)
     * Dùng khi muốn thêm lẻ vào giữa chừng
     */
    const addFiles = useCallback(async (filePaths: string[], scanType: ManualScanType) => {
        // await tất cả (async do có dynamic import prompt theo profile)
        const newItems = await Promise.all(filePaths.map(fp => buildItem(fp, scanType)));
        setItems(prev => [...prev, ...newItems]);
        if (newItems.length > 0) setActiveItemId(id => id ?? newItems[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /**
     * setFilesForType: THAY THẾ toàn bộ items của scanType đó bằng set mới
     * Giữ nguyên items của các type khác
     * Dùng khi bấm nút Scan tự động → không cộng dồn giữa các tab
     */
    const setFilesForType = useCallback(async (filePaths: string[], scanType: ManualScanType) => {
        // await tất cả (async do có dynamic import prompt theo profile)
        const newItems = await Promise.all(filePaths.map(fp => buildItem(fp, scanType)));
        // Giữ items của TYPE KHÁC, thay hẳn items của type này
        setItems(prev => [
            ...prev.filter(i => i.scanType !== scanType),
            ...newItems,
        ]);
        // Chọn item đầu tiên của type vừa load
        if (newItems.length > 0) setActiveItemId(newItems[0].id);
        else setActiveItemId(prev =>
            prev && items.find(i => i.id === prev && i.scanType !== scanType) ? prev : null
        );
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [items]);

    // ── Xoá 1 item ────────────────────────────────
    const removeItem = useCallback((id: string) => {
        setItems(prev => {
            const next = prev.filter(i => i.id !== id);
            return next;
        });
        setActiveItemId(prev => prev === id ? null : prev);
    }, []);

    // ── Cập nhật raw JSON khi user paste ──────────
    const updateRawJson = useCallback((id: string, rawJson: string) => {
        setItems(prev => prev.map(i => i.id === id
            ? { ...i, rawJson, parsedData: null, parseError: null, savedOk: false }
            : i
        ));
    }, []);

    // ── Parse JSON ────────────────────────────────
    const parseJson = useCallback((id: string) => {
        setItems(prev => prev.map(i => {
            if (i.id !== id) return i;
            const { data, error } = parseGeminiJson(i.rawJson);
            return { ...i, parsedData: data, parseError: error };
        }));
    }, []);

    // ── Lưu vào metadata ──────────────────────────
    const saveMetadata = useCallback(async (id: string) => {
        const item = items.find(i => i.id === id);
        if (!item || !item.parsedData) return;

        let ok = false;
        if (item.scanType === 'image') {
            ok = await saveImageMeta(item.filePath, item.fileName, item.parsedData);
        } else if (item.scanType === 'footage') {
            ok = await saveFootageMeta(item.filePath, item.fileName, item.parsedData);
        } else {
            // Truyền scanType (music | sfx) để lưu đúng type
            ok = await saveAudioMeta(item.filePath, item.fileName, item.parsedData, item.scanType);
        }

        setItems(prev => prev.map(i => i.id === id ? { ...i, savedOk: ok } : i));
    }, [items]);

    /**
     * parseAndSave: Parse + Lưu metadata trong 1 bước — không phụ thuộc timing state.
     * Giải quyết bug: setTimeout đọc state cũ trước khi React flush re-render.
     * Đây là hàm nút "Thêm vào metadata" gọi.
     */
    const parseAndSave = useCallback(async (id: string) => {
        // Đọc item trực tiếp từ state hiện tại (không qua state chain)
        const item = items.find(i => i.id === id);
        if (!item) return;

        // 1. Parse JSON từ rawJson — không cần parseJson state trước
        const { data, error } = parseGeminiJson(item.rawJson);
        if (error || !data) {
            console.warn('[ManualScan] ❌ Parse thất bại:', error);
            setItems(prev => prev.map(i => i.id === id
                ? { ...i, parsedData: null, parseError: error }
                : i
            ));
            return;
        }

        // 2. Lưu ngay vào file metadata — data lấy từ rawJson, không qua state
        let ok = false;
        if (item.scanType === 'image') {
            ok = await saveImageMeta(item.filePath, item.fileName, data);
        } else if (item.scanType === 'footage') {
            ok = await saveFootageMeta(item.filePath, item.fileName, data);
        } else {
            ok = await saveAudioMeta(item.filePath, item.fileName, data, item.scanType);
        }
        console.log(`[ManualScan] parseAndSave "${item.fileName}": parse ✅, save ${ok ? '✅' : '❌'}`);

        // 3. Cập nhật UI sau khi save xong
        setItems(prev => prev.map(i => i.id === id
            ? { ...i, parsedData: data, parseError: null, savedOk: ok }
            : i
        ));
    }, [items]);

    // ── Lưu tất cả item đã parse ──────────────────
    const saveAll = useCallback(async () => {
        const parsedItems = items.filter(i => i.parsedData && !i.savedOk);
        for (const item of parsedItems) {
            await saveMetadata(item.id);
        }
    }, [items, saveMetadata]);

    // ── Xoá tất cả ───────────────────────────────
    const clearAll = useCallback(() => {
        setItems([]);
        setActiveItemId(null);
    }, []);

    // ── Computed: item đang active ────────────────
    const activeItem = items.find(i => i.id === activeItemId) ?? null;

    return {
        items,
        activeItem,
        activeItemId,
        defaultScanType,
        // Actions
        setDefaultScanType,
        setActiveItemId,
        addFiles,
        setFilesForType,
        removeItem,
        updateRawJson,
        parseJson,
        saveMetadata,
        parseAndSave,   // Hàm gộp parse+save (không có race condition)
        saveAll,
        clearAll,
    };
}

