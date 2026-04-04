// capcut-adapter.ts
// Adapter cho CapCut — nhận UniversalTimeline từ Core Pipeline
// và tạo CapCut Draft project JSON
//
// Chỉ làm 1 việc: CHUYỂN ĐỔI UniversalTimeline → CapCutDraftInput → gọi generateCapCutDraft()
// KHÔNG chứa logic AI, FFmpeg, hay xử lý dữ liệu nặng

import type { UniversalTimeline, OnStepUpdate, AutoMediaConfig } from '@/types/auto-media-types'
import type { CapCutDraftInput, CapCutClipInput, CapCutSubtitleInput } from '@/types/capcut-types'
import { generateCapCutDraft } from '@/services/capcut-draft-service'

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

        // ====== GỌI CAPCUT DRAFT SERVICE ======
        onStepUpdate('effects', 'running', '🎬 CapCut: đang tạo Draft project...')
        const result = await generateCapCutDraft(draftInput)

        onStepUpdate('effects', 'done', `✅ CapCut Draft: "${result.projectName}" → ${result.projectPath}`, undefined,
            `${summary}\nProject: ${result.projectName}\nPath: ${result.projectPath}`)

        console.log('[CapCut Adapter] ✅ Draft tạo xong:', result.projectName, result.projectPath)
        return result

    } catch (err) {
        console.error('[CapCut Adapter] ❌ Lỗi:', err)
        onStepUpdate('effects', 'error', 'CapCut Draft lỗi', String(err))
        return null
    }
}
