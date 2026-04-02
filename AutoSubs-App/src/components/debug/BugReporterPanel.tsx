/**
 * BugReporterPanel.tsx — AutoSubs-App v2
 * Floating panel hiển thị bugs + UX insights + API logs.
 * - Nút nổi góc dưới-phải với badge số lỗi
 * - Panel mở ra có 5 tabs: Bugs | API | Notes | Insights | Timeline
 * - Copy for AI — paste trực tiếp vào chat để báo lỗi
 * - Annotation Mode button 📌 để ghi chú trực tiếp lên UI
 *
 * Dùng inline styles để không phụ thuộc Tailwind/shadcn.
 * Hoạt động ở mọi nơi trong app vì mounted tại App level.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useBugReporter } from '@/hooks/useBugReporter';
import type { BugEntry, UXInsight, BehaviorEvent } from '@/services/bugReportService';
import AnnotationLayer from './AnnotationLayer';
// Import debug-logger để lấy request/response logs từ API
import {
  getDebugLogs,
  clearDebugLogs,
  subscribeDebugLogs,
  type DebugLogEntry,
} from '@/services/debug-logger';

// ── Icons nhỏ gọn (SVG inline) ────────────────────────────────────────────────
const IconBug      = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} width={16} height={16}><path d="M9 9c0-1.657 1.343-3 3-3s3 1.343 3 3v8c0 1.657-1.343 3-3 3s-3-1.343-3-3V9z"/><path d="M6 12H4M20 12h-2M6.343 6.343l-1.414-1.414M19.07 4.93l-1.413 1.413M6.343 17.657l-1.414 1.414M19.07 19.07l-1.413-1.413"/></svg>;
const IconClose    = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} width={14} height={14}><path d="M18 6 6 18M6 6l12 12"/></svg>;
const IconCopy     = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} width={14} height={14}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>;
const IconDownload = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} width={14} height={14}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>;
const IconTrash    = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} width={14} height={14}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>;

// ── CSS-in-JS Styles ───────────────────────────────────────────────────────────
const STYLES = {
  // Nút nổi góc dưới phải
  fab: {
    position:   'fixed' as const,
    bottom:     24,
    right:      24,
    zIndex:     99999,
    display:    'flex',
    alignItems: 'center',
    gap:        8,
    padding:    '8px 14px',
    background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
    color:      '#f1f5f9',
    borderRadius: 50,
    border:     '1px solid rgba(99,102,241,0.5)',
    boxShadow:  '0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(99,102,241,0.2)',
    cursor:     'pointer',
    fontSize:   12,
    fontFamily: 'monospace',
    fontWeight: 600,
    transition: 'all 0.2s ease',
    userSelect: 'none' as const,
  },

  // Badge số lỗi — xanh nếu 0 lỗi, đỏ nếu có lỗi
  badge: (count: number) => ({
    display:        'inline-flex',
    alignItems:     'center',
    justifyContent: 'center',
    minWidth:       18,
    height:         18,
    borderRadius:   9,
    background:     count > 0 ? '#ef4444' : '#22c55e',
    color:          '#fff',
    fontSize:       10,
    fontWeight:     700,
    padding:        '0 4px',
  }),

  // Panel chính floating
  panel: {
    position:    'fixed' as const,
    bottom:      80,
    right:       24,
    zIndex:      99998,
    width:       560,
    maxWidth:    'calc(100vw - 48px)',
    maxHeight:   '78vh',
    background:  '#0f172a',
    border:      '1px solid rgba(99,102,241,0.4)',
    borderRadius: 16,
    boxShadow:   '0 24px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(99,102,241,0.15)',
    display:     'flex',
    flexDirection: 'column' as const,
    overflow:    'hidden',
    fontFamily:  'system-ui, -apple-system, sans-serif',
    fontSize:    13,
    color:       '#e2e8f0',
  },

  panelHeader: {
    padding:         '12px 16px',
    background:      'rgba(30,41,59,0.95)',
    borderBottom:    '1px solid rgba(51,65,85,0.8)',
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'space-between',
    gap:             8,
    flexShrink:      0,
  },

  tabs: {
    display:         'flex',
    gap:             4,
    padding:         '0 16px',
    borderBottom:    '1px solid rgba(51,65,85,0.8)',
    background:      'rgba(15,23,42,0.8)',
    flexShrink:      0,
  },

  tab: (active: boolean) => ({
    padding:          '8px 12px',
    fontSize:         12,
    fontWeight:       active ? 700 : 400,
    color:            active ? '#818cf8' : '#94a3b8',
    cursor:           'pointer',
    transition:       'all 0.15s ease',
    background:       'none',
    border:           'none',
    borderBottom:     active ? '2px solid #818cf8' : '2px solid transparent',
    marginBottom:     -1,
    userSelect:       'none' as const,
  }),

  scrollArea: {
    flex:             1,
    overflowY:        'auto' as const,
    padding:          16,
    display:          'flex',
    flexDirection:    'column' as const,
    gap:              10,
  },

  // Card màu theo level: error=đỏ, warn=vàng, info=tím
  bugCard: (level: string) => ({
    background: level === 'error'
      ? 'rgba(239,68,68,0.08)'
      : level === 'warn'
      ? 'rgba(251,191,36,0.08)'
      : 'rgba(99,102,241,0.08)',
    border: `1px solid ${level === 'error' ? 'rgba(239,68,68,0.3)' : level === 'warn' ? 'rgba(251,191,36,0.3)' : 'rgba(99,102,241,0.3)'}`,
    borderRadius: 8,
    padding:      '10px 12px',
    display:      'flex',
    flexDirection: 'column' as const,
    gap:          5,
  }),

  levelBadge: (level: string) => ({
    display:       'inline-block',
    padding:       '1px 6px',
    borderRadius:  4,
    fontSize:      10,
    fontWeight:    700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    background:    level === 'error' ? 'rgba(239,68,68,0.2)' : level === 'warn' ? 'rgba(251,191,36,0.2)' : 'rgba(99,102,241,0.2)',
    color:         level === 'error' ? '#fca5a5' : level === 'warn' ? '#fde68a' : '#a5b4fc',
  }),

  insightCard: (severity: string) => ({
    background: severity === 'high'
      ? 'rgba(239,68,68,0.07)'
      : severity === 'medium'
      ? 'rgba(251,191,36,0.07)'
      : 'rgba(34,197,94,0.07)',
    border: `1px solid ${severity === 'high' ? 'rgba(239,68,68,0.25)' : severity === 'medium' ? 'rgba(251,191,36,0.25)' : 'rgba(34,197,94,0.25)'}`,
    borderRadius: 8,
    padding:      '10px 12px',
    display:      'flex',
    flexDirection: 'column' as const,
    gap:          4,
  }),

  actionBar: {
    padding:    '10px 16px',
    display:    'flex',
    gap:        6,
    borderTop:  '1px solid rgba(51,65,85,0.8)',
    background: 'rgba(15,23,42,0.95)',
    flexShrink: 0,
    flexWrap:   'wrap' as const,
  },

  btn: (variant: 'primary' | 'secondary' | 'danger') => ({
    display:    'flex',
    alignItems: 'center',
    gap:        5,
    padding:    '5px 10px',
    borderRadius: 6,
    fontSize:   11,
    fontWeight: 600,
    cursor:     'pointer',
    border:     '1px solid',
    transition: 'all 0.15s',
    ...(variant === 'primary' ? {
      background:   'rgba(99,102,241,0.2)',
      borderColor:  'rgba(99,102,241,0.5)',
      color:        '#a5b4fc',
    } : variant === 'danger' ? {
      background:   'rgba(239,68,68,0.15)',
      borderColor:  'rgba(239,68,68,0.4)',
      color:        '#fca5a5',
    } : {
      background:   'rgba(30,41,59,0.8)',
      borderColor:  'rgba(71,85,105,0.6)',
      color:        '#94a3b8',
    }),
  }),

  monoSmall: {
    fontFamily: 'monospace',
    fontSize:   11,
    color:      '#94a3b8',
    lineHeight: 1.5,
  },

  timeLabel: {
    fontSize:   10,
    color:      '#64748b',
    fontFamily: 'monospace',
  },

  emptyState: {
    textAlign:      'center' as const,
    color:          '#475569',
    padding:        '32px 0',
    fontSize:       13,
    display:        'flex',
    flexDirection:  'column' as const,
    alignItems:     'center',
    gap:            8,
  },
};

// ── BugCard: hiển thị 1 lỗi ───────────────────────────────────────────────────
function BugCard({ bug }: { bug: BugEntry }) {
  const [expanded, setExpanded] = useState(false);
  const time = new Date(bug.ts).toLocaleTimeString('vi-VN');

  return (
    <div style={STYLES.bugCard(bug.level)}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={STYLES.levelBadge(bug.level)}>{bug.level}</span>
          <span style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'monospace' }}>{bug.source}</span>
        </div>
        <span style={STYLES.timeLabel}>{time}</span>
      </div>

      {/* Message */}
      <div style={{ fontSize: 12, color: '#e2e8f0', lineHeight: 1.5, wordBreak: 'break-word' }}>
        {bug.message.slice(0, expanded ? 5000 : 200)}
        {bug.message.length > 200 && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            style={{ background: 'none', border: 'none', color: '#818cf8', cursor: 'pointer', fontSize: 11, padding: '0 4px' }}
          >
            ...xem thêm
          </button>
        )}
      </div>

      {/* Stack trace (nếu có và expanded) */}
      {expanded && bug.stack && (
        <pre style={{ ...STYLES.monoSmall, background: 'rgba(0,0,0,0.3)', padding: 8, borderRadius: 6, overflow: 'auto', maxHeight: 200, whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: 4 }}>
          {bug.stack.split('\n').slice(0, 10).join('\n')}
        </pre>
      )}

      {/* Context: active tab + last actions */}
      {expanded && bug.context && (
        <div style={{ ...STYLES.monoSmall, borderTop: '1px solid rgba(51,65,85,0.5)', paddingTop: 6, marginTop: 4 }}>
          <span style={{ color: '#64748b' }}>Tab: </span>{bug.context.activeTab || '–'}&nbsp;&nbsp;
          <span style={{ color: '#64748b' }}>Trước đó: </span>{bug.context.lastActions?.slice(-3).join(' → ') || '–'}
        </div>
      )}

      {/* Toggle expand/collapse */}
      <button
        onClick={() => setExpanded(!expanded)}
        style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 11, textAlign: 'left', padding: 0, marginTop: 2 }}
      >
        {expanded ? '▲ Thu gọn' : '▼ Xem chi tiết + context'}
      </button>
    </div>
  );
}

