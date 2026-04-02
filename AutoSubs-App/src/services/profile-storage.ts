// profile-storage.ts
// Quản lý lưu trữ Profile mã hóa trên ổ cứng
//
// Cấu trúc file:
//   ~/Desktop/Auto_media/data/profiles/<id>.enc  ← file mã hóa AES-256
//
// Format nội dung (sau khi giải mã):
//   JSON của CustomProfile (xem interface bên dưới)
//
// Ưu tiên khi load prompt:
//   1. Custom profile (từ file .enc) nếu tồn tại
//   2. Compiled default (từ code TypeScript trong src/prompts/)

import { readTextFile, writeTextFile, exists, mkdir, remove, readDir } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";

import { encryptData, decryptData } from "@/services/profile-crypto";

// ======================== TYPES ========================

/** Cấu hình kỹ thuật của profile */
export interface ProfileConfig {
    MUSIC_BATCH_COUNT: number;
    SFX_BATCH_COUNT: number;
    MAX_SFX_CUES_PER_BATCH: number;
    RESOLUTION?: {
        width: number;
        height: number;
        useVertical: boolean;
    };
}

/** Tập hợp tất cả prompt của 1 profile */
export interface ProfilePrompts {
    /** Prompt ghép kịch bản với giọng đọc Whisper */
    match: string;
    /** Prompt chọn nhạc nền */
    audio: string;
    /** Prompt chọn SFX / âm thanh phụ */
    sfx: string;
    /** Prompt quét thư viện footage */
    footageScan: string;
    /** Prompt chọn footage phù hợp */
    footageMatch: string;
    /** Prompt chỉnh màu tự động */
    color?: string;
    /** Prompt căn nhịp điệu giọng đọc (tùy chọn) */
    voicePacing?: string;
    /** Prompt nhấn mạnh chữ (highlight text) */
    highlight?: string;
}

/** 1 Custom Profile đầy đủ — được lưu mã hóa vào file .enc */
export interface CustomProfile {
    id: string;               // "documentary", "tiktok", "edu_shorts"...
    label: string;            // Tên hiển thị: "Documentary", "TikTok / Shorts"...
    icon: string;             // Tên icon Lucide: "Film", "Smartphone", "BookOpen"...
    desc: string;             // Mô tả ngắn
    config: ProfileConfig;    // Cài đặt kỹ thuật
    prompts: ProfilePrompts;  // Nội dung các prompt
    createdAt: string;        // ISO date string
    updatedAt: string;
}

// ======================== CONSTANTS ========================
const PROFILES_SUBFOLDER = "profiles";                      // Subfolder trong Auto_media/data/

// ======================== ĐƯỜNG DẪN ========================

async function getProfilesDir(): Promise<string> {
    // Lấy path: ~/Desktop/Auto_media/data/profiles/
    const { getDataDir } = await import("@/services/auto-media-storage");
    const dataDir = await getDataDir();
    return join(dataDir, PROFILES_SUBFOLDER);
}

async function getProfileFilePath(profileId: string): Promise<string> {
    const dir = await getProfilesDir();
    return join(dir, `${profileId}.enc`);
}

// Đảm bảo thư mục profiles tồn tại
async function ensureProfilesDir(): Promise<void> {
    const dir = await getProfilesDir();
    if (!(await exists(dir))) {
        await mkdir(dir, { recursive: true });
    }
}

// ======================== LƯU / ĐỌC PROFILE ========================

/**
 * Lưu profile vào file mã hóa .enc
 * @param profile  - Dữ liệu profile đầy đủ
 * @param password - Mật khẩu để mã hóa
 */
export async function saveCustomProfile(profile: CustomProfile, password: string): Promise<void> {
    await ensureProfilesDir();
    const filePath = await getProfileFilePath(profile.id);

    // Cập nhật timestamp
    profile.updatedAt = new Date().toISOString();

    // Mã hóa toàn bộ profile thành chuỗi
    const json = JSON.stringify(profile, null, 2);
    const encrypted = await encryptData(json, password);

    await writeTextFile(filePath, encrypted);
    console.log(`[ProfileStorage] ✅ Đã lưu profile "${profile.id}" (mã hóa)`);
}

