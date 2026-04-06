// capcut-draft-service.ts
// Service tạo CapCut Draft project từ kết quả Auto Media pipeline
// 
// PHƯƠNG PHÁP: Clone-and-Override
// 1. Load material_templates.json (clone từ project CapCut thật — đủ 65/62/125 keys)
// 2. Deep clone template → override id/path/duration
// 3. Gọi Rust backend ghi file vào ~/Movies/CapCut/Drafts/
//
// Lưu ý: Thời gian CapCut tính bằng MICROSECOND (µs), 1 giây = 1,000,000 µs

import { invoke } from '@tauri-apps/api/core'
import type { CapCutDraftInput } from '@/types/capcut-types'

// ======================== CONSTANTS ========================

/** 1 giây = 1,000,000 microsecond */
const SEC_TO_US = 1_000_000

// ======================== HELPERS ========================

/** Tạo ID unique 32 ký tự hex (đủ cho CapCut, không cần crypto-secure) */
function generateId(): string {
    return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0
        const v = c === 'x' ? r : (r & 0x3) | 0x8
        return v.toString(16)
    })
}

/** Tạo UUID v4 dạng 8-4-4-4-12 */
function generateUuidV4(): string {
    const p1 = 'xxxxxxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16))
    const p2 = 'xxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16))
    const p3 = '4xxx'.replace(/[x]/g, () => ((Math.random() * 16) | 0).toString(16))
    const p4 = 'yxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0
        const v = c === 'x' ? r : (r & 0x3) | 0x8
        return v.toString(16)
    })
    const p5 = 'xxxxxxxxxxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16))
    return `${p1}-${p2}-${p3}-${p4}-${p5}`
}

/**
 * Sinh id theo format của id mẫu:
 * - Nếu mẫu là UUID có dấu `-` => sinh UUID (giữ uppercase nếu mẫu uppercase).
 * - Ngược lại sinh hex32 như logic cũ.
 */
function generateIdLike(sampleId?: string): string {
    if (!sampleId || typeof sampleId !== 'string') return generateId()
    if (sampleId.includes('-')) {
        const uuid = generateUuidV4()
        const isUpper = sampleId === sampleId.toUpperCase()
        return isUpper ? uuid.toUpperCase() : uuid.toLowerCase()
    }
    return generateId()
}

/** Chuyển giây (float) sang microsecond */
function secToUs(seconds: number): number {
    return Math.round(seconds * SEC_TO_US)
}

/**
 * Đọc duration hiện tại của draft nguồn (microsecond -> second).
 * Dùng làm fallback trong overwrite mode để tránh bị co ngắn timeline
 * khi CapCut update thay đổi cách lưu/khôi phục track.
 */
async function readDraftDurationSec(targetDraftPath?: string): Promise<number> {
    const draftPath = (targetDraftPath || '').trim()
    if (!draftPath) return 0
    try {
        const { join } = await import('@tauri-apps/api/path')
        const { exists, readTextFile } = await import('@tauri-apps/plugin-fs')
        const infoPath = await join(draftPath, 'draft_info.json')
        if (!(await exists(infoPath))) return 0
        const raw = await readTextFile(infoPath)
        const parsed = JSON.parse(raw)
        const durationUs = Number(parsed?.duration || 0)
        if (!Number.isFinite(durationUs) || durationUs <= 0) return 0
        return durationUs / SEC_TO_US
    } catch (err) {
        console.warn('[CapCut] ⚠️ Không đọc được duration từ draft nguồn:', err)
        return 0
    }
}

/** Deep clone 1 object JSON */
function deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj))
}

/**
 * Tách text thành token để tạo cấu trúc word-level:
 * - Giữ token chữ và token khoảng trắng riêng.
 * - Điều này giúp dữ liệu gần với draft gốc của CapCut hơn.
 */
function tokenizeSubtitleText(text: string): string[] {
    const tokens = text.match(/(\s+|[^\s]+)/g)
    return tokens ? tokens : []
}

/**
 * Sinh word timing tối thiểu cho text material (đơn vị milliseconds).
 * API/engine CapCut thường lưu words.start_time/end_time theo ms.
 *
 * Request vào hàm:
 * - text: nội dung subtitle mới.
 * - durationSec: thời lượng segment subtitle (giây).
 *
 * Response:
 * - object { start_time, end_time, text } để gán trực tiếp vào `mat.words`.
 */
function buildWordsTimingForText(text: string, durationSec: number) {
    const tokens = tokenizeSubtitleText(text)
    const totalMs = Math.max(1, Math.round(durationSec * 1000))
    const totalNonSpaceChars = Math.max(
        1,
        tokens.reduce((sum, tk) => sum + (/^\s+$/.test(tk) ? 0 : tk.length), 0)
    )

    const start_time: number[] = []
    const end_time: number[] = []
    const tokenTexts: string[] = []

    let cursorMs = 0

    for (let i = 0; i < tokens.length; i++) {
        const tk = tokens[i]
        const isSpace = /^\s+$/.test(tk)

        start_time.push(cursorMs)
        tokenTexts.push(tk)

        if (isSpace) {
            // Khoảng trắng có độ dài 0ms (pattern thường thấy ở dữ liệu gốc CapCut).
            end_time.push(cursorMs)
            continue
        }

        let delta = Math.round((totalMs * tk.length) / totalNonSpaceChars)
        if (delta < 1) delta = 1

        // Token cuối cùng chốt đúng mốc totalMs để không trôi sai số.
        if (i === tokens.length - 1) {
            cursorMs = totalMs
        } else {
            cursorMs = Math.min(totalMs, cursorMs + delta)
        }
        end_time.push(cursorMs)
    }

    return { start_time, end_time, text: tokenTexts }
}

// ======================== LOAD TEMPLATE ========================

// Cache template materials (load 1 lần duy nhất)
let _materialTemplates: any = null

/**
 * Load material_templates.json từ resources — chứa 1 mẫu đầy đủ cho mỗi loại:
 * video_material (65 keys), audio_material (62 keys), text_material (125 keys),
 * video_segment (50 keys), audio_segment (50 keys), text_segment (50 keys),
 * speed, sound_channel_mapping, loudness, vocal_separation
 */
async function loadMaterialTemplates(): Promise<any> {
    if (_materialTemplates) return _materialTemplates

    // Đọc file JSON từ Tauri resources
    const { resolveResource } = await import('@tauri-apps/api/path')
    const { readTextFile } = await import('@tauri-apps/plugin-fs')
    const templatePath = await resolveResource('resources/capcut_template/material_templates.json')
    const content = await readTextFile(templatePath)
    _materialTemplates = JSON.parse(content)
    console.log('[CapCut] 📦 Loaded material templates:', Object.keys(_materialTemplates).join(', '))
    return _materialTemplates
}

// ======================== CLONE FACTORIES ========================

/**
 * Clone video material — override id/path/duration/name
 * Template gốc có 65 keys, đảm bảo CapCut parse không lỗi
 */
