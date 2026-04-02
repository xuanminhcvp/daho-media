// ============================================================
// ai-provider.ts — Multi-provider AI helper
//
// Phân tải request giữa Claude (ezaiapi) và Gemini
// Tránh rate limit khi gửi nhiều request song song
//
// Chiến lược:
// - Round-robin: request chẵn → Claude, request lẻ → Gemini
// - Nếu 1 provider lỗi 429 → tự chuyển sang provider còn lại
// - Audio scan / Footage scan (media) → CHỈ Gemini (vì cần inline_data)
// ============================================================

import { addDebugLog, updateDebugLog, generateLogId } from "@/services/debug-logger";

// ======================== CẤU HÌNH ========================

/** Model Claude mặc định */
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";

/** Danh sách models Claude khả dụng — hiển thị trên UI cho user chọn */
export const AVAILABLE_CLAUDE_MODELS = [
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6 (mới nhất)" },
    { id: "claude-sonnet-4-5", label: "Sonnet 4.5" },
] as const;

/** Danh sách models Gemini khả dụng */
export const AVAILABLE_GEMINI_MODELS = [
    { id: "gemini-2.5-pro", label: "2.5 Pro (mạnh nhất)" },
    { id: "gemini-2.5-flash", label: "2.5 Flash (nhanh)" },
    { id: "gemini-2.0-flash", label: "2.0 Flash" },
] as const;

/** Claude qua ezaiapi — dùng cho text analysis
 *  model có thể thay đổi runtime qua setClaudeModel()
 *  ⚠️ API key KHÔNG hardcode — đọc từ settings (user nhập qua UI) */
let CLAUDE_CONFIG = {
    name: "Claude",
    baseUrl: "https://ezaiapi.com/v1",
    // apiKey: xóa hardcode — đọc dynamic từ settings mỗi lần gọi
    model: DEFAULT_CLAUDE_MODEL,
    maxTokens: 65536,
    timeoutMs: 900000,  // 15 phút
};

/** Gemini — dùng cho cả text analysis và media scan
 *  model có thể thay đổi runtime qua setGeminiModel() */
let GEMINI_CONFIG = {
    name: "Gemini",
    model: "gemini-2.5-pro",
    maxTokens: 65536, // Tăng từ 16K → 65K (2.5 Pro dùng ~16K thinking tokens nội bộ)
    timeoutMs: 900000,
};

// ======================== PROVIDER TYPE ========================

export type AIProvider = "claude" | "gemini" | "auto";

/** Provider user đã chọn trên UI ("auto" = logic tự động chọn) */
let preferredProviderSetting: "claude" | "gemini" | "auto" = "auto";

/** Bộ đếm round-robin (tự tăng mỗi lần gọi) */
let requestCounter = 0;

/** Track provider nào đang bị rate limit */
let claudeRateLimited = false;
let geminiRateLimited = false;
let claudeRateLimitResetTime = 0;
let geminiRateLimitResetTime = 0;

/**
 * Lấy TẤT CẢ Claude keys (để retry khi key lỗi)
 */
async function getAllClaudeKeys(): Promise<string[]> {
    try {
        const { getClaudeApiKeys } = await import("@/services/saved-folders-service");
        return await getClaudeApiKeys();
    } catch {
        return [];
    }
}

/**
 * Lấy TẤT CẢ Gemini keys (để retry khi key lỗi)
 */
async function getAllGeminiKeys(): Promise<string[]> {
    try {
        const { getGeminiApiKeys } = await import("@/services/saved-folders-service");
        return await getGeminiApiKeys();
    } catch {
        return [];
    }
}

/**
 * Chọn provider dựa theo:
 * 1. Nếu user đã chọn cụ thể (claude/gemini) → dùng đó, fallback khi rate limit
 * 2. Nếu "auto" → round-robin — request chẵn Claude, lẻ Gemini
 */
