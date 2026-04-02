/**
 * GeminiManualScanPanel.tsx
 * =========================
 * Tab "Manual Intelligence" — Scan thủ công file chưa có metadata.
 *
 * Luồng:
 *   1. Chọn Tab (Nhạc / SFX / Footage / Ảnh) → Bấm Scan
 *   2. Bấm file trong danh sách → Copy Prompt → Mở Gemini → Upload → Chạy
 *   3. Paste JSON về → Bấm "BƠM JSON" → Auto Parse + Lưu
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import { open as openUrl, Command } from '@tauri-apps/plugin-shell';
import { useManualScan, ManualScanType } from '@/hooks/useManualScan';
import { useProject } from '@/contexts/ProjectContext';
import { scanAudioFolder, loadAudioItemsFromFolder, findNewFiles } from '@/services/audio-library-service';
import { scanFootageFolder, loadFootageMetadata } from '@/services/footage-library-service';
import { ensureAutoMediaFolders, getMusicFolderPath, getSfxFolderPath, getFootageFolderPath, getRefImagesFolderPath } from '@/services/auto-media-storage';

// ═══════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════
const SCAN_TYPE_OPTIONS: { value: ManualScanType; label: string; emoji: string }[] = [
    { value: 'music',   label: 'Nhạc Nền', emoji: '🎵' },
    { value: 'sfx',     label: 'SFX',      emoji: '🔊' },
    { value: 'footage', label: 'Footage',  emoji: '📽️' },
    { value: 'image',   label: 'Ảnh',      emoji: '🖼️' },
];

// ═══════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════
export default function GeminiManualScanPanel() {
    const {
        items, activeItem, activeItemId, defaultScanType,
        setDefaultScanType, setActiveItemId,
        setFilesForType, removeItem, updateRawJson,
        parseAndSave, saveAll, clearAll,
    } = useManualScan();

    const [copiedPrompt, setCopiedPrompt] = useState(false);
    const [isAutoLoading, setIsAutoLoading] = useState(false);
    const [scanMsg, setScanMsg] = useState<string | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const { project } = useProject();

    // ── Khởi tạo Auto_media khi mount ─────────────────────
    useEffect(() => {
        // Tự tạo folder Auto_media đầy đủ khi mởi mở tab
        ensureAutoMediaFolders()
            .catch(err => console.warn('[ManualScan] Không thể tạo Auto_media:', err));
    }, []);

    // ── Scan tự động — THAY THẾ list của type đang chọn ──
    const handleScan = useCallback(async () => {
        setScanMsg(null);
        setIsAutoLoading(true);
        try {
            if (defaultScanType === 'music') {
                // Project folder ưu tiên, fallback vào ~/Desktop/Auto_media/nhac_nen (động)
                const folder = project?.musicLibrary?.musicFolder || await getMusicFolderPath();
                console.log('[ManualScan] music folder:', folder);
                const scanned = await scanAudioFolder(folder, 'music');
                const existing = await loadAudioItemsFromFolder(folder);
                
                // TỰ ĐỘNG DỌN DẸP
                const currentPaths = new Set(scanned.map(i => i.filePath));
                const cleanedExisting = existing.filter(item => currentPaths.has(item.filePath));
                if (existing.length - cleanedExisting.length > 0) {
                    const { saveAudioItemsToFolder } = await import('@/services/audio-library-service');
                    await saveAudioItemsToFolder(folder, cleanedExisting);
                }

                const newFiles = findNewFiles(scanned, cleanedExisting);
                console.log('[ManualScan] music scanned:', scanned.length, 'new:', newFiles.length);
                setFilesForType(newFiles.map((f: any) => f.filePath), 'music');
                setScanMsg(newFiles.length > 0
                    ? `✅ Tìm thấy ${newFiles.length} file chưa scan trong nhac_nen/`
                    : '✅ Tất cả nhạc đã được scan');
            }
            else if (defaultScanType === 'sfx') {
                const folder = project?.sfxLibrary?.sfxFolder || await getSfxFolderPath();
                console.log('[ManualScan] sfx folder:', folder);
                const scanned = await scanAudioFolder(folder, 'sfx');
                const existing = await loadAudioItemsFromFolder(folder);
                
                // TỰ ĐỘNG DỌN DẸP
                const currentPaths = new Set(scanned.map(i => i.filePath));
                const cleanedExisting = existing.filter(item => currentPaths.has(item.filePath));
                if (existing.length - cleanedExisting.length > 0) {
                    const { saveAudioItemsToFolder } = await import('@/services/audio-library-service');
                    await saveAudioItemsToFolder(folder, cleanedExisting);
                }

                const newFiles = findNewFiles(scanned, cleanedExisting);
                console.log('[ManualScan] sfx scanned:', scanned.length, 'new:', newFiles.length);
                setFilesForType(newFiles.map((f: any) => f.filePath), 'sfx');
                setScanMsg(newFiles.length > 0
                    ? `✅ Tìm thấy ${newFiles.length} SFX chưa scan trong sfx/`
                    : '✅ Tất cả SFX đã được scan');
            }
            else if (defaultScanType === 'footage') {
                const folder = project?.mediaImport?.mediaFolder || await getFootageFolderPath();
                console.log('[ManualScan] footage folder:', folder);
                const scanned = await scanFootageFolder(folder);
                const existing = await loadFootageMetadata(folder);
                
                // TỰ ĐỘNG DỌN DẸP FOOTAGE
                const currentPaths = new Set(scanned.map(i => i.filePath));
                const cleanedExisting = existing.filter((item: any) => currentPaths.has(item.filePath));
                if (existing.length - cleanedExisting.length > 0) {
                    const { saveFootageMetadata } = await import('@/services/footage-library-service');
                    await saveFootageMetadata(folder, cleanedExisting);
                }

                const existingMap = new Map(cleanedExisting.map((i: any) => [i.filePath, i]));
                const newFiles = scanned.filter((s: any) => {
                    const ex = existingMap.get(s.filePath);
                    return !(ex && ex.aiDescription && ex.aiMood !== 'Error' && ex.durationSec > 0 && ex.fileHash === s.fileHash);
                });
                console.log('[ManualScan] footage scanned:', scanned.length, 'new:', newFiles.length);
                setFilesForType(newFiles.map((f: any) => f.filePath), 'footage');
                setScanMsg(newFiles.length > 0
                    ? `✅ Tìm thấy ${newFiles.length} footage chưa scan trong footage/`
                    : '✅ Tất cả footage đã được scan');
            }
            else if (defaultScanType === 'image') {
                const refPath = await getRefImagesFolderPath();
                setScanMsg(`ℹ️ Nếu muốn scan ảnh, hãy thêm file từ: ${refPath}`);
            }
        } catch (err) {
            console.error('[ManualScan] Lỗi:', err);
            setScanMsg(`❌ Lỗi: ${String(err)}`);
        } finally {
            setIsAutoLoading(false);
        }
    }, [project, setFilesForType, defaultScanType]);

    // ── Parse + Lưu 1 cú bấm (atomic, không race condition) ────────
    const handleBoomJson = useCallback(async () => {
        if (!activeItemId) return;
        // parseAndSave: parse ngay từ rawJson + lưu file trong 1 async call
        await parseAndSave(activeItemId);
    }, [activeItemId, parseAndSave]);

    // ── Filtered list theo tab hiện tại ──────────
    const visibleItems = items.filter(i => i.scanType === defaultScanType);
    const savedCount   = visibleItems.filter(i => i.savedOk).length;
    const parsedCount  = visibleItems.filter(i => i.parsedData).length;

    return (
        <div className="flex flex-col h-full bg-background text-foreground overflow-hidden">

            {/* ── HEADER ── */}
            <div className="flex-none px-5 py-3 border-b border-border/40 bg-card/30 backdrop-blur flex justify-between items-center">
                <div>
                    <h2 className="text-base font-bold text-foreground flex items-center gap-2">
                        ✨ Scan Thủ Công
                    </h2>
                </div>
                {visibleItems.length > 0 && (
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground bg-muted px-3 py-1 rounded-md border border-border/50">
                            {savedCount}/{visibleItems.length} đã lưu
                        </span>
                        {parsedCount > savedCount && (
                            <button onClick={saveAll} className="px-3 py-1 bg-primary text-primary-foreground text-xs font-bold rounded-lg hover:-translate-y-0.5 transition-all shadow shadow-primary/30">
                                💾 Lưu Tất Cả
                            </button>
                        )}
                        <button onClick={clearAll} className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors" title="Xoá hết">
                            🗑
                        </button>
                    </div>
                )}
            </div>

            {/* ── MAIN 2-COLUMN LAYOUT ── */}
            <div className="flex-1 overflow-hidden flex gap-5 p-5">

                {/* ═══ CỘT TRÁI: CHỌN TYPE + DANH SÁCH ═══ */}
                <div className="w-[240px] flex-none flex flex-col gap-4">

                    {/* Segmented Control */}
                    <div className="bg-card/40 border border-border/50 rounded-2xl p-3 space-y-3">
                        <p className="text-[11px] font-bold text-muted-foreground uppercase tracking-widest px-1">Khu Vực</p>
                        <div className="grid grid-cols-2 gap-1 p-1 bg-muted/60 rounded-xl border border-border/40">
                            {SCAN_TYPE_OPTIONS.map(opt => (
                                <button
                                    key={opt.value}
                                    onClick={() => setDefaultScanType(opt.value)}
                                    className={`flex flex-col items-center py-2.5 rounded-lg transition-all duration-200 text-center ${
                                        defaultScanType === opt.value
                                            ? 'bg-background shadow text-foreground ring-1 ring-border'
                                            : 'text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground'
                                    }`}
                                >
                                    <span className="text-xl mb-1">{opt.emoji}</span>
                                    <span className="text-[10px] font-semibold leading-none">{opt.label}</span>
                                </button>
                            ))}
                        </div>

                        {/* Nút Scan + Thông báo */}
                        <div className="flex flex-col gap-2">
                            <button
                                onClick={handleScan}
                                disabled={isAutoLoading}
                                className="w-full flex items-center justify-center gap-2 py-2.5 bg-primary/10 text-primary border border-primary/20 rounded-xl font-semibold text-sm hover:bg-primary/20 transition-all disabled:opacity-50"
                            >
                                <span>{isAutoLoading ? '⏳' : '🔍'}</span>
                                {isAutoLoading ? 'Đang Scan...' : `Scan ${SCAN_TYPE_OPTIONS.find(o => o.value === defaultScanType)?.label}`}
                            </button>
                            {/* Thông báo kết quả scan */}
                            {scanMsg && (
                                <div className={`text-xs px-3 py-2 rounded-lg font-medium ${
                                    scanMsg.startsWith('✅') ? 'bg-green-500/10 text-green-600 border border-green-500/20'
                                    : scanMsg.startsWith('⚠') || scanMsg.startsWith('ℹ') ? 'bg-amber-500/10 text-amber-600 border border-amber-500/20'
                                    : 'bg-destructive/10 text-destructive border border-destructive/20'
                                }`}>
                                    {scanMsg}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* File Queue */}
                    {visibleItems.length > 0 ? (
                        <div className="flex-1 bg-card/40 border border-border/50 rounded-2xl p-3 flex flex-col overflow-hidden">
                            <p className="text-[11px] font-bold text-muted-foreground uppercase tracking-widest mb-2 px-1 flex justify-between">
                                <span>Chưa Scan ({visibleItems.length})</span>
                                <span className="text-green-500">{savedCount > 0 ? `✓ ${savedCount} xong` : ''}</span>
                            </p>
                            <div className="flex-1 overflow-y-auto space-y-1">
                                {visibleItems.map(item => (
                                    <div
                                        key={item.id}
                                        onClick={() => setActiveItemId(item.id)}
                                        className={`group flex items-center gap-2.5 p-2.5 rounded-xl border cursor-pointer transition-all ${
                                            item.id === activeItemId
                                                ? 'bg-primary/10 border-primary/30'
                                                : 'bg-muted/20 border-transparent hover:bg-muted/60 hover:border-border/50'
                                        }`}
                                    >
                                        {/* Status Dot */}
                                        <div className={`shrink-0 w-2.5 h-2.5 rounded-full ${
                                            item.savedOk ? 'bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.6)]'
                                            : item.parseError ? 'bg-destructive shadow-[0_0_6px_rgba(239,68,68,0.6)]'
                                            : item.parsedData ? 'bg-blue-400 animate-pulse'
                                            : 'bg-amber-400'
                                        }`} />
                                        <span className={`flex-1 text-xs font-medium truncate ${item.id === activeItemId ? 'text-primary' : 'text-foreground/80'}`}
                                              title={item.filePath}>
                                            {item.fileName}
                                        </span>
                                        <button
                                            onClick={e => { e.stopPropagation(); removeItem(item.id); }}
                                            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive text-xs px-1 transition-all"
                                        >✕</button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : (
                        <div className="flex-1 flex flex-col gap-2 p-1">
                            <div className="flex flex-col items-center justify-center text-center opacity-40 py-4">
                                <span className="text-3xl mb-2">📂</span>
                                <p className="text-xs text-muted-foreground">Bấm <strong>Scan</strong> để tải danh sách<br/>file chưa có metadata</p>
                            </div>

                            {/* Hint: để file ở folder chính, không để trong sub-folder */}
                            <div className="bg-amber-500/8 border border-amber-500/20 rounded-xl p-3 space-y-1.5">
                                <p className="text-[10px] font-bold text-amber-600/80 uppercase tracking-widest">⚠ Lưu ý cấu trúc folder</p>
                                <p className="text-[11px] text-muted-foreground leading-relaxed">
                                    Để file <span className="font-semibold text-foreground">trực tiếp trong folder</span>, không đặt vào sub-folder nhỏ hơn:
                                </p>
                                {/* Ví dụ động theo tab đang chọn */}
                                <div className="font-mono text-[10px] bg-muted/60 rounded-lg px-3 py-2 text-muted-foreground leading-relaxed">
                                    {defaultScanType === 'music' && (<>
                                        <span className="text-primary">nhac_nen/</span><br/>
                                        <span className="text-green-500">✓ nhac_nen/bai_hat.mp3</span><br/>
                                        <span className="text-destructive">✗ nhac_nen/album/bai_hat.mp3</span>
                                    </>)}
                                    {defaultScanType === 'sfx' && (<>
                                        <span className="text-primary">sfx/</span><br/>
                                        <span className="text-green-500">✓ sfx/tieng_gio.wav</span><br/>
                                        <span className="text-destructive">✗ sfx/nature/tieng_gio.wav</span>
                                    </>)}
                                    {defaultScanType === 'footage' && (<>
                                        <span className="text-primary">footage/</span><br/>
                                        <span className="text-green-500">✓ footage/clip_001.mp4</span><br/>
                                        <span className="text-destructive">✗ footage/project/clip_001.mp4</span>
                                    </>)}
                                    {defaultScanType === 'image' && (<>
                                        <span className="text-primary">ref_images/</span><br/>
                                        <span className="text-green-500">✓ ref_images/anh_01.jpg</span><br/>
                                        <span className="text-destructive">✗ ref_images/batch1/anh_01.jpg</span>
                                    </>)}
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                {/* ═══ CỘT PHẢI: WORKSPACE ═══ */}
                <div className="flex-1 min-w-0 bg-card/60 border border-border/50 rounded-3xl shadow-xl backdrop-blur overflow-hidden flex flex-col">

                    {!activeItem ? (
                        /* Empty State */
                        <div className="flex-1 flex flex-col items-center justify-center text-center opacity-50">
                            <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center mb-4 border border-border shadow-inner">
                                <span className="text-3xl">🪄</span>
                            </div>
                            <h3 className="font-bold text-foreground">Chọn file bên trái</h3>
                            <p className="text-sm text-muted-foreground max-w-60 mt-1.5 leading-relaxed">
                                Bấm vào một file trong danh sách để bắt đầu quy trình fix thủ công
                            </p>
                        </div>
                    ) : (
                        /* Workspace khi có file active */
                        <div className="flex-1 flex flex-col overflow-hidden">
                            {/* File Info Bar */}
                            <div className="flex-none flex items-center justify-between px-5 py-3 border-b border-border/40 bg-muted/20">
                                <div className="flex items-center gap-3 overflow-hidden">
                                    <div className="w-9 h-9 rounded-lg bg-background flex items-center justify-center border border-border shadow-sm shrink-0 text-lg">
                                        {activeItem.scanType === 'music' ? '🎵' : activeItem.scanType === 'sfx' ? '🔊' : activeItem.scanType === 'footage' ? '📽️' : '🖼️'}
                                    </div>
                                    <div className="overflow-hidden">
                                        <p className="text-sm font-bold truncate text-foreground/90" title={activeItem.fileName}>
                                            {activeItem.fileName}
                                        </p>
                                        <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-semibold">{activeItem.scanType}</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    <button
                                        onClick={async () => {
                                            try { await Command.create('exec-sh', ['-c', `open -R "${activeItem.filePath}"`]).execute(); }
                                            catch (e) { console.error(e); }
                                        }}
                                        className="px-3 py-1.5 bg-background border border-border rounded-lg text-xs font-semibold hover:bg-muted transition-colors shadow-sm"
                                    >
                                        📂 Finder
                                    </button>
                                    <button
                                        onClick={() => openUrl('https://gemini.google.com/app')}
                                        className="px-3 py-1.5 bg-blue-500/10 text-blue-500 border border-blue-500/20 rounded-lg text-xs font-bold hover:bg-blue-500/20 transition-colors shadow-sm"
                                    >
                                        ✦ Gemini
                                    </button>
                                </div>
                            </div>

                            {/* 2-pane: Prompt | JSON */}
                            <div className="flex-1 flex overflow-hidden">

                                {/* Trái: Prompt */}
                                <div className="w-1/2 border-r border-border/40 flex flex-col overflow-hidden">
                                    <div className="flex-none flex items-center justify-between px-4 py-2.5 bg-muted/30 border-b border-border/30">
                                        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">1. Copy Prompt này</p>
                                        <button
                                            onClick={async () => {
                                                await navigator.clipboard.writeText(activeItem.prompt);
                                                setCopiedPrompt(true);
                                                setTimeout(() => setCopiedPrompt(false), 2000);
                                            }}
                                            className={`px-3 py-1 rounded-md text-[10px] font-bold transition-all ${
                                                copiedPrompt
                                                    ? 'bg-green-500/20 text-green-500 border border-green-500/30'
                                                    : 'bg-primary text-primary-foreground shadow shadow-primary/30 hover:-translate-y-0.5'
                                            }`}
                                        >
                                            {copiedPrompt ? '✓ ĐÃ COPY' : '📋 COPY'}
                                        </button>
                                    </div>
                                    <div className="flex-1 overflow-y-auto p-4">
                                        <pre className="text-[11px] leading-relaxed font-mono text-muted-foreground/80 whitespace-pre-wrap">{activeItem.prompt}</pre>
                                    </div>
                                </div>

                                {/* Phải: JSON Drop + Action */}
                                <div className="w-1/2 flex flex-col overflow-hidden">
                                    <div className="flex-none flex items-center justify-between px-4 py-2.5 bg-muted/30 border-b border-border/30">
                                        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">2. Paste JSON vào đây</p>
                                        {activeItem.rawJson && !activeItem.savedOk && (
                                            <button onClick={() => updateRawJson(activeItem.id, '')} className="text-[10px] text-destructive hover:underline font-bold">Xoá</button>
                                        )}
                                    </div>

                                    <div className="relative flex-1 overflow-hidden">
                                        <textarea
                                            ref={textareaRef}
                                            placeholder={`Paste JSON từ Gemini vào đây...\n\n${activeItem.scanType === 'music' || activeItem.scanType === 'sfx'
                                                ? '{\n  "emotion": [...],\n  "intensity": "...",\n  "description": "..."\n}'
                                                : '{\n  "description": "...",\n  "tags": [...],\n  "mood": "..."\n}'
                                            }`}
                                            value={activeItem.rawJson}
                                            onChange={e => updateRawJson(activeItem.id, e.target.value)}
                                            className={`w-full h-full p-4 bg-transparent border-none outline-none resize-none text-xs font-mono leading-relaxed ${
                                                activeItem.savedOk ? 'text-green-500/80'
                                                : activeItem.parseError ? 'text-destructive/80'
                                                : 'text-foreground/80'
                                            }`}
                                        />
                                        {/* Lỗi parse */}
                                        {activeItem.parseError && (
                                            <div className="absolute bottom-3 left-3 right-3 p-2.5 bg-destructive/90 text-white text-xs font-medium rounded-lg shadow-xl backdrop-blur animate-in slide-in-from-bottom-2">
                                                🚨 {activeItem.parseError}
                                            </div>
                                        )}
                                    </div>

                                    {/* BIG Action Button */}
                                    <div className="flex-none p-4 border-t border-border/30">
                                        <button
                                            onClick={handleBoomJson}
                                            disabled={!activeItem.rawJson.trim() || activeItem.savedOk}
                                            className={`w-full py-3.5 rounded-xl font-bold text-sm tracking-wide transition-all border ${
                                                activeItem.savedOk
                                                    ? 'bg-green-500/10 text-green-500 border-green-500/20 cursor-default'
                                                    : !activeItem.rawJson.trim()
                                                        ? 'bg-muted text-muted-foreground border-border/50 opacity-40 cursor-not-allowed'
                                                        : 'bg-gradient-to-r from-primary to-purple-500 text-white border-transparent shadow-lg shadow-primary/30 hover:shadow-primary/50 hover:-translate-y-0.5'
                                            }`}
                                        >
                                            {activeItem.savedOk ? '✅ Đã lưu metadata' : '💾 Thêm vào metadata'}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
