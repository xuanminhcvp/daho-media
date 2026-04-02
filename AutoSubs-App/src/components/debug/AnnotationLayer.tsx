/**
 * AnnotationLayer.tsx — AutoSubs-App
 * Lớp overlay trong suốt bắt click khi Annotation Mode bật.
 * - Khi active: hover element → viền vàng highlight
 * - Click bất kỳ đâu → popup nhỏ để gõ note
 * - Sau khi save → hiển thị pin 📌 tại vị trí đó
 * - Pin tồn tại qua reload (lưu localStorage)
 * - Click vào pin → xem note + nút xoá
 *
 * Toàn bộ style dùng inline để không phụ thuộc Tailwind/shadcn
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { bugReportService } from '@/services/bugReportService';
import type { Annotation } from '@/services/bugReportService';

interface AnnotationLayerProps {
  isActive:          boolean;        // bật/tắt annotation mode từ ngoài
  onToggle:          () => void;     // callback khi user bấm ESC để tắt
  onAnnotationSaved?: () => void;   // callback sau khi lưu ghi chú → tự tắt annotation mode
}

/** Lấy mô tả đọc được của element tại vị trí click */
function describeElementAt(x: number, y: number): string {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return 'unknown';
  const id   = el.id ? `#${el.id}` : '';
  const tag  = el.tagName.toLowerCase();
  const text = el.textContent?.slice(0, 50).trim() || '';
  const role = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
  return `${tag}${id}${role ? `[${role}]` : ''}${text ? ` "${text}"` : ''}`;
}

// ── Component Pin nhỏ hiển thị trên màn hình ──────────────────────────────────
function AnnotationPin({
  annotation,
  onRemove,
}: {
  annotation: Annotation;
  onRemove: (id: string) => void;
}) {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <div
      style={{
        position: 'fixed',
        left: annotation.x,
        top:  annotation.y,
        // zIndex phải CAO HƠN overlay (99995) để click được vào pin
        zIndex: 99996,
        transform: 'translate(-50%, -100%)',
        pointerEvents: 'auto',
      }}
      // stopPropagation để click vào pin không lan ra overlay
      onClick={e => e.stopPropagation()}
    >
      {/* Pin badge hình mũi tên */}
      <div
        onClick={() => setShowTooltip(v => !v)}
        title="Click để xem note"
        style={{
          width: 28,
          height: 28,
          borderRadius: '50% 50% 50% 0',
          transform: 'rotate(-45deg)',
          background: 'linear-gradient(135deg, #f59e0b, #d97706)',
          border: '2px solid #fff',
          boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'transform 0.15s ease',
        }}
      >
        <span style={{ transform: 'rotate(45deg)', fontSize: 13 }}>📌</span>
      </div>

      {/* Tooltip hiển thị nội dung note */}
      {showTooltip && (
        <div
          style={{
            position: 'absolute',
            bottom: 36,
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#1e293b',
            border: '1px solid rgba(245,158,11,0.5)',
            borderRadius: 8,
            padding: '10px 12px',
            minWidth: 200,
            maxWidth: 280,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            zIndex: 99991,
          }}
        >
          <div style={{ fontSize: 12, color: '#fde68a', marginBottom: 6, fontWeight: 600 }}>
            📌 Ghi chú
          </div>
          <div style={{ fontSize: 12, color: '#e2e8f0', lineHeight: 1.5, marginBottom: 8 }}>
            {annotation.note}
          </div>
          <div style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace', marginBottom: 8 }}>
            {annotation.elementDesc.slice(0, 60)}
          </div>
          {/* Nút xoá */}
          <button
            onClick={() => { onRemove(annotation.id); setShowTooltip(false); }}
            style={{
              background: 'rgba(239,68,68,0.15)',
              border: '1px solid rgba(239,68,68,0.4)',
              borderRadius: 4,
              color: '#fca5a5',
              fontSize: 11,
              padding: '3px 8px',
              cursor: 'pointer',
              width: '100%',
            }}
          >
            🗑 Xoá ghi chú này
          </button>
        </div>
      )}
    </div>
  );
}