function pickProvider(hasGeminiKey: boolean, hasClaudeKey: boolean): "claude" | "gemini" {
    const now = Date.now();

    // Reset rate limit flags sau 60s
    if (claudeRateLimited && now > claudeRateLimitResetTime) claudeRateLimited = false;
    if (geminiRateLimited && now > geminiRateLimitResetTime) geminiRateLimited = false;

    // Không có Gemini key → bắt buộc dùng Claude
    if (!hasGeminiKey && hasClaudeKey) return "claude";
    // Không có Claude key → bắt buộc dùng Gemini
    if (!hasClaudeKey && hasGeminiKey) return "gemini";

    // "auto": round-robin Claude/Gemini luân phiên
    requestCounter++;
    if (requestCounter % 2 === 0) {
        return claudeRateLimited ? "gemini" : "claude";
    } else {
        return geminiRateLimited ? "claude" : "gemini";
    }
}

/**
 * Gọi Claude API (qua Rust reqwest streaming — bypass plugin-http hoàn toàn)
 *
 * Flow:
 * 1. Frontend gọi invoke('call_claude_stream', params)
 * 2. Rust gửi POST tới Claude API với stream: true
 * 3. Rust đọc SSE chunks, nối thành full text
 * 4. Trả full text về frontend
 *
 * Lợi ích:
 * - Không bị ReadableStream treo (bug plugin-http)
 * - Tránh Cloudflare 524 timeout (connection alive liên tục)
 * - Ổn định với response dài
 */
async function callClaude(
    prompt: string,
    logId: string,
    label: string,
    timeoutMs: number,
    claudeApiKey: string,
    temperature: number = 0.7
): Promise<string> {
    const { invoke } = await import("@tauri-apps/api/core");

    const url = `${CLAUDE_CONFIG.baseUrl}/chat/completions`;

    // Log request vào Debug Panel (trước khi gửi)
    addDebugLog({
        id: logId,
        timestamp: new Date(),
        method: "POST",
        url,
        requestHeaders: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${claudeApiKey.slice(0, 8)}...`,
        },
        requestBody: JSON.stringify({
            model: CLAUDE_CONFIG.model,
            max_tokens: CLAUDE_CONFIG.maxTokens,
            temperature,
            stream: true,
            messages: [
                { role: "user", content: prompt }
            ]
        }, null, 2),
        status: null,
        responseHeaders: {},
        responseBody: "(đang chờ Claude stream qua Rust...)",
        duration: 0,
        error: null,
        label: `[Claude Stream] ${label}`,
    });

    const startTime = Date.now();

    try {
        // Gọi Rust command — Rust xử lý stream, trả full text
        const result = await invoke<{
            text: string;
            status: number;
            chunk_count: number;
        }>("call_claude_stream", {
            params: {
                url,
                api_key: claudeApiKey,
                model: CLAUDE_CONFIG.model,
                prompt,
                max_tokens: CLAUDE_CONFIG.maxTokens,
                temperature,
                timeout_secs: Math.ceil(timeoutMs / 1000),
            },
        });

        const duration = Date.now() - startTime;
        const fullText = result.text;

        // Cập nhật Debug Panel — response đã nhận đủ
        updateDebugLog(logId, {
            status: result.status,
            responseHeaders: { "Rust-Stream": "True", "Chunk-Count": result.chunk_count.toString() },
            responseBody: JSON.stringify({
                model: CLAUDE_CONFIG.model,
                choices: [{ message: { content: fullText } }]
            }, null, 2),
            duration,
        });

        return fullText;
    } catch (error) {
        const duration = Date.now() - startTime;
        const errMsg = String(error);

        // Phân loại lỗi để xử lý rate limit
        if (errMsg.includes("429") || errMsg.includes("529")) {
            claudeRateLimited = true;
            claudeRateLimitResetTime = Date.now() + 60000;
        }

        updateDebugLog(logId, {
            status: errMsg.match(/HTTP (\d+)/)?.[1]
                ? parseInt(errMsg.match(/HTTP (\d+)/)![1])
                : 0,
            responseBody: errMsg,
            duration,
            error: errMsg.slice(0, 200),
        });

        throw new Error(errMsg);
    }
}

/**
 * Gọi Gemini API (text-only, không gửi media)
 */
async function callGemini(
    prompt: string,
    logId: string,
    label: string,
    timeoutMs: number,
    geminiApiKey: string,
    temperature: number = 0.7  // ← Nhận temperature từ caller
): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CONFIG.model}:generateContent?key=${geminiApiKey}`;
    const requestBody = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens: GEMINI_CONFIG.maxTokens,
            temperature,  // ← Gửi temperature lên Gemini API
        },
    });

    addDebugLog({
        id: logId,
        timestamp: new Date(),
        method: "POST",
        url: url.split("?key=")[0],  // Ẩn API key trong log
        requestHeaders: { "Content-Type": "application/json" },
        requestBody,
        status: null,
        responseHeaders: {},
        responseBody: "(đang chờ Gemini...)",
        duration: 0,
        error: null,
        label: `[Gemini] ${label}`,
    });

    // Lưu thời điểm bắt đầu để tính duration chính xác
    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await window.fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: requestBody,
            signal: controller.signal,
        });

        const duration = Date.now() - startTime;
        const responseText = await response.text();

        updateDebugLog(logId, {
            status: response.status,
            responseBody: responseText,
            duration,
            error: response.ok ? null : `HTTP ${response.status}`,
        });

        if (response.status === 429) {
            geminiRateLimited = true;
            geminiRateLimitResetTime = Date.now() + 60000;
            throw new Error(`Gemini rate limited (429)`);
        }

        if (!response.ok) {
            throw new Error(`Gemini API error ${response.status}: ${responseText}`);
        }

        const data = JSON.parse(responseText);
        const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        return rawText;
    } finally {
        clearTimeout(timeout);
    }
}

