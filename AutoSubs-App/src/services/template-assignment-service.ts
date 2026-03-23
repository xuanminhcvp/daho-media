// template-assignment-service.ts
// Service AI phân tích kịch bản và gán Template hiệu ứng chữ cho từng câu
// Mỗi câu trong kịch bản sẽ được AI chọn 1 trong 5 Template phù hợp nhất
// dựa trên ngữ cảnh, cảm xúc, và mục đích truyền tải

import { readTextFile, exists } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { MatchingSentence } from "@/services/audio-director-service";

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

/**
 * Định nghĩa 1 Template hiệu ứng chữ
 * Người dùng sẽ cấu hình tối đa 5 template với tên + mô tả + quy tắc sử dụng
 */
export interface TextTemplate {
    /** ID duy nhất: "template_1" đến "template_5" */
    id: string;
    /** Tên hiển thị (do user đặt): "Title 1 Glow", "Typewriter", v.v. */
    displayName: string;
    /** Mô tả ngắn cho AI hiểu template này trông như thế nào */
    description: string;
    /** Quy tắc sử dụng: khi nào nên dùng template này */
    usageRule: string;
    /** Có bật/sử dụng template này không */
    enabled: boolean;
    /** Màu nhận diện trên giao diện (hex color) */
    badgeColor: string;
    /** Tên template THỰC TẾ trong DaVinci Resolve Media Pool
     *  User chọn từ dropdown — đây là tên mà Lua sẽ tìm trong Media Pool
     *  Nếu rỗng → fallback về "Default Template" */
    resolveTemplateName: string;
}

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
 * 4 Template mặc định — Map 1:1 với 4 Title .setting trong DaVinci
 */
export const DEFAULT_TEMPLATES: TextTemplate[] = [
    {
        id: "template_1",
        // 🪪 Hồ sơ, danh tính, pháp lý → Title 1 (Trajan Pro 3 vàng gold fade)
        displayName: "Document / ID Card",
        description: "Text vàng gold Serif, fade-in chậm — phong cách hồ sơ trang trọng",
        usageRule: "Dùng khi giới thiệu tên người + chức danh chính thức lần đầu (FBI agent, cartel leader), trích dẫn phán quyết tòa án, lệnh bắt giữ, văn bản pháp lý, hoặc thông tin tình báo mật",
        enabled: true,
        badgeColor: "#06b6d4", // cyan
        resolveTemplateName: "Title 1",
    },
    {
        id: "template_2",
        // 📍💰 Địa điểm + Số liệu Impact → Title 2 (vàng SLAM)
        displayName: "Location / Impact",
        description: "Text vàng lớn, SLAM animation — hiện địa điểm, mốc thời gian, hoặc số liệu gây ấn tượng",
        usageRule: "Dùng khi: (1) kịch bản nêu địa điểm + thời gian cụ thể lần đầu (vd: 'Stockholm, 2006', 'February 22nd, 2026'), chuyển cảnh sang địa điểm mới; HOẶC (2) câu chứa số tiền ($15M, $50B), số thống kê lớn (40+ countries, 90% of cocaine), quy mô đế chế, con số quan trọng cần nhấn mạnh",
        enabled: true,
        badgeColor: "#f59e0b", // gold/amber
        resolveTemplateName: "Title 2",
    },
    {
        id: "template_3",
        // 💀 Bạo lực, chết chóc, cảnh báo → Title 3 (đỏ crimson SLAM)
        displayName: "Death / Violence",
        description: "Text đỏ crimson lớn, SLAM animation — cảnh báo nguy hiểm",
        usageRule: "Dùng khi câu đề cập đến số người chết, thiệt hại bạo lực (9 dead, 15 officers killed, 252 blockades), vũ khí cụ thể được nêu tên, đòn tấn công hoặc thảm họa",
        enabled: true,
        badgeColor: "#ef4444", // red
        resolveTemplateName: "Title 3",
    },
    {
        id: "template_4",
        // 💬 Trích dẫn, câu kết biểu tượng → Title 4 (Georgia Italic trắng xanh lạnh)
        displayName: "Quote / Motif",
        description: "Text trắng xanh lạnh Serif Italic, flash nhanh — trích dẫn hoặc câu kết có sức nặng",
        usageRule: "Dùng khi câu có trích dẫn trực tiếp đáng nhớ (có dấu ngoặc kép + nguồn), câu nhận định triết lý/khái quát có sức nặng, câu biểu tượng lặp đi lặp lại trong video, hoặc câu kết chương/video mang thông điệp chính",
        enabled: true,
        badgeColor: "#8b5cf6", // violet
        resolveTemplateName: "Title 4",
    },
    {
        id: "template_5",
        // 🎬 Main Title / Opening Title — Tên video chính, full screen cảnh đầu
        displayName: "Main Title",
        description: "Text trắng lớn Serif Bold, animation nổi bật full screen — dành cho tên video/đề phùng",
        usageRule: "Dùng duy nhất 1 lần ở đầu video: câu đầu tiên narrator nói đẹn đạt tên phùng hoặc concept tổng quan của phùng (VD: 'This is the story of the most powerful cartel in history'), câu giới thiệu chủ đề chính của tòan bộ video.",
        enabled: true,
        badgeColor: "#ffffff", // white
        resolveTemplateName: "Title 5",
    },
    {
        id: "template_6",
        // 🗂️ Chapter Title / Scene Title — Tiêu đề chương, chuyển cảnh lớn
        displayName: "Chapter / Scene",
        description: "Text lớn full/half screen có line divider — đánh dấu chuyển chương hoặc plot twist",
        usageRule: "Dùng khi narrative rõ ràng chuyển sang giai đoạn mới: câu đầu của một chương ('Part 1: The Rise'), câu báo hiệu nhảy timeline ('6 months later', '3 days before', 'Meanwhile in'), plot twist lớn làm thầy đổi câu chuyện, hoặc câu đảo ngược bất ngờ (reveals)",
        enabled: true,
        badgeColor: "#10b981", // emerald
        resolveTemplateName: "Title 6",
    },
    {
        id: "template_7",
        // 🏷️ Fact / Stat Card — Số liệu, thống kê, sự kiện chì a khóa
        displayName: "Fact / Stat Card",
        description: "Card nền đậm + chữ to highlight — số liệu kinh tế, thống kê, sự kiện chìa khóa",
        usageRule: "Dùng khi câu chứa số liệu kinh tế (doanh thu, lợi nhuận), thống kê quan trọng (số lượng, tỷ lệ phần trăm, quốc gia, năm hoạt động), hoặc sự kiện lịch sử quan trọng không phải bạo lực cần được highlight riêng (khác với template_2 — template này focus vào sự kiện/fact, không phải địa điểm hay mốc thời gian)",
        enabled: true,
        badgeColor: "#f97316", // orange
        resolveTemplateName: "Title 7",
    },
    {
        id: "template_8",
        // 🔥 Emphasis / Key Text — Câu nhấn mạnh, text nổi bật
        displayName: "Emphasis / Key Text",
        description: "Text lớn nổi bật giữa màn hình, highlight câu quan trọng nhất của cả đoạn",
        usageRule: "Dùng khi câu là đỉnh điểm cảm xúc của đoạn: câu mà nếu cắt ra khỏi video vẫn hiểu được thông điệp chính nất, câu nhấn mạnh sự thật đau lòng / đột phá / khải tượng, hoặc câu mà được repeat nhiều trong video như một leitmotif. KHÔNG dùng cho câu kể chuyện bình thường.",
        enabled: true,
        badgeColor: "#ec4899", // pink
        resolveTemplateName: "Title 8",
    },
];

