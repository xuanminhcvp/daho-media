/**
 * GeminiDebugTimeline.tsx
 * =======================
 * Timeline hiển thị screenshots + DOM info từ Gemini Scan server.
 * Mỗi step = 1 card: thumbnail (click phóng to) + DOM state badges.
 * Giúp debug Chrome đang làm gì mà không cần nhìn trực tiếp Chrome.
 *
 * Pattern copy từ FlowDebugTimeline.tsx của dự án 3d-documentary.
 */

import React, { useRef, useEffect, useState } from 'react';

// ─── Types từ SSE event "debug_step" ───────────────
export interface GeminiDebugStep {
    step: string;
    step_index: number;
    job_id: string;
    timestamp: number;
    screenshot_base64: string | null;
    dom_info: {
        url: string;
        title: string;
        viewport?: { w: number; h: number };
        buttons: Array<{
            text: string;
            aria: string;
            visible: boolean;
            enabled: boolean;
            x: number; y: number;
        }>;
        inputs: Array<{ type: string; visible: boolean; text_length: number; text_preview: string }>;
        file_inputs: Array<{ visible: boolean; accept: string }>;
        large_images: number;
        large_images_detail: Array<{ w: number; h: number; src_preview: string }>;
        popups: string[];
        has_spinner: boolean;
        gemini_response_preview?: string;
    };
    extra: Record<string, any>;
    is_error: boolean;
    message: string;
}

// ─── Bug report type ───────────────────────────────
export interface GeminiBugReport {
    total_errors: number;
    total_warnings: number;
    errors: Array<{ code: string; message: string; context: any; ts: string }>;
    warnings: Array<{ code: string; message: string; context: any; ts: string }>;
}

// ═══════════════════════════════════════════════════
// STEP LABELS (step name → label đẹp hiển thị UI)
// ═══════════════════════════════════════════════════
const STEP_LABELS: Record<string, string> = {
    browser_opened:        '🌐 Chrome đã mở',
    confirm_login_check:   '🔍 Kiểm tra đăng nhập',
    login_confirmed:       '✅ Đã đăng nhập',
    login_failed:          '❌ Chưa đăng nhập',
    before_upload:         '📎 Trước khi upload file',
    after_gemini_response: '💬 Gemini đã phản hồi',
    batch_complete:        '🎉 Hoàn tất batch',
};

const getStepLabel = (step: string): string => {
    if (STEP_LABELS[step]) return STEP_LABELS[step];
    if (step.startsWith('error_'))     return `❌ Lỗi: ${step.replace('error_', '')}`;
    if (step.startsWith('exception_')) return `💥 Exception: ${step.replace('exception_', '')}`;
    return `📋 ${step}`;
};

// ═══════════════════════════════════════════════════
// COMPONENT: 1 STEP CARD
// ═══════════════════════════════════════════════════
interface StepCardProps {
    step: GeminiDebugStep;
    onClickScreenshot: (step: GeminiDebugStep) => void;
}

