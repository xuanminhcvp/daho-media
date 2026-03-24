// template-assignment-service.ts
// Service AI phân tích kịch bản và gán Template hiệu ứng chữ cho từng câu
// Mỗi câu trong kịch bản sẽ được AI chọn 1 trong 5 Template phù hợp nhất
// dựa trên ngữ cảnh, cảm xúc, và mục đích truyền tải

import { readTextFile, exists } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { MatchingSentence } from "@/services/audio-director-service";
// Import types vào scope nội bộ file để dùng trong function signatures
import type { TextTemplate, TitleCue, AITitleCueResult } from "@/types/title-types";
// Re-export để các component vẫn import được từ service như cũ
export type { TextTemplate, TitleCue, AITitleCueResult } from "@/types/title-types";

// ======================== CẤU HÌNH ========================

// Cấu hình AI local (OpenAI-compatible API)
const LOCAL_AI_CONFIG = {
    baseUrl: "https://ezaiapi.com/v1",
    apiKey: "sk-570848c49fda787c748cd58f3a21a1d95f00afd87a5cba6e",
    model: "claude-sonnet-4-6",
    timeoutMs: 300000, // 5 phút
};

const MATCHING_CACHE_FILE = "autosubs_matching.json";

// ======================== TYPES ========================
// TextTemplate, TitleCue, AITitleCueResult đã được re-export từ @/types/title-types ở trên (dòng 11)
// Dùng trực tiếp trong file này mà không cần import lại

/**
 * Kết quả AI gán template cho 1 câu cụ thể
 */
export interface TemplateAssignment {
    /** Số câu trong kịch bản (num từ matching.json) */
    sentenceNum: number;
    /** ID template được chọn ("template_1" ... "template_5") */
    templateId: string;
    /** Lý do AI chọn template này cho câu đó */
    reason: string;
    /** Text rút gọn hiển thị trên màn hình (VD: "$50 BILLION", "FEBRUARY 22, 2026") */
    displayText: string;
    /** Từ gốc narrator nói — dùng để khớp với whisper words timestamps
     *  VD: câu gốc nói "fifty billion dollars" → matchWords = "fifty billion dollars"
     *  Hệ thống sẽ tìm các từ này trong whisper words để lấy start/end chính xác */
    matchWords: string;
}

/**
 * Kết quả tổng thể từ AI Template Assignment
 */
export interface AITemplateAssignmentResult {
    /** Danh sách gán template cho từng câu */
    assignments: TemplateAssignment[];
    /** Thời gian phân tích */
    analyzedAt: string;
}

// ======================== DEFAULT TEMPLATES ========================

/**
 * 10 Template mặc định — Map 1:1 với Fusion Compositions trong Power Bin
 * Quy tắc tên: [màu] [size] [animation]
 * - Màu: xanh (blue/teal), vàng (yellow/gold), đỏ (red)
 * - Size: to (large full-screen), nhỏ (small lower-third)
 * - Animation: xuất hiện (appear/fade), đập xuống (slam down), đánh máy (typewriter)
 */
