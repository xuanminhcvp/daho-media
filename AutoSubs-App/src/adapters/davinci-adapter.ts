// davinci-adapter.ts
// Adapter cho DaVinci Resolve — nhận UniversalTimeline từ Core Pipeline
// và đổ kết quả lên DaVinci timeline qua Lua server (http://127.0.0.1:56003)
//
// Chỉ làm 1 việc: NHẬN DỮ LIỆU → GỌI API DAVINCI
// KHÔNG chứa logic AI, FFmpeg, hay xử lý dữ liệu

import type { UniversalTimeline, OnStepUpdate, AutoMediaConfig } from '@/types/auto-media-types'
import { TRACK_LAYOUT } from '@/types/auto-media-types'

// Dùng window.fetch thay vì plugin-http (fix Tauri streamChannel bug)
const tauriFetch = window.fetch

/**
 * Đổ toàn bộ UniversalTimeline lên DaVinci Resolve timeline
 * Gọi lần lượt từng bước: setup tracks → image → subtitle → music → sfx → footage → effects
 */
export async function exportToDaVinci(
    timeline: UniversalTimeline,
    onStepUpdate: OnStepUpdate,
    config: AutoMediaConfig,
    deps: { subtitleTemplate: string; subtitleFontSize: number }
): Promise<void> {
    console.log('[DaVinci Adapter] 🚀 Bắt đầu export lên DaVinci Resolve...')

    // ====== SETUP TRACKS ======
    try {
        onStepUpdate('effects', 'running', '🛠️ Đang khởi tạo cấu trúc 7V + 5A tracks...')
        const { setupTimelineTracks } = await import('@/api/resolve-api')
        await setupTimelineTracks(TRACK_LAYOUT)
        console.log('[DaVinci Adapter] ✅ Setup tracks OK')
    } catch (err) {
        console.warn('[DaVinci Adapter] ⚠️ Lỗi setup tracks:', err)
    }

    // ====== IMAGE → Track V1 ======
    if (timeline.imageClips.length > 0) {
        try {
            onStepUpdate('effects', 'running', `📥 DaVinci: import ${timeline.imageClips.length} clips lên V${TRACK_LAYOUT.VIDEO_AI_TRACK}...`)
            const { addMediaToTimeline } = await import('@/api/resolve-api')
            await addMediaToTimeline(timeline.imageClips, TRACK_LAYOUT.VIDEO_AI_TRACK)
            console.log(`[DaVinci Adapter] ✅ Image: ${timeline.imageClips.length} clips → V${TRACK_LAYOUT.VIDEO_AI_TRACK}`)
        } catch (err) {
            console.error('[DaVinci Adapter] Image import lỗi:', err)
        }
    }

    // ====== SUBTITLE ======
    if (timeline.subtitleLines.length > 0) {
        try {
            if (config.subtitleMode === 'srt') {
                // --- Chế độ SRT Native (nhẹ) ---
                if (timeline.srtFilePath) {
                    onStepUpdate('effects', 'running', '📥 DaVinci: import SRT vào Media Pool...')
                    const response = await tauriFetch('http://127.0.0.1:56003/', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            func: 'ImportSrtToMediaPool',
                            filePath: timeline.srtFilePath,
                        }),
                    })
                    const result = await response.json() as any
                    if (result.error) {
                        throw new Error(result.message || 'Lỗi import SRT vào DaVinci')
                    }
                    console.log('[DaVinci Adapter] ✅ SRT imported → Media Pool')
                }
            } else {
                // --- Chế độ Fusion Text+ (nặng/đẹp) ---
                onStepUpdate('effects', 'running', `📥 DaVinci: import ${timeline.subtitleLines.length} phụ đề Fusion lên V${TRACK_LAYOUT.TEXT_ONSCREEN_TRACK}...`)
                const response = await tauriFetch('http://127.0.0.1:56003/', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        func: 'AddSimpleSubtitles',
                        clips: timeline.subtitleLines.map(line => ({
                            text: line.text,
                            start: line.start,
                            end: line.end,
                        })),
                        templateName: deps.subtitleTemplate || 'Subtitle Default',
                        trackIndex: TRACK_LAYOUT.TEXT_ONSCREEN_TRACK,
                        fontSize: deps.subtitleFontSize || 0.04,
                    }),
                })
                const result = await response.json() as any
                if (result.error) {
                    throw new Error(result.message || 'Lỗi import phụ đề Fusion vào DaVinci')
                }
                console.log(`[DaVinci Adapter] ✅ ${timeline.subtitleLines.length} phụ đề Fusion → V${TRACK_LAYOUT.TEXT_ONSCREEN_TRACK}`)
            }
        } catch (err) {
            console.error('[DaVinci Adapter] Subtitle import lỗi:', err)
        }
    }

    // ====== MUSIC (BGM) → Track A5 ======
    if (timeline.bgm && timeline.bgm.mixedAudioPath) {
        try {
            onStepUpdate('effects', 'running', '📥 DaVinci: import nhạc nền lên timeline...')
            const { addAudioToTimeline } = await import('@/api/resolve-api')
            const resolveResult = await addAudioToTimeline(
                timeline.bgm.mixedAudioPath,
                'BGM - AutoSubs'
            )
            if (resolveResult.error) {
                console.warn(`[DaVinci Adapter] BGM import lỗi: ${resolveResult.message}`)
            } else {
                console.log(`[DaVinci Adapter] ✅ BGM → Track A${resolveResult.audioTrack}`)
            }
        } catch (err) {
            console.warn('[DaVinci Adapter] BGM import không kết nối:', err)
        }
    }

    // ====== SFX → Track A1 ======
    if (timeline.sfxClips.length > 0) {
        try {
            onStepUpdate('effects', 'running', `📥 DaVinci: import ${timeline.sfxClips.length} SFX clips lên A${TRACK_LAYOUT.SFX_VIDEO_TRACK}...`)
            const { addSfxClipsToTimeline } = await import('@/api/resolve-api')
            const sfxResult = await addSfxClipsToTimeline(timeline.sfxClips, 'SFX - AutoSubs')
            if (sfxResult.error) {
                console.error('[DaVinci Adapter] SFX import lỗi:', sfxResult.message)
            } else {
                console.log(`[DaVinci Adapter] ✅ ${sfxResult.clipsAdded || timeline.sfxClips.length} SFX clips → A${TRACK_LAYOUT.SFX_VIDEO_TRACK}`)
            }
        } catch (err) {
            console.error('[DaVinci Adapter] SFX import lỗi:', err)
        }
    }

    // ====== FOOTAGE → Track V7 ======
    if (timeline.footageClips.length > 0) {
        try {
            onStepUpdate('effects', 'running', `📥 DaVinci: import ${timeline.footageClips.length} footage lên V${TRACK_LAYOUT.FOOTAGE_TRACK}...`)
            const { addMediaToTimeline } = await import('@/api/resolve-api')
            await addMediaToTimeline(
                timeline.footageClips,
                TRACK_LAYOUT.FOOTAGE_TRACK,
                true // videoOnly — chỉ lấy hình, bỏ audio
            )
            console.log(`[DaVinci Adapter] ✅ ${timeline.footageClips.length} footage → V${TRACK_LAYOUT.FOOTAGE_TRACK}`)
        } catch (err) {
            console.error('[DaVinci Adapter] Footage import lỗi:', err)
        }
    }

    // ====== EFFECTS (Ken Burns / Shake) ======
    if (config.enableEffects && timeline.imageClips.length > 0) {
        try {
            onStepUpdate('effects', 'running', '✨ DaVinci: áp hiệu ứng chuyển động...')
            const response = await tauriFetch('http://127.0.0.1:56003/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    func: 'ApplyMotionEffects',
                    trackIndex: TRACK_LAYOUT.VIDEO_AI_TRACK,
                    effectType: config.effectType,
                    intensity: config.effectIntensity,
                    fadeDuration: 0.3,
                }),
            })
            const data = await response.json() as any
            if (data.error) {
                onStepUpdate('effects', 'error', 'Hiệu ứng lỗi', data.message || 'Không rõ')
            } else {
                onStepUpdate('effects', 'done', `✅ DaVinci: effects ${data.applied || 0}/${data.total || 0} clips`)
            }
        } catch (err) {
            onStepUpdate('effects', 'error', 'DaVinci effects lỗi', String(err))
        }
    }

    // Đánh dấu export hoàn tất
    onStepUpdate('effects', 'done', '✅ DaVinci: export hoàn tất!')
    console.log('[DaVinci Adapter] ✅ Export hoàn tất!')
}