function cloneVideoMaterial(template: any, filePath: string, durationUs: number): { mat: any; id: string } {
    const mat = deepClone(template)
    const id = generateId()
    mat.id = id
    mat.local_material_id = id
    mat.path = filePath
    mat.duration = durationUs
    mat.material_name = filePath.split('/').pop() || 'unknown'
    mat.width = 1920
    mat.height = 1080
    return { mat, id }
}

/**
 * Clone audio material — override id/path/duration/name
 * Template gốc có 62 keys
 */
function cloneAudioMaterial(template: any, filePath: string, durationUs: number): { mat: any; id: string } {
    const mat = deepClone(template)
    const id = generateId()
    mat.id = id
    mat.local_material_id = id
    mat.path = filePath
    mat.name = filePath.split('/').pop() || 'unknown'
    mat.duration = durationUs
    return { mat, id }
}

/**
 * Clone text material — override id/content
 * Template gốc có 125 keys
 */
function cloneTextMaterial(template: any, text: string, durationSec: number): { mat: any; id: string } {
    const mat = deepClone(template)
    const id = generateIdLike(template?.id)
    mat.id = id

    // Giữ lại định dạng (font, màu sắc, bóng, animation) từ template gốc
    let contentObj: any = {}
    try {
        contentObj = JSON.parse(template.content || '{}')
    } catch {
        contentObj = { styles: [{ fill: { content: { solid: { color: [1, 1, 1] }, render_type: 'solid' } } }] }
    }

    contentObj.text = text
    if (contentObj.styles && contentObj.styles.length > 0) {
        // Chỉ cập nhật độ dài text cho tất cả styles
        contentObj.styles.forEach((style: any) => {
            if (style.range) {
                style.range = [0, text.length]
            }
        })
    }

    mat.content = JSON.stringify(contentObj)

    // ==== ĐỒNG BỘ METADATA WORD-LEVEL CHO TEXT MỚI ====
    // Flow:
    // 1) Request của generator truyền vào text mới + duration subtitle.
    // 2) Ở đây tạo response object words timing tối thiểu theo text mới.
    // 3) CapCut nhận draft sẽ có đủ trường recognize/words nhất quán hơn để chạy template.
    mat.recognize_text = text
    mat.recognize_task_id = ''

    if (mat.words && typeof mat.words === 'object') {
        mat.words = buildWordsTimingForText(text, durationSec)
    }
    if (mat.current_words && typeof mat.current_words === 'object') {
        mat.current_words = { start_time: [], end_time: [], text: [] }
    }

    return { mat, id }
}

/**
 * Clone speed material — chỉ override id
 */
function cloneSpeed(template: any): { mat: any; id: string } {
    const mat = deepClone(template)
    const id = generateId()
    mat.id = id
    return { mat, id }
}

/**
 * Clone sound_channel_mapping — chỉ override id
 */
function cloneChannel(template: any): { mat: any; id: string } {
    const mat = deepClone(template)
    const id = generateId()
    mat.id = id
    return { mat, id }
}

/**
 * Clone loudness — chỉ override id
 */
function cloneLoudness(template: any): { mat: any; id: string } | null {
    if (!template) return null
    const mat = deepClone(template)
    const id = generateId()
    mat.id = id
    return { mat, id }
}

/**
 * Clone vocal_separation — chỉ override id
 */
function cloneVocalSep(template: any): { mat: any; id: string } | null {
    if (!template) return null
    const mat = deepClone(template)
    const id = generateId()
    mat.id = id
    return { mat, id }
}

// ======================== CLONE SEGMENTS ========================

/**
 * Clone video segment (50 keys) — override id, material_id, timerange, extra_material_refs
 */
function cloneVideoSegment(
    template: any, matId: string, speedId: string, channelId: string,
    startSec: number, endSec: number, sourceStartSec: number = 0
): any {
    const seg = deepClone(template)
    seg.id = generateId()
    seg.material_id = matId
    seg.target_timerange = { start: secToUs(startSec), duration: secToUs(endSec - startSec) }
    seg.source_timerange = { start: secToUs(sourceStartSec), duration: secToUs(endSec - startSec) }
    seg.extra_material_refs = [speedId, channelId]
    return seg
}

/**
 * Clone audio segment (50 keys) — override id, material_id, timerange, volume, extra_material_refs
 */
function cloneAudioSegment(
    template: any, matId: string, channelId: string,
    loudnessId: string | null, vocalSepId: string | null,
    startSec: number, endSec: number, volume: number = 1.0
): any {
    const seg = deepClone(template)
    seg.id = generateId()
    seg.material_id = matId
    seg.target_timerange = { start: secToUs(startSec), duration: secToUs(endSec - startSec) }
    seg.source_timerange = { start: 0, duration: secToUs(endSec - startSec) }
    seg.volume = volume
    seg.last_nonzero_volume = volume
    const refs = [channelId]
    if (loudnessId) refs.push(loudnessId)
    if (vocalSepId) refs.push(vocalSepId)
    seg.extra_material_refs = refs
    return seg
}

/**
 * Clone text segment (50 keys) — override id, material_id, timerange
 */
function cloneTextSegment(
    template: any, matId: string, startSec: number, endSec: number
): any {
    const seg = deepClone(template)
    seg.id = generateIdLike(template?.id)
    seg.material_id = matId
    seg.target_timerange = { start: secToUs(startSec), duration: secToUs(endSec - startSec) }
    // CapCut draft gốc thường để null cho text segment source_timerange.
    // Giữ null giúp output gần hành vi project tạo trực tiếp trong CapCut hơn.
    seg.source_timerange = null
    return seg
}

// ======================== BUILD TRACK ========================

/** Tạo 1 track trên timeline */
function buildTrack(type: string, segments: any[]) {
    return {
        id: generateId(),
        type,
        // Video track cần attribute=1 (quy ước CapCut), các track khác = 0
        attribute: type === 'video' ? 1 : 0,
        flag: 0,
        is_default_name: true,
        name: '',
        segments,
    }
}

/**
 * Khử trùng theo id cho 1 mảng material.
 * Vì CapCut rất nhạy với duplicate id: cùng 1 id xuất hiện 2 object có thể làm project load lỗi.
 *
 * Request:
 * - items: mảng materials trước khi ghi draft.
 * - label: tên mảng để log debug.
 *
 * Response:
 * - mảng đã loại trùng (giữ bản ghi đầu tiên).
 */
function dedupeById(items: any[], label: string): any[] {
    const seen = new Set<string>()
    const out: any[] = []
    let dropped = 0
    for (const it of items || []) {
        const id = it?.id
        if (!id) {
            out.push(it)
            continue
        }
        const key = String(id).toLowerCase()
        if (seen.has(key)) {
            dropped += 1
            continue
        }
        seen.add(key)
        out.push(it)
    }
    if (dropped > 0) {
        console.warn(`[CapCut] ⚠️ Dedupe ${label}: đã bỏ ${dropped} object trùng id`)
    }
    return out
}