export const DEFAULT_TEMPLATES: TextTemplate[] = [
    {
        id: "template_1",
        // 🔵 Xanh to xuất hiện — Chapter, Location lớn, chuyển cảnh
        displayName: "Xanh To Xuất Hiện",
        description: "Text xanh lớn, fade-in mượt — cho chuyển cảnh, chapter, location quan trọng",
        usageRule: "Dùng khi chuyển chapter lớn, mở đầu phần mới, hoặc giới thiệu location quan trọng một cách nhẹ nhàng",
        enabled: true,
        badgeColor: "#06b6d4", // cyan
        resolveTemplateName: "xanh to xuất hiện",
        sfxName: "Click.mp3",
    },
    {
        id: "template_2",
        // 🔵 Xanh to đập xuống — Chapter SLAM, reveal bất ngờ
        displayName: "Xanh To Đập Xuống",
        description: "Text xanh lớn, SLAM xuống mạnh — cho reveal, twist, chapter impact",
        usageRule: "Dùng khi có plot twist, reveal quan trọng, chapter mở đầu drama, hoặc cần impact mạnh cho chuyển cảnh",
        enabled: true,
        badgeColor: "#0891b2", // teal
        resolveTemplateName: "xanh to đập xuống",
        sfxName: "Cinematic Hit 3.mp3",
    },
    {
        id: "template_3",
        // 🔵 Xanh nhỏ xuất hiện — Location nhỏ, thời gian, địa điểm
        displayName: "Xanh Nhỏ Xuất Hiện",
        description: "Text xanh nhỏ, fade-in nhẹ — location card, thời gian, địa điểm cụ thể",
        usageRule: "Dùng cho địa điểm + thời gian cụ thể (VD: 'GUADALAJARA — 2003', 'FEBRUARY 22, 2026'), chuyển cảnh sang location mới",
        enabled: true,
        badgeColor: "#67e8f9", // light cyan
        resolveTemplateName: "Xanh nhỏ xuất hiện",
        sfxName: "Click.mp3",
    },
    {
        id: "template_4",
        // 🔵 Xanh nhỏ đánh máy — Document, pháp lý, hồ sơ
        displayName: "Xanh Nhỏ Đánh Máy",
        description: "Text xanh nhỏ, hiệu ứng đánh máy — hồ sơ, pháp lý, tài liệu chính thức",
        usageRule: "Dùng cho văn bản pháp lý, phán quyết tòa, lệnh bắt giữ, thông tin tình báo, hồ sơ mật — kiểu typewriter tạo cảm giác tài liệu chính thức",
        enabled: true,
        badgeColor: "#22d3ee", // cyan light
        resolveTemplateName: "Xanh nhỏ đánh máy",
        sfxName: "ComputerDesktop 6103_69_4.WAV",
    },
    {
        id: "template_5",
        // 🟡 Vàng to xuất hiện — Main title, emphasis lớn, khai mở
        displayName: "Vàng To Xuất Hiện",
        description: "Text vàng gold lớn, fade-in trang trọng — main title, câu emphasis lớn",
        usageRule: "Dùng cho main title video (1 lần duy nhất ở đầu), hoặc câu emphasis trang trọng cần hiện full screen",
        enabled: true,
        badgeColor: "#f59e0b", // amber
        resolveTemplateName: "vàng to xuất hiện",
        sfxName: "Click.mp3",
    },
    {
        id: "template_6",
        // 🟡 Vàng to đập xuống — Fact/stat impact, số liệu gây sốc
        displayName: "Vàng To Đập Xuống",
        description: "Text vàng gold lớn, SLAM xuống — số liệu kinh tế gây sốc, fact card impact",
        usageRule: "Dùng khi câu chứa số liệu gây sốc ($50 BILLION, 90% OF COCAINE, 40+ COUNTRIES), con số lớn cần impact mạnh",
        enabled: true,
        badgeColor: "#d97706", // dark amber
        resolveTemplateName: "vàng to đập xuống",
        sfxName: "Cinematic Hit 3.mp3",
    },
    {
        id: "template_7",
        // 🟡 Vàng nhỏ xuất hiện — Quote, motif, câu kết nhẹ nhàng
        displayName: "Vàng Nhỏ Xuất Hiện",
        description: "Text vàng nhỏ, fade-in — trích dẫn, quote, câu nhận định có sức nặng",
        usageRule: "Dùng cho trích dẫn trực tiếp (có dấu ngoặc kép + nguồn), câu nhận định triết lý, câu kết chương nhẹ nhàng, motif lặp lại",
        enabled: true,
        badgeColor: "#fbbf24", // yellow
        resolveTemplateName: "Vàng nhỏ xuất hiện",
        sfxName: "Click.mp3",
    },
    {
        id: "template_8",
        // 🟡 Vàng nhỏ đánh máy — ID card, thông tin, giới thiệu nhân vật
        displayName: "Vàng Nhỏ Đánh Máy",
        description: "Text vàng nhỏ, hiệu ứng đánh máy — giới thiệu danh tính, lower third",
        usageRule: "Dùng khi giới thiệu tên người + chức danh lần đầu (VD: 'NEMESIO OSEGUERA CERVANTES — CJNG Cartel Leader'), thông tin nhân vật mới",
        enabled: true,
        badgeColor: "#fde68a", // light yellow
        resolveTemplateName: "Vàng nhỏ đánh máy",
        sfxName: "ComputerDesktop 6103_69_4.WAV",
    },
    {
        id: "template_9",
        // 🔴 Đỏ to xuất hiện — Death/violence cảnh báo, emphasis đỏ
        displayName: "Đỏ To Xuất Hiện",
        description: "Text đỏ lớn, fade-in — cảnh báo bạo lực, thiệt hại, emphasis đỏ nặng nề",
        usageRule: "Dùng khi câu đề cập bạo lực kéo dài, thảm họa, cảnh báo nguy hiểm — tone nặng nề, đau thương hơn là bất ngờ",
        enabled: true,
        badgeColor: "#ef4444", // red
        resolveTemplateName: "đỏ to xuất hiện",
        sfxName: "Click.mp3",
    },
    {
        id: "template_10",
        // 🔴 Đỏ to đập xuống — Death SLAM, bạo lực bất ngờ, impact đỏ
        displayName: "Đỏ To Đập Xuống",
        description: "Text đỏ lớn, SLAM xuống — số người chết, bạo lực bất ngờ, đòn tấn công",
        usageRule: "Dùng khi câu nêu số người chết cụ thể (9 DEAD, 15 OFFICERS KILLED), vũ khí, đòn tấn công bất ngờ, bạo lực impact mạnh",
        enabled: true,
        badgeColor: "#dc2626", // dark red
        resolveTemplateName: "đỏ to đập xuống",
        sfxName: "Cinematic Hit 3.mp3",
    },
];

