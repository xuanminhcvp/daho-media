// useGeminiScan.ts
// Hook quản lý toàn bộ state cho Gemini Scan Tab
// Bao gồm: trạng thái server, queue file, kết quả, và logic lưu metadata

import { useState, useRef, useCallback, useEffect } from 'react';
import {
    GeminiServerStatus,
    GeminiScanType,
    GeminiScanJob,
    GeminiScanResult as _GeminiScanResult, // re-exported bên dưới
    checkGeminiServerHealth,
    getGeminiStatus,
    startGeminiSession,
    confirmGeminiLogin,
    stopGeminiScan,
    closeGeminiSession,
    scanBatchSSE,
} from '@/services/geminiScanService';

// Tauri filesystem để lưu metadata
import { writeTextFile, readTextFile, exists } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';

// Import component types (debug timeline + bug report)
import type { GeminiDebugStep, GeminiBugReport } from '@/components/gemini-scan/GeminiDebugTimeline';

// Import prompt builders
import { buildGeminiBrowserAudioPrompt, buildGeminiBrowserSfxPrompt } from '@/prompts/gemini-browser-audio-scan-prompt';
import { buildGeminiBrowserImagePrompt } from '@/prompts/gemini-browser-image-scan-prompt';

// ─── Types ────────────────────────────────────────
/** 1 dòng log trong panel */
export interface GeminiScanLogEntry {
    timestamp: number;
    status: 'info' | 'processing' | 'done' | 'error' | 'stopped';
    message: string;
    fileName?: string;
}

/** Tiến trình scan hiện tại */
export interface GeminiScanProgress {
    done: number;
    total: number;
    failed: number;
    currentFileName: string;
}

// Re-export types cho bên ngoài dùng
export type { GeminiDebugStep, GeminiBugReport };

/** Kết quả 1 file sau khi parse JSON từ Gemini response */
export interface GeminiParsedResult {
    jobId: string;
    filePath: string;
    fileName: string;
    scanType: GeminiScanType;
    rawText: string;          // Text thô từ Gemini
    parsedJson: any | null;   // JSON đã parse (null nếu parse lỗi)
    savedToMetadata: boolean; // Đã lưu vào file JSON thành công chưa
    error: string | null;
}

// ─── Constants ────────────────────────────────────
/** Tên file metadata audio (trùng với audio-library-service.ts) */
const AUDIO_METADATA_FILE = 'autosubs_audio_metadata.json';
/** Tên file metadata ảnh */
const IMAGE_METADATA_FILE = 'autosubs_image_metadata.json';

// ─── Parse JSON từ text Gemini trả về ─────────────
function parseGeminiResponse(text: string): any | null {
    try {
        // Bỏ thinking tags nếu có
        let cleaned = text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
        // Bỏ markdown code block
        const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlock) cleaned = codeBlock[1];
        // Tìm JSON object
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        return JSON.parse(jsonMatch[0]);
    } catch {
        return null;
    }
}

// ─── Lưu kết quả audio vào autosubs_audio_metadata.json ─────────
async function saveAudioMetadata(
    filePath: string,
    fileName: string,
    parsedJson: any,
): Promise<boolean> {
    try {
        // Lấy thư mục chứa file
        const folderPath = filePath.substring(0, filePath.lastIndexOf('/'));
        const metaPath = await join(folderPath, AUDIO_METADATA_FILE);

        // Load metadata hiện có (nếu có)
        let existingData: any = { version: '2.0', lastScanned: '', itemCount: 0, items: [] };
        const fileExists = await exists(metaPath);
        if (fileExists) {
            const raw = await readTextFile(metaPath);
            existingData = JSON.parse(raw);
        }

        // Tạo item mới theo chuẩn AudioLibraryItem
        const newItem = {
            filePath,
            fileName,
            fileHash: fileName.split('').reduce((h, c) => (((h << 5) - h) + c.charCodeAt(0)) | 0, 0).toString(36),
            durationSec: parsedJson.totalDurationSec || 0,
            type: 'music' as const,
            aiMetadata: {
                emotion: parsedJson.emotion || ['Không xác định'],
                intensity: parsedJson.intensity || 'Trung bình',
                description: parsedJson.description || '',
                tags: parsedJson.tags || [],
                bestFor: parsedJson.bestFor || [],
                hasDrop: parsedJson.hasDrop ?? undefined,
                hasBuildUp: parsedJson.hasBuildUp ?? undefined,
                totalDurationSec: parsedJson.totalDurationSec ?? undefined,
                timeline: parsedJson.timeline || [],
                beats: parsedJson.beats || [],
                trimSuggestions: parsedJson.trimSuggestions || [],
            },
            scannedAt: new Date().toISOString(),
            // Đánh dấu scan bởi Gemini browser (không phải API key)
            scannedBy: 'gemini-browser',
        };

        // Merge: nếu đã có item cùng filePath → update, không thì thêm mới
        const items: any[] = existingData.items || [];
        const idx = items.findIndex((i: any) => i.filePath === filePath);
        if (idx >= 0) {
            items[idx] = newItem;
        } else {
            items.push(newItem);
        }

        // Lưu lại file JSON
        const updated = {
            ...existingData,
            lastScanned: new Date().toISOString(),
            itemCount: items.length,
            items,
        };
        await writeTextFile(metaPath, JSON.stringify(updated, null, 2));
        console.log(`[GeminiScan] 💾 Đã lưu metadata audio: ${fileName} → ${AUDIO_METADATA_FILE}`);
        return true;
    } catch (error) {
        console.error(`[GeminiScan] ❌ Lỗi lưu audio metadata:`, error);
        return false;
    }
}

