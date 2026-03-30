// GeminiScanResultCard.tsx
// Hiển thị kết quả scan 1 file (ảnh hoặc audio) từ Gemini

import React, { useState } from 'react';
import type { GeminiParsedResult } from '@/hooks/useGeminiScan';

interface GeminiScanResultCardProps {
    result: GeminiParsedResult;
}

const GeminiScanResultCard: React.FC<GeminiScanResultCardProps> = ({ result }) => {
    // Toggle xem raw text từ Gemini
    const [showRaw, setShowRaw] = useState(false);
    // Toggle xem JSON đẹp
    const [showJson, setShowJson] = useState(false);

    const { fileName, scanType, parsedJson, savedToMetadata, error, rawText } = result;

    // Lấy thông tin tóm tắt dựa theo loại scan
    const getSummary = () => {
        if (!parsedJson) return null;
        if (scanType === 'audio') {
            return {
                main: parsedJson.emotion?.join(', ') || '—',
                sub: parsedJson.intensity || '—',
                description: parsedJson.description || '',
                tags: parsedJson.tags || [],
            };
        } else {
            // Image
            return {
                main: parsedJson.isAIGenerated ? '🤖 AI Generated' : '📷 Ảnh thật',
                sub: `${parsedJson.confidence || 0}% chắc chắn`,
                description: parsedJson.description || '',
                tags: parsedJson.tags || [],
                extra: parsedJson.aiTool ? `Tool: ${parsedJson.aiTool}` : null,
                quality: parsedJson.quality || null,
                usable: parsedJson.usableForDocumentary,
                recommendation: parsedJson.recommendation || null,
            };
        }
    };

    const summary = getSummary();
    const hasError = !!error || !parsedJson;

    // Copy kết quả ra clipboard
    const handleCopy = () => {
        const text = parsedJson
            ? JSON.stringify(parsedJson, null, 2)
            : rawText;
        navigator.clipboard.writeText(text).catch(() => {});
    };

    return (
        <div style={{
            borderRadius: '10px',
            border: `1px solid ${hasError ? 'rgba(239,68,68,0.3)' : 'rgba(255,255,255,0.08)'}`,
            backgroundColor: hasError ? 'rgba(239,68,68,0.05)' : 'rgba(255,255,255,0.03)',
            padding: '12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
        }}>
            {/* ─── Header: tên file + status ─── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                    {/* Icon file type */}
                    <span style={{ fontSize: '14px', flexShrink: 0 }}>
                        {scanType === 'audio' ? '🎵' : '🖼️'}
                    </span>
                    {/* Tên file */}
                    <span style={{
                        fontSize: '12px',
                        fontWeight: 600,
                        color: '#e2e8f0',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}>
                        {fileName}
                    </span>
                </div>

                {/* Status badge */}
                <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                    {savedToMetadata && (
                        <span style={{
                            fontSize: '10px', padding: '2px 6px', borderRadius: '4px',
                            backgroundColor: 'rgba(34,197,94,0.15)', color: '#22c55e',
                            border: '1px solid rgba(34,197,94,0.3)',
                        }}>
                            💾 Đã lưu
                        </span>
                    )}
                    {hasError && (
                        <span style={{
                            fontSize: '10px', padding: '2px 6px', borderRadius: '4px',
                            backgroundColor: 'rgba(239,68,68,0.15)', color: '#ef4444',
                            border: '1px solid rgba(239,68,68,0.3)',
                        }}>
                            ❌ Lỗi
                        </span>
                    )}
                </div>
            </div>

            {/* ─── Nội dung tóm tắt ─── */}
            {summary && !hasError && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {/* Main info */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '13px', fontWeight: 600, color: '#a78bfa' }}>
                            {summary.main}
                        </span>
                        <span style={{ fontSize: '11px', color: '#94a3b8' }}>
                            {summary.sub}
                        </span>
                        {/* extra info (image: AI tool, quality) */}
                        {'extra' in summary && summary.extra && (
                            <span style={{ fontSize: '11px', color: '#f59e0b' }}>
                                {(summary as any).extra}
                            </span>
                        )}
                        {'quality' in summary && summary.quality && (
                            <span style={{
                                fontSize: '10px', padding: '1px 6px', borderRadius: '4px',
                                backgroundColor: 'rgba(59,130,246,0.15)', color: '#60a5fa',
                            }}>
                                {(summary as any).quality}
                            </span>
                        )}
                    </div>

                    {/* Description */}
                    {summary.description && (
                        <p style={{ fontSize: '11px', color: '#94a3b8', margin: 0, lineHeight: 1.5 }}>
                            {summary.description.slice(0, 200)}{summary.description.length > 200 ? '...' : ''}
                        </p>
                    )}

                    {/* Recommendation (image) */}
                    {'recommendation' in summary && (summary as any).recommendation && (
                        <p style={{
                            fontSize: '11px', color: '#22c55e', margin: 0,
                            padding: '4px 8px', borderRadius: '4px',
                            backgroundColor: 'rgba(34,197,94,0.08)',
                        }}>
                            💡 {(summary as any).recommendation}
                        </p>
                    )}

                    {/* Tags */}
                    {summary.tags.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                            {summary.tags.slice(0, 8).map((tag: string) => (
                                <span key={tag} style={{
                                    fontSize: '10px', padding: '1px 6px', borderRadius: '12px',
                                    backgroundColor: 'rgba(255,255,255,0.06)',
                                    color: '#64748b', border: '1px solid rgba(255,255,255,0.08)',
                                }}>
                                    #{tag}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* ─── Error message ─── */}
            {hasError && (
                <p style={{ fontSize: '11px', color: '#ef4444', margin: 0 }}>
                    {error || 'Không parse được JSON từ Gemini'}
                </p>
            )}

            {/* ─── Action buttons ─── */}
            <div style={{ display: 'flex', gap: '6px', marginTop: '2px' }}>
                <button
                    onClick={handleCopy}
                    style={{
                        padding: '3px 10px', borderRadius: '6px', fontSize: '11px',
                        backgroundColor: 'rgba(255,255,255,0.06)', color: '#94a3b8',
                        border: '1px solid rgba(255,255,255,0.1)', cursor: 'pointer',
                    }}
                >
                    📋 Copy JSON
                </button>
                <button
                    onClick={() => setShowJson(!showJson)}
                    style={{
                        padding: '3px 10px', borderRadius: '6px', fontSize: '11px',
                        backgroundColor: showJson ? 'rgba(168,85,247,0.15)' : 'rgba(255,255,255,0.06)',
                        color: showJson ? '#a855f7' : '#94a3b8',
                        border: `1px solid ${showJson ? 'rgba(168,85,247,0.3)' : 'rgba(255,255,255,0.1)'}`,
                        cursor: 'pointer',
                    }}
                >
                    {showJson ? '▲ Ẩn JSON' : '▼ Xem JSON'}
                </button>
                <button
                    onClick={() => setShowRaw(!showRaw)}
                    style={{
                        padding: '3px 10px', borderRadius: '6px', fontSize: '11px',
                        backgroundColor: showRaw ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.06)',
                        color: showRaw ? '#3b82f6' : '#94a3b8',
                        border: `1px solid ${showRaw ? 'rgba(59,130,246,0.3)' : 'rgba(255,255,255,0.1)'}`,
                        cursor: 'pointer',
                    }}
                >
                    {showRaw ? '▲ Ẩn raw' : '▼ Raw text'}
                </button>
            </div>

            {/* ─── JSON view ─── */}
            {showJson && parsedJson && (
                <pre style={{
                    fontSize: '10px', color: '#94a3b8', margin: 0,
                    padding: '8px', borderRadius: '6px',
                    backgroundColor: 'rgba(0,0,0,0.3)',
                    overflow: 'auto', maxHeight: '200px',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                }}>
                    {JSON.stringify(parsedJson, null, 2)}
                </pre>
            )}

            {/* ─── Raw text view ─── */}
            {showRaw && (
                <pre style={{
                    fontSize: '10px', color: '#64748b', margin: 0,
                    padding: '8px', borderRadius: '6px',
                    backgroundColor: 'rgba(0,0,0,0.3)',
                    overflow: 'auto', maxHeight: '150px',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                }}>
                    {rawText || '(không có text)'}
                </pre>
            )}
        </div>
    );
};

export default GeminiScanResultCard;