// ── Popup nhập note sau khi click ─────────────────────────────────────────────
function NotePopup({
  x,
  y,
  elementDesc,
  onSave,
  onCancel,
}: {
  x: number;
  y: number;
  elementDesc: string;
  onSave: (note: string) => void;
  onCancel: () => void;
}) {
  const [text, setText]   = useState('');
  const inputRef          = useRef<HTMLTextAreaElement>(null);

  // Auto focus vào textarea khi popup mở
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (text.trim()) onSave(text.trim());
    }
    if (e.key === 'Escape') onCancel();
  };

  // Tính toán vị trí để popup không bị ra ngoài màn hình
  const popupX = Math.min(x, window.innerWidth  - 260);
  const popupY = Math.min(y, window.innerHeight - 200);

  return (
    <div
      style={{
        position: 'fixed',
        left: popupX + 12,
        top:  popupY + 12,
        zIndex: 99997,
        background: '#0f172a',
        border: '1.5px solid rgba(245,158,11,0.6)',
        borderRadius: 10,
        padding: 12,
        width: 248,
        boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
        pointerEvents: 'auto',
      }}
      // Không để click popup lan ra overlay
      onClick={e => e.stopPropagation()}
    >
      <div style={{ fontSize: 11, color: '#f59e0b', fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 5 }}>
        📌 Thêm ghi chú tại đây
      </div>
      {/* Mô tả element đang được ghi chú */}
      <div style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace', marginBottom: 8, wordBreak: 'break-word' }}>
        → {elementDesc.slice(0, 70)}
      </div>
      {/* Ô nhập text */}
      <textarea
        ref={inputRef}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Gõ ghi chú... (Enter để lưu, Shift+Enter xuống dòng)"
        rows={3}
        style={{
          width: '100%',
          background: 'rgba(30,41,59,0.8)',
          border: '1px solid rgba(99,102,241,0.4)',
          borderRadius: 6,
          color: '#e2e8f0',
          fontSize: 12,
          padding: '6px 8px',
          resize: 'vertical',
          fontFamily: 'system-ui, sans-serif',
          lineHeight: 1.5,
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />
      {/* Buttons Save / Huỷ */}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button
          onClick={() => { if (text.trim()) onSave(text.trim()); }}
          disabled={!text.trim()}
          style={{
            flex: 1,
            padding: '5px 0',
            background: text.trim() ? 'rgba(245,158,11,0.2)' : 'rgba(30,41,59,0.5)',
            border: `1px solid ${text.trim() ? 'rgba(245,158,11,0.5)' : 'rgba(51,65,85,0.5)'}`,
            borderRadius: 6,
            color: text.trim() ? '#fde68a' : '#475569',
            fontSize: 11,
            fontWeight: 600,
            cursor: text.trim() ? 'pointer' : 'default',
          }}
        >
          ✓ Lưu (Enter)
        </button>
        <button
          onClick={onCancel}
          style={{
            padding: '5px 10px',
            background: 'transparent',
            border: '1px solid rgba(51,65,85,0.5)',
            borderRadius: 6,
            color: '#64748b',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          Huỷ
        </button>
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────
export default function AnnotationLayer({ isActive, onToggle, onAnnotationSaved }: AnnotationLayerProps) {
  const [annotations,   setAnnotations]   = useState<Annotation[]>(() => bugReportService.getAnnotations());
  // Vị trí click đang chờ gõ note
  const [pendingClick,  setPendingClick]  = useState<{ x: number; y: number; elementDesc: string } | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Subscribe vào service để cập nhật pins khi có thay đổi
  useEffect(() => {
    const unsub = bugReportService.subscribe(() => {
      setAnnotations([...bugReportService.getAnnotations()]);
    });
    return unsub;
  }, []);

  // ESC để tắt annotation mode hoặc đóng popup
  useEffect(() => {
    if (!isActive && !pendingClick) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (pendingClick) {
          setPendingClick(null); // đóng popup trước
        } else {
          onToggle(); // tắt annotation mode
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onToggle, pendingClick, isActive]);

  // Hover highlight: thêm outline vàng vào element bên dưới khi di chuột
  useEffect(() => {
    if (!isActive) return;
    let lastEl: HTMLElement | null = null;

    const onMouseMove = (e: MouseEvent) => {
      const x = e.clientX;
      const y = e.clientY;

      // Tạm ẩn overlay để elementFromPoint trả về element thật bên dưới
      if (overlayRef.current) overlayRef.current.style.pointerEvents = 'none';
      const realEl = document.elementFromPoint(x, y) as HTMLElement | null;
      if (overlayRef.current) overlayRef.current.style.pointerEvents = 'auto';

      // Bỏ qua nếu là BugReporter panel hoặc annotation UI (để không self-highlight)
      if (
        realEl?.closest('#bug-reporter-panel') ||
        realEl?.closest('#bug-reporter-fab') ||
        realEl?.closest('#annotation-mode-btn')
      ) {
        if (lastEl) { lastEl.style.outline = ''; lastEl = null; }
        return;
      }

      // Xoá outline cũ nếu đổi element
      if (lastEl && lastEl !== realEl) lastEl.style.outline = '';

      // Thêm outline vàng
      lastEl = realEl;
      if (lastEl) lastEl.style.outline = '2px solid rgba(245,158,11,0.8)';
    };

    const onMouseLeave = () => {
      if (lastEl) { lastEl.style.outline = ''; lastEl = null; }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseleave', onMouseLeave);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseleave', onMouseLeave);
      // Cleanup: bỏ outline khi tắt annotation mode
      if (lastEl) { lastEl.style.outline = ''; lastEl = null; }
    };
  }, [isActive]);

  // Xử lý click trên overlay → mở popup gõ note
  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Nếu popup đang mở → click vào vùng ngoài popup = đóng popup
    if (pendingClick) {
      setPendingClick(null);
      return;
    }

    const x = e.clientX;
    const y = e.clientY;

    // Tìm element thật sự bên dưới tại vị trí click
    if (overlayRef.current) overlayRef.current.style.pointerEvents = 'none';
    const elementDesc = describeElementAt(x, y);
    if (overlayRef.current) overlayRef.current.style.pointerEvents = 'auto';

    setPendingClick({ x, y, elementDesc });
  }, [pendingClick]);

  const handleSave = useCallback((note: string) => {
    if (!pendingClick) return;
    bugReportService.addAnnotation({
      x:           pendingClick.x,
      y:           pendingClick.y,
      note,
      elementDesc: pendingClick.elementDesc,
      url:         window.location.href,
      activeTab:   bugReportService.activeTab,
    });
    setPendingClick(null);
    // Tự tắt annotation mode sau khi lưu
    onAnnotationSaved?.();
  }, [pendingClick, onAnnotationSaved]);

  const handleRemove = useCallback((id: string) => {
    bugReportService.removeAnnotation(id);
  }, []);

  return (
    <>
      {/* Overlay trong suốt bắt click — chỉ hiển thị khi annotation mode bật */}
      {isActive && (
        <div
          id="annotation-layer"
          ref={overlayRef}
          onClick={handleOverlayClick}
          style={{
            position: 'fixed',
            // Dùng riêng lẻ thay vì inset:0 để tương thích WebView Tauri
            top:    0,
            left:   0,
            right:  0,
            bottom: 0,
            zIndex: 99995,
            cursor: 'crosshair',
            background: 'rgba(245,158,11,0.04)', // trong suốt nhẹ
            outline: '2px solid rgba(245,158,11,0.3)', // viền vàng mỏng
            outlineOffset: -2,
            pointerEvents: 'auto',
          }}
        />
      )}

      {/* Popup nhập note */}
      {pendingClick && (
        <NotePopup
          x={pendingClick.x}
          y={pendingClick.y}
          elementDesc={pendingClick.elementDesc}
          onSave={handleSave}
          onCancel={() => setPendingClick(null)}
        />
      )}

      {/* Render tất cả pins — luôn hiển thị, không phụ thuộc isActive */}
      {annotations.map(a => (
        <AnnotationPin
          key={a.id}
          annotation={a}
          onRemove={handleRemove}
        />
      ))}
    </>
  );
}