/**
 * Chuẩn hoá đường dẫn logo trước khi inject vào CapCut draft.
 * Ưu tiên copy logo vào cùng thư mục media đang dùng (image/footage) để tăng xác suất
 * CapCut đã có quyền truy cập thư mục đó và tránh Unsupported media cho logo.
 *
 * Request:
 * - rawLogoPath: đường dẫn logo gốc user chọn.
 * - imageClips/footageClips: dùng để suy ra "thư mục media tin cậy".
 *
 * Response:
 * - path logo đã chuẩn hoá (có thể là file copy mới), fallback path gốc nếu copy lỗi.
 */
async function resolveCapCutLogoPath(
    rawLogoPath: string,
    imageClips: Array<{ filePath: string }> = [],
    footageClips: Array<{ filePath: string }> = []
): Promise<string> {
    if (!rawLogoPath) return rawLogoPath

    try {
        const { exists, copyFile } = await import('@tauri-apps/plugin-fs')
        const { dirname, join } = await import('@tauri-apps/api/path')

        // Nếu file gốc không tồn tại thì trả nguyên để luồng trên log lỗi rõ.
        if (!(await exists(rawLogoPath))) return rawLogoPath

        // Chọn thư mục media đích:
        // 1) thư mục của ảnh clip đầu tiên
        // 2) fallback thư mục của footage clip đầu tiên
        // 3) không có thì giữ nguyên
        const firstMediaPath =
            imageClips.find(c => !!c.filePath)?.filePath ||
            footageClips.find(c => !!c.filePath)?.filePath ||
            ''
        if (!firstMediaPath) return rawLogoPath

        const targetDir = await dirname(firstMediaPath)
        const extRaw = (rawLogoPath.split('.').pop() || 'png').toLowerCase()
        const ext = ['png', 'jpg', 'jpeg', 'webp'].includes(extRaw) ? extRaw : 'png'
        const targetLogoPath = await join(targetDir, `autosubs_channel_logo_${Date.now()}.${ext}`)

        await copyFile(rawLogoPath, targetLogoPath)
        return targetLogoPath
    } catch (err) {
        console.warn('[CapCut] ⚠️ Không copy được logo sang thư mục media tin cậy:', err)
        return rawLogoPath
    }
}

// ======================== MAIN GENERATE FUNCTION ========================

/**
 * Hàm chính: Tạo CapCut Draft project từ kết quả pipeline
 * Dùng clone-and-override từ material_templates.json — đảm bảo đúng 100% schema CapCut
 * 
 * @param input - Kết quả từ 5 pipeline (clips, subtitles, audio...)
 * @returns projectName + projectPath
 */
