/**
 * GeminiManualScanPanel.tsx
 * =========================
 * Tab "Scan Thủ Công" — không cần Python server hay Chrome automation.
 *
 * Luồng:
 *   BƯỚC 1  → Chọn loại scan + chọn file
 *   BƯỚC 2  → Copy prompt → mở Gemini → upload file → paste prompt → chạy
 *   BƯỚC 3  → Copy JSON từ Gemini → paste vào ô → Parse → Lưu vào Metadata
 *
 * Hỗ trợ batch: thêm nhiều file, xử lý từng file một.
 */

import React, { useRef, useState, useCallback } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { desktopDir, join as pathJoin } from '@tauri-apps/api/path';  // lấy đường dẫn Desktop
import { useManualScan, ManualScanType } from '@/hooks/useManualScan';

// ═══════════════════════════════════════════════════
// STYLES (dùng inline style cho nhất quán với codebase)
// ═══════════════════════════════════════════════════
const colors = {
    bg:       'rgba(0,0,0,0)',
    card:     'rgba(255,255,255,0.04)',
    cardHov:  'rgba(255,255,255,0.07)',
    border:   'rgba(255,255,255,0.06)',
    borderAct:'rgba(139,92,246,0.4)',   // tím khi active
    text:     '#e2e8f0',
    textMuted:'#64748b',
    textSub:  '#94a3b8',
    purple:   '#a78bfa',
    green:    '#4ade80',
    red:      '#f87171',
    yellow:   '#fbbf24',
    blue:     '#60a5fa',
};

const btn = (variant: 'primary' | 'secondary' | 'ghost' | 'danger'): React.CSSProperties => ({
    padding: '6px 14px', borderRadius: '8px',
    fontSize: '12px', fontWeight: 500,
    cursor: 'pointer', border: 'none',
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    transition: 'all 0.15s',
    ...(variant === 'primary' && {
        background: 'linear-gradient(135deg, #7c3aed, #a855f7)',
        color: '#fff', boxShadow: '0 2px 8px rgba(124,58,237,0.3)',
    }),
    ...(variant === 'secondary' && {
        backgroundColor: 'rgba(255,255,255,0.08)',
        color: colors.text, border: `1px solid ${colors.border}`,
    }),
    ...(variant === 'ghost' && {
        backgroundColor: 'transparent',
        color: colors.textMuted, border: `1px solid rgba(255,255,255,0.05)`,
    }),
    ...(variant === 'danger' && {
        backgroundColor: 'rgba(239,68,68,0.1)',
        color: colors.red, border: '1px solid rgba(239,68,68,0.2)',
    }),
});

const section: React.CSSProperties = {
    borderRadius: '12px',
    backgroundColor: colors.card,
    border: `1px solid ${colors.border}`,
    padding: '14px 16px',
    display: 'flex', flexDirection: 'column', gap: '10px',
};

const stepLabel = (): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center',
    gap: '8px', fontSize: '12px', fontWeight: 600, color: colors.text,
});

const stepNumber = (color: string): React.CSSProperties => ({
    width: '22px', height: '22px', borderRadius: '50%',
    backgroundColor: color, color: '#fff',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '11px', fontWeight: 700, flexShrink: 0,
});

// ═══════════════════════════════════════════════════
// COMPONENT: PILL CHỌN SCAN TYPE
// ═══════════════════════════════════════════════════
const SCAN_TYPE_OPTIONS: { value: ManualScanType; label: string; emoji: string }[] = [
    { value: 'music', label: 'Nhạc nền', emoji: '🎵' },
    { value: 'sfx',   label: 'SFX',      emoji: '🔊' },
    { value: 'image', label: 'Ảnh',      emoji: '🖼️' },
];