/**
 * Đọc và giải mã profile từ file .enc
 * Trả về null nếu mật khẩu sai hoặc file không tồn tại
 *
 * @param profileId - ID profile cần đọc
 * @param password  - Mật khẩu để giải mã
 */
export async function loadCustomProfile(profileId: string, password: string): Promise<CustomProfile | null> {
    try {
        const filePath = await getProfileFilePath(profileId);
        if (!(await exists(filePath))) return null;

        const encrypted = await readTextFile(filePath);
        const decrypted = await decryptData(encrypted, password);
        if (!decrypted) {
            console.warn(`[ProfileStorage] ⚠️ Giải mã "${profileId}" thất bại (sai mật khẩu?)`);
            return null;
        }

        return JSON.parse(decrypted) as CustomProfile;
    } catch (err) {
        console.error(`[ProfileStorage] ❌ Lỗi đọc profile "${profileId}":`, err);
        return null;
    }
}

/**
 * Xóa file .enc của profile (sau khi user xóa profile khỏi danh sách)
 * @param profileId - ID profile cần xóa
 */
export async function deleteCustomProfile(profileId: string): Promise<void> {
    const filePath = await getProfileFilePath(profileId);
    if (await exists(filePath)) {
        await remove(filePath);
        console.log(`[ProfileStorage] 🗑️ Đã xóa profile "${profileId}"`);
    }
}

/**
 * Liệt kê tất cả profile IDs đang có file .enc (chưa giải mã)
 * Dùng để hiển thị danh sách profiles trong UI
 */
export async function listCustomProfileIds(): Promise<string[]> {
    try {
        await ensureProfilesDir();
        const dir = await getProfilesDir();
        const entries = await readDir(dir);
        return entries
            .filter(e => e.name?.endsWith(".enc"))
            .map(e => e.name!.replace(".enc", ""));
    } catch {
        return [];
    }
}

export const BUILT_IN_PROFILES = [
    { id: "documentary", label: "Documentary", icon: "Film", desc: "Video dài, kịch tính, điều tra" },
    { id: "stories", label: "YouTube Stories", icon: "MonitorPlay", desc: "Video dài ngang, phong cách kể chuyện" },
    { id: "tiktok", label: "TikTok (Old)", icon: "Smartphone", desc: "Giữ lại bản cũ dự phòng" }
];

/**
 * Đọc tất cả profiles (Custom + Built-in)
 * Ưu tiên: File `.enc` custom đè lên bản Built-in nếu trùng ID.
 * @param password - Mật khẩu giải mã
 */
export async function loadAllCustomProfiles(password: string): Promise<CustomProfile[]> {
    const ids = await listCustomProfileIds();
    const results: CustomProfile[] = [];

    // 1. Tải tất cả Custom Profiles (từ file .enc)
    for (const id of ids) {
        const profile = await loadCustomProfile(id, password);
        if (profile) results.push(profile);
    }

    // 2. Thêm các Built-in profiles chưa có custom đè lên
    for (const bp of BUILT_IN_PROFILES) {
        if (!results.find(p => p.id === bp.id)) {
            // Tạo profile ảo từ default
            const p = createNewProfile(bp.id, bp.label);
            p.icon = bp.icon;
            p.desc = bp.desc;
            const defPrompts = await loadDefaultPrompts(bp.id);
            p.prompts = { ...p.prompts, ...defPrompts };
            results.push(p);
        }
    }

    return results;
}

// ======================== HELPER: TẠO PROFILE MỚI TỪ COMPILED DEFAULT ========================

import { buildMatchPrompt as docMatch } from "@/prompts/documentary/match-prompt";
import { buildDirectorPrompt as docDirector } from "@/prompts/documentary/audio-director-prompt";
import { buildSfxDirectorPrompt as docSfx } from "@/prompts/documentary/sfx-director-prompt";
import { buildFootageScanPrompt as docFootageScan } from "@/prompts/documentary/footage-scan-prompt";
import { buildFootageMatchPrompt as docFootageMatch } from "@/prompts/documentary/footage-match-prompt";
import { buildAutoColorPrompt as docAutoColor } from "@/prompts/documentary/auto-color-prompt";

