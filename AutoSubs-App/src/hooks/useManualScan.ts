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
import { buildGeminiBrowserAudioPrompt, buildGeminiBrowserSfxPrompt } from '@/prompts/gemini-browser-audio-scan-prompt';
import { buildGeminiBrowserImagePrompt } from '@/prompts/gemini-browser-image-scan-prompt';

// ─── Types ─────────────────────────────────────────
export type ManualScanType = 'music' | 'sfx' | 'image';

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
async function saveAudioMeta(filePath: string, fileName: string, data: any): Promise<boolean> {
    try {
        const folder = filePath.substring(0, filePath.lastIndexOf('/'));
        const metaPath = await join(folder, AUDIO_METADATA_FILE);

        let existing: any = { version: '2.0', lastScanned: '', itemCount: 0, items: [] };
        if (await exists(metaPath)) {
            existing = JSON.parse(await readTextFile(metaPath));
        }

        const item = {
            filePath, fileName,
            fileHash: fileName.split('').reduce((h, c) => (((h << 5) - h) + c.charCodeAt(0)) | 0, 0).toString(36),
            durationSec: data.totalDurationSec || 0,
            type: 'music' as const,
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

    // ── Thêm file vào danh sách ────────────────────
    const addFiles = useCallback((filePaths: string[], scanType: ManualScanType) => {
        const newItems: ManualScanItem[] = filePaths.map(fp => {
            const fileName = fp.split('/').pop() || fp;
            // Chọn prompt theo loại
            const prompt = scanType === 'image'
                ? buildGeminiBrowserImagePrompt()
                : scanType === 'sfx'
                    ? buildGeminiBrowserSfxPrompt()
                    : buildGeminiBrowserAudioPrompt();

            return {
                id: `manual_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                filePath: fp,
                fileName,
                scanType,
                prompt,
                rawJson: '',
                parsedData: null,
                parseError: null,
                savedOk: false,
            };
        });

        setItems(prev => [...prev, ...newItems]);
        // Tự chọn item đầu tiên nếu chưa có active
        if (newItems.length > 0) {
            setActiveItemId(id => id ?? newItems[0].id);
        }
    }, []);

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
        } else {
            ok = await saveAudioMeta(item.filePath, item.fileName, item.parsedData);
        }

        setItems(prev => prev.map(i => i.id === id ? { ...i, savedOk: ok } : i));
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
        removeItem,
        updateRawJson,
        parseJson,
        saveMetadata,
        saveAll,
        clearAll,
    };
}