// ======================== LƯU/ĐỌC CẤU HÌNH TEMPLATES ========================

// Version templates — tăng khi thay đổi cấu trúc DEFAULT_TEMPLATES
// v5: chuyển từ Title 1-8 sang 10 Fusion Compositions Power Bin
const TEMPLATES_CURRENT_VERSION = "5";

import { readSettings, saveSettings } from '@/services/auto-media-storage'

/**
 * Đọc danh sách templates đã lưu từ settings.json (hoặc trả về mặc định).
 * Nếu version không khớp, tự động reset về DEFAULT_TEMPLATES mới nhất.
 * ⚠️ ASYNC — khác với bản cũ (localStorage là sync)
 */
export async function loadTemplatesConfig(): Promise<TextTemplate[]> {
    try {
        const settings = await readSettings()

        // Kiểm tra version — nếu cũ hơn thì dùng mặc định mới
        if (settings.templatesVersion !== TEMPLATES_CURRENT_VERSION) {
            // Version mới → xóa cache cũ, lưu version mới
            await saveSettings({ templates: undefined, templatesVersion: TEMPLATES_CURRENT_VERSION })
            return [...DEFAULT_TEMPLATES]
        }

        if (settings.templates && Array.isArray(settings.templates)) {
            return settings.templates
        }
    } catch (e) {
        console.warn('[TemplateAssignment] Lỗi đọc config:', e)
    }
    return [...DEFAULT_TEMPLATES]
}

/**
 * Lưu danh sách templates vào settings.json
 */
export async function saveTemplatesConfig(templates: TextTemplate[]): Promise<void> {
    await saveSettings({ templates })
}

// ======================== GỌI AI PHÂN TÍCH ========================

/**
 * Gọi AI để phân tích kịch bản và gán Template hiệu ứng cho từng câu
 *
 * @param mediaFolder - Thư mục chứa autosubs_matching.json
 * @param sentences - Danh sách câu từ matching.json
 * @param templates - 5 template đã cấu hình
 * @param onProgress - Callback báo tiến trình
 */
