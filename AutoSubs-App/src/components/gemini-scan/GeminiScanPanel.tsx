// GeminiScanPanel.tsx
// Panel chính của tab Gemini Scan
// Cho phép: chọn loại scan (audio/image) → chọn file/folder → scan qua Gemini browser → xem kết quả → lưu metadata

import React, { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { readDir } from '@tauri-apps/plugin-fs';
import GeminiScanStatusBadge from './GeminiScanStatusBadge';
import GeminiScanResultCard from './GeminiScanResultCard';
import GeminiDebugTimeline from './GeminiDebugTimeline';
import { useGeminiScan } from '@/hooks/useGeminiScan';
import type { GeminiScanType } from '@/services/geminiScanService';

// Extensions hỗ trợ
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.aiff', '.flac', '.ogg', '.m4a'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

// Màu log theo status
const LOG_COLORS: Record<string, string> = {
    info: '#94a3b8',
    processing: '#3b82f6',
    done: '#22c55e',
    error: '#ef4444',
    stopped: '#f59e0b',
};

// ═══════════════════════════════════════════════════
// COMPONENT CHÍNH
// ═══════════════════════════════════════════════════
export function GeminiScanPanel() {
    // Hook state
    const {
        serverStatus, serverMessage, isScanning, progress,
        logs, results,
        debugSteps, bugReport,           // ← debug state
        connect, confirmLogin, disconnect, stopScan,
        startScan, clearLogs, clearResults, clearDebug, checkHealth,
    } = useGeminiScan();

    // Loại scan đang chọn
    const [scanType, setScanType] = useState<GeminiScanType>('audio');
    // Sub-type của audio
    const [audioSubType, setAudioSubType] = useState<'music' | 'sfx'>('music');
    // Danh sách file đã chọn
    const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
    // Tab kết quả hiện tại
    const [activeResultTab, setActiveResultTab] = useState<'results' | 'logs' | 'debug'>('logs');

    // Auto-scroll log
    const logEndRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [logs.length]);

    // Check server health khi mount
    useEffect(() => {
        checkHealth();
    }, [checkHealth]);

    // ── Chọn file đơn lẻ ────────────────────────────
    const handleSelectFiles = async () => {
        const extensions = scanType === 'audio' ? AUDIO_EXTENSIONS : IMAGE_EXTENSIONS;
        const selected = await open({
            multiple: true,
            filters: [{
                name: scanType === 'audio' ? 'Audio files' : 'Image files',
                extensions: extensions.map(e => e.replace('.', '')),
            }],
        });
        if (selected) {
            const paths = Array.isArray(selected) ? selected : [selected];
            setSelectedFiles(prev => {
                const all = [...prev, ...paths];
                // Loại trùng
                return [...new Set(all)];
            });
        }
    };

    // ── Chọn toàn bộ folder ─────────────────────────
    const handleSelectFolder = async () => {
        const selected = await open({ directory: true });
        if (!selected || Array.isArray(selected)) return;

        try {
            const extensions = scanType === 'audio' ? AUDIO_EXTENSIONS : IMAGE_EXTENSIONS;
            // Quét đệ quy folder
            const scanFolder = async (folderPath: string): Promise<string[]> => {
                const entries = await readDir(folderPath);
                const files: string[] = [];
                for (const entry of entries) {
                    if (!entry.name || entry.name.startsWith('.')) continue;
                    const fullPath = `${folderPath}/${entry.name}`;
                    if (entry.isDirectory) {
                        const sub = await scanFolder(fullPath);
                        files.push(...sub);
                    } else {
                        const ext = entry.name.toLowerCase().slice(entry.name.lastIndexOf('.'));
                        if (extensions.includes(ext)) files.push(fullPath);
                    }
                }
                return files;
            };

            const files = await scanFolder(selected as string);
            setSelectedFiles(prev => [...new Set([...prev, ...files])]);
        } catch (e) {
            console.error('[GeminiScan] Lỗi quét folder:', e);
        }
    };

    // ── Xoá 1 file khỏi danh sách ──────────────────
    const removeFile = (fp: string) => {
        setSelectedFiles(prev => prev.filter(f => f !== fp));
    };

    // ── Bắt đầu scan ────────────────────────────────
    const handleStartScan = async () => {
        if (selectedFiles.length === 0) return;
        await startScan(scanType, selectedFiles, audioSubType);
    };

    // Thanh % tiến trình
    const progressPercent = progress.total > 0
        ? Math.round((progress.done / progress.total) * 100)
        : 0;

    // ── RENDER ───────────────────────────────────────
    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            overflow: 'hidden',
            backgroundColor: 'transparent',
        }}>
            {/* ─────────── Scroll container ─────────── */}
            <div style={{
                flex: 1,
                overflowY: 'auto',
                padding: '16px',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
            }}>

                {/* ═══ SECTION 1: KẾT NỐI SERVER ═══ */}
                <div style={sectionStyle}>
                    <div style={sectionHeaderStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontSize: '16px' }}>🤖</span>
                            <div>
                                <div style={titleStyle}>Gemini Browser Scan</div>
                                <div style={subtitleStyle}>Scan ảnh/audio qua giao diện Gemini (không cần API key)</div>
                            </div>
                            <GeminiScanStatusBadge status={serverStatus} />
                        </div>

                        {/* Action buttons */}
                        <div style={{ display: 'flex', gap: '6px' }}>
                            {serverStatus === 'disconnected' && (
                                <button style={btnPrimary} onClick={connect}>
                                    🔌 Kết nối
                                </button>
                            )}
                            {serverStatus === 'waiting_login' && (
                                <button style={btnSuccess} onClick={confirmLogin}>
                                    ✅ Đã đăng nhập
                                </button>
                            )}
                            {isScanning && (
                                <button style={btnDanger} onClick={stopScan}>
                                    ⏹ Dừng
                                </button>
                            )}
                            {serverStatus !== 'disconnected' && !isScanning && (
                                <button style={btnGhost} onClick={disconnect} title="Đóng Chrome">
                                    ✕
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Server message */}
                    {serverMessage && (
                        <div style={{
                            fontSize: '12px', color: '#94a3b8',
                            padding: '6px 10px', borderRadius: '6px',
                            backgroundColor: 'rgba(255,255,255,0.04)',
                        }}>
                            {serverMessage}
                        </div>
                    )}

                    {/* Hướng dẫn khi chưa kết nối */}
                    {serverStatus === 'disconnected' && (
                        <div style={{
                            fontSize: '12px', color: '#64748b',
                            padding: '10px', borderRadius: '8px',
                            backgroundColor: 'rgba(0,0,0,0.2)',
                            lineHeight: 1.7,
                        }}>
                            <p style={{ margin: '0 0 4px 0', fontWeight: 600, color: '#94a3b8' }}>📋 Hướng dẫn:</p>
                            <p style={{ margin: 0 }}>
                                1. Mở Terminal → chạy: <code style={codeStyle}>python scripts/gemini_server.py</code>
                            </p>
                            <p style={{ margin: 0 }}>2. Bấm <strong>Kết nối</strong> → Chrome mở gemini.google.com</p>
                            <p style={{ margin: 0 }}>3. Đăng nhập Google trên Chrome → bấm <strong>Đã đăng nhập</strong></p>
                            <p style={{ margin: 0 }}>4. Chọn file → bấm <strong>Bắt đầu Scan</strong></p>
                        </div>
                    )}
                </div>

                {/* ═══ SECTION 2: LOẠI SCAN ═══ */}
                <div style={sectionStyle}>
                    <div style={labelStyle}>Loại scan</div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                            style={scanType === 'audio' ? tabBtnActive : tabBtnInactive}
                            onClick={() => { setScanType('audio'); setSelectedFiles([]); }}
                        >
                            🎵 Audio (nhạc + SFX)
                        </button>
                        <button
                            style={scanType === 'image' ? tabBtnActive : tabBtnInactive}
                            onClick={() => { setScanType('image'); setSelectedFiles([]); }}
                        >
                            🖼️ Hình ảnh
                        </button>
                    </div>

                    {/* Sub-type cho audio */}
                    {scanType === 'audio' && (
                        <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                                style={audioSubType === 'music' ? tabBtnActive : tabBtnInactive}
                                onClick={() => setAudioSubType('music')}
                            >
                                🎼 Nhạc nền
                            </button>
                            <button
                                style={audioSubType === 'sfx' ? tabBtnActive : tabBtnInactive}
                                onClick={() => setAudioSubType('sfx')}
                            >
                                🔊 SFX
                            </button>
                        </div>
                    )}
                </div>

                {/* ═══ SECTION 3: CHỌN FILE ═══ */}
                <div style={sectionStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={labelStyle}>File cần scan ({selectedFiles.length})</div>
                        <div style={{ display: 'flex', gap: '6px' }}>
                            <button style={btnSmall} onClick={handleSelectFiles}>
                                📄 Chọn file
                            </button>
                            <button style={btnSmall} onClick={handleSelectFolder}>
                                📁 Chọn folder
                            </button>
                            {selectedFiles.length > 0 && (
                                <button
                                    style={{ ...btnSmall, color: '#ef4444' }}
                                    onClick={() => setSelectedFiles([])}
                                >
                                    🗑 Xoá hết
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Danh sách file đã chọn */}
                    {selectedFiles.length > 0 && (
                        <div style={{
                            maxHeight: '140px', overflowY: 'auto',
                            borderRadius: '8px', backgroundColor: 'rgba(0,0,0,0.2)',
                            padding: '6px',
                        }}>
                            {selectedFiles.map((fp, idx) => (
                                <div key={fp} style={{
                                    display: 'flex', alignItems: 'center', gap: '6px',
                                    padding: '3px 6px', borderRadius: '4px',
                                    fontSize: '11px', color: '#94a3b8',
                                }}>
                                    <span style={{ color: '#64748b', flexShrink: 0 }}>{idx + 1}.</span>
                                    <span style={{
                                        flex: 1, overflow: 'hidden',
                                        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                    }}>
                                        {fp.split('/').pop()}
                                    </span>
                                    <button
                                        onClick={() => removeFile(fp)}
                                        style={{
                                            background: 'none', border: 'none',
                                            color: '#64748b', cursor: 'pointer',
                                            fontSize: '11px', padding: '0 2px',
                                            flexShrink: 0,
                                        }}
                                        title={fp}
                                    >
                                        ✕
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    {selectedFiles.length === 0 && (
                        <div style={{
                            textAlign: 'center', padding: '12px',
                            color: '#475569', fontSize: '12px',
                        }}>
                            Chưa có file nào. Bấm "Chọn file" hoặc "Chọn folder".
                        </div>
                    )}
                </div>

                {/* ═══ SECTION 4: TIẾN TRÌNH + NÚT SCAN ═══ */}
                <div style={sectionStyle}>
                    {/* Progress bar */}
                    {progress.total > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <div style={{
                                height: '6px', borderRadius: '3px',
                                backgroundColor: 'rgba(255,255,255,0.1)', overflow: 'hidden',
                            }}>
                                <div style={{
                                    height: '100%', borderRadius: '3px',
                                    width: `${progressPercent}%`,
                                    backgroundColor: progress.failed > 0 ? '#f59e0b' : '#a855f7',
                                    transition: 'width 0.3s ease',
                                }} />
                            </div>
                            <div style={{
                                display: 'flex', justifyContent: 'space-between',
                                fontSize: '11px', color: '#94a3b8',
                            }}>
                                <span>
                                    {progress.done}/{progress.total}
                                    {progress.failed > 0 && ` (${progress.failed} lỗi)`}
                                    {progress.currentFileName && ` — ${progress.currentFileName}`}
                                </span>
                                <span>{progressPercent}%</span>
                            </div>
                        </div>
                    )}

                    {/* Nút scan */}
                    <button
                        style={{
                            ...btnPrimary,
                            width: '100%',
                            justifyContent: 'center',
                            padding: '10px',
                            fontSize: '13px',
                            opacity: (serverStatus !== 'ready' || selectedFiles.length === 0 || isScanning) ? 0.5 : 1,
                            cursor: (serverStatus !== 'ready' || selectedFiles.length === 0 || isScanning) ? 'not-allowed' : 'pointer',
                            background: 'linear-gradient(135deg, #7c3aed, #a855f7)',
                        }}
                        onClick={handleStartScan}
                        disabled={serverStatus !== 'ready' || selectedFiles.length === 0 || isScanning}
                    >
                        {isScanning
                            ? `⏳ Đang scan ${progress.done}/${progress.total}...`
                            : `🚀 Bắt đầu Scan (${selectedFiles.length} file)`
                        }
                    </button>
                </div>

                {/* ═══ SECTION 5: KẾT QUẢ + LOG ═══ */}
                {(results.length > 0 || logs.length > 0 || debugSteps.length > 0) && (
                    <div style={sectionStyle}>
                        {/* Tab switcher: Results / Logs / Debug */}
                        <div style={{ display: 'flex', gap: '4px', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '8px' }}>
                            <button
                                style={activeResultTab === 'results' ? tabBtnActive : tabBtnInactive}
                                onClick={() => setActiveResultTab('results')}
                            >
                                📊 Kết quả ({results.length})
                            </button>
                            <button
                                style={activeResultTab === 'logs' ? tabBtnActive : tabBtnInactive}
                                onClick={() => setActiveResultTab('logs')}
                            >
                                📋 Log ({logs.length})
                            </button>
                            <div style={{ flex: 1 }} />
                            <button
                                style={{ ...btnSmall, color: '#64748b' }}
                                onClick={() => { clearLogs(); clearResults(); }}
                            >
                                🗑 Xoá
                            </button>
                        </div>

                        {/* Results tab */}
                        {activeResultTab === 'results' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                {results.length === 0 && (
                                    <div style={{ textAlign: 'center', color: '#475569', fontSize: '12px', padding: '12px' }}>
                                        Chưa có kết quả. Hãy scan file trước.
                                    </div>
                                )}
                                {results.map((result) => (
                                    <GeminiScanResultCard key={result.jobId} result={result} />
                                ))}
                            </div>
                        )}

                        {/* Logs tab */}
                        {activeResultTab === 'logs' && (
                            <div style={{
                                display: 'flex', flexDirection: 'column',
                                maxHeight: '250px', overflowY: 'auto',
                                borderRadius: '8px', backgroundColor: 'rgba(0,0,0,0.2)',
                                padding: '8px', fontFamily: 'monospace',
                            }}>
                                {logs.map((log, idx) => (
                                    <div key={idx} style={{
                                        display: 'flex', gap: '6px',
                                        padding: '2px 0',
                                        borderBottom: '1px solid rgba(255,255,255,0.03)',
                                        fontSize: '11px', lineHeight: '1.4',
                                    }}>
                                        <span style={{ color: '#475569', flexShrink: 0, minWidth: '55px' }}>
                                            {new Date(log.timestamp).toLocaleTimeString('vi-VN', {
                                                hour: '2-digit', minute: '2-digit', second: '2-digit',
                                            })}
                                        </span>
                                        <span style={{
                                            color: LOG_COLORS[log.status] || '#94a3b8',
                                            wordBreak: 'break-word', flex: 1, minWidth: 0,
                                        }}>
                                            {log.message}
                                        </span>
                                    </div>
                                ))}
                                <div ref={logEndRef} />
                            </div>
                        )}

                        {/* Debug Timeline tab — screenshot + DOM badges */}
                        {activeResultTab === 'debug' && (
                            <GeminiDebugTimeline
                                debugSteps={debugSteps}
                                bugReport={bugReport}
                                onClear={clearDebug}
                            />
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════
// STYLES (inline object — không dùng CSS files riêng)
// ═══════════════════════════════════════════════════

const sectionStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '14px',
    borderRadius: '12px',
    backgroundColor: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.06)',
};

const sectionHeaderStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
};

const titleStyle: React.CSSProperties = {
    fontSize: '14px', fontWeight: 600, color: '#e2e8f0',
};

const subtitleStyle: React.CSSProperties = {
    fontSize: '11px', color: '#64748b',
};

const labelStyle: React.CSSProperties = {
    fontSize: '12px', fontWeight: 600, color: '#94a3b8',
};

const codeStyle: React.CSSProperties = {
    backgroundColor: 'rgba(255,255,255,0.1)',
    padding: '1px 6px', borderRadius: '4px',
    fontSize: '11px', fontFamily: 'monospace',
};

// Buttons
const btnBase: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '4px',
    padding: '5px 12px', borderRadius: '8px', border: 'none',
    fontSize: '12px', fontWeight: 500, cursor: 'pointer',
    transition: 'all 0.2s',
};

const btnPrimary: React.CSSProperties = {
    ...btnBase, backgroundColor: '#7c3aed', color: '#fff',
};

const btnSuccess: React.CSSProperties = {
    ...btnBase, backgroundColor: '#22c55e', color: '#fff',
};

const btnDanger: React.CSSProperties = {
    ...btnBase, backgroundColor: '#ef4444', color: '#fff',
};

const btnGhost: React.CSSProperties = {
    ...btnBase,
    backgroundColor: 'transparent', color: '#94a3b8',
    border: '1px solid rgba(255,255,255,0.1)',
};

const btnSmall: React.CSSProperties = {
    padding: '3px 10px', borderRadius: '6px',
    border: '1px solid rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(255,255,255,0.05)',
    color: '#94a3b8', fontSize: '11px', cursor: 'pointer',
};

const tabBtnActive: React.CSSProperties = {
    padding: '4px 12px', borderRadius: '6px', border: 'none',
    backgroundColor: 'rgba(168,85,247,0.2)', color: '#a855f7',
    fontSize: '12px', cursor: 'pointer',
    boxShadow: '0 0 0 1px rgba(168,85,247,0.3)',
};

const tabBtnInactive: React.CSSProperties = {
    padding: '4px 12px', borderRadius: '6px',
    border: '1px solid rgba(255,255,255,0.08)',
    backgroundColor: 'transparent', color: '#64748b',
    fontSize: '12px', cursor: 'pointer',
};