// ======================== HÀM CHÍNH: callAIMultiProvider ========================

/**
 * Gọi AI text analysis — tự động chọn Claude hoặc Gemini
 *
 * Chiến lược:
 * 1. Round-robin: request chẵn → Claude, lẻ → Gemini
 * 2. Nếu provider chọn bị rate limit → tự chuyển sang provider kia
 * 3. Nếu provider kia cũng lỗi → throw error
 *
 * @param prompt - Nội dung prompt text
 * @param label - Label hiển thị trên Debug Panel
 * @param preferredProvider - Ưu tiên provider ("auto" = round-robin)
 * @param timeoutMs - Timeout (ms), mặc định 15 phút
 * @returns AI response text
 */
export async function callAIMultiProvider(
    prompt: string,
    label: string,
    preferredProvider: AIProvider = "auto",
    timeoutMs?: number,
    temperature?: number  // ← Nhận từ caller (mặc định lấy từ AppSettings)
): Promise<string> {
    const actualTimeout = timeoutMs || CLAUDE_CONFIG.timeoutMs;
    
    // Lấy temperature từ Tauri Store (cùng nơi SettingsContext lưu) nếu caller không truyền
    let actualTemp = temperature;
    if (actualTemp === undefined) {
        try {
            const { load } = await import('@tauri-apps/plugin-store');
            const store = await load('autosubs-store.json');
            const storedSettings = await store.get<any>('settings');
            actualTemp = storedSettings?.aiTemperature ?? 0.7;
        } catch {
            actualTemp = 0.7;
        }
    }

    // ═══ Lấy TẤT CẢ keys của cả 2 provider ═══
    const allClaudeKeys = await getAllClaudeKeys();
    const allGeminiKeys = await getAllGeminiKeys();
    const hasClaudeKey = allClaudeKeys.length > 0;
    const hasGeminiKey = allGeminiKeys.length > 0;

    // Không có key nào → báo lỗi rõ ràng
    if (!hasClaudeKey && !hasGeminiKey) {
        throw new Error(
            "❌ Chưa có API key nào! Vui lòng vào Settings nhập Claude hoặc Gemini API keys."
        );
    }

    // Đọc preferred provider từ Tauri Store — đây là source of truth
    // Biến module preferredProviderSetting có thể chưa được sync sau HMR reload
    try {
        const { load } = await import('@tauri-apps/plugin-store');
        const store = await load('autosubs-store.json');
        const storedSettings = await store.get<any>('settings');
        if (storedSettings?.preferredProvider) {
            preferredProviderSetting = storedSettings.preferredProvider;
        }
    } catch {
        // Không đọc được → giữ biến module hiện tại
    }

    // Dùng preferredProviderSetting (từ settings/ui) lấn át argument preferredProvider nếu nó không phải auto
    const effectiveProvider = preferredProvider !== "auto" ? preferredProvider : preferredProviderSetting;

    // Chọn provider ưu tiên
    let provider: "claude" | "gemini";
    if (effectiveProvider === "auto") {
        provider = pickProvider(hasGeminiKey, hasClaudeKey);
    } else {
        provider = effectiveProvider;
        // User ép buộc chọn 1 model cụ thể → không cho fallback nếu thiếu key
        if (provider === "gemini" && !hasGeminiKey) {
            throw new Error("❌ Bạn đã chọn Gemini nhưng chưa nhập API Key cho Gemini! Hãy kiểm tra lại Settings.");
        }
        if (provider === "claude" && !hasClaudeKey) {
            throw new Error("❌ Bạn đã chọn Claude nhưng chưa nhập API Key cho Claude! Hãy kiểm tra lại Settings.");
        }
    }

    console.log(`[AI Provider] 🔀 ${label} → ${provider.toUpperCase()} (counter: ${requestCounter})`);

    // ═══ BỂ XOAY TUA: thử từng key cùng provider, rồi fallback ═══
    const primaryKeys = provider === "claude" ? allClaudeKeys : allGeminiKeys;
    const fallbackProvider = provider === "claude" ? "gemini" : "claude";
    
    // YÊU CẦU: Nếu user chọn đích danh 1 model, tuyệt đối KHÔNG đổi chéo sang model kia kể cả khi rate limit.
    const fallbackKeys = effectiveProvider === "auto" ? (provider === "claude" ? allGeminiKeys : allClaudeKeys) : [];

    // Bước 1: Thử từng key của provider chính
    for (let i = 0; i < primaryKeys.length; i++) {
        const key = primaryKeys[i];
        const logId = generateLogId();
        try {
            if (provider === "claude") {
                return await callClaude(prompt, logId, label, actualTimeout, key, actualTemp);
            } else {
                return await callGemini(prompt, logId, label, actualTimeout, key, actualTemp);
            }
        } catch (error) {
            const errMsg = String(error);
            // Chỉ retry key khác nếu lỗi rate limit / server error / timeout
            if (errMsg.includes("429") || errMsg.includes("529") || errMsg.includes("500") || errMsg.includes("rate limit") || errMsg.includes("timeout") || errMsg.includes("timed out")) {
                console.warn(`[AI Provider] ⚠️ ${provider} key #${i + 1} lỗi: ${errMsg.slice(0, 100)}`);
                if (i < primaryKeys.length - 1) {
                    console.log(`[AI Provider] 🔄 Thử key #${i + 2}...`);
                    continue; // Thử key tiếp theo
                }
                // Hết key cùng provider → chuyển sang fallback
                break;
            }
            // Lỗi khác (network, timeout...) → throw luôn
            throw error;
        }
    }

    // Bước 2: Fallback — thử từng key của provider còn lại
    if (fallbackKeys.length > 0) {
        console.log(`[AI Provider] 🔄 Hết key ${provider} → Fallback ${fallbackProvider.toUpperCase()} (${fallbackKeys.length} keys)`);

        for (let i = 0; i < fallbackKeys.length; i++) {
            const key = fallbackKeys[i];
            const fallbackLogId = generateLogId();
            try {
                if (fallbackProvider === "claude") {
                    return await callClaude(prompt, fallbackLogId, `[Fallback] ${label}`, actualTimeout, key, actualTemp);
                } else {
                    return await callGemini(prompt, fallbackLogId, `[Fallback] ${label}`, actualTimeout, key, actualTemp);
                }
            } catch (error) {
                const errMsg = String(error);
                if (errMsg.includes("429") || errMsg.includes("529") || errMsg.includes("500") || errMsg.includes("rate limit") || errMsg.includes("timeout") || errMsg.includes("timed out")) {
                    console.warn(`[AI Provider] ⚠️ ${fallbackProvider} key #${i + 1} cũng lỗi`);
                    continue;
                }
                throw error;
            }
        }
    }

    // Bước 3: Hết tất cả keys → báo lỗi
    throw new Error(
        `❌ Tất cả API keys đều bị rate limit!\n` +
        `Claude: ${allClaudeKeys.length} keys, Gemini: ${allGeminiKeys.length} keys\n` +
        `Vui lòng chờ 1-2 phút rồi thử lại, hoặc thêm key mới trong Settings.`
    );
}