export async function analyzeScriptForTemplateAssignment(
    mediaFolder: string,
    sentences: MatchingSentence[],
    templates: TextTemplate[],
    onProgress?: (msg: string) => void
): Promise<AITemplateAssignmentResult> {
    const { callAIMultiProvider } = await import("@/utils/ai-provider");
    // Chỉ dùng template đang bật
    const enabledTemplates = templates.filter((t) => t.enabled);

    if (enabledTemplates.length === 0) {
        throw new Error("Chưa có template nào được bật. Hãy bật ít nhất 1 template.");
    }

    // Tạo mô tả template cho AI
    const templateDescriptions = enabledTemplates
        .map(
            (t, i) =>
                `${i + 1}. ID: "${t.id}" — Tên: "${t.displayName}"\n   Mô tả: ${t.description}\n   Quy tắc: ${t.usageRule}`
        )
        .join("\n\n");

    // Tạo script text cho AI đọc
    const scriptText = sentences
        .map((s) => `[Câu ${s.num}] (${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s): ${s.text}`)
        .join("\n");

    onProgress?.("AI đang đọc kịch bản và gán hiệu ứng...");

    // ==== PROMPT ====
    const prompt = `Bạn là một Video Editor chuyên nghiệp sản xuất phim Tài liệu phong cách YouTube (Black Files, Veritasium, Johnny Harris).

Nhiệm vụ: Đọc kịch bản và XÁC ĐỊNH những câu nào CẦN HIỂN THỊ TEXT ON SCREEN, rồi gán đúng Template cho câu đó.

=== QUAN TRỌNG — ĐÂY KHÔNG PHẢI SUBTITLE ===
Đây là TEXT ON SCREEN kiểu phim tài liệu — xuất hiện ở khoảng ~18% số câu.
PHẦN LỚN câu kể chuyện KHÔNG có text on screen. Nhưng BẤT KỲ câu nào chứa mốc thời gian, địa điểm, hoặc số liệu đều PHẢI được chọn.

=== 4 LOẠI CÂU CẦN TEXT ON SCREEN ===

1. DOCUMENT / ID CARD — Khi câu GIỚI THIỆU DANH TÍNH CHÍNH THỨC hoặc VĂN BẢN PHÁP LÝ
   - Dấu hiệu: Tên người + chức danh lần đầu ("FBI agent John O'Neal", "El Mencho"), phán quyết tòa, lệnh bắt giữ
   - Thông tin hồ sơ mật, dữ liệu tình báo, văn kiện chính phủ

2. LOCATION / IMPACT — Khi câu nêu ĐỊA ĐIỂM, THỜI GIAN cụ thể, HOẶC SỐ LIỆU gây sốc
   ⚠️ BẮT BUỘC: KHÔNG ĐƯỢC BỎ QUA bất kỳ câu nào chứa mốc thời gian hoặc địa điểm cụ thể!
   - Dấu hiệu địa điểm: "Stockholm, 2006", "April 8th, 1989, Guadalajara", tên thành phố, quốc gia
   - Dấu hiệu thời gian (không cần kèm địa điểm): "February 22nd, 2026", "In 2003", "By 1995", "that same year", năm cụ thể
   - Dấu hiệu số liệu: số tiền ($15M, $50 billion), % thị phần (90% of cocaine), quy mô (40+ countries)
   - Chuyển cảnh sang địa điểm mới, mốc thời gian mới, hoặc con số quan trọng cần nhấn mạnh
   - Kể cả câu nói lại địa điểm/thời gian đã xuất hiện trước đó cũng PHẢI được chọn nếu nó đánh dấu một sự kiện mới

3. DEATH / VIOLENCE — Khi câu nêu SỐ NGƯỜI CHẾT / BẠO LỰC / THIỆT HẠI
   - Dấu hiệu: số người chết ("9 dead", "15 officers killed"), vũ khí cụ thể, đòn tấn công, thảm họa
   - Số người bị bắt, thiệt hại vật chất lớn trong bạo lực

4. QUOTE / MOTIF — Khi câu có TRÍCH DẪN TRỰC TIẾP đáng nhớ hoặc CÂU KẾT MANG THÔNG ĐIỆP
   - Dấu hiệu: dấu ngoặc kép + nguồn trích dẫn, câu nhận định triết lý sâu sắc
   - Câu kết chương/video biểu tượng, câu lặp đi lặp lại như leitmotif

5. BỎ QUA (không gán) — Câu kể chuyện bình thường, giải thích background, câu hỏi tu từ, CTA
   - Câu mô tả hành động liên tục, câu quảng cáo/sponsor, câu chuyển tiếp

=== DANH SÁCH TEMPLATE TƯƠNG ỨNG ===
${templateDescriptions}

=== KỊCH BẢN VIDEO (có đánh số câu & timecode) ===
${scriptText}

=== NHIỆM VỤ ===
1. Đọc TOÀN BỘ kịch bản để hiểu bối cảnh.
2. Xác định NHỮNG CÂU CẦN text on screen (theo 4 loại trên).
3. Với mỗi câu được chọn: gán đúng 1 templateId, viết lý do ngắn gọn (1 dòng tiếng Việt).
4. Mục tiêu: chọn khoảng 18% tổng số câu. Không quá ít (ít nhất 10 câu).
5. ⚠️ ƯU TIÊN TUYỆT ĐỐI: Mọi câu chứa mốc thời gian (năm, ngày tháng) hoặc địa điểm cụ thể (tên thành phố, quốc gia) PHẢI được chọn — KHÔNG BAO GIỜ bỏ qua.
6. Sau đó ưu tiên thêm: con số lớn, sự kiện, danh tính, cái chết.

Trả về ĐÚNG chuẩn JSON sau, KHÔNG giải thích gì thêm, KHÔNG dùng markdown:
{
  "assignments": [
    {
      "sentenceNum": 1,
      "templateId": "template_2",
      "displayText": "FEBRUARY 22, 2026",
      "matchWords": "February twenty second twenty twenty six",
      "reason": "Câu mở đầu nêu thời gian cụ thể — Location/Impact"
    },
    {
      "sentenceNum": 5,
      "templateId": "template_2",
      "displayText": "$30 BILLION",
      "matchWords": "thirty billion dollars",
      "reason": "Nêu con số $30 billion — Location/Impact"
    },
    {
      "sentenceNum": 19,
      "templateId": "template_1",
      "displayText": "NEMESIO OSEGUERA CERVANTES",
      "matchWords": "Nemesio Oseguera Cervantes",
      "reason": "Giới thiệu tên chính thức lần đầu — Document/ID Card"
    }
  ]
}

=== QUY TẮC displayText ===
- displayText là TEXT HIỂN THỊ TRÊN MÀN HÌNH — có thể là rút gọn HOẶC cả câu gốc
- Với số tiền: rút gọn dạng ký hiệu ($50 BILLION, $15M) — VIẾT HOA
- Với địa điểm: rút gọn tên địa điểm + năm (GUADALAJARA, 2003) — VIẾT HOA
- Với số chết/bạo lực: rút gọn ngắn gọn (15 OFFICERS KILLED, 9 DEAD) — VIẾT HOA
- Với tên người: rút gọn tên đầy đủ VIẾT HOA (NEMESIO OSEGUERA CERVANTES)
- Với trích dẫn (Quote/Motif): GIỮ NGUYÊN CẢ CÂU GỐC, có dấu ngoặc kép, không viết hoa
- Với câu ngắn đã đủ ý, GIỮ NGUYÊN CẢ CÂU, VIẾT HOA

=== QUY TẮC matchWords ===
- matchWords là CÁC TỪ GỐC mà narrator THỰC SỰ NÓI trong audio
- Phải là từ TIẾNG ANH đúng như trong kịch bản (không phải ký hiệu $)
- VD: displayText = "$50 BILLION" → matchWords = "fifty billion dollars"
- VD: displayText = "FEBRUARY 22, 2026" → matchWords = "February twenty second twenty twenty six"
- VD: displayText = "NEMESIO OSEGUERA CERVANTES" → matchWords = "Nemesio Oseguera Cervantes"
- VD: displayText = '"It is a corporate merger."' → matchWords = "It is a corporate merger"
- matchWords dùng để tìm vị trí chính xác trong audio, nên PHẢI khớp với từ narrator nói`;

    try {
        // Round-robin Claude/Gemini
        const content = await callAIMultiProvider(
            prompt,
            `AI Template Assignment: ${sentences.length} câu → ${enabledTemplates.length} templates`,
            "auto",
            LOCAL_AI_CONFIG.timeoutMs
        );

        // Clean markdown block nếu có
        const cleaned = content.replace(/```(?:json)?\s*([\s\S]*?)```/, "$1");

        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error("AI Template Assignment không trả về JSON hợp lệ");
        }
        const parsed = JSON.parse(jsonMatch[0]);

        // Validate: chỉ giữ lại assignment có templateId hợp lệ
        const validTemplateIds = new Set(templates.map((t) => t.id));
        const assignments: TemplateAssignment[] = (
            Array.isArray(parsed.assignments) ? parsed.assignments : []
        ).filter((a: any) => validTemplateIds.has(a.templateId));

        const result: AITemplateAssignmentResult = {
            assignments,
            analyzedAt: new Date().toISOString(),
        };

        // Cache kết quả vào file matching.json
        const filePath = await join(mediaFolder, MATCHING_CACHE_FILE);
        if (await exists(filePath)) {
            onProgress?.("Đang lưu cache AI Template Assignment...");
            const currentContent = await readTextFile(filePath);
            const currentJson = JSON.parse(currentContent);
            currentJson.templateAssignmentResult = result;
            const { writeTextFile } = await import("@tauri-apps/plugin-fs");
            await writeTextFile(filePath, JSON.stringify(currentJson, null, 2));
        }

        return result;
    } catch (error) {
        throw error;
    }
}