export async function generateCapCutDraft(
    input: CapCutDraftInput
): Promise<{ projectName: string; projectPath: string }> {
    console.log('[CapCut] 🎬 Bắt đầu tạo CapCut Draft (clone approach)...')

    // Load templates (cached sau lần đầu)
    const tpl = await loadMaterialTemplates()

    const { config, imageClips, footageClips, voiceoverClips, bgmClips, sfxClips, subtitles, effectsSettings, channelBranding } = input

    // Resolve logo path sớm để track logo luôn dùng path ổn định hơn cho CapCut.
    const resolvedChannelLogoPath = channelBranding?.logoPath
        ? await resolveCapCutLogoPath(channelBranding.logoPath, imageClips || [], footageClips || [])
        : ''

    // Effects settings (defaults nếu không truyền)
    const fx = effectsSettings || {}
    // Một số field resolved (cachePath, duration, name) được panel đẩy vào fx._resolved.
    // Fallback này giúp generator vẫn đọc đúng dù parent chưa flatten object.
    const fxResolved: any = (fx as any)._resolved || {}
    const muteVideo = fx.muteVideo ?? false
    const zoomEnabled = fx.zoomEnabled ?? false
    const zoomLevel = fx.zoomLevel ?? 1.35

    // ======================== DEBUG: Log toàn bộ effects settings nhận được ========================
    console.log('[CapCut] 🔍 DEBUG effectsSettings nhận được:', JSON.stringify({
        textTemplateEffectId: fx.textTemplateEffectId || '(TRỐNG - không chọn template)',
        textTemplateCachePath: fx.textTemplateCachePath || fxResolved.textTemplateCachePath || '(TRỐNG)',
        textTemplateName: fx.textTemplateName || fxResolved.textTemplateName || '(TRỐNG)',
        textAnimationEffectId: fx.textAnimationEffectId || '(TRỐNG)',
        transitionEffectId: fx.transitionEffectId || '(TRỐNG)',
        videoEffectId: fx.videoEffectId || '(TRỐNG)',
        zoomEnabled, zoomLevel, muteVideo,
        fxKeys: Object.keys(fx),
        rawFx: fx,
    }, null, 2))

    // Collect tất cả materials + tracks
    const allVideoMats: any[] = []
    const allAudioMats: any[] = []
    const allTextMats: any[] = []
    const allSpeeds: any[] = []
    const allChannels: any[] = []
    const allLoudness: any[] = []
    const allVocalSeps: any[] = []
    const allTracks: any[] = []
    const allTransitions: any[] = []
    const allVideoEffects: any[] = []
    const allTextTemplates: any[] = []
    const allMaterialAnimations: any[] = []
    const allEffects: any[] = []
    const allCanvases: any[] = []
    const allMaterialColors: any[] = []
    const allPlaceholderInfos: any[] = []
    const debugFootageSegments: any[] = []

    let maxEndTime = 0
    // Timeline fallback từ pipeline (adapter) và draft nguồn cũ (overwrite mode).
    const configuredTotalDurationSec = Math.max(0, Number(config.totalDurationSec || 0))
    const sourceDraftDurationSec = await readDraftDurationSec(config.targetDraftPath)
    const fallbackTimelineEndSec = Math.max(configuredTotalDurationSec, sourceDraftDurationSec)

    // ======================== XÁC ĐỊNH VOICE END TIME (source-of-truth) ========================
    // VO là source-of-truth cho tổng duration timeline
    // Tất cả track khác sẽ được clamp về giá trị này — lớp safety cuối cùng
    const voiceEndTime = Math.max(...(voiceoverClips || []).map(c => c.endTime), 0)
    if (voiceEndTime > 0) {
        maxEndTime = voiceEndTime
        console.log(`[CapCut] 🎤 Voice end time (source-of-truth): ${voiceEndTime.toFixed(3)}s`)
    } else if (fallbackTimelineEndSec > 0) {
        // Không có VO mới: dùng mốc fallback để giữ timing ổn định sau overwrite.
        maxEndTime = fallbackTimelineEndSec
        console.log(`[CapCut] ⏱️ Fallback timeline end: ${fallbackTimelineEndSec.toFixed(3)}s (config=${configuredTotalDurationSec.toFixed(3)}s, sourceDraft=${sourceDraftDurationSec.toFixed(3)}s)`)
    }

    // Mốc timeline dùng để clamp các track media trong overwrite mode.
    // Nếu không có VO mới, fallbackTimelineEndSec sẽ giúp media không bị co ngắn ngoài ý muốn.
    const mediaTimelineEndSec = voiceEndTime > 0 ? voiceEndTime : fallbackTimelineEndSec

    // ===== VIDEO TRACK: Image clips (AI generated) =====
    if (imageClips && imageClips.length > 0) {
        const segments: any[] = []
        for (let ci = 0; ci < imageClips.length; ci++) {
            const clip = imageClips[ci]

            // ===== CLAMP: không để clip vượt quá mốc timeline hiện tại =====
            const clipEnd = mediaTimelineEndSec > 0 ? Math.min(clip.endTime, mediaTimelineEndSec) : clip.endTime
            const clipStart = Math.max(0, clip.startTime)
            if (clipEnd <= clipStart) continue // skip clip lỗi

            const durationUs = secToUs(clipEnd - clipStart)
            const { mat, id: matId } = cloneVideoMaterial(tpl.video_material, clip.filePath, durationUs)

            // ★ CapCut phân biệt ảnh (type="photo") và video (type="video")
            // Khi nhận ảnh gốc .jpg/.png, phải set type="photo" + duration mặc định 3 tiếng (10800s)
            // CapCut sẽ tự trim theo source_timerange — giống hành vi khi kéo ảnh vào timeline thủ công
            if (clip.type === 'image') {
                mat.type = 'photo'
                mat.duration = 10800000000 // 10800s = 3 tiếng (default CapCut cho ảnh)
            }

            const { mat: spd, id: spdId } = cloneSpeed(tpl.speed)
            const { mat: ch, id: chId } = cloneChannel(tpl.sound_channel_mapping)

            allVideoMats.push(mat)
            allSpeeds.push(spd)
            allChannels.push(ch)

            const seg = cloneVideoSegment(tpl.video_segment, matId, spdId, chId, clipStart, clipEnd, clip.sourceStart || 0)

            // === MUTE VIDEO: set volume = 0 ===
            if (muteVideo) {
                seg.volume = 0.0
            }

            // === KEYFRAME ZOOM IN (Ken Burns) cho IMAGE CLIPS ===
            // Theo yêu cầu:
            // 1) Chỉ áp dụng cho imageClips (không áp dụng footageClips).
            // 2) Random rất nhỏ để vẫn tự nhiên nhưng không "lúc có lúc không".
            // 3) Tạo keyframe khi clip > 0.2s.
            // 4) Gắn cả X và Y để CapCut nội suy ổn định hơn.
            if (zoomEnabled && durationUs > 200000) {
                // Random rất nhỏ: ±1% quanh zoomLevel
                const randomOffset = (Math.random() * 0.02) - 0.01
                const finalZoom = Math.max(1.01, zoomLevel + randomOffset)
                const endOffset = Math.max(0, durationUs - 200000)

                seg.common_keyframes = [
                    {
                        id: generateId(),
                        property_type: 'KFTypeScaleX',
                        keyframe_list: [
                            { time_offset: 0, curveType: 0, values: [1.0] },
                            { time_offset: endOffset, curveType: 0, values: [finalZoom] },
                        ]
                    },
                    {
                        id: generateId(),
                        property_type: 'KFTypeScaleY',
                        keyframe_list: [
                            { time_offset: 0, curveType: 0, values: [1.0] },
                            { time_offset: endOffset, curveType: 0, values: [finalZoom] },
                        ]
                    }
                ]

                // Cập nhật clip.scale theo giá trị cuối keyframe để preview initial state đồng bộ.
                seg.clip = { ...seg.clip, scale: { x: finalZoom, y: finalZoom } }
            }

            // === TRANSITION: Thêm chuyển cảnh giữa các clip ===
            if (fx.transitionEffectId && ci > 0) {
                const trId = generateId()
                const transitionMat = {
                    id: trId,
                    type: 'transition',
                    name: 'Transition',
                    effect_id: fx.transitionEffectId,
                    resource_id: fx.transitionEffectId,
                    third_resource_id: fx.transitionEffectId,
                    source_platform: 1,
                    path: fx.transitionCachePath || fxResolved.transitionCachePath || '',
                    duration: fx.transitionDuration || fxResolved.transitionDuration || 466666,
                    is_overlap: false,
                    platform: 'all',
                    category_id: '123456',
                    category_name: 'Chuyển tiếp',
                    request_id: '',
                    is_ai_transition: false,
                    video_path: '',
                    task_id: '',
                }
                allTransitions.push(transitionMat)
                // Gắn transition vào extra_material_refs của segment
                if (!seg.extra_material_refs) seg.extra_material_refs = []
                seg.extra_material_refs.push(trId)
            }

            segments.push(seg)
            maxEndTime = Math.max(maxEndTime, clipEnd)
        }

        allTracks.push(buildTrack('video', segments))

        // DEBUG media timing: so sánh input clip timing và segment timing thực tế chuẩn bị ghi draft.
        // Mục tiêu: nếu user thấy lệch ảnh theo câu, có thể đối chiếu ngay tại đây xem lệch từ pipeline
        // hay lệch ở bước map sang CapCut segment.
        const imageInputMaxEnd = Math.max(0, ...imageClips.map(c => Number(c.endTime || 0)))
        const imageSegMaxEnd = Math.max(
            0,
            ...segments.map((s: any) =>
                (Number(s?.target_timerange?.start || 0) + Number(s?.target_timerange?.duration || 0)) / SEC_TO_US
            )
        )
        console.log(
            `[CapCut][MediaTiming] imageClips=${imageClips.length}, segments=${segments.length}, inputMaxEnd=${imageInputMaxEnd.toFixed(3)}s, segMaxEnd=${imageSegMaxEnd.toFixed(3)}s`
        )
    }

    // ===== VIDEO TRACK: Footage B-roll =====
    if (footageClips && footageClips.length > 0) {
        const segments: any[] = []
        for (const clip of footageClips) {
            // ===== CLAMP: không để clip vượt quá mốc timeline hiện tại =====
            const clipEnd = mediaTimelineEndSec > 0 ? Math.min(clip.endTime, mediaTimelineEndSec) : clip.endTime
            const clipStart = Math.max(0, clip.startTime)
            if (clipEnd <= clipStart) continue

            const durationUs = secToUs(clipEnd - clipStart)
            const { mat, id: matId } = cloneVideoMaterial(tpl.video_material, clip.filePath, durationUs)
            const { mat: spd, id: spdId } = cloneSpeed(tpl.speed)
            const { mat: ch, id: chId } = cloneChannel(tpl.sound_channel_mapping)

            allVideoMats.push(mat)
            allSpeeds.push(spd)
            allChannels.push(ch)

            const seg = cloneVideoSegment(tpl.video_segment, matId, spdId, chId, clipStart, clipEnd, clip.sourceStart || 0)
            // Mute footage track
            if (muteVideo) seg.volume = 0.0
            segments.push(seg)
            debugFootageSegments.push(seg)
            maxEndTime = Math.max(maxEndTime, clipEnd)
        }
        allTracks.push(buildTrack('video', segments))
    }

    // ===== VIDEO TRACK: Channel Logo Overlay =====
    // Nếu user chọn kênh + có logoPath thì chèn 1 track video ảnh logo phủ suốt timeline.
    // Chỉ dùng preset vị trí (không preview, không intro/outro) theo yêu cầu.
    if (resolvedChannelLogoPath && channelBranding) {
        const logoTimelineEnd = voiceEndTime > 0 ? voiceEndTime : maxEndTime
        if (logoTimelineEnd > 0) {
            const logoDurationUs = secToUs(logoTimelineEnd)
            const { mat, id: matId } = cloneVideoMaterial(tpl.video_material, resolvedChannelLogoPath, logoDurationUs)
            // Logo là ảnh tĩnh.
            mat.type = 'photo'
            mat.duration = 10800000000

            const { mat: spd, id: spdId } = cloneSpeed(tpl.speed)
            const { mat: ch, id: chId } = cloneChannel(tpl.sound_channel_mapping)

            allVideoMats.push(mat)
            allSpeeds.push(spd)
            allChannels.push(ch)

            const logoSeg = cloneVideoSegment(tpl.video_segment, matId, spdId, chId, 0, logoTimelineEnd, 0)
            // Logo không cần âm thanh.
            logoSeg.volume = 0.0

            // Preset vị trí logo (tọa độ normalized theo clip.transform của CapCut).
            const positionMap: Record<string, { x: number; y: number }> = {
                'top-left': { x: -0.87, y: 0.75 },
                'top-right': { x: 0.87, y: 0.75 },
                'bottom-left': { x: -0.87, y: -0.75 },
                'bottom-right': { x: 0.87, y: -0.75 },
            }
            const pos = positionMap[channelBranding.position] || positionMap['top-right']
            const transformX = typeof channelBranding.x === 'number' ? channelBranding.x : pos.x
            const transformY = typeof channelBranding.y === 'number' ? channelBranding.y : pos.y
            const logoScale = typeof channelBranding.scale === 'number' ? channelBranding.scale : 0.17

            // Scale logo nhỏ gọn để không che nội dung chính.
            logoSeg.clip = {
                ...(logoSeg.clip || {}),
                scale: { x: logoScale, y: logoScale },
                transform: { x: transformX, y: transformY },
            }

            allTracks.push(buildTrack('video', [logoSeg]))
            console.log(`[CapCut] 🏷️ Channel logo overlay: channel="${channelBranding.channelName}" position=${channelBranding.position} x=${transformX} y=${transformY} scale=${logoScale} rawPath=${channelBranding.logoPath} resolvedPath=${resolvedChannelLogoPath}`)
        } else {
            console.warn('[CapCut] ⚠️ Bỏ qua logo overlay vì timeline chưa có duration > 0')
        }
    }

    // ===== AUDIO TRACK: Voice Over (A1) =====
    if (voiceoverClips && voiceoverClips.length > 0) {
        const segments: any[] = []
        for (const clip of voiceoverClips) {
            const durationUs = secToUs(clip.endTime - clip.startTime)
            const { mat, id: matId } = cloneAudioMaterial(tpl.audio_material, clip.filePath, durationUs)
            const { mat: ch, id: chId } = cloneChannel(tpl.sound_channel_mapping)
            const loud = cloneLoudness(tpl.loudness)
            const vs = cloneVocalSep(tpl.vocal_separation)

            allAudioMats.push(mat)
            allChannels.push(ch)
            if (loud) allLoudness.push(loud.mat)
            if (vs) allVocalSeps.push(vs.mat)

            segments.push(cloneAudioSegment(
                tpl.audio_segment, matId, chId, loud?.id || null, vs?.id || null,
                clip.startTime, clip.endTime, 1.0 // VO volume 100%
            ))
            maxEndTime = Math.max(maxEndTime, clip.endTime)
        }
        allTracks.push(buildTrack('audio', segments))
    }

    // ===== AUDIO TRACK: BGM =====
    if (bgmClips && bgmClips.length > 0) {
        const segments: any[] = []
        for (const clip of bgmClips) {
            // Clamp: không để BGM vượt quá VO
            const clipEnd = voiceEndTime > 0 ? Math.min(clip.endTime, voiceEndTime) : clip.endTime
            const clipStart = Math.max(0, clip.startTime)
            if (clipEnd <= clipStart) continue

            const durationUs = secToUs(clipEnd - clipStart)
            const { mat, id: matId } = cloneAudioMaterial(tpl.audio_material, clip.filePath, durationUs)
            const { mat: ch, id: chId } = cloneChannel(tpl.sound_channel_mapping)
            const loud = cloneLoudness(tpl.loudness)
            const vs = cloneVocalSep(tpl.vocal_separation)

            allAudioMats.push(mat)
            allChannels.push(ch)
            if (loud) allLoudness.push(loud.mat)
            if (vs) allVocalSeps.push(vs.mat)

            segments.push(cloneAudioSegment(
                tpl.audio_segment, matId, chId, loud?.id || null, vs?.id || null,
                clipStart, clipEnd, 0.5 // BGM volume mặc định
            ))
            maxEndTime = Math.max(maxEndTime, clipEnd)
        }
        allTracks.push(buildTrack('audio', segments))
    }

    // ===== AUDIO TRACK: SFX =====
    if (sfxClips && sfxClips.length > 0) {
        const segments: any[] = []
        for (const clip of sfxClips) {
            // Clamp: không để SFX vượt quá VO
            const clipEnd = voiceEndTime > 0 ? Math.min(clip.endTime, voiceEndTime) : clip.endTime
            const clipStart = Math.max(0, clip.startTime)
            if (clipEnd <= clipStart) continue

            const durationUs = secToUs(clipEnd - clipStart)
            const { mat, id: matId } = cloneAudioMaterial(tpl.audio_material, clip.filePath, durationUs)
            const { mat: ch, id: chId } = cloneChannel(tpl.sound_channel_mapping)
            const loud = cloneLoudness(tpl.loudness)
            const vs = cloneVocalSep(tpl.vocal_separation)

            allAudioMats.push(mat)
            allChannels.push(ch)
            if (loud) allLoudness.push(loud.mat)
            if (vs) allVocalSeps.push(vs.mat)

            segments.push(cloneAudioSegment(
                tpl.audio_segment, matId, chId, loud?.id || null, vs?.id || null,
                clipStart, clipEnd, 1.0 // SFX volume mặc định
            ))
            maxEndTime = Math.max(maxEndTime, clipEnd)
        }
        allTracks.push(buildTrack('audio', segments))
    }

    // ===== TEXT TRACK: Subtitles =====
    if (subtitles && subtitles.length > 0) {
        console.log(`[CapCut] 📝 TEXT TRACK: ${subtitles.length} phụ đề, textTemplateEffectId=${fx.textTemplateEffectId || '(KHÔNG CÓ - sẽ dùng mặc định)'}`)
        const segments: any[] = []
        for (let si = 0; si < subtitles.length; si++) {
            const sub = subtitles[si]
            // Clamp: không để phụ đề vượt quá VO
            const subEnd = voiceEndTime > 0 ? Math.min(sub.endTime, voiceEndTime) : sub.endTime
            const subStart = Math.max(0, sub.startTime)
            if (subEnd <= subStart) continue

            // Ưu tiên clone text material gốc đi kèm template user chọn để giữ style/font/border/shadow chuẩn.
            // Fallback về template mặc định nếu không có raw text material.
            const baseTextMaterial = fx.textTemplateTextMaterialRawJson || tpl.text_material
            const { mat, id: matId } = cloneTextMaterial(baseTextMaterial, sub.text, subEnd - subStart)
            allTextMats.push(mat)

            // Tạm dùng matId cho segment — nếu có template sẽ đổi sang ttId bên dưới
            const textSeg = cloneTextSegment(tpl.text_segment, matId, subStart, subEnd)

            // === VỊ TRÍ PHỤ ĐỀ: đặt ở đáy màn hình (y = -0.73) ===
            textSeg.clip = {
                ...textSeg.clip,
                scale: { x: 1.0, y: 1.0 },
                transform: { x: 0.0, y: -0.73 },
            }

            // Khởi tạo extra_material_refs để gắn template + animation
            if (!textSeg.extra_material_refs) textSeg.extra_material_refs = []

            // === TEXT TEMPLATE: gắn template subtitle (nếu user chọn) ===
            if (fx.textTemplateEffectId) {
                const ttId = generateIdLike(fx.textTemplateRawJson?.id)
                const textInfoResId = generateIdLike(fx.textTemplateRawJson?.text_info_resources?.[0]?.id)
                let textTplMat: any

                // Tối ưu quan trọng: dùng nguyên file JSON của CapCut để clone lại, tránh thiếu các keys do CapCut thiết lập
                if (fx.textTemplateRawJson) {
                    textTplMat = JSON.parse(JSON.stringify(fx.textTemplateRawJson))
                    textTplMat.id = ttId
                    // CapCut hierarchy: segment → text_template → text_info_resources[].text_material_id → texts[]
                    if (!textTplMat.text_info_resources) textTplMat.text_info_resources = []
                    if (textTplMat.text_info_resources.length === 0) {
                        textTplMat.text_info_resources.push({})
                    }

                    // Ghi đè các uuid quan hệ vào bản clone
                    const infoRes = textTplMat.text_info_resources[0]
                    infoRes.id = textInfoResId
                    infoRes.text_material_id = matId

                    // Clone refs theo từng subtitle segment để tránh 2 segment dùng chung 1 material ref.
                    const originalRefs: string[] = Array.isArray(infoRes.extra_material_refs)
                        ? [...infoRes.extra_material_refs]
                        : []

                    // Nguồn raw refs để clone:
                    // - material_animations
                    // - effects
                    const linkedAnims: any[] = Array.isArray(fx.textTemplateLinkedMaterialAnimationsRawJson)
                        ? fx.textTemplateLinkedMaterialAnimationsRawJson
                        : []
                    const linkedEffects: any[] = Array.isArray(fx.textTemplateLinkedEffectsRawJson)
                        ? fx.textTemplateLinkedEffectsRawJson
                        : []
                    const mappedRefs: string[] = []
                    for (const oldRef of originalRefs) {
                        const normalizedOldRef = String(oldRef || '').toLowerCase()
                        let mappedRef = oldRef

                        const animRaw = linkedAnims.find((a: any) => String(a?.id || '').toLowerCase() === normalizedOldRef)
                        if (animRaw) {
                            const newAnimId = generateIdLike(oldRef)
                            const animClone = JSON.parse(JSON.stringify(animRaw))
                            animClone.id = newAnimId
                            allMaterialAnimations.push(animClone)
                            mappedRef = newAnimId
                        }

                        const effectRaw = linkedEffects.find((e: any) => String(e?.id || '').toLowerCase() === normalizedOldRef)
                        if (effectRaw) {
                            const newEffectId = generateIdLike(oldRef)
                            const effectClone = JSON.parse(JSON.stringify(effectRaw))
                            effectClone.id = newEffectId
                            allEffects.push(effectClone)
                            mappedRef = newEffectId
                        }
                        mappedRefs.push(mappedRef)
                    }
                    infoRes.extra_material_refs = mappedRefs

                    // Giữ timing gốc của template (chỉ ép start=0 để khớp segment local).
                    // Không ép duration theo subEnd-subStart để tránh phá timing nội bộ của effect preset.
                    if (infoRes.attach_info) {
                        infoRes.attach_info.start_time = 0
                    } else {
                        // Fallback khi template raw thiếu attach_info.
                        infoRes.attach_info = {
                            start_time: 0,
                            duration: secToUs(subEnd - subStart),
                            original_size_width: 236.2,
                            original_size_height: 32.1,
                            clip: {
                                scale: { x: 1.0, y: 1.0 },
                                rotation: 0.0,
                                transform: { x: 0.0, y: 0.0 },
                                flip: { vertical: false, horizontal: false },
                                alpha: 1.0
                            }
                        }
                    }
                } else {
                    // Fallback nếu không có raw JSON (rất hiếm)
                    textTplMat = {
                        id: ttId,
                        version: '1.0.0',
                        effect_id: fx.textTemplateEffectId,
                        resource_id: fx.textTemplateEffectId,
                        third_resource_id: '',
                        name: fx.textTemplateName || 'Text Template',
                        type: 'text_template_subtitle',
                        path: fx.textTemplateCachePath || fxResolved.textTemplateCachePath || '',
                        category_id: '',
                        category_name: '',
                        platform: 'all',
                        text_to_audio_ids: [],
                        source_platform: 1,
                        resources: [],
                        text_info_resources: [
                            {
                                id: textInfoResId,
                                attach_info: {
                                    start_time: 0,
                                    duration: secToUs(subEnd - subStart),
                                    original_size_width: 236.2,
                                    original_size_height: 32.1,
                                    clip: {
                                        scale: { x: 1.0, y: 1.0 },
                                        rotation: 0.0,
                                        transform: { x: 0.0, y: 0.0 },
                                        flip: { vertical: false, horizontal: false },
                                        alpha: 1.0
                                    }
                                },
                                text_material_id: matId,
                                extra_material_refs: [],
                                clip_type: "",
                                lyric_keyframes: [],
                                word_index: [],
                                order_in_layer: 0,
                                capital: ""
                            }
                        ],
                        non_text_info_resources: [],
                        check_flag: 7,
                        is_3d: false,
                        is_pre_rendered: false,
                        aigc_type: 'none',
                        text_template_resource_type: 'subtitle_template',
                        is_dynamic_build: false,
                    }
                }

                allTextTemplates.push(textTplMat)

                // ★★★ FIX CHÍNH: segment.material_id PHẢI trỏ vào text_template.id (ttId)
                // KHÔNG PHẢI text_material.id (matId)!
                textSeg.material_id = ttId

                // Segment refs nên bám theo text_info_resources[0].extra_material_refs của template.
                // Không nhét ttId vào refs vì relation chính đã nằm ở segment.material_id.
                const segRefsFromTemplate: string[] = Array.isArray(textTplMat.text_info_resources?.[0]?.extra_material_refs)
                    ? [...textTplMat.text_info_resources[0].extra_material_refs]
                    : []
                textSeg.extra_material_refs = segRefsFromTemplate

                // Debug log chi tiết cho subtitle đầu tiên
                if (si === 0) {
                    console.log('[CapCut] ✅ TEXT TEMPLATE SEGMENT #0:', JSON.stringify({
                        segId: textSeg.id,
                        'segment.material_id (ĐỔI → ttId)': ttId,
                        'textMaterial.id (matId, được link qua text_info_resources)': matId,
                        textInfoResId,
                        effectId: fx.textTemplateEffectId,
                        cachePath: fx.textTemplateCachePath || fxResolved.textTemplateCachePath || '(TRỐNG)',
                        templateName: fx.textTemplateName || '(TRỐNG)',
                        extraMaterialRefs: textSeg.extra_material_refs,
                    }, null, 2))
                }
            } else {
                // Debug: user KHÔNG chọn template
                if (si === 0) {
                    console.log('[CapCut] ⚠️ KHÔNG CÓ textTemplateEffectId → phụ đề sẽ dùng style mặc định')
                    console.log('[CapCut] 🔍 effectsSettings hiện tại:', JSON.stringify(fx, null, 2))
                }
            }

            // === ANIMATION chữ bổ sung (chỉ dùng khi KHÔNG dùng text template) ===
            // Khi đã dùng text template, refs animation sẽ lấy từ template graph gốc để tránh lệch/treo render.
            if (!fx.textTemplateEffectId && fx.textAnimationEffectId) {
                const animId = generateId()
                const animMat = {
                    id: animId,
                    type: 'sticker_animation',
                    animations: [{
                        id: "",
                        type: "caption",
                        start: 0,
                        duration: secToUs(subEnd - subStart),
                        path: fx.textAnimationCachePath || '',
                        platform: "all",
                        resource_id: fx.textAnimationEffectId,
                        third_resource_id: "",
                        source_platform: 0,
                        name: fx.textAnimationName || '',
                        category_id: "",
                        category_name: "",
                        panel: "",
                        material_type: "sticker",
                        anim_adjust_params: null,
                        request_id: ""
                    }],
                    multi_language_current: 'none',
                }
                allMaterialAnimations.push(animMat)
                textSeg.extra_material_refs.push(animId)
            }

            segments.push(textSeg)
            // Dùng subEnd đã clamp để maxEnd không vượt mốc timeline thực tế.
            maxEndTime = Math.max(maxEndTime, subEnd)
        }
        allTracks.push(buildTrack('text', segments))

        // ======================== DEBUG SUMMARY TEXT TRACK ========================
        console.log(`[CapCut] 📝 TEXT TRACK SUMMARY:`, JSON.stringify({
            totalSubtitles: subtitles.length,
            segmentsCreated: segments.length,
            textMaterialsCount: allTextMats.length,
            textTemplatesCount: allTextTemplates.length,
            materialAnimationsCount: allMaterialAnimations.length,
            hasTextTemplateEffect: !!fx.textTemplateEffectId,
            // Kiểm tra segment đầu tiên có đủ refs không
            firstSegExtraMaterialRefs: segments[0]?.extra_material_refs || '(KHÔNG CÓ)',
            firstSegExtraMaterialRefsCount: segments[0]?.extra_material_refs?.length || 0,
        }, null, 2))
    }

    // ===== EFFECT TRACK: Video Effect (khung phim) =====
    if (fx.videoEffectId && maxEndTime > 0) {
        const veId = generateId()
        const videoEffectMat = {
            id: veId,
            effect_id: fx.videoEffectId,
            resource_id: fx.videoEffectId,
            name: fx.videoEffectName || fxResolved.videoEffectName || 'Video Effect',
            type: 'video_effect',
            sub_type: 0,
            bind_segment_id: '',
            transparent_params: '',
            path: fx.videoEffectCachePath || fxResolved.videoEffectCachePath || '',
            value: 1.0,
            category_id: '1111',
            category_name: 'Hiệu ứng video',
            platform: 'all',
            apply_target_type: 2, // Apply toàn timeline
            source_platform: 1,
            version: '',
            item_effect_type: 0,
            adjust_params: [],
            time_range: null,
            common_keyframes: [],
            request_id: '',
            enable_mask: true,
            effect_mask: [],
        }
        allVideoEffects.push(videoEffectMat)

        // Tạo 1 segment effect phủ toàn timeline
        const effectSeg = deepClone(tpl.video_segment || {})
        effectSeg.id = generateId()
        effectSeg.material_id = veId
        effectSeg.target_timerange = { start: 0, duration: secToUs(maxEndTime) }
        effectSeg.source_timerange = null
        effectSeg.extra_material_refs = []
        effectSeg.volume = 1.0

        allTracks.push(buildTrack('effect', [effectSeg]))
    }

    // ===== Tính tổng duration (microsecond) =====
    // Ưu tiên voiceEndTime làm total duration — timeline không được dài hơn VO
    const safeEndTime = voiceEndTime > 0 ? voiceEndTime : maxEndTime
    const totalDurationUs = secToUs(safeEndTime)
    console.log(`[CapCut] ⏱️ Total duration: ${safeEndTime.toFixed(3)}s (voiceEnd=${voiceEndTime.toFixed(3)}s, maxEnd=${maxEndTime.toFixed(3)}s)`)

    // ===== Gọi Rust backend tạo project =====
    // Request gửi đi:
    // - draftData: JSON timeline/materials đã build.
    // - metaMaterials: danh sách media để cập nhật draft_meta_info.
    // - targetDraftPath (optional): nếu có thì ghi đè trực tiếp draft nguồn.
    //
    // Response nhận về:
    // - project_path: path draft đã ghi.
    // - project_name: tên draft thực tế.
    const isOverwriteMode = !!config.targetDraftPath
    console.log(
        `[CapCut] 📦 ${isOverwriteMode ? 'Ghi đè draft nguồn' : 'Tạo draft mới'} "${config.projectName}" — ${allTracks.length} tracks, ${maxEndTime.toFixed(1)}s`
    )
    console.log(`[CapCut] Effects: mute=${muteVideo} zoom=${zoomEnabled}(${zoomLevel}) transition=${!!fx.transitionEffectId} videoFx=${!!fx.videoEffectId} textTpl=${!!fx.textTemplateEffectId}`)

    // ======================== DEBUG: TỔNG KẾT MATERIALS TRƯỚC KHI GHI ========================
    console.log('[CapCut] 📊 MATERIALS SUMMARY:', JSON.stringify({
        videos: allVideoMats.length,
        audios: allAudioMats.length,
        texts: allTextMats.length,
        speeds: allSpeeds.length,
        channels: allChannels.length,
        transitions: allTransitions.length,
        videoEffects: allVideoEffects.length,
        textTemplates: allTextTemplates.length,
        materialAnimations: allMaterialAnimations.length,
        // ★ QUAN TRỌNG: nếu textTemplates = 0 mà user đã chọn template → BUG!
        textTemplatesMismatch: (!!fx.textTemplateEffectId && allTextTemplates.length === 0)
            ? '❌ BUG: User chọn template nhưng allTextTemplates rỗng!'
            : '✅ OK',
    }))

    // ======================== DEBUG: Kiểm tra JSON THỰC SỰ gửi vào Rust ========================
    // Dump debug riêng cho footage để kiểm tra lệch timeline/source.
    try {
        const { writeTextFile } = await import('@tauri-apps/plugin-fs')
        const { join, homeDir } = await import('@tauri-apps/api/path')
        const homePath = await homeDir()
        const debugFootagePath = await join(homePath, 'Desktop', 'capcut_debug_footage_export.json')
        await writeTextFile(debugFootagePath, JSON.stringify({
            source: 'capcut-draft-service',
            generatedAt: new Date().toISOString(),
            footageClipsCount: footageClips?.length || 0,
            footageSegmentsCount: debugFootageSegments.length,
            footageClipsHead: (footageClips || []).slice(0, 60).map((c: any, idx: number) => ({
                idx,
                filePath: c.filePath,
                timelineStartSec: Number((c.startTime || 0).toFixed(6)),
                timelineEndSec: Number((c.endTime || 0).toFixed(6)),
                timelineDurationSec: Number(((c.endTime || 0) - (c.startTime || 0)).toFixed(6)),
                sourceStartSec: Number((c.sourceStart || 0).toFixed(6)),
            })),
            footageSegmentsHead: debugFootageSegments.slice(0, 60).map((s: any, idx: number) => ({
                idx,
                materialId: s.material_id,
                timelineStartSec: Number((Number(s?.target_timerange?.start || 0) / SEC_TO_US).toFixed(6)),
                timelineEndSec: Number(((Number(s?.target_timerange?.start || 0) + Number(s?.target_timerange?.duration || 0)) / SEC_TO_US).toFixed(6)),
                timelineDurationSec: Number((Number(s?.target_timerange?.duration || 0) / SEC_TO_US).toFixed(6)),
                sourceStartSec: Number((Number(s?.source_timerange?.start || 0) / SEC_TO_US).toFixed(6)),
                sourceDurationSec: Number((Number(s?.source_timerange?.duration || 0) / SEC_TO_US).toFixed(6)),
            })),
        }, null, 2))
        console.log('[CapCut] 🔬 Đã dump footage export debug ra:', debugFootagePath)
    } catch (e) {
        console.warn('[CapCut] ⚠️ Không dump được footage export debug file:', e)
    }

    // ======================== SAFETY PASS: CHUẨN HOÁ REF TRƯỚC KHI GHI DRAFT ========================
    // Mục tiêu:
    // 1) Khử duplicate id trong materials (tránh CapCut parse mơ hồ).
    // 2) Lọc extra_material_refs chỉ giữ ref tồn tại thật trong materials.
    //
    // Cơ chế request/response trong pass này:
    // - Input: toàn bộ arrays materials + tracks vừa generate ở RAM.
    // - Process: chuẩn hoá id map và refs.
    // - Output: chính các arrays đó sau khi được mutate an toàn, rồi mới serialize gửi Rust.
    const normalizedMaterialArrays: Record<string, any[]> = {
        videos: dedupeById(allVideoMats, 'materials.videos'),
        audios: dedupeById(allAudioMats, 'materials.audios'),
        texts: dedupeById(allTextMats, 'materials.texts'),
        text_templates: dedupeById(allTextTemplates, 'materials.text_templates'),
        material_animations: dedupeById(allMaterialAnimations, 'materials.material_animations'),
        effects: dedupeById(allEffects, 'materials.effects'),
        transitions: dedupeById(allTransitions, 'materials.transitions'),
        video_effects: dedupeById(allVideoEffects, 'materials.video_effects'),
        canvases: dedupeById(allCanvases, 'materials.canvases'),
        material_colors: dedupeById(allMaterialColors, 'materials.material_colors'),
        speeds: dedupeById(allSpeeds, 'materials.speeds'),
        sound_channel_mappings: dedupeById(allChannels, 'materials.sound_channel_mappings'),
        loudnesses: dedupeById(allLoudness, 'materials.loudnesses'),
        vocal_separations: dedupeById(allVocalSeps, 'materials.vocal_separations'),
        placeholder_infos: dedupeById(allPlaceholderInfos, 'materials.placeholder_infos'),
    }

    const existingMaterialIds = new Set<string>()
    for (const arr of Object.values(normalizedMaterialArrays)) {
        for (const m of arr) {
            const id = m?.id
            if (id) existingMaterialIds.add(String(id).toLowerCase())
        }
    }

    let droppedRefs = 0
    for (const track of allTracks) {
        for (const seg of (track.segments || [])) {
            const refs: any[] = Array.isArray(seg.extra_material_refs) ? seg.extra_material_refs : []
            const seen = new Set<string>()
            const filtered: any[] = []
            for (const ref of refs) {
                const key = String(ref || '').toLowerCase()
                if (!key || seen.has(key)) continue
                seen.add(key)
                if (existingMaterialIds.has(key)) {
                    filtered.push(ref)
                } else {
                    droppedRefs += 1
                }
            }
            seg.extra_material_refs = filtered
        }
    }
    if (droppedRefs > 0) {
        console.warn(`[CapCut] ⚠️ Đã loại ${droppedRefs} extra_material_refs không tồn tại trong materials`)
    }

    const result = await invoke<{ project_path: string; project_name: string }>('create_capcut_draft', {
        projectName: config.projectName,
        targetDraftPath: config.targetDraftPath || null,
        draftData: JSON.stringify({
            tracks: allTracks,
            duration: totalDurationUs,
            materials: {
                videos: normalizedMaterialArrays.videos,
                audios: normalizedMaterialArrays.audios,
                texts: normalizedMaterialArrays.texts,
                speeds: normalizedMaterialArrays.speeds,
                sound_channel_mappings: normalizedMaterialArrays.sound_channel_mappings,
                loudnesses: normalizedMaterialArrays.loudnesses,
                vocal_separations: normalizedMaterialArrays.vocal_separations,
                transitions: normalizedMaterialArrays.transitions,
                video_effects: normalizedMaterialArrays.video_effects,
                text_templates: normalizedMaterialArrays.text_templates,
                material_animations: normalizedMaterialArrays.material_animations,
                effects: normalizedMaterialArrays.effects,
                canvases: normalizedMaterialArrays.canvases,
                material_colors: normalizedMaterialArrays.material_colors,
                placeholder_infos: normalizedMaterialArrays.placeholder_infos,
            },
            canvas_config: {
                ratio: 'original',
                width: config.width,
                height: config.height,
            },
        }),
        // Meta materials cho draft_meta_info.json
        metaMaterials: JSON.stringify([
            ...allVideoMats.map(m => ({ id: m.id, file_Path: m.path, metetype: 'video', duration: m.duration })),
            ...allAudioMats.map(m => ({ id: m.id, file_Path: m.path, metetype: 'music', duration: m.duration })),
        ]),
        totalDuration: totalDurationUs,
    })

    console.log(`[CapCut] ✅ Project tạo thành công tại: ${result.project_path}`)

    return {
        // Dùng tên backend trả về:
        // - Create mode: là tên draft mới.
        // - Overwrite mode: là tên draft nguồn thực tế đang bị ghi đè.
        projectName: result.project_name,
        projectPath: result.project_path,
    }
}