// ── InsightCard: hiển thị 1 UX insight ────────────────────────────────────────
function InsightCard({ insight }: { insight: UXInsight }) {
  const time = new Date(insight.ts).toLocaleTimeString('vi-VN');
  const emoji = insight.type === 'rage_click' ? '👆'
    : insight.type === 'missing_copy' ? '📋'
    : insight.type === 'confusion'    ? '🤔'
    : insight.type === 'dead_tab'     ? '💤'
    : '🔁';

  return (
    <div style={STYLES.insightCard(insight.severity)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>{emoji}</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0' }}>{insight.title}</span>
        </div>
        <span style={STYLES.timeLabel}>{time}</span>
      </div>
      <div style={{ fontSize: 11.5, color: '#94a3b8', lineHeight: 1.6 }}>{insight.detail}</div>
    </div>
  );
}

// ── TimelineRow: 1 hành động trong timeline ────────────────────────────────────
function TimelineRow({ event }: { event: BehaviorEvent }) {
  const time  = new Date(event.ts).toLocaleTimeString('vi-VN');
  const color = event.type === 'rage_click'  ? '#fca5a5'
    : event.type === 'page_error' ? '#fca5a5'
    : event.type === 'tab_switch' ? '#93c5fd'
    : '#94a3b8';

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '3px 0', borderBottom: '1px solid rgba(30,41,59,0.6)' }}>
      <span style={{ ...STYLES.timeLabel, flexShrink: 0, minWidth: 60 }}>{time}</span>
      <span style={{ fontSize: 11, color, fontFamily: 'monospace', flexShrink: 0, minWidth: 110, textTransform: 'uppercase' }}>{event.type}</span>
      <span style={{ fontSize: 11, color: '#64748b', wordBreak: 'break-word', flex: 1 }}>{event.target.slice(0, 80)}</span>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────
