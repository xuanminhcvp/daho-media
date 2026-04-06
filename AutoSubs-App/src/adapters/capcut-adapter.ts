// capcut-adapter.ts
// Adapter cho CapCut — nhận UniversalTimeline từ Core Pipeline
// và tạo CapCut Draft project JSON
//
// Chỉ làm 1 việc: CHUYỂN ĐỔI UniversalTimeline → CapCutDraftInput → gọi generateCapCutDraft()
// KHÔNG chứa logic AI, FFmpeg, hay xử lý dữ liệu nặng

import type { UniversalTimeline, OnStepUpdate, AutoMediaConfig } from '@/types/auto-media-types'
import type { CapCutDraftInput, CapCutClipInput, CapCutSubtitleInput } from '@/types/capcut-types'
import { generateCapCutDraft } from '@/services/capcut-draft-service'
import { addDebugLog, generateLogId } from '@/services/debug-logger'

/**
 * Đổ toàn bộ UniversalTimeline vào CapCut Draft project
 * Chuyển đổi format rồi gọi capcut-draft-service.ts để tạo JSON
 */
export async function exportToCapCut(
    timeline: UniversalTimeline,
    onStepUpdate: OnStepUpdate,
    _config: AutoMediaConfig,
    /** Thông tin thêm cho CapCut (file VO, effects settings...) */
    options: {
        voFilePath?: string
        projectName?: string
        /** Nếu có, ghi đè trực tiếp vào draft này thay vì tạo draft mới */
        targetDraftPath?: string
        /** Effects settings từ CapCutEffectsSettingsPanel */
        effectsSettings?: any
        /** Branding theo kênh: logo + vị trí */
        channelBranding?: {
            channelId: string
            channelName: string
            logoPath: string
            position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
            x?: number
            y?: number
            scale?: number
        }
        width?: number
        height?: number
        fps?: number
    }
): Promise<{ projectName: string; projectPath: string } | null> {
    console.log('[CapCut Adapter] 🚀 Bắt đầu tạo CapCut Draft từ UniversalTimeline...')

    try {
        // Tính tổng thời lượng timeline từ dữ liệu pipeline.
        // Đây là mốc "an toàn" để service dùng khi không có VO file mới.
        const inferredTotalDurationSec = Math.max(
            0,
            ...timeline.imageClips.map(c => c.endTime),
            ...timeline.footageClips.map(c => c.endTime),
            ...timeline.subtitleLines.map(c => c.end),
            ...timeline.sfxClips.map(c => c.startTime + 3),
            ...timeline.matchedSentences.map((s: any) => Number(s?.end || 0)),
        )

        // ====== CHUYỂN ĐỔI: UniversalTimeline → CapCutDraftInput ======

        // 1. Image clips → CapCut video track V1
        const imageClips: CapCutClipInput[] = timeline.imageClips.map(clip => ({
            filePath: clip.filePath,
            startTime: clip.startTime,
            endTime: clip.endTime,
            type: 'image' as const,
        }))

        // 2. Footage clips → CapCut video track V2
        const footageClips: CapCutClipInput[] = timeline.footageClips.map(clip => ({
            filePath: clip.filePath,
            startTime: clip.startTime,
            endTime: clip.endTime,
            sourceStart: clip.trimStart || 0,
            type: 'video' as const,
        }))

        // 3. Voice Over → CapCut audio track A1
        // CapCut cần file VO gốc (không phải từ DaVinci export)
        const voiceoverClips: CapCutClipInput[] = []
        if (options.voFilePath) {
            // Tính duration từ timeline data — lấy max endTime
            const allEndTimes = [
                ...timeline.imageClips.map(c => c.endTime),
                ...timeline.subtitleLines.map(c => c.end),
                ...timeline.sfxClips.map(c => c.startTime + 5), // ước lượng SFX ~5s
            ]
            const maxEnd = allEndTimes.length > 0 ? Math.max(...allEndTimes) : 0
            voiceoverClips.push({
                filePath: options.voFilePath,
                startTime: 0,
                endTime: maxEnd > 0 ? maxEnd : 60, // fallback 60s
            })
        }

        // 4. BGM → CapCut audio track A2
        const bgmClips: CapCutClipInput[] = []
        if (timeline.bgm && timeline.bgm.mixedAudioPath) {
            // BGM đã mix → 1 file duy nhất, phủ toàn bộ timeline
            const maxEnd = Math.max(
                ...timeline.imageClips.map(c => c.endTime),
                ...voiceoverClips.map(c => c.endTime),
                0
            )
            bgmClips.push({
                filePath: timeline.bgm.mixedAudioPath,
                startTime: 0,
                endTime: maxEnd > 0 ? maxEnd : 60,
                type: 'audio',
            })
        }

        // 5. SFX → CapCut audio track A3
        const sfxClips: CapCutClipInput[] = timeline.sfxClips.map(clip => ({
            filePath: clip.filePath,
            startTime: clip.startTime,
            endTime: clip.startTime + 3, // SFX default ~3s (CapCut sẽ tự trim theo file thật)
            sourceStart: clip.trimStartSec || 0,
            type: 'audio' as const,
        }))

        // 6. Subtitles → CapCut text track T1
        const subtitles: CapCutSubtitleInput[] = timeline.subtitleLines.map(line => ({
            text: line.text,
            startTime: line.start,
            endTime: line.end,
        }))

        // ====== ĐÓNG GÓI CapCutDraftInput ======
        const draftInput: CapCutDraftInput = {
            config: {
                projectName: options.projectName || `AutoMedia_${new Date().toISOString().slice(0, 10)}`,
                targetDraftPath: options.targetDraftPath,
                width: options.width || 1920,
                height: options.height || 1080,
                fps: options.fps || 30,
                totalDurationSec: inferredTotalDurationSec,
            },
            imageClips,
            footageClips,
            voiceoverClips,
            bgmClips,
            sfxClips,
            subtitles,
            effectsSettings: options.effectsSettings || {},
            channelBranding: options.channelBranding,
        }

        // Log debug: tóm tắt input
        const summary = `Images: ${imageClips.length} | Footage: ${footageClips.length} | VO: ${voiceoverClips.length} | BGM: ${bgmClips.length} | SFX: ${sfxClips.length} | Subs: ${subtitles.length}`
        onStepUpdate('effects', 'running', `📦 CapCut: đóng gói dữ liệu... ${summary}`)
        console.log('[CapCut Adapter] 📦 Draft input:', summary)

        // Debug dễ đọc cho user:
        // - Timeline = clip nằm ở đâu trên timeline CapCut
        // - Source = clip lấy từ đoạn nào trong file footage gốc
        const formatTimeReadable = (secRaw: number): string => {
            const sec = Math.max(0, Number(secRaw) || 0)
            const hh = Math.floor(sec / 3600)
            const mm = Math.floor((sec % 3600) / 60)
            const ss = Math.floor(sec % 60)
            const ms = Math.floor((sec - Math.floor(sec)) * 1000)
            const hhStr = String(hh).padStart(2, '0')
            const mmStr = String(mm).padStart(2, '0')
            const ssStr = String(ss).padStart(2, '0')
            const msStr = String(ms).padStart(3, '0')
            return `${hhStr}:${mmStr}:${ssStr}.${msStr}`
        }

        const footageTimingDebug = footageClips.length > 0
            ? footageClips
                .slice(0, 12)
                .map((c, idx) => {
                    const tlStartSec = Number(c.startTime || 0)
                    const tlEndSec = Number(c.endTime || 0)
                    const srcStartSec = Number(c.sourceStart || 0)
                    const srcEndSec = Number((Number(c.sourceStart || 0) + (Number(c.endTime || 0) - Number(c.startTime || 0))).toFixed(6))
                    const tlStart = tlStartSec.toFixed(2)
                    const tlEnd = tlEndSec.toFixed(2)
                    const srcStart = srcStartSec.toFixed(2)
                    const srcEnd = srcEndSec.toFixed(2)
                    const fileName = c.filePath.split('/').pop() || 'unknown'
                    return `${idx + 1}. ${fileName}\n   Timeline: ${tlStart}s → ${tlEnd}s (${formatTimeReadable(tlStartSec)} → ${formatTimeReadable(tlEndSec)})\n   Source:   ${srcStart}s → ${srcEnd}s (${formatTimeReadable(srcStartSec)} → ${formatTimeReadable(srcEndSec)})`
                })
                .join('\n')
            : 'Không có footage clip.'

        // ====== GỌI CAPCUT DRAFT SERVICE ======
        onStepUpdate('effects', 'running', '🎬 CapCut: đang tạo Draft project...')
        const result = await generateCapCutDraft(draftInput)

        // Ghi riêng 1 API log để user nhìn ngay trong tab API của Debug Panel.
        // Mục tiêu:
        // - Không cần mở step details vẫn thấy timing cuối cùng của footage.
        // - Dùng đúng "thời gian cuối" app đã gửi sang capcut-draft-service.
        // - Hiển thị cả giây thập phân + định dạng hh:mm:ss.mmm để đối chiếu với ruler của CapCut.
        const footageTimingResponse = {
            source: 'capcut-adapter/final-footage-timing',
            generatedAt: new Date().toISOString(),
            clipsCount: footageClips.length,
            clips: footageClips.slice(0, 30).map((clip, idx) => {
                const timelineStartSec = Number(clip.startTime || 0)
                const timelineEndSec = Number(clip.endTime || 0)
                const sourceStartSec = Number(clip.sourceStart || 0)
                const sourceEndSec = Number((sourceStartSec + (timelineEndSec - timelineStartSec)).toFixed(6))
                return {
                    index: idx + 1,
                    fileName: clip.filePath.split('/').pop() || 'unknown',
                    timelineStartSec: Number(timelineStartSec.toFixed(6)),
                    timelineEndSec: Number(timelineEndSec.toFixed(6)),
                    timelineStartHms: formatTimeReadable(timelineStartSec),
                    timelineEndHms: formatTimeReadable(timelineEndSec),
                    sourceStartSec: Number(sourceStartSec.toFixed(6)),
                    sourceEndSec: Number(sourceEndSec.toFixed(6)),
                    sourceStartHms: formatTimeReadable(sourceStartSec),
                    sourceEndHms: formatTimeReadable(sourceEndSec),
                }
            }),
            truncated: footageClips.length > 30 ? `+${footageClips.length - 30} clips` : null,
        }

        addDebugLog({
            id: generateLogId(),
            timestamp: new Date(),
            method: 'LOCAL_WRITE',
            url: 'local://capcut/final-footage-timing',
            requestHeaders: { 'Content-Type': 'application/json' },
            requestBody: JSON.stringify({
                projectName: options.projectName || `AutoMedia_${new Date().toISOString().slice(0, 10)}`,
                targetDraftPath: options.targetDraftPath || '(new draft)',
                footageClipsCount: footageClips.length,
            }, null, 2),
            status: 200,
            responseHeaders: {},
            responseBody: JSON.stringify(footageTimingResponse, null, 2),
            duration: 0,
            error: null,
            label: 'CapCut Final Footage Timing',
        })

        onStepUpdate('effects', 'done', `✅ CapCut Draft: "${result.projectName}" → ${result.projectPath}`, undefined,
            `${summary}\nProject: ${result.projectName}\nPath: ${result.projectPath}\n\n[FOOTAGE TIMING MAP]\n${footageTimingDebug}${footageClips.length > 12 ? `\n... +${footageClips.length - 12} clips` : ''}`)

        console.log('[CapCut Adapter] ✅ Draft tạo xong:', result.projectName, result.projectPath)
        return result

    } catch (err) {
        console.error('[CapCut Adapter] ❌ Lỗi:', err)
        onStepUpdate('effects', 'error', 'CapCut Draft lỗi', String(err))
        return null
    }
}