import { buildMatchPrompt as storiesMatch } from "@/prompts/stories/match-prompt";
import { buildDirectorPrompt as storiesDirector } from "@/prompts/stories/audio-director-prompt";
import { buildSfxDirectorPrompt as storiesSfx } from "@/prompts/stories/sfx-director-prompt";
import { buildFootageScanPrompt as storiesFootageScan } from "@/prompts/stories/footage-scan-prompt";
import { buildFootageMatchPrompt as storiesFootageMatch } from "@/prompts/stories/footage-match-prompt";
import { buildVoicePacingPrompt as storiesVoicePacing } from "@/prompts/stories/voice-pacing-prompt";
import { buildHighlightTextPrompt as storiesHighlight } from "@/prompts/stories/highlight-text-prompt";

/**
 * Tải prompt mặc định từ code TypeScript để pre-fill khi tạo profile mới
 *
 * @param profileId - "documentary" | "stories"
 * @returns Partial prompts (chỉ các loại đã tồn tại trong code)
 */
export async function loadDefaultPrompts(profileId: string): Promise<Partial<ProfilePrompts>> {
    const prompts: Partial<ProfilePrompts> = {};

    if (profileId === "documentary") {
        try { prompts.match = docMatch([{ num: 1, text: "{{CAU_KICH_BAN_MAU}}" }], "{{DOAN_WHISPER_MAU}}", 1, 1, "{{THOI_GIAN}}"); } catch (e: any) { prompts.match = "Error match: " + e?.message }
        try { prompts.audio = docDirector([], []); } catch (e: any) { prompts.audio = "Error audio: " + e?.message }
        try { prompts.sfx = docSfx([]); } catch (e: any) { prompts.sfx = "Error sfx: " + e?.message }
        try { prompts.footageScan = docFootageScan(); } catch (e: any) { prompts.footageScan = "Error footageScan: " + e?.message }
        try { prompts.footageMatch = docFootageMatch("{{TOAN_BO_KICH_BAN}}", "[]", 60); } catch (e: any) { prompts.footageMatch = "Error footageMatch: " + e?.message }
        try { prompts.color = docAutoColor(); } catch (e: any) { prompts.color = "Error color: " + e?.message }
    } else if (profileId === "stories" || profileId === "tiktok") {
        try { prompts.match = storiesMatch([{ num: 1, text: "{{CAU_KICH_BAN_MAU}}" }], "{{DOAN_WHISPER_MAU}}", 1, 1, "{{THOI_GIAN}}"); } catch (e: any) { prompts.match = "Error match: " + e?.message }
        try { prompts.audio = storiesDirector([], []); } catch (e: any) { prompts.audio = "Error audio: " + e?.message }
        try { prompts.sfx = storiesSfx([]); } catch (e: any) { prompts.sfx = "Error sfx: " + e?.message }
        try { prompts.footageScan = storiesFootageScan(); } catch (e: any) { prompts.footageScan = "Error footageScan: " + e?.message }
        try { prompts.footageMatch = storiesFootageMatch("{{TOAN_BO_KICH_BAN}}", "[]", 60); } catch (e: any) { prompts.footageMatch = "Error footageMatch: " + e?.message }
        try { prompts.voicePacing = storiesVoicePacing("{{TOAN_BO_KICH_BAN}}"); } catch (e: any) { prompts.voicePacing = "Error voicePacing: " + e?.message }
        try { prompts.highlight = storiesHighlight([]); } catch (e: any) { prompts.highlight = "Error highlight: " + e?.message }
    }

    return prompts;
}

/**
 * Tạo CustomProfile mới với giá trị mặc định
 * @param id    - ID profile (chữ thường, dấu gạch dưới: "edu_shorts")
 * @param label - Tên hiển thị: "Edu Shorts"
 */
export function createNewProfile(id: string, label: string): CustomProfile {
    const now = new Date().toISOString();
    return {
        id,
        label,
        icon: "Film",
        desc: "",
        config: {
            MUSIC_BATCH_COUNT: 1,
            SFX_BATCH_COUNT: 1,
            MAX_SFX_CUES_PER_BATCH: 10,
            RESOLUTION: { width: 1920, height: 1080, useVertical: false },
        },
        prompts: {
            match: "",
            audio: "",
            sfx: "",
            footageScan: "",
            footageMatch: "",
            color: "",
        },
        createdAt: now,
        updatedAt: now,
    };
}
