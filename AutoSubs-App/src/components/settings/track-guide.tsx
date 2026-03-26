// track-guide.tsx
// Component infographic hiển thị bố cục Track Layout chuẩn 7V + 5A
// Dùng ở: Settings Dialog, Auto Media Panel
// Lấy data từ TRACK_LABELS trong auto-media-types.ts

import { useState } from 'react'
import { TRACK_LABELS, TRACK_LAYOUT } from '@/types/auto-media-types'
import { setupTimelineTracks } from '@/api/resolve-api'
import { Button } from '@/components/ui/button'

/** Props cho TrackGuide */
interface TrackGuideProps {
    /** Chế độ gọn — ẩn mô tả chi tiết, chỉ hiện icon + tên */
    compact?: boolean
}

/**
 * TrackGuide — Bảng infographic hiển thị bố cục track chuẩn
 * 
 * Layout: 2 cột (Video Tracks | Audio Tracks)
 * Mỗi track = 1 hàng: icon + số track + tên + màu riêng
 * Nút Setup Track + Ghi chú cuối: hướng dẫn setup DaVinci
 */
export function TrackGuide({ compact = false }: TrackGuideProps) {
    // State cho nút Setup Track
    const [setupLoading, setSetupLoading] = useState(false)
    const [setupResult, setSetupResult] = useState<string | null>(null)

    // Gọi API tạo 7V+5A tracks
    const handleSetupTracks = async () => {
        if (setupLoading) return
        setSetupLoading(true)
        setSetupResult(null)
        try {
            const result = await setupTimelineTracks()
            if (result?.success) {
                setSetupResult(`✅ ${result.message}`)
            } else {
                setSetupResult(`❌ ${result?.message || 'Lỗi không xác định'}`)
            }
        } catch (err: any) {
            setSetupResult(`❌ ${err?.message || 'Không kết nối được DaVinci'}`)
        } finally {
            setSetupLoading(false)
            setTimeout(() => setSetupResult(null), 4000)
        }
    }

    return (
        <div className="space-y-3">
            {/* Tiêu đề */}
            <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">🎛️ Track Layout Chuẩn</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400 font-medium">
                    {TRACK_LAYOUT.TOTAL_VIDEO_TRACKS}V + {TRACK_LAYOUT.TOTAL_AUDIO_TRACKS}A
                </span>
            </div>

            {/* 2 cột: Video | Audio */}
            <div className="grid grid-cols-2 gap-3">
                {/* Video Tracks */}
                <div className="space-y-1">
                    <div className="text-[10px] font-semibold text-blue-400 uppercase tracking-wider mb-1.5">
                        📹 Video Tracks
                    </div>
                    {TRACK_LABELS.video.map((t) => (
                        <div
                            key={t.track}
                            className="flex items-center gap-1.5 px-2 py-1 rounded-md border transition-colors hover:bg-muted/30"
                            style={{ borderColor: t.color + '30' }}
                        >
                            {/* Số track — badge tròn nhỏ */}
                            <span
                                className="shrink-0 w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center"
                                style={{ backgroundColor: t.color + '20', color: t.color }}
                            >
                                {t.track}
                            </span>
                            {/* Icon + Tên */}
                            <span className="text-[11px] font-medium truncate flex-1">
                                {t.icon} {t.name}
                            </span>
                            {/* Mô tả (ẩn trong compact mode) */}
                            {!compact && (
                                <span className="text-[9px] text-muted-foreground shrink-0 hidden sm:inline">
                                    {t.desc}
                                </span>
                            )}
                        </div>
                    ))}
                </div>

                {/* Audio Tracks */}
                <div className="space-y-1">
                    <div className="text-[10px] font-semibold text-green-400 uppercase tracking-wider mb-1.5">
                        🎧 Audio Tracks
                    </div>
                    {TRACK_LABELS.audio.map((t) => (
                        <div
                            key={t.track}
                            className="flex items-center gap-1.5 px-2 py-1 rounded-md border transition-colors hover:bg-muted/30"
                            style={{ borderColor: t.color + '30' }}
                        >
                            {/* Số track — badge tròn nhỏ */}
                            <span
                                className="shrink-0 w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center"
                                style={{ backgroundColor: t.color + '20', color: t.color }}
                            >
                                {t.track}
                            </span>
                            {/* Icon + Tên */}
                            <span className="text-[11px] font-medium truncate flex-1">
                                {t.icon} {t.name}
                            </span>
                            {/* Mô tả (ẩn trong compact mode) */}
                            {!compact && (
                                <span className="text-[9px] text-muted-foreground shrink-0 hidden sm:inline">
                                    {t.desc}
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            {/* Nút Setup Track Tự Động */}
            <div className="flex flex-col gap-2">
                <Button
                    variant="outline"
                    size="sm"
                    className={`w-full h-8 text-xs transition-all duration-200 ${
                        setupResult?.startsWith('✅')
                            ? 'border-green-500 text-green-400 bg-green-500/10'
                            : setupResult?.startsWith('❌')
                            ? 'border-red-500 text-red-400 bg-red-500/10'
                            : 'border-violet-500/50 text-violet-400 hover:bg-violet-500/10'
                    }`}
                    onClick={handleSetupTracks}
                    disabled={setupLoading}
                >
                    {setupLoading ? (
                        'Đang tạo track...'
                    ) : setupResult ? (
                        setupResult
                    ) : (
                        'Setup Track Tự Động (7V + 5A)'
                    )}
                </Button>
                <p className="text-[9px] text-muted-foreground text-center">
                    Tạo đủ tracks + đặt tên chuẩn trong DaVinci. An toàn, không xoá clip.
                </p>
            </div>

            {/* Ghi chú hướng dẫn */}
            <div className="rounded-md bg-yellow-500/10 border border-yellow-500/20 px-3 py-2 space-y-1">
                <p className="text-[10px] text-yellow-500 font-medium">
                    ⚠️ Hướng dẫn setup DaVinci Resolve:
                </p>
                <ul className="text-[10px] text-yellow-500/80 space-y-0.5 pl-3 list-disc">
                    <li>Bấm <strong>Setup Track Tự Động</strong> hoặc tạo thủ công <strong>{TRACK_LAYOUT.TOTAL_VIDEO_TRACKS} Video</strong> + <strong>{TRACK_LAYOUT.TOTAL_AUDIO_TRACKS} Audio</strong> tracks</li>
                    <li>Voice/VO đặt ở <strong>A2</strong> — app sẽ lấy audio từ track này</li>
                    <li>Timeline FPS: <strong>{TRACK_LAYOUT.DEFAULT_FPS}fps</strong></li>
                </ul>
            </div>
        </div>
    )
}

