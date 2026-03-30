// GeminiScanStatusBadge.tsx
// Badge hiển thị trạng thái kết nối Gemini Server

import React from 'react';
import type { GeminiServerStatus } from '@/services/geminiScanService';

interface GeminiScanStatusBadgeProps {
    status: GeminiServerStatus;
}

// Mapping trạng thái → màu + text + dot color
const STATUS_CONFIG: Record<GeminiServerStatus, { label: string; color: string; dotColor: string; pulse: boolean }> = {
    disconnected: { label: 'Chưa kết nối', color: '#64748b', dotColor: '#64748b', pulse: false },
    connecting:   { label: 'Đang kết nối...', color: '#f59e0b', dotColor: '#f59e0b', pulse: true },
    waiting_login:{ label: 'Chờ đăng nhập', color: '#3b82f6', dotColor: '#3b82f6', pulse: true },
    ready:        { label: 'Sẵn sàng', color: '#22c55e', dotColor: '#22c55e', pulse: false },
    scanning:     { label: 'Đang scan...', color: '#a855f7', dotColor: '#a855f7', pulse: true },
    error:        { label: 'Lỗi', color: '#ef4444', dotColor: '#ef4444', pulse: false },
};

const GeminiScanStatusBadge: React.FC<GeminiScanStatusBadgeProps> = ({ status }) => {
    const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.disconnected;

    return (
        <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            padding: '2px 8px',
            borderRadius: '20px',
            fontSize: '11px',
            fontWeight: 500,
            backgroundColor: `${cfg.color}20`,
            border: `1px solid ${cfg.color}40`,
            color: cfg.color,
        }}>
            {/* Dot indicator */}
            <span style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                backgroundColor: cfg.dotColor,
                flexShrink: 0,
                // Pulse animation cho các trạng thái chờ
                animation: cfg.pulse ? 'gemini-pulse 1.5s ease-in-out infinite' : 'none',
            }} />
            {cfg.label}

            {/* CSS animation inline (không dùng Tailwind) */}
            <style>{`
                @keyframes gemini-pulse {
                    0%, 100% { opacity: 1; transform: scale(1); }
                    50% { opacity: 0.4; transform: scale(0.8); }
                }
            `}</style>
        </span>
    );
};

export default GeminiScanStatusBadge;