// ======================== EXPORT CONFIG (để các service khác dùng) ========================

/** Lấy config Claude hiện tại */
export function getClaudeConfig() {
    return { ...CLAUDE_CONFIG };
}

/** Lấy config Gemini hiện tại */
export function getGeminiConfig() {
    return { ...GEMINI_CONFIG };
}

// ======================== ĐỔI MODEL RUNTIME ========================

/** Lấy model Claude đang dùng */
export function getClaudeModel(): string {
    return CLAUDE_CONFIG.model;
}

/** Lấy model Gemini đang dùng */
export function getGeminiModel(): string {
    return GEMINI_CONFIG.model;
}

/** Lấy preferred provider hiện tại */
export function getPreferredProvider(): "claude" | "gemini" | "auto" {
    return preferredProviderSetting;
}

/**
 * User chọn provider ưu tiên trên UI:
 * - "claude" → luôn gọi Claude (fallback Gemini khi rate limit)
 * - "gemini" → luôn gọi Gemini (fallback Claude khi rate limit)
 * - "auto"   → round-robin luân phiên
 */
export async function setPreferredProvider(provider: "claude" | "gemini" | "auto"): Promise<void> {
    preferredProviderSetting = provider;
    console.log(`[AI Provider] 🎯 Preferred provider → ${provider}`);
    try {
        const { saveSettings } = await import("@/services/auto-media-storage");
        await saveSettings({ preferredProvider: provider });
    } catch (err) {
        console.warn("[AI Provider] Không lưu được preferredProvider:", err);
    }
}