const StepCard: React.FC<StepCardProps> = ({ step, onClickScreenshot }) => {
    const dom = step.dom_info;
    const enabledBtns = dom.buttons.filter(b => b.enabled).length;
    const visibleInputs = dom.inputs.filter(i => i.visible).length;

    return (
        <div style={{
            display: 'flex',
            gap: '10px',
            padding: '8px',
            borderRadius: '8px',
            backgroundColor: step.is_error ? 'rgba(239,68,68,0.05)' : 'rgba(0,0,0,0.2)',
            border: `1px solid ${step.is_error ? 'rgba(239,68,68,0.3)' : 'rgba(255,255,255,0.06)'}`,
        }}>
            {/* Thumbnail screenshot — click để phóng to */}
            {step.screenshot_base64 ? (
                <img
                    src={step.screenshot_base64}
                    alt={step.step}
                    onClick={() => onClickScreenshot(step)}
                    title="Click để phóng to"
                    style={{
                        width: '120px', height: '75px',
                        borderRadius: '6px', objectFit: 'cover',
                        cursor: 'pointer', flexShrink: 0,
                        border: '1px solid rgba(255,255,255,0.1)',
                        backgroundColor: 'rgba(0,0,0,0.3)',
                    }}
                />
            ) : (
                <div style={{
                    width: '120px', height: '75px',
                    borderRadius: '6px', flexShrink: 0,
                    backgroundColor: 'rgba(0,0,0,0.2)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '1.25rem', color: '#475569',
                }}>
                    📷
                </div>
            )}

            {/* Info */}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' }}>
                {/* Label */}
                <div style={{ fontSize: '0.85rem', fontWeight: 500, color: step.is_error ? '#f87171' : '#e2e8f0' }}>
                    {getStepLabel(step.step)}
                </div>

                {/* Job + time */}
                <div style={{ fontSize: '0.7rem', color: '#64748b' }}>
                    {step.job_id && <span>[{step.job_id}] </span>}
                    {new Date(step.timestamp * 1000).toLocaleTimeString('vi-VN', {
                        hour: '2-digit', minute: '2-digit', second: '2-digit',
                    })}
                    {dom.url && <span style={{ marginLeft: '4px' }}>· {dom.url.slice(0, 50)}</span>}
                </div>

                {/* DOM badges */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {/* Buttons */}
                    {dom.buttons.length > 0 && (
                        <Badge color={enabledBtns > 0 ? 'green' : 'yellow'}>
                            🔘 {enabledBtns}/{dom.buttons.length} nút
                        </Badge>
                    )}
                    {/* Inputs */}
                    {dom.inputs.length > 0 && (
                        <Badge color={visibleInputs > 0 ? 'blue' : 'gray'}>
                            ✏️ {visibleInputs} input
                        </Badge>
                    )}
                    {/* File inputs */}
                    {dom.file_inputs.length > 0 && (
                        <Badge color="blue">📎 {dom.file_inputs.length} file input</Badge>
                    )}
                    {/* Ảnh lớn */}
                    <Badge color={dom.large_images > 0 ? 'green' : 'gray'}>
                        🖼️ {dom.large_images} ảnh
                    </Badge>
                    {/* Popup */}
                    {dom.popups.length > 0 && (
                        <Badge color="red">⚠️ {dom.popups.length} popup</Badge>
                    )}
                    {/* Spinner */}
                    {dom.has_spinner && (
                        <Badge color="yellow">⏳ generating</Badge>
                    )}
                </div>

                {/* Gemini response preview */}
                {dom.gemini_response_preview && (
                    <div style={{
                        fontSize: '0.7rem', color: '#a78bfa',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }} title={dom.gemini_response_preview}>
                        💬 {dom.gemini_response_preview.slice(0, 100)}...
                    </div>
                )}

                {/* Message tóm tắt */}
                {step.message && (
                    <div style={{
                        fontSize: '0.7rem', color: '#94a3b8',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }} title={step.message}>
                        {step.message}
                    </div>
                )}

                {/* Extra info (nếu có) */}
                {step.extra && Object.keys(step.extra).length > 0 && (
                    <div style={{ fontSize: '0.7rem', color: '#64748b' }}>
                        {JSON.stringify(step.extra).slice(0, 100)}
                    </div>
                )}
            </div>
        </div>
    );
};

// ─── Badge helper ──────────────────────────────────
const BADGE_COLORS: Record<string, { bg: string; color: string }> = {
    blue:   { bg: 'rgba(59,130,246,0.15)',  color: '#60a5fa' },
    green:  { bg: 'rgba(34,197,94,0.15)',   color: '#4ade80' },
    yellow: { bg: 'rgba(245,158,11,0.15)',  color: '#fbbf24' },
    red:    { bg: 'rgba(239,68,68,0.15)',   color: '#f87171' },
    gray:   { bg: 'rgba(148,163,184,0.15)', color: '#94a3b8' },
    purple: { bg: 'rgba(168,85,247,0.15)',  color: '#a78bfa' },
};

const Badge: React.FC<{ color: string; children: React.ReactNode }> = ({ color, children }) => {
    const c = BADGE_COLORS[color] || BADGE_COLORS.gray;
    return (
        <span style={{
            padding: '1px 6px', borderRadius: '4px',
            fontSize: '0.7rem', fontWeight: 500,
            backgroundColor: c.bg, color: c.color,
            whiteSpace: 'nowrap',
        }}>
            {children}
        </span>
    );
};

// ═══════════════════════════════════════════════════
// COMPONENT: BUG REPORT PANEL
// ═══════════════════════════════════════════════════
const BugReportPanel: React.FC<{ report: GeminiBugReport }> = ({ report }) => {
    const [expanded, setExpanded] = useState(false);

    if (report.total_errors === 0 && report.total_warnings === 0) return null;

    return (
        <div style={{
            borderRadius: '8px',
            border: `1px solid ${report.total_errors > 0 ? 'rgba(239,68,68,0.3)' : 'rgba(245,158,11,0.3)'}`,
            backgroundColor: report.total_errors > 0 ? 'rgba(239,68,68,0.06)' : 'rgba(245,158,11,0.06)',
            padding: '8px 10px',
        }}>
            {/* Header */}
            <div
                style={{ display: 'flex', justifyContent: 'space-between', cursor: 'pointer' }}
                onClick={() => setExpanded(e => !e)}
            >
                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#e2e8f0' }}>
                    🐛 Bug Report
                    {report.total_errors > 0 && (
                        <span style={{ color: '#ef4444', marginLeft: '6px' }}>
                            {report.total_errors} lỗi
                        </span>
                    )}
                    {report.total_warnings > 0 && (
                        <span style={{ color: '#f59e0b', marginLeft: '6px' }}>
                            {report.total_warnings} warnings
                        </span>
                    )}
                </span>
                <span style={{ fontSize: '0.8rem', color: '#64748b' }}>
                    {expanded ? '▲ Thu gọn' : '▼ Xem chi tiết'}
                </span>
            </div>

            {/* Detail */}
            {expanded && (
                <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {report.errors.map((e, idx) => (
                        <div key={idx} style={{
                            fontSize: '0.8rem', padding: '4px 8px', borderRadius: '4px',
                            backgroundColor: 'rgba(239,68,68,0.1)', color: '#f87171',
                        }}>
                            <strong>[{e.code}]</strong> {e.message}
                            {Object.keys(e.context || {}).length > 0 && (
                                <div style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: '2px' }}>
                                    {JSON.stringify(e.context).slice(0, 150)}
                                </div>
                            )}
                        </div>
                    ))}
                    {report.warnings.map((w, idx) => (
                        <div key={idx} style={{
                            fontSize: '0.8rem', padding: '4px 8px', borderRadius: '4px',
                            backgroundColor: 'rgba(245,158,11,0.1)', color: '#fbbf24',
                        }}>
                            <strong>[{w.code}]</strong> {w.message}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

// ═══════════════════════════════════════════════════
// COMPONENT CHÍNH: GEMINI DEBUG TIMELINE
// ═══════════════════════════════════════════════════
interface GeminiDebugTimelineProps {
    debugSteps: GeminiDebugStep[];
    bugReport?: GeminiBugReport | null;
    onClear?: () => void;
}

const GeminiDebugTimeline: React.FC<GeminiDebugTimelineProps> = ({
    debugSteps,
    bugReport,
    onClear,
}) => {
    const endRef = useRef<HTMLDivElement>(null);
    const [fullscreenStep, setFullscreenStep] = useState<GeminiDebugStep | null>(null);

    // Auto-scroll khi có step mới
    useEffect(() => {
        endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [debugSteps.length]);

    const errorCount = debugSteps.filter(s => s.is_error).length;

    return (
        <>
            {/* ─── Header ─── */}
            <div style={{
                display: 'flex', alignItems: 'center',
                justifyContent: 'space-between', marginBottom: '8px',
            }}>
                <span style={{ fontSize: '1.1rem', fontWeight: 600, color: '#e2e8f0' }}>
                    📸 Debug Timeline
                </span>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <span style={{
                        fontSize: '0.8rem', color: '#64748b',
                        padding: '2px 8px', borderRadius: '10px',
                        backgroundColor: 'rgba(255,255,255,0.06)',
                    }}>
                        {debugSteps.length} steps
                        {errorCount > 0 && (
                            <span style={{ color: '#ef4444', marginLeft: '4px' }}>
                                · {errorCount} errors
                            </span>
                        )}
                    </span>
                    {onClear && debugSteps.length > 0 && (
                        <button
                            onClick={onClear}
                            style={{
                                padding: '2px 8px', borderRadius: '6px', fontSize: '0.7rem',
                                backgroundColor: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                                color: '#64748b', cursor: 'pointer',
                            }}
                        >
                            🗑 Xoá
                        </button>
                    )}
                </div>
            </div>

            {/* ─── Bug Report ─── */}
            {bugReport && <BugReportPanel report={bugReport} />}

            {/* ─── Empty state ─── */}
            {debugSteps.length === 0 && (
                <div style={{
                    textAlign: 'center', padding: '20px',
                    color: '#475569', fontSize: '0.85rem',
                }}>
                    📸 Screenshots sẽ hiện ở đây khi Gemini Scan chạy
                </div>
            )}

            {/* ─── Timeline cards ─── */}
            <div style={{
                display: 'flex', flexDirection: 'column', gap: '6px',
                maxHeight: '400px', overflowY: 'auto',
            }}>
                {debugSteps.map((step, idx) => (
                    <StepCard
                        key={idx}
                        step={step}
                        onClickScreenshot={setFullscreenStep}
                    />
                ))}
                <div ref={endRef} />
            </div>

            {/* ─── Fullscreen overlay ─── */}
            {fullscreenStep && fullscreenStep.screenshot_base64 && (
                <div
                    onClick={() => setFullscreenStep(null)}
                    style={{
                        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                        backgroundColor: 'rgba(0,0,0,0.88)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        zIndex: 99999, cursor: 'pointer',
                    }}
                >
                    <img
                        src={fullscreenStep.screenshot_base64}
                        alt={fullscreenStep.step}
                        style={{
                            maxWidth: '95vw', maxHeight: '90vh',
                            borderRadius: '12px',
                            boxShadow: '0 0 40px rgba(0,0,0,0.5)',
                        }}
                    />
                    {/* Info overlay */}
                    <div style={{
                        position: 'absolute', bottom: '20px', left: '50%',
                        transform: 'translateX(-50%)',
                        backgroundColor: 'rgba(0,0,0,0.75)',
                        color: '#e2e8f0', padding: '8px 16px',
                        borderRadius: '8px', fontSize: '1.1rem',
                        textAlign: 'center', maxWidth: '600px',
                    }}>
                        <strong>{getStepLabel(fullscreenStep.step)}</strong>
                        {fullscreenStep.message && (
                            <><br /><span style={{ fontSize: '0.85rem', color: '#94a3b8' }}>{fullscreenStep.message}</span></>
                        )}
                        {fullscreenStep.dom_info.url && (
                            <><br /><small style={{ color: '#64748b' }}>{fullscreenStep.dom_info.url}</small></>
                        )}
                        <br /><small style={{ color: '#475569' }}>Click bất kỳ để đóng</small>
                    </div>
                </div>
            )}
        </>
    );
};

export default GeminiDebugTimeline;
