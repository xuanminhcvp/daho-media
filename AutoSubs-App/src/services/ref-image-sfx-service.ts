// ref-image-sfx-service.ts
// Tự động tìm SFX phù hợp trong folder sfx/ theo type của ảnh tham khảo
// Ánh xạ cứng: type ảnh → tên file SFX (không dùng AI, nhanh hơn)
//
// Cấu trúc SFX folder (~/Desktop/Auto_media/sfx/):
//   - shutter.wav / shutter.mp3   → portrait / document
//   - whoosh.wav / whoosh.mp3     → location / map / event
//   - impact.wav / impact.mp3     → evidence
//   - paper.wav / paper.mp3       → headline / document
//   - pin.wav / pin.mp3           → map / location

import { exists } from "@tauri-apps/plugin-fs"
import { join } from "@tauri-apps/api/path"
import { getSfxFolderPath } from "@/services/auto-media-storage"
import type { RefImageType } from "@/types/reference-image-types"

// ======================== MAP TYPE → KEYWORD ========================

/**
 * Ánh xạ từng loại ảnh → SFX
 * Hiện tại chỉ dùng 2 file: whoosh.wav và shutter.wav
 *   - portrait / document / headline → shutter (tiếng chụp ảnh, lật giấy)
 *   - evidence / event / location / map → whoosh (tiếng xuất hiện mạnh)
 */
const SFX_TYPE_MAP: Record<RefImageType, string[]> = {
    portrait:  ["shutter"],
    headline:  ["shutter"],
    document:  ["shutter"],
    evidence:  ["whoosh"],
    event:     ["whoosh"],
    location:  ["whoosh"],
    map:       ["whoosh"],
}

/** Phần mở rộng audio được hỗ trợ */
const AUDIO_EXTS = ["wav", "mp3", "aiff", "m4a", "flac"]

// ======================== FUNCTIONS ========================

/**
 * Tìm file SFX phù hợp nhất cho 1 type ảnh
 * Duyệt từng keyword → thử từng extension → trả về filepath đầu tiên tìm thấy
 * Trả về null nếu không tìm thấy
 */
export async function findSfxForImageType(imageType: RefImageType): Promise<string | null> {
    const sfxFolder = await getSfxFolderPath()
    const keywords = SFX_TYPE_MAP[imageType] || SFX_TYPE_MAP["event"]

    for (const keyword of keywords) {
        for (const ext of AUDIO_EXTS) {
            // Thử exact match: "shutter.wav"
            const filePath = await join(sfxFolder, `${keyword}.${ext}`)
            const fileExists = await exists(filePath)
            if (fileExists) {
                console.log(`[RefSFX] ✅ Found SFX for ${imageType}: ${keyword}.${ext}`)
                return filePath
            }
        }
    }

    console.log(`[RefSFX] ⚠️ Không tìm thấy SFX cho type: ${imageType}`)
    return null
}

/**
 * Build danh sách SFX clips để gửi cùng với import ref images
 * Mỗi slot ảnh đã gán → tìm SFX phù hợp → trả về {filePath, startTime}
 *
 * @param assignedSlots - Danh sách ảnh đã được gán, cần có type và startTime
 * @returns Danh sách SFX clips để import
 */
export async function buildSfxClipsForRefImages(
    assignedSlots: Array<{
        imageType: RefImageType;
        startTime: number;
    }>
): Promise<Array<{ filePath: string; startTime: number }>> {
    const result: Array<{ filePath: string; startTime: number }> = []

    for (const slot of assignedSlots) {
        const sfxPath = await findSfxForImageType(slot.imageType)
        if (sfxPath) {
            result.push({
                filePath: sfxPath,
                startTime: slot.startTime,
            })
        }
    }

    console.log(`[RefSFX] Built ${result.length} SFX clips cho ${assignedSlots.length} ảnh`)
    return result
}