// ═══════════════════════════════════════════════════
// COMPONENT: FILE LIST (sidebar trái)
// ═══════════════════════════════════════════════════
const FileList: React.FC<{
    items: ReturnType<typeof useManualScan>['items'];
    activeId: string | null;
    onSelect: (id: string) => void;
    onRemove: (id: string) => void;
}> = ({ items, activeId, onSelect, onRemove }) => {
    if (items.length === 0) return null;

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', gap: '4px',
            maxHeight: '160px', overflowY: 'auto',
        }}>
            {items.map(item => (
                <div
                    key={item.id}
                    onClick={() => onSelect(item.id)}
                    style={{
                        display: 'flex', alignItems: 'center', gap: '8px',
                        padding: '6px 10px', borderRadius: '8px', cursor: 'pointer',
                        backgroundColor: item.id === activeId ? 'rgba(139,92,246,0.12)' : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${item.id === activeId ? colors.borderAct : 'transparent'}`,
                        transition: 'all 0.15s',
                    }}
                >
                    {/* Status icon */}
                    <span style={{ fontSize: '14px', flexShrink: 0 }}>
                        {item.savedOk ? '✅' : item.parseError ? '❌' : item.parsedData ? '📋' : '⏳'}
                    </span>
                    {/* Tên file */}
                    <span style={{
                        flex: 1, minWidth: 0, fontSize: '11px', color: colors.textSub,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }} title={item.filePath}>
                        {item.fileName}
                    </span>
                    {/* Loại scan */}
                    <span style={{ fontSize: '10px', color: colors.textMuted, flexShrink: 0 }}>
                        {item.scanType}
                    </span>
                    {/* Nút xoá */}
                    <button
                        onClick={e => { e.stopPropagation(); onRemove(item.id); }}
                        style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            color: colors.textMuted, fontSize: '12px', padding: '0 2px',
                            flexShrink: 0,
                        }}
                        title="Xoá"
                    >×</button>
                </div>
            ))}
        </div>
    );
};

// ═══════════════════════════════════════════════════
// COMPONENT CHÍNH
// ═══════════════════════════════════════════════════
const GeminiManualScanPanel: React.FC = () => {
    const {
        items, activeItem, activeItemId, defaultScanType,
        setDefaultScanType, setActiveItemId,
        addFiles, removeItem,
        updateRawJson, parseJson, saveMetadata, saveAll, clearAll,
    } = useManualScan();

    // State copy feedback
    const [copiedPrompt, setCopiedPrompt] = useState(false);
    const [copiedJson,   setCopiedJson]   = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // ── Chọn file (mặc định mở ~/Desktop/auto-media) ──────────
    const handlePickFiles = useCallback(async () => {
        const isImage = defaultScanType === 'image';

        // Tính đường dẫn ~/Desktop/auto-media làm thư mục mặc định
        let defaultPath: string | undefined;
        try {
            const desktop = await desktopDir();
            defaultPath = await pathJoin(desktop, 'Auto_media');
        } catch {
            defaultPath = undefined; // fallback: mở ở vị trí mặc định nếu lỗi
        }

        const selected = await openDialog({
            multiple: true,
            defaultPath,   // <-- mở thẳng vào auto-media
            filters: isImage
                ? [{ name: 'Ảnh', extensions: ['jpg','jpeg','png','webp','gif'] }]
                : [{ name: 'Audio', extensions: ['mp3','wav','aac','m4a','ogg','flac','aiff'] }],
        });
        if (!selected) return;
        const paths = Array.isArray(selected) ? selected : [selected];
        addFiles(paths, defaultScanType);
    }, [defaultScanType, addFiles]);

    // ── Copy prompt ───────────────────────────────
    const handleCopyPrompt = useCallback(async () => {
        if (!activeItem) return;
        await navigator.clipboard.writeText(activeItem.prompt);
        setCopiedPrompt(true);
        setTimeout(() => setCopiedPrompt(false), 2000);
    }, [activeItem]);

    // ── Copy JSON (để xem lại) ────────────────────
    const handleCopyJson = useCallback(async () => {
        if (!activeItem?.rawJson) return;
        await navigator.clipboard.writeText(activeItem.rawJson);
        setCopiedJson(true);
        setTimeout(() => setCopiedJson(false), 2000);
    }, [activeItem]);

    // ── Mở Gemini trên trình duyệt ────────────────
    const handleOpenGemini = useCallback(async () => {
        await openUrl('https://gemini.google.com/app');
    }, []);

    // ── Parse ─────────────────────────────────────
    const handleParse = useCallback(() => {
        if (!activeItemId) return;
        parseJson(activeItemId);
    }, [activeItemId, parseJson]);

    // ── Lưu 1 item ────────────────────────────────
    const handleSave = useCallback(async () => {
        if (!activeItemId) return;
        await saveMetadata(activeItemId);
    }, [activeItemId, saveMetadata]);

    // Đếm items đã parse, đã lưu
    const parsedCount = items.filter(i => i.parsedData).length;
    const savedCount  = items.filter(i => i.savedOk).length;

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', gap: '12px',
            padding: '2px 0',
        }}>
            {/* ═══ HEADER ═══ */}
            <div style={{
                display: 'flex', alignItems: 'center',
                justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px',
            }}>
                <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: colors.text }}>
                        ✍️ Scan Thủ Công
                    </div>
                    <div style={{ fontSize: '11px', color: colors.textMuted, marginTop: '2px' }}>
                        Tự upload lên Gemini → paste JSON về đây → lưu metadata
                    </div>
                </div>
                {items.length > 0 && (
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <span style={{ fontSize: '11px', color: colors.textMuted }}>
                            {savedCount}/{items.length} đã lưu
                        </span>
                        {parsedCount > savedCount && (
                            <button style={btn('primary')} onClick={saveAll}>
                                💾 Lưu tất cả ({parsedCount - savedCount})
                            </button>
                        )}
                        <button style={btn('ghost')} onClick={clearAll} title="Xoá tất cả">
                            🗑
                        </button>
                    </div>
                )}
            </div>

            {/* ═══ BƯỚC 1: Loại scan + Chọn file ═══ */}
            <div style={section}>
                <div style={stepLabel()}>
                    <span style={stepNumber('rgba(139,92,246,0.8)')}>1</span>
                    Chọn loại scan &amp; file
                </div>

                {/* Pill chọn loại */}
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {SCAN_TYPE_OPTIONS.map(opt => (
                        <button
                            key={opt.value}
                            onClick={() => setDefaultScanType(opt.value)}
                            style={{
                                padding: '5px 12px', borderRadius: '20px',
                                fontSize: '12px', fontWeight: 500, cursor: 'pointer',
                                border: 'none', transition: 'all 0.15s',
                                background: defaultScanType === opt.value
                                    ? 'linear-gradient(135deg, #7c3aed, #a855f7)'
                                    : 'rgba(255,255,255,0.06)',
                                color: defaultScanType === opt.value ? '#fff' : colors.textSub,
                                boxShadow: defaultScanType === opt.value
                                    ? '0 2px 8px rgba(124,58,237,0.3)' : 'none',
                            }}
                        >
                            {opt.emoji} {opt.label}
                        </button>
                    ))}
                </div>

                {/* Nút chọn file */}
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <button style={btn('secondary')} onClick={handlePickFiles}>
                        📂 Chọn file {defaultScanType === 'image' ? 'ảnh' : 'audio'}
                    </button>
                    {items.length > 0 && (
                        <span style={{ fontSize: '11px', color: colors.textMuted }}>
                            {items.length} file đã thêm
                        </span>
                    )}
                </div>

                {/* Danh sách file đã chọn */}
                <FileList
                    items={items}
                    activeId={activeItemId}
                    onSelect={setActiveItemId}
                    onRemove={removeItem}
                />
            </div>

            {/* ═══ BƯỚC 2: Prompt ═══ (chỉ hiện khi có file active) */}
            {activeItem && (
                <div style={section}>
                    <div style={stepLabel()}>
                        <span style={stepNumber('rgba(59,130,246,0.8)')}>2</span>
                        Copy prompt → Upload lên Gemini → Chạy
                    </div>

                    {/* File đang xử lý */}
                    <div style={{
                        fontSize: '11px', color: colors.purple,
                        padding: '4px 10px', borderRadius: '6px',
                        backgroundColor: 'rgba(139,92,246,0.1)',
                        border: '1px solid rgba(139,92,246,0.2)',
                        display: 'flex', alignItems: 'center', gap: '6px',
                    }}>
                        📄 <span style={{ fontWeight: 500 }}>{activeItem.fileName}</span>
                        <span style={{ color: colors.textMuted }}>({activeItem.scanType})</span>
                    </div>

                    {/* Prompt box */}
                    <div style={{
                        borderRadius: '8px', backgroundColor: 'rgba(0,0,0,0.25)',
                        border: `1px solid ${colors.border}`,
                        padding: '10px 12px',
                        fontSize: '11px', color: colors.textSub,
                        fontFamily: 'monospace', lineHeight: '1.5',
                        maxHeight: '120px', overflowY: 'auto',
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    }}>
                        {activeItem.prompt}
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <button style={btn('primary')} onClick={handleCopyPrompt}>
                            {copiedPrompt ? '✅ Đã copy!' : '📋 Copy Prompt'}
                        </button>
                        <button style={btn('secondary')} onClick={handleOpenGemini}>
                            🌐 Mở Gemini
                        </button>
                    </div>

                    <div style={{
                        fontSize: '10px', color: colors.textMuted,
                        padding: '6px 10px', borderRadius: '6px',
                        backgroundColor: 'rgba(255,255,255,0.02)',
                        lineHeight: '1.6',
                    }}>
                        💡 <strong>Hướng dẫn:</strong> Copy prompt → Mở Gemini → Upload file{' '}
                        <code style={{ fontSize: '10px', backgroundColor: 'rgba(255,255,255,0.06)', padding: '1px 4px', borderRadius: '3px' }}>
                            {activeItem.fileName}
                        </code>
                        {' '}→ Paste prompt → Enter → Copy toàn bộ JSON phản hồi
                    </div>
                </div>
            )}

            {/* ═══ BƯỚC 3: Paste JSON ═══ */}
            {activeItem && (
                <div style={section}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={stepLabel()}>
                            <span style={stepNumber('rgba(34,197,94,0.8)')}>3</span>
                            Paste JSON từ Gemini → Parse → Lưu
                        </div>
                        {activeItem.rawJson && (
                            <button style={btn('ghost')} onClick={handleCopyJson}>
                                {copiedJson ? '✅ Copied' : '📋 Copy lại'}
                            </button>
                        )}
                    </div>

                    {/* Textarea paste JSON */}
                    <textarea
                        ref={textareaRef}
                        placeholder={`Paste JSON từ Gemini vào đây...\n\nGemini sẽ trả về dạng:\n{\n  "emotion": [...],\n  "intensity": "...",\n  "description": "...",\n  ...\n}`}
                        value={activeItem.rawJson}
                        onChange={e => updateRawJson(activeItem.id, e.target.value)}
                        style={{
                            width: '100%', minHeight: '140px',
                            backgroundColor: 'rgba(0,0,0,0.3)',
                            border: `1px solid ${activeItem.parseError ? 'rgba(239,68,68,0.4)' : colors.border}`,
                            borderRadius: '8px', padding: '10px 12px',
                            color: colors.text, fontSize: '11px',
                            fontFamily: 'monospace', lineHeight: '1.5',
                            resize: 'vertical', outline: 'none',
                            boxSizing: 'border-box',
                        }}
                        onFocus={e => (e.target.style.borderColor = 'rgba(139,92,246,0.5)')}
                        onBlur={e => (e.target.style.borderColor = activeItem.parseError
                            ? 'rgba(239,68,68,0.4)' : colors.border)}
                    />

                    {/* Lỗi parse */}
                    {activeItem.parseError && (
                        <div style={{
                            fontSize: '11px', color: colors.red,
                            padding: '6px 10px', borderRadius: '6px',
                            backgroundColor: 'rgba(239,68,68,0.08)',
                            border: '1px solid rgba(239,68,68,0.2)',
                        }}>
                            ❌ {activeItem.parseError}
                        </div>
                    )}

                    {/* Nút Parse */}
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <button
                            style={btn('secondary')}
                            onClick={handleParse}
                            disabled={!activeItem.rawJson.trim()}
                        >
                            🔍 Parse JSON
                        </button>
                        {activeItem.parsedData && !activeItem.savedOk && (
                            <button style={btn('primary')} onClick={handleSave}>
                                💾 Lưu vào Metadata
                            </button>
                        )}
                        {activeItem.savedOk && (
                            <span style={{
                                fontSize: '12px', color: colors.green,
                                display: 'flex', alignItems: 'center', gap: '4px',
                            }}>
                                ✅ Đã lưu vào metadata!
                            </span>
                        )}
                    </div>

                    {/* Preview kết quả parsed */}
                    {activeItem.parsedData && (
                        <ParsedPreview data={activeItem.parsedData} scanType={activeItem.scanType} />
                    )}
                </div>
            )}

            {/* ═══ EMPTY STATE ═══ */}
            {items.length === 0 && (
                <div style={{
                    textAlign: 'center', padding: '32px 16px',
                    color: colors.textMuted, fontSize: '12px',
                    border: `2px dashed ${colors.border}`,
                    borderRadius: '12px',
                }}>
                    <div style={{ fontSize: '32px', marginBottom: '10px' }}>✍️</div>
                    <div style={{ fontWeight: 500, color: colors.textSub, marginBottom: '6px' }}>
                        Chưa có file nào
                    </div>
                    <div style={{ lineHeight: '1.6' }}>
                        Chọn loại scan → bấm <strong>Chọn file</strong> để bắt đầu
                    </div>
                </div>
            )}
        </div>
    );
};

// ═══════════════════════════════════════════════════
// SUB-COMPONENT: PREVIEW KẾT QUẢ PARSE
// ═══════════════════════════════════════════════════
const ParsedPreview: React.FC<{ data: any; scanType: ManualScanType }> = ({ data, scanType }) => {
    const [showRaw, setShowRaw] = useState(false);

    return (
        <div style={{
            borderRadius: '8px', backgroundColor: 'rgba(34,197,94,0.05)',
            border: '1px solid rgba(34,197,94,0.15)',
            padding: '10px 12px',
            display: 'flex', flexDirection: 'column', gap: '8px',
        }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: colors.green }}>
                    ✅ Parse thành công
                </span>
                <button
                    onClick={() => setShowRaw(s => !s)}
                    style={{
                        fontSize: '10px', color: colors.textMuted, cursor: 'pointer',
                        background: 'none', border: 'none', padding: 0,
                    }}
                >
                    {showRaw ? 'Ẩn JSON thô' : 'Xem JSON thô'}
                </button>
            </div>

            {/* Hiển thị theo loại scan */}
            {scanType !== 'image' ? (
                // Audio preview
                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    {data.description && (
                        <PreviewRow label="Mô tả" value={data.description} />
                    )}
                    {data.emotion && (
                        <PreviewRow label="Cảm xúc" value={[].concat(data.emotion).join(', ')} />
                    )}
                    {data.intensity && (
                        <PreviewRow label="Cường độ" value={data.intensity} />
                    )}
                    {data.tags && (
                        <PreviewRowTags label="Tags" tags={[].concat(data.tags)} />
                    )}
                    {data.bestFor && (
                        <PreviewRowTags label="Dùng cho" tags={[].concat(data.bestFor)} />
                    )}
                    {data.totalDurationSec !== undefined && (
                        <PreviewRow label="Thời lượng" value={`${data.totalDurationSec}s`} />
                    )}
                </div>
            ) : (
                // Image preview
                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    {Object.entries(data).slice(0, 6).map(([k, v]) => (
                        <PreviewRow key={k} label={k} value={
                            typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : String(v)
                        } />
                    ))}
                </div>
            )}

            {/* JSON thô */}
            {showRaw && (
                <pre style={{
                    fontSize: '10px', color: colors.textSub,
                    backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: '6px',
                    padding: '8px', margin: 0, overflowX: 'auto',
                    maxHeight: '180px', overflowY: 'auto',
                }}>
                    {JSON.stringify(data, null, 2)}
                </pre>
            )}
        </div>
    );
};

const PreviewRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
    <div style={{ display: 'flex', gap: '6px', fontSize: '11px' }}>
        <span style={{ color: colors.textMuted, flexShrink: 0, minWidth: '75px' }}>{label}:</span>
        <span style={{ color: colors.textSub, flex: 1, wordBreak: 'break-word' }}>{value}</span>
    </div>
);

const PreviewRowTags: React.FC<{ label: string; tags: string[] }> = ({ label, tags }) => (
    <div style={{ display: 'flex', gap: '6px', fontSize: '11px', alignItems: 'flex-start' }}>
        <span style={{ color: colors.textMuted, flexShrink: 0, minWidth: '75px' }}>{label}:</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {tags.slice(0, 8).map((t, i) => (
                <span key={i} style={{
                    padding: '1px 8px', borderRadius: '10px',
                    backgroundColor: 'rgba(139,92,246,0.12)',
                    color: colors.purple, fontSize: '10px',
                }}>
                    {t}
                </span>
            ))}
        </div>
    </div>
);

export default GeminiManualScanPanel;