// Số batch mặc định — chạy song song để nhanh
const TITLE_BATCH_COUNT = 5
// Số từ overlap giữa các batch liền kề — tránh mất cue ở ranh giới
const TITLE_BATCH_OVERLAP = 100
// Số lần retry nếu batch lỗi
const TITLE_RETRY_COUNT = 2

/**
 * Chia whisper words text thành N batches đều nhau theo timestamp.
 * Mỗi batch có overlap từ ở đầu/cuối để AI không bỏ sót cue ở ranh giới.
 * Cắt ở ranh giới timestamp [xx.xx] để không bị cắt giữa từ.
 */
function splitWhisperIntoBatches(
    whisperText: string,
    batchCount: number,
    overlapWords: number
): { text: string; batchIndex: number }[] {
    // Tách thành tokens (mỗi token là [time] hoặc word)
    const tokens = whisperText.split(/\s+/)
    if (tokens.length === 0) return [{ text: whisperText, batchIndex: 0 }]

    // Đếm số từ thật (không phải timestamp)
    const realWords = tokens.filter(t => !t.match(/^\[\d+\.?\d*\]$/))
    const totalRealWords = realWords.length
    const wordsPerBatch = Math.ceil(totalRealWords / batchCount)

    if (totalRealWords <= wordsPerBatch) {
        // Quá ít từ → không cần chia
        return [{ text: whisperText, batchIndex: 0 }]
    }

    // Tìm vị trí cắt theo số từ thật
    const batches: { text: string; batchIndex: number }[] = []
    let tokenIdx = 0

    for (let b = 0; b < batchCount; b++) {
        const startTokenIdx = tokenIdx
        // Lùi lại overlap tokens cho batch sau batch đầu
        const overlapStart = b > 0 ? Math.max(0, findOverlapStartIndex(tokens, startTokenIdx, overlapWords)) : startTokenIdx

        // Đếm wordsPerBatch từ thật từ vị trí hiện tại
        let batchEndTokenIdx = startTokenIdx
        let batchWordCount = 0
        for (let i = startTokenIdx; i < tokens.length; i++) {
            batchEndTokenIdx = i + 1
            if (!tokens[i].match(/^\[\d+\.?\d*\]$/)) {
                batchWordCount++
            }
            if (batchWordCount >= wordsPerBatch && b < batchCount - 1) {
                // Cắt ở timestamp tiếp theo cho sạch
                for (let j = i + 1; j < tokens.length; j++) {
                    if (tokens[j].match(/^\[\d+\.?\d*\]$/)) {
                        batchEndTokenIdx = j
                        break
                    }
                }
                break
            }
        }

        // Thêm overlap cuối cho batch (trừ batch cuối)
        let endWithOverlap = batchEndTokenIdx
        if (b < batchCount - 1) {
            let overlapCount = 0
            for (let i = batchEndTokenIdx; i < tokens.length && overlapCount < overlapWords; i++) {
                endWithOverlap = i + 1
                if (!tokens[i].match(/^\[\d+\.?\d*\]$/)) overlapCount++
            }
        }

        const batchTokens = tokens.slice(overlapStart, endWithOverlap)
        if (batchTokens.length > 0) {
            batches.push({ text: batchTokens.join(" "), batchIndex: b })
        }

        // Di chuyển con trỏ tới vị trí cắt (không overlap)
        tokenIdx = batchEndTokenIdx
        if (tokenIdx >= tokens.length) break
    }

    return batches
}