export default function BugReporterPanel() {
  const {
    bugs, insights, behaviors, annotations,
    errorCount, warnCount, insightCount,
    clearAll, generateReport, exportJSON, removeAnnotation,
  } = useBugReporter();

  const [isOpen,          setIsOpen]          = useState(false);
  // Tab mặc định là 'api' — xem request/response là việc đầu tiên khi debug
  const [activeTab,       setTab]             = useState<'bugs' | 'api' | 'insights' | 'timeline' | 'notes'>('api');
  const [copied,          setCopied]          = useState(false);
  const [annotationMode,  setAnnotationMode]  = useState(false); // toggle chế độ ghi chú 📌
  const panelRef         = useRef<HTMLDivElement>(null);
  const fabRef           = useRef<HTMLButtonElement>(null); // ref FAB để exclude khỏi outside-click
  const annotationBtnRef = useRef<HTMLButtonElement>(null); // ref nút 📌

  // ── API logs (request/response debug) ──────────────────────────────
  const [apiLogs,     setApiLogs]     = useState<DebugLogEntry[]>(() => getDebugLogs());
  const [selectedLog, setSelectedLog] = useState<DebugLogEntry | null>(null);
  const [modalTab,    setModalTab]    = useState<'request' | 'response'>('response');

  const totalCount = errorCount + warnCount;

  // Đóng panel khi click ra ngoài — NHƯNG không đóng khi click FAB hoặc nút 📌
  // (vì nếu click FAB thì event FAB sẽ toggle, không cần đóng ở đây)
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // Không đóng nếu click vào panel, FAB, hoặc nút annotation
      if (
        (panelRef.current         && panelRef.current.contains(target)) ||
        (fabRef.current           && fabRef.current.contains(target)) ||
        (annotationBtnRef.current && annotationBtnRef.current.contains(target))
      ) return;
      setIsOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  // Mỗi khi panel mở → reset về tab API (tab quan trọng nhất)
  useEffect(() => {
    if (isOpen) setTab('api');
  }, [isOpen]);

  // Subscribe API logs mới — cập nhật khi request xong
  useEffect(() => {
    setApiLogs(getDebugLogs());
    const unsub = subscribeDebugLogs(() => setApiLogs([...getDebugLogs()]));
    return unsub;
  }, []);

  // NOTE: Global listeners (click, mouseup, contextmenu) đã được chuyển sang main.tsx
  // để đảm bảo chỉ đăng ký 1 lần duy nhất — tránh duplicate do React StrictMode
  // mount/unmount/remount component trong dev mode.

  // Copy report → clipboard
  const handleCopyReport = useCallback(async () => {
    const report = generateReport();
    await navigator.clipboard.writeText(report);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [generateReport]);

  // Download JSON đầy đủ
  const handleDownloadJSON = useCallback(() => {
    const json = exportJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `autosubs-bug-report-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [exportJSON]);

  return (
    <>
      {/* ── Nút 📌 Annotation Mode — nằm ngay trên FAB ── */}
      <button
        ref={annotationBtnRef}
        id="annotation-mode-btn"
        onClick={() => setAnnotationMode(v => !v)}
        title={annotationMode ? 'Tắt chế độ ghi chú (ESC)' : 'Bật chế độ ghi chú trực tiếp lên UI'}
        style={{
          position:   'fixed' as const,
          bottom:     76,      // nằm trên FAB bugs
          right:      24,
          zIndex:     99999,
          width:      36,
          height:     36,
          borderRadius: '50%',
          background: annotationMode
            ? 'linear-gradient(135deg, #f59e0b, #d97706)'
            : 'rgba(30,41,59,0.9)',
          border: annotationMode
            ? '2px solid #fde68a'
            : '1px solid rgba(245,158,11,0.4)',
          boxShadow: annotationMode
            ? '0 0 16px rgba(245,158,11,0.5), 0 4px 12px rgba(0,0,0,0.4)'
            : '0 4px 12px rgba(0,0,0,0.3)',
          cursor:     'pointer',
          fontSize:   16,
          display:    'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'all 0.2s ease',
        }}
      >
        📌
      </button>

      {/* ── Floating Action Button (FAB) — hiển thị số lỗi ── */}
      <button
        ref={fabRef}
        id="bug-reporter-fab"
        onClick={() => setIsOpen(v => !v)}
        style={STYLES.fab}
        title="Mở Bug Reporter — xem toàn bộ lỗi và hành vi"
      >
        <IconBug />
        <span>Bugs</span>
        {/* Badge errors: đỏ nếu có lỗi, xanh nếu sạch */}
        <span style={STYLES.badge(errorCount)}>{errorCount > 99 ? '99+' : errorCount || '✓'}</span>
        {/* Badge warnings */}
        {warnCount > 0 && (
          <span style={{ ...STYLES.badge(warnCount), background: '#f59e0b' }}>{warnCount}W</span>
        )}
        {/* Badge insights */}
        {insightCount > 0 && (
          <span style={{ ...STYLES.badge(insightCount), background: '#8b5cf6' }}>{insightCount}I</span>
        )}
        {/* Badge annotations */}
        {annotations.length > 0 && (
          <span style={{ ...STYLES.badge(annotations.length), background: '#d97706' }}>{annotations.length}📌</span>
        )}
      </button>

      {/* ── Panel chính ── */}
      {isOpen && (
        <div ref={panelRef} style={STYLES.panel} id="bug-reporter-panel">

          {/* Header */}
          <div style={STYLES.panelHeader}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <IconBug />
              <span style={{ fontWeight: 700, color: '#e2e8f0' }}>Bug Reporter</span>
              <span style={{ fontSize: 11, color: '#64748b' }}>— AutoSubs Session Logger</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {/* Tổng: errors + warns */}
              <span style={{ fontSize: 11, color: errorCount > 0 ? '#fca5a5' : '#64748b', fontFamily: 'monospace' }}>
                {totalCount > 0 ? `${totalCount} vấn đề` : '✓ Sạch'}
              </span>
              <button
                onClick={() => setIsOpen(false)}
                style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', padding: 4, borderRadius: 4 }}
              >
                <IconClose />
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div style={STYLES.tabs}>
            <button style={STYLES.tab(activeTab === 'bugs')}     onClick={() => setTab('bugs')}>
              🐛 Bugs ({totalCount})
            </button>
            <button style={STYLES.tab(activeTab === 'api')}      onClick={() => setTab('api')}>
              🔌 API ({apiLogs.length})
            </button>
            <button style={STYLES.tab(activeTab === 'notes')}    onClick={() => setTab('notes')}>
              📌 Notes ({annotations.length})
            </button>
            <button style={STYLES.tab(activeTab === 'insights')} onClick={() => setTab('insights')}>
              🎯 Insights ({insightCount})
            </button>
            <button style={STYLES.tab(activeTab === 'timeline')} onClick={() => setTab('timeline')}>
              📋 Timeline ({Math.min(behaviors.length, 15)})
            </button>
          </div>

          {/* Scroll area — nội dung theo tab */}
          <div style={STYLES.scrollArea}>

            {/* ── Tab: API Request/Response logs  ── */}
            {activeTab === 'api' && (
              <>
                {apiLogs.length === 0 ? (
                  <div style={STYLES.emptyState}>
                    <span style={{ fontSize: 32 }}>🔌</span>
                    <span>Chưa có API request nào</span>
                    <span style={{ fontSize: 11, color: '#334155' }}>Thực hiện AI Match / Transcribe — request sẽ hiện tại đây</span>
                  </div>
                ) : (
                  <>
                    {/* Thanh tool — nút Clear API logs */}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
                      <button
                        style={{ ...STYLES.btn('danger'), fontSize: 10 }}
                        onClick={() => clearDebugLogs()}
                        title="Xóa toàn bộ API logs (không ảnh hưởng dữ liệu app)"
                      >
                        <IconTrash /> Clear API logs
                      </button>
                    </div>

                    {/* Danh sách requests */}
                    {apiLogs.map(log => (
                      <div
                        key={log.id}
                        onClick={() => { setSelectedLog(log); setModalTab('response'); }}
                        style={{
                          background: log.error
                            ? 'rgba(239,68,68,0.08)'
                            : log.status === null
                            ? 'rgba(59,130,246,0.08)'
                            : 'rgba(34,197,94,0.06)',
                          border: `1px solid ${
                            log.error ? 'rgba(239,68,68,0.3)'
                            : log.status === null ? 'rgba(59,130,246,0.3)'
                            : 'rgba(34,197,94,0.25)'
                          }`,
                          borderRadius: 8,
                          padding: '8px 12px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                        }}
                      >
                        {/* Thời gian */}
                        <span style={{ ...STYLES.timeLabel, flexShrink: 0, minWidth: 60 }}>
                          {new Date(log.timestamp).toLocaleTimeString('vi-VN')}
                        </span>

                        {/* Method badge */}
                        <span style={{
                          fontSize: 10, fontWeight: 700, fontFamily: 'monospace',
                          color: '#818cf8', flexShrink: 0, minWidth: 32,
                        }}>
                          {log.method}
                        </span>

                        {/* Label */}
                        <span style={{ flex: 1, fontSize: 12, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {log.label}
                        </span>

                        {/* Status */}
                        <span style={{
                          fontSize: 10, fontWeight: 700, flexShrink: 0,
                          color: log.error ? '#fca5a5' : log.status === null ? '#93c5fd' : '#86efac',
                        }}>
                          {log.error ? '❌ Lỗi' : log.status === null ? '⏳ Đang gửi...' : `✓ ${log.status}`}
                        </span>

                        {/* Duration */}
                        {log.duration > 0 && (
                          <span style={{ ...STYLES.timeLabel, flexShrink: 0 }}>
                            {log.duration < 1000 ? `${log.duration}ms` : `${(log.duration / 1000).toFixed(1)}s`}
                          </span>
                        )}

                        {/* Arrow */}
                        <span style={{ color: '#475569', flexShrink: 0 }}>›</span>
                      </div>
                    ))}
                  </>
                )}
              </>
            )}

            {/* ── Tab: Bugs ── */}
            {activeTab === 'bugs' && (
              <>
                {bugs.length === 0 ? (
                  <div style={STYLES.emptyState}>
                    <span style={{ fontSize: 32 }}>✅</span>
                    <span>Không có lỗi nào được ghi nhận</span>
                    <span style={{ fontSize: 11, color: '#334155' }}>Hãy thao tác trên app — lỗi sẽ tự xuất hiện ở đây</span>
                  </div>
                ) : (
                  // Hiển thị mới nhất trước
                  [...bugs].reverse().map(bug => <BugCard key={bug.id} bug={bug} />)
                )}
              </>
            )}

            {/* ── Tab: Notes (Annotations) ── */}
            {activeTab === 'notes' && (
              <>
                {/* Hướng dẫn nhanh */}
                <div style={{
                  background: 'rgba(245,158,11,0.08)',
                  border: '1px solid rgba(245,158,11,0.25)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  fontSize: 11.5,
                  color: '#fde68a',
                  lineHeight: 1.6,
                  marginBottom: 4,
                }}>
                  <strong>Cách dùng:</strong> Bấm nút <strong>📌</strong> góc dưới phải → click vào bất kỳ vùng nào trên app → gõ ghi chú → Enter. Pin sẽ hiện tại vị trí đó và tồn tại qua reload.
                </div>

                {annotations.length === 0 ? (
                  <div style={STYLES.emptyState}>
                    <span style={{ fontSize: 32 }}>📌</span>
                    <span>Chưa có ghi chú nào</span>
                    <span style={{ fontSize: 11, color: '#334155' }}>Bật chế độ 📌 rồi click lên bất kỳ vùng trên app</span>
                  </div>
                ) : (
                  [...annotations].reverse().map((a, idx) => (
                    <div key={a.id} style={{
                      background: 'rgba(245,158,11,0.07)',
                      border: '1px solid rgba(245,158,11,0.25)',
                      borderRadius: 8,
                      padding: '10px 12px',
                      display: 'flex',
                      flexDirection: 'column' as const,
                      gap: 4,
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 700 }}>
                          📌 #{annotations.length - idx}
                        </span>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <span style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace' }}>
                            {new Date(a.ts).toLocaleTimeString('vi-VN')}
                          </span>
                          <button
                            onClick={() => removeAnnotation(a.id)}
                            style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 12, padding: 0 }}
                            title="Xoá ghi chú này"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                      <div style={{ fontSize: 12.5, color: '#e2e8f0', fontWeight: 500 }}>{a.note}</div>
                      <div style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace' }}>
                        {a.elementDesc.slice(0, 80)} — x={a.x}, y={a.y}
                      </div>
                      {a.activeTab && (
                        <div style={{ fontSize: 10, color: '#475569' }}>Tab: {a.activeTab}</div>
                      )}
                    </div>
                  ))
                )}
              </>
            )}

            {/* ── Tab: Insights ── */}
            {activeTab === 'insights' && (
              <>
                {insights.length === 0 ? (
                  <div style={STYLES.emptyState}>
                    <span style={{ fontSize: 32 }}>🔍</span>
                    <span>Chưa phát hiện UX issue nào</span>
                    <span style={{ fontSize: 11, color: '#334155' }}>Thao tác bình thường — hệ thống sẽ tự phát hiện pattern bất thường</span>
                  </div>
                ) : (
                  [...insights].reverse().map(insight => <InsightCard key={insight.id} insight={insight} />)
                )}
              </>
            )}

            {/* ── Tab: Timeline ── */}
            {activeTab === 'timeline' && (
              <>
                {behaviors.length === 0 ? (
                  <div style={STYLES.emptyState}>
                    <span style={{ fontSize: 32 }}>⏱️</span>
                    <span>Chưa có hành động nào được ghi</span>
                  </div>
                ) : (
                  <div>
                    {/* Chỉ hiện 15 hành động gần nhất — đủ để debug, không spam */}
                    {[...behaviors].reverse().slice(0, 15).map(b => (
                      <TimelineRow key={b.id} event={b} />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Action bar */}
          <div style={STYLES.actionBar}>
            {/* Copy report dạng text → paste vào chat AI */}
            <button
              style={STYLES.btn('primary')}
              onClick={handleCopyReport}
              title="Copy toàn bộ report dạng text — paste vào chat AI để báo lỗi"
            >
              <IconCopy />
              {copied ? '✓ Đã copy!' : 'Copy cho AI'}
            </button>

            {/* Download JSON đầy đủ */}
            <button
              style={STYLES.btn('secondary')}
              onClick={handleDownloadJSON}
              title="Download JSON đầy đủ để phân tích offline"
            >
              <IconDownload />
              Export JSON
            </button>

            {/* Clear session — chỉ xoá log BugReporter, KHÔNG xoá cache/IndexedDB */}
            <button
              style={{ ...STYLES.btn('danger'), marginLeft: 'auto' }}
              onClick={() => clearAll()}
              title="Xoá toàn bộ log session hiện tại (không ảnh hưởng dữ liệu app)"
            >
              <IconTrash />
              Clear session
            </button>
          </div>
        </div>
      )}

      {/* ── Annotation Layer — overlay + pins ── */}
      <AnnotationLayer
        isActive={annotationMode}
        onToggle={() => setAnnotationMode(v => !v)}
        onAnnotationSaved={() => setAnnotationMode(false)}
      />

      {/* ── Modal chi tiết API Request / Response ── */}
      {selectedLog && (
        <div
          onClick={() => setSelectedLog(null)}
          style={{
            position: 'fixed',
            top: 0, left: 0, right: 0, bottom: 0,
            zIndex: 100000,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#0f172a',
              border: '1px solid rgba(99,102,241,0.4)',
              borderRadius: 14,
              width: '90vw',
              maxWidth: 880,
              maxHeight: '88vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 32px 100px rgba(0,0,0,0.8)',
              overflow: 'hidden',
            }}
          >
            {/* Modal header */}
            <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(51,65,85,0.8)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: selectedLog.error ? '#fca5a5' : selectedLog.status === null ? '#93c5fd' : '#86efac' }}>
                {selectedLog.error ? '❌ Lỗi' : selectedLog.status === null ? '⏳' : `✓ ${selectedLog.status}`}
              </span>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selectedLog.label}
              </span>
              <span style={{ ...STYLES.timeLabel }}>
                {new Date(selectedLog.timestamp).toLocaleTimeString('vi-VN')}
                {selectedLog.duration > 0 && ` · ${selectedLog.duration < 1000 ? selectedLog.duration + 'ms' : (selectedLog.duration / 1000).toFixed(1) + 's'}`}
              </span>
              <button
                onClick={() => setSelectedLog(null)}
                style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 4px' }}
              >
                ×
              </button>
            </div>

            {/* URL bar */}
            <div style={{ padding: '6px 16px', borderBottom: '1px solid rgba(51,65,85,0.5)', fontSize: 10, fontFamily: 'monospace', color: '#818cf8', background: 'rgba(30,41,59,0.4)', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedLog.url}
            </div>

            {/* Tabs request / response + Copy */}
            <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid rgba(51,65,85,0.8)', flexShrink: 0, padding: '0 4px' }}>
              <button style={{ ...STYLES.tab(modalTab === 'request'), padding: '8px 14px' }} onClick={() => setModalTab('request')}>
                📤 Request ({formatApiSize(selectedLog.requestBody)})
              </button>
              <button style={{ ...STYLES.tab(modalTab === 'response'), padding: '8px 14px' }} onClick={() => setModalTab('response')}>
                📥 Response ({formatApiSize(selectedLog.responseBody)})
              </button>
              {/* Nút Copy */}
              <button
                style={{ ...STYLES.btn('secondary'), fontSize: 10, marginLeft: 'auto', marginRight: 8 }}
                onClick={async () => {
                  const content = modalTab === 'request' ? selectedLog.requestBody : selectedLog.responseBody;
                  let formatted = content;
                  try { formatted = JSON.stringify(JSON.parse(content), null, 2); } catch { /* giữ nguyên */ }
                  await navigator.clipboard.writeText(formatted);
                }}
                title="Copy nội dung vào clipboard"
              >
                <IconCopy /> Copy {modalTab}
              </button>
            </div>

            {/* Nội dung request hoặc response */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
              {selectedLog.error && (
                <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 12, color: '#fca5a5' }}>
                  ❌ {selectedLog.error}
                </div>
              )}
              <pre style={{ ...STYLES.monoSmall, whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.6 }}>
                {formatApiContent(modalTab === 'request' ? selectedLog.requestBody : selectedLog.responseBody)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Helpers cho API tab ────────────────────────────────────────────────────────

/** Tính kích thước text dạng human-readable */
function formatApiSize(text: string): string {
  if (!text || text === '(đang chờ...)') return '-';
  const bytes = new Blob([text]).size;
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

/**
 * Format API content để dễ đọc:
 * - JSON hợp lệ → pretty-print 2 spaces
 * - Text thường → giữ nguyên
 */
function formatApiContent(text: string): string {
  if (!text || text === '(đang chờ...)') return '(trống)';
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text; // không phải JSON → raw
  }
}