// ─── Lưu kết quả ảnh vào autosubs_image_metadata.json ─────────
async function saveImageMetadata(
    filePath: string,
    fileName: string,
    parsedJson: any,
): Promise<boolean> {
    try {
        const folderPath = filePath.substring(0, filePath.lastIndexOf('/'));
        const metaPath = await join(folderPath, IMAGE_METADATA_FILE);

        // Load metadata hiện có
        let existingData: any = { version: '1.0', lastScanned: '', itemCount: 0, items: [] };
        const fileExists = await exists(metaPath);
        if (fileExists) {
            const raw = await readTextFile(metaPath);
            existingData = JSON.parse(raw);
        }

        // Tạo item mới
        const newItem = {
            filePath,
            fileName,
            scanType: 'image',
            aiMetadata: parsedJson,
            scannedAt: new Date().toISOString(),
            scannedBy: 'gemini-browser',
        };

        // Merge
        const items: any[] = existingData.items || [];
        const idx = items.findIndex((i: any) => i.filePath === filePath);
        if (idx >= 0) {
            items[idx] = newItem;
        } else {
            items.push(newItem);
        }

        const updated = {
            ...existingData,
            lastScanned: new Date().toISOString(),
            itemCount: items.length,
            items,
        };
        await writeTextFile(metaPath, JSON.stringify(updated, null, 2));
        console.log(`[GeminiScan] 💾 Đã lưu metadata ảnh: ${fileName} → ${IMAGE_METADATA_FILE}`);
        return true;
    } catch (error) {
        console.error(`[GeminiScan] ❌ Lỗi lưu image metadata:`, error);
        return false;
    }
}