/** Tìm vị trí bắt đầu overlap — lùi lại N từ thật từ vị trí hiện tại */
function findOverlapStartIndex(tokens: string[], fromIdx: number, overlapWords: number): number {
    let count = 0
    for (let i = fromIdx - 1; i >= 0; i--) {
        if (!tokens[i].match(/^\[\d+\.?\d*\]$/)) count++
        if (count >= overlapWords) {
            // Tìm timestamp gần nhất phía trước để cắt sạch
            for (let j = i; j >= 0; j--) {
                if (tokens[j].match(/^\[\d+\.?\d*\]$/)) return j
            }
            return i
        }
    }
    return 0
}

/**
 * Gọi AI phân tích Master SRT / Whisper Words để tìm Title Cues
 * V4: 5 batch song song, retry, overlap ranh giới, dedup, 20-25%
 *
 * @param whisperWordsText - "[time] word [time] word ..." (từ Master SRT hoặc Whisper thô)
 * @param templates - Danh sách template đang dùng
 * @param scriptText - Kịch bản gốc (optional) để AI so khớp text chính xác
 * @param onProgress - Callback tiến trình
 */
export async function analyzeWhisperWordsForTitles(
    whisperWordsText: string,
    templates: TextTemplate[],
    scriptText?: string,
    onProgress?: (msg: string) => void
): Promise<AITitleCueResult> {
    const { callAIMultiProvider } = await import("@/utils/ai-provider")
    const { buildTitleFromWhisperPrompt } = await import("@/prompts/title-assignment-prompt")

    const enabledTemplates = templates.filter(t => t.enabled)
    if (enabledTemplates.length === 0) {
        throw new Error("Chưa có template nào được bật.")
    }

    // ═══ CHIA BATCH (5 batch, overlap 100 từ) ═══
    const batches = splitWhisperIntoBatches(whisperWordsText, TITLE_BATCH_COUNT, TITLE_BATCH_OVERLAP)
    onProgress?.(`Chia transcript → ${batches.length} batch (overlap ${TITLE_BATCH_OVERLAP} từ)`)
    console.log(`[AddTitle] ${batches.length} batches, overlap ${TITLE_BATCH_OVERLAP}`)

    const validTemplateIds = new Set(templates.map(t => t.id))

    // ═══ TẠO TASKS SONG SONG ═══
    const batchTasks = batches.map((batch) => async (): Promise<TitleCue[]> => {
        const batchLabel = `batch ${batch.batchIndex + 1}/${batches.length}`

        // Build prompt — truyền kịch bản gốc nếu có
        const prompt = buildTitleFromWhisperPrompt(batch.text, enabledTemplates, scriptText)

        // Retry logic
        for (let attempt = 0; attempt <= TITLE_RETRY_COUNT; attempt++) {
            try {
                if (attempt > 0) {
                    console.log(`[AddTitle] ${batchLabel} retry #${attempt}`)
                    onProgress?.(`🔄 Retry ${batchLabel} (lần ${attempt + 1})...`)
                }

                const content = await callAIMultiProvider(
                    prompt,
                    `AI Title ${batchLabel} (${enabledTemplates.length} templates)`,
                    "auto",
                    LOCAL_AI_CONFIG.timeoutMs
                )

                // Parse response
                const cleaned = content.replace(/```(?:json)?\s*([\s\S]*?)```/, "$1")
                
                // Parse an toàn: tìm '[' hoặc '{' đầu tiên để lấy Array hoặc Object
                const firstBrace = cleaned.indexOf('{')
                const firstBracket = cleaned.indexOf('[')
                const lastBrace = cleaned.lastIndexOf('}')
                const lastBracket = cleaned.lastIndexOf(']')

                let jsonObjString = ''
                // Ưu tiên theo first index hợp lệ (không phải -1) và nhỏ hơn
                const isArrayFirst = firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)

                if (isArrayFirst && lastBracket !== -1 && lastBracket >= firstBracket) {
                    jsonObjString = cleaned.slice(firstBracket, lastBracket + 1)
                } else if (!isArrayFirst && firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
                    jsonObjString = cleaned.slice(firstBrace, lastBrace + 1)
                } else {
                    console.error(`[AddTitle] ❌ AI không trả về Array hoặc Object:`, cleaned.substring(0, 100))
                    throw new Error(`AI không trả về JSON hợp lệ — response ${content.length} chars`)
                }
                
                let parsed: any;
                try {
                    parsed = JSON.parse(jsonObjString)
                } catch (e) {
                    console.error(`[AddTitle] ❌ Lỗi parse JSON raw string:`, jsonObjString.substring(0, 100) + '...')
                    throw new Error(`JSON Parse error: ${e}`)
                }

                // AI có thể trả về Array trực tiếp [...] hoặc Object { titles: [...] }
                let rawTitles = []
                if (Array.isArray(parsed)) {
                    rawTitles = parsed
                } else if (parsed && Array.isArray(parsed.titles)) {
                    rawTitles = parsed.titles
                }

                // Lọc cue hợp lệ
                const batchCues: TitleCue[] = rawTitles
                    .filter((c: any) =>
                        validTemplateIds.has(c.templateId) &&
                        typeof c.start === "number" &&
                        typeof c.end === "number" &&
                        typeof c.displayText === "string" &&
                        c.displayText.trim().length > 0
                    )
                    .map((c: any) => ({
                        templateId: c.templateId,
                        displayText: c.displayText.trim(),
                        start: Math.max(0, c.start),
                        end: Math.max(c.start + 0.1, c.end),
                        reason: c.reason || "",
                    }))

                console.log(`[AddTitle] ✅ ${batchLabel}: ${batchCues.length} cues`)
                return batchCues

            } catch (err) {
                console.error(`[AddTitle] ❌ ${batchLabel} attempt ${attempt}:`, err)
                if (attempt >= TITLE_RETRY_COUNT) {
                    // Hết retry → trả về mảng rỗng cho batch này
                    onProgress?.(`⚠ ${batchLabel} lỗi sau ${TITLE_RETRY_COUNT + 1} lần thử`)
                    return []
                }
                // Đợi 2 giây trước khi retry
                await new Promise(r => setTimeout(r, 2000))
            }
        }
        return [] // fallback — không bao giờ đến đây
    })

    // ═══ CHẠY SONG SONG 5 BATCH ═══
    onProgress?.(`Gửi ${batches.length} batch song song...`)
    let completedCount = 0
    const results = await Promise.all(
        batchTasks.map(async (task, idx) => {
            const cues = await task()
            completedCount++
            onProgress?.(`✓ ${completedCount}/${batches.length} batch xong (batch ${idx + 1}: ${cues.length} cues)`)
            return cues
        })
    )

    // ═══ GOM + DEDUP OVERLAP ═══
    const allCues = results.flat()

    // Loại bỏ duplicate — cue ở vùng overlap sẽ trùng start time (±1 giây)
    // Giữ cue có displayText dài hơn (chất lượng tốt hơn)
    allCues.sort((a, b) => a.start - b.start)
    const uniqueCues: TitleCue[] = []
    for (const cue of allCues) {
        const existing = uniqueCues.find(c => Math.abs(c.start - cue.start) < 1.0)
        if (!existing) {
            uniqueCues.push(cue)
        } else if (cue.displayText.length > existing.displayText.length) {
            // Thay thế bằng cue có displayText tốt hơn
            const idx = uniqueCues.indexOf(existing)
            uniqueCues[idx] = cue
        }
    }

    onProgress?.(`✅ Tổng cộng ${uniqueCues.length} Title cues (dedup từ ${allCues.length})`)
    console.log(`[AddTitle] Final: ${uniqueCues.length} unique cues (raw: ${allCues.length})`)

    return {
        cues: uniqueCues,
        analyzedAt: new Date().toISOString(),
    }
}