/**
 * Đổi model Claude — cập nhật runtime + lưu vào settings
 */
export async function setClaudeModel(modelId: string): Promise<void> {
    CLAUDE_CONFIG = { ...CLAUDE_CONFIG, model: modelId };
    console.log(`[AI Provider] 🔄 Claude model → ${modelId}`);
    try {
        const { saveSettings } = await import("@/services/auto-media-storage");
        await saveSettings({ claudeModel: modelId });
    } catch (err) {
        console.warn("[AI Provider] Không lưu được Claude model:", err);
    }
}

/**
 * Đổi model Gemini — cập nhật runtime + lưu vào settings
 */
export async function setGeminiModel(modelId: string): Promise<void> {
    GEMINI_CONFIG = { ...GEMINI_CONFIG, model: modelId };
    console.log(`[AI Provider] 🔄 Gemini model → ${modelId}`);
    try {
        const { saveSettings } = await import("@/services/auto-media-storage");
        await saveSettings({ geminiModel: modelId });
    } catch (err) {
        console.warn("[AI Provider] Không lưu được Gemini model:", err);
    }
}

/**
 * Khởi tạo tất cả AI settings từ file (gọi khi app mount)
 * Load: preferredProvider + claudeModel + geminiModel
 */
export async function initModelsFromSettings(): Promise<void> {
    try {
        const { readSettings } = await import("@/services/auto-media-storage");
        const settings = await readSettings();

        if (settings.preferredProvider) {
            preferredProviderSetting = settings.preferredProvider;
            console.log(`[AI Provider] 📦 Preferred provider từ settings: ${settings.preferredProvider}`);
        }
        if (settings.claudeModel) {
            CLAUDE_CONFIG = { ...CLAUDE_CONFIG, model: settings.claudeModel };
            console.log(`[AI Provider] 📦 Claude model từ settings: ${settings.claudeModel}`);
        }
        if (settings.geminiModel) {
            GEMINI_CONFIG = { ...GEMINI_CONFIG, model: settings.geminiModel };
            console.log(`[AI Provider] 📦 Gemini model từ settings: ${settings.geminiModel}`);
        }
    } catch (err) {
        console.warn("[AI Provider] Không đọc được settings:", err);
    }
}

// Backward compatibility
export const initClaudeModelFromSettings = initModelsFromSettings;