// ═══════════════════════════════════════════════════
// HOOK CHÍNH
// ═══════════════════════════════════════════════════
export function useGeminiScan() {
    // Trạng thái server
    const [serverStatus, setServerStatus] = useState<GeminiServerStatus>('disconnected');
    const [serverMessage, setServerMessage] = useState('');
    
    // Đang scan không
    const [isScanning, setIsScanning] = useState(false);
    
    // Tiến trình
    const [progress, setProgress] = useState<GeminiScanProgress>({
        done: 0, total: 0, failed: 0, currentFileName: '',
    });
    
    // Log entries
    const [logs, setLogs] = useState<GeminiScanLogEntry[]>([]);

    // Kết quả đã parse
    const [results, setResults] = useState<GeminiParsedResult[]>([]);

    // ─── DEBUG STATE ─────────────────────────────────
    // Danh sách debug steps (screenshot + DOM info)
    const [debugSteps, setDebugSteps] = useState<GeminiDebugStep[]>([]);
    // Bug report hiện tại
    const [bugReport, setBugReport] = useState<GeminiBugReport | null>(null);
    
    // AbortController để dừng SSE
    const abortControllerRef = useRef<AbortController | null>(null);
    
    // Thêm log entry
    const addLog = useCallback((
        message: string,
        status: GeminiScanLogEntry['status'] = 'info',
        fileName?: string
    ) => {
        setLogs(prev => [...prev, { timestamp: Date.now(), status, message, fileName }]);
    }, []);

    // Poll trạng thái server mỗi 5 giây (khi đang scanning)
    useEffect(() => {
        if (!isScanning) return;
        const interval = setInterval(async () => {
            try {
                const st = await getGeminiStatus();
                setServerStatus(st.status);
                setServerMessage(st.message);
            } catch {
                // Server ngắt → bỏ qua
            }
        }, 5000);
        return () => clearInterval(interval);
    }, [isScanning]);

    // ── Kết nối (mở Chrome) ──────────────────────────
    const connect = useCallback(async () => {
        addLog('Đang mở Chrome + Gemini...', 'info');
        setServerStatus('connecting');
        try {
            const res = await startGeminiSession();
            if (res.ok) {
                setServerStatus('waiting_login');
                setServerMessage(res.message || 'Chrome đã mở. Đăng nhập Google rồi xác nhận.');
                addLog('Chrome đã mở gemini.google.com. Đăng nhập Google rồi bấm "Đã đăng nhập".', 'info');
            } else {
                setServerStatus('error');
                setServerMessage(res.error || 'Lỗi kết nối');
                addLog(`Lỗi: ${res.error}`, 'error');
            }
        } catch (e: any) {
            setServerStatus('error');
            addLog(`Lỗi: ${e.message}. Hãy chạy: python scripts/gemini_server.py`, 'error');
        }
    }, [addLog]);

    // ── Xác nhận đăng nhập ───────────────────────────
    const confirmLogin = useCallback(async () => {
        addLog('Đang kiểm tra đăng nhập Gemini...', 'info');
        try {
            const res = await confirmGeminiLogin();
            if (res.ok) {
                setServerStatus('ready');
                setServerMessage('Sẵn sàng scan!');
                addLog('✅ Đã xác nhận đăng nhập! Sẵn sàng scan file.', 'done');
            } else {
                setServerStatus('waiting_login');
                addLog(`Chưa OK: ${res.error}`, 'error');
            }
        } catch (e: any) {
            addLog(`Lỗi: ${e.message}`, 'error');
        }
    }, [addLog]);

    // ── Đóng Chrome ──────────────────────────────────
    const disconnect = useCallback(async () => {
        await closeGeminiSession();
        setServerStatus('disconnected');
        setServerMessage('');
        addLog('Đã đóng Chrome.', 'info');
    }, [addLog]);

    // ── Dừng scan ────────────────────────────────────
    const stopScan = useCallback(async () => {
        abortControllerRef.current?.abort();
        await stopGeminiScan();
        setIsScanning(false);
        addLog('Đã dừng scan.', 'stopped');
    }, [addLog]);

    // ── Xoá log ──────────────────────────────────────
    const clearLogs = useCallback(() => setLogs([]), []);

    // Xoá kết quả
    const clearResults = useCallback(() => setResults([]), []);

    // Xoá debug
    const clearDebug = useCallback(() => {
        setDebugSteps([]);
        setBugReport(null);
    }, []);

    // ── Bắt đầu scan hàng loạt ───────────────────────
    const startScan = useCallback(async (
        scanType: GeminiScanType,
        filePaths: string[],  // Đường dẫn tuyệt đối các file cần scan
        audioSubType: 'music' | 'sfx' = 'music',  // Dành cho audio
    ) => {
        if (serverStatus !== 'ready') {
            addLog('Server chưa sẵn sàng. Hãy kết nối và đăng nhập trước.', 'error');
            return;
        }
        if (filePaths.length === 0) {
            addLog('Chưa chọn file nào để scan.', 'error');
            return;
        }

        // Reset state
        setResults([]);
        setDebugSteps([]);       // Reset debug timeline
        setBugReport(null);      // Reset bug report
        setIsScanning(true);
        setServerStatus('scanning');
        setProgress({ done: 0, total: filePaths.length, failed: 0, currentFileName: '' });
        addLog(`Bắt đầu scan ${filePaths.length} file (${scanType})...`, 'info');

        // Xây dựng prompt theo scan type
        const getPrompt = (fp: string): string => {
            if (scanType === 'image') return buildGeminiBrowserImagePrompt();
            // Audio: phân biệt music vs sfx theo extension/folder
            const isLikelySfx = fp.toLowerCase().includes('sfx') || fp.toLowerCase().includes('sound_effect');
            return audioSubType === 'sfx' || isLikelySfx
                ? buildGeminiBrowserSfxPrompt()
                : buildGeminiBrowserAudioPrompt();
        };

        // Tạo danh sách jobs
        const jobs: GeminiScanJob[] = filePaths.map((fp, i) => ({
            job_id: `${scanType}_${i}`,
            file_path: fp,
            file_name: fp.split('/').pop() || fp,
            prompt: getPrompt(fp),
        }));

        // AbortController để dừng
        const controller = new AbortController();
        abortControllerRef.current = controller;

        try {
            await scanBatchSSE(
                scanType,
                jobs,
                async (event) => {
                    switch (event.event) {
                        case 'processing':
                            // Đang xử lý 1 file
                            setProgress(prev => ({
                                ...prev,
                                currentFileName: event.data.file_name || '',
                            }));
                            addLog(`Đang scan: ${event.data.file_name}`, 'processing', event.data.file_name);
                            break;

                        case 'done': {
                            // 1 file xong — parse JSON + lưu metadata
                            const responseText = event.data.response_text || '';
                            const parsedJson = parseGeminiResponse(responseText);
                            const filePath = event.data.file_path || '';
                            const fileName = event.data.file_name || '';

                            let savedOk = false;
                            if (parsedJson) {
                                // Lưu vào metadata file tương ứng
                                if (scanType === 'audio') {
                                    savedOk = await saveAudioMetadata(filePath, fileName, parsedJson);
                                } else {
                                    savedOk = await saveImageMetadata(filePath, fileName, parsedJson);
                                }
                            }

                            // Thêm vào results
                            const result: GeminiParsedResult = {
                                jobId: event.data.job_id || '',
                                filePath,
                                fileName,
                                scanType: event.data.scan_type || scanType,
                                rawText: responseText,
                                parsedJson,
                                savedToMetadata: savedOk,
                                error: parsedJson ? null : 'Không parse được JSON từ Gemini',
                            };
                            setResults(prev => [...prev, result]);

                            // Cập nhật progress
                            setProgress(prev => ({
                                ...prev,
                                done: event.data.done || prev.done + 1,
                                currentFileName: '',
                            }));

                            addLog(
                                parsedJson
                                    ? `✅ ${fileName} — ${savedOk ? 'đã lưu metadata' : 'lưu thất bại'}`
                                    : `⚠️ ${fileName} — scan OK nhưng không parse được JSON`,
                                parsedJson ? 'done' : 'error',
                                fileName,
                            );
                            break;
                        }

                        case 'error':
                            // Lỗi 1 file (bỏ qua, tiếp tục)
                            setProgress(prev => ({
                                ...prev,
                                failed: (event.data.failed || prev.failed),
                                currentFileName: '',
                            }));
                            addLog(`❌ ${event.data.file_name}: ${event.data.error}`, 'error', event.data.file_name);
                            break;

                        case 'stopped':
                            addLog('⏹ Đã dừng scan.', 'stopped');
                            break;

                        case 'complete':
                            addLog(
                                `🎉 Hoàn tất! ${event.data.done}/${event.data.total} file thành công.`,
                                'done',
                            );
                            // Cập nhật bug report tổng
                            if (event.data.bug_report) {
                                setBugReport(event.data.bug_report as GeminiBugReport);
                            }
                            break;

                        case 'debug_step':
                            // Nhận screenshot + DOM info từ server → thêm vào debug timeline
                            if (event.data.step) {
                                setDebugSteps(prev => [...prev, {
                                    step: event.data.step!,
                                    step_index: event.data.step_index || 0,
                                    job_id: event.data.job_id || '',
                                    timestamp: event.data.timestamp || Date.now() / 1000,
                                    screenshot_base64: event.data.screenshot_base64 || null,
                                    dom_info: event.data.dom_info || {
                                        url: '', title: '', buttons: [], inputs: [], file_inputs: [],
                                        large_images: 0, large_images_detail: [], popups: [], has_spinner: false,
                                    },
                                    extra: event.data.extra || {},
                                    is_error: event.data.is_error || false,
                                    message: event.data.message || '',
                                } as GeminiDebugStep]);
                            }
                            break;

                        case 'bug_report':
                            // Nhận bug report từng file → cập nhật state (ghi đè lên báo cáo mới nhất)
                            if (event.data.report) {
                                setBugReport(event.data.report as GeminiBugReport);
                                const rpt = event.data.report;
                                if (rpt.total_errors > 0) {
                                    addLog(
                                        `🐛 [${event.data.file_name}] ${rpt.total_errors} lỗi, ${rpt.total_warnings} warnings`,
                                        'error',
                                        event.data.file_name,
                                    );
                                }
                            }
                            break;
                    }
                },
                controller.signal,
            );
        } catch (e: any) {
            if (e.name !== 'AbortError') {
                addLog(`Lỗi scan batch: ${e.message}`, 'error');
            }
        } finally {
            setIsScanning(false);
            setServerStatus('ready');
            setProgress(prev => ({ ...prev, currentFileName: '' }));
        }
    }, [serverStatus, addLog]);

    // ── Check server health khi mount ────────────────
    const checkHealth = useCallback(async () => {
        const alive = await checkGeminiServerHealth();
        if (alive) {
            const st = await getGeminiStatus().catch(() => null);
            if (st) {
                setServerStatus(st.status);
                setServerMessage(st.message);
            }
        }
    }, []);

    return {
        // State
        serverStatus,
        serverMessage,
        isScanning,
        progress,
        logs,
        results,
        // Debug state
        debugSteps,
        bugReport,
        // Actions
        connect,
        confirmLogin,
        disconnect,
        stopScan,
        startScan,
        clearLogs,
        clearResults,
        clearDebug,
        checkHealth,
    };
}