// ======================== LƯU/ĐỌC CẤU HÌNH TEMPLATES ========================

// Version templates — tăng khi thay đổi cấu trúc DEFAULT_TEMPLATES
// v4: thêm 4 template mới (Main Title, Chapter, Fact/Stat, Emphasis) → tổng 8 templates
const TEMPLATES_CURRENT_VERSION = "4";

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

// ======================== NEW: TITLE CUE TỪ WHISPER WORDS ========================

/**
 * 1 Title Cue được lấy trực tiếp từ Whisper Words (không cần matching.json)
 * AI đọc word timestamps → trả về start/end chính xác ngay
 */
export interface TitleCue {
    /** ID template: "template_1" ... "template_4" */
    templateId: string;
    /** Text hiển thị trên màn hình: "FEBRUARY 22, 2026" */
    displayText: string;
    /** Giây bắt đầu hiển thị — lấy từ timestamp từ đầu tiên */
    start: number;
    /** Giây kết thúc hiển thị — lấy từ timestamp từ cuối + 0.5s */
    end: number;
    /** Lý do AI chọn */
    reason: string;
}

/** Kết quả tổng thể từ phân tích Whisper Words */
export interface AITitleCueResult {
    cues: TitleCue[];
    analyzedAt: string;
}

/**
 * Gọi AI phân tích file Whisper Words để tìm Title Cues
 * Flow mới — không cần autosubs_matching.json, không bước matching riêng:
 *   whisperWordsText → AI đọc hiểu + lấy timing → TitleCue[]
 *
 * @param whisperWordsText - Nội dung file whisper words (format: "[0.13] February [0.77] twenty ...")
 * @param templates - Danh sách template đang dùng
 * @param onProgress - Callback tiến trình
 */
export async function analyzeWhisperWordsForTitles(
    whisperWordsText: string,
    templates: TextTemplate[],
    onProgress?: (msg: string) => void
): Promise<AITitleCueResult> {
    const { callAIMultiProvider } = await import("@/utils/ai-provider")
    const { buildTitleFromWhisperPrompt } = await import("@/prompts/title-assignment-prompt")

    const enabledTemplates = templates.filter(t => t.enabled)
    if (enabledTemplates.length === 0) {
        throw new Error("Chưa có template nào được bật.")
    }

    onProgress?.("AI đang đọc Whisper transcript và xác định Title cues...")

    // Build prompt — gửi toàn bộ whisper words text
    const prompt = buildTitleFromWhisperPrompt(whisperWordsText, enabledTemplates)

    const content = await callAIMultiProvider(
        prompt,
        `AI Title Assignment từ Whisper Words (${enabledTemplates.length} templates)`,
        "auto",
        LOCAL_AI_CONFIG.timeoutMs
    )

    // Parse response
    const cleaned = content.replace(/```(?:json)?\s*([\s\S]*?)```/, "$1")
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
        throw new Error("AI không trả về JSON hợp lệ")
    }

    const parsed = JSON.parse(jsonMatch[0])
    const validTemplateIds = new Set(templates.map(t => t.id))

    // Lọc cue hợp lệ: có templateId đúng, có start/end là số
    const cues: TitleCue[] = (Array.isArray(parsed.titles) ? parsed.titles : [])
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

    // Sort theo start time để hiển thị theo thứ tự
    cues.sort((a, b) => a.start - b.start)

    onProgress?.(`✅ Đã tìm được ${cues.length} Title cues`)

    return {
        cues,
        analyzedAt: new Date().toISOString(),
    }
}
