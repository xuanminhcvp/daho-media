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

import { fetch } from "@tauri-apps/plugin-http";
import { addDebugLog, updateDebugLog, generateLogId } from "@/services/debug-logger";

// ======================== CẤU HÌNH ========================

/** Claude qua ezaiapi — dùng cho text analysis */
const CLAUDE_CONFIG = {
    name: "Claude",
    baseUrl: "https://ezaiapi.com/v1",
    apiKey: "sk-570848c49fda787c748cd58f3a21a1d95f00afd87a5cba6e",
    model: "claude-sonnet-4-6",
    maxTokens: 16000,
    timeoutMs: 900000,  // 15 phút
};

/** Gemini — dùng cho cả text analysis và media scan */
// API key lấy từ settings (user nhập trên giao diện)
const GEMINI_CONFIG = {
    name: "Gemini",
    model: "gemini-3-flash-preview",
    maxTokens: 16000,
    timeoutMs: 900000,
};

// ======================== PROVIDER TYPE ========================

export type AIProvider = "claude" | "gemini" | "auto";

/** Bộ đếm round-robin (tự tăng mỗi lần gọi) */
let requestCounter = 0;

/** Track provider nào đang bị rate limit */
let claudeRateLimited = false;
let geminiRateLimited = false;
let claudeRateLimitResetTime = 0;
let geminiRateLimitResetTime = 0;

/**
 * Lấy Gemini API key từ settings (đã lưu bởi user)
 */
async function getGeminiApiKey(): Promise<string | null> {
    try {
        const { getAudioScanApiKey } = await import("@/services/saved-folders-service");
        return await getAudioScanApiKey();
    } catch {
        return null;
    }
}

/**
 * Chọn provider tự động (round-robin + rate limit awareness)
 * - Nếu cả 2 available → xen kẽ Claude/Gemini
 * - Nếu 1 bị rate limit → dùng provider còn lại
 * - Nếu không có Gemini API key → chỉ dùng Claude
 */
function pickProvider(hasGeminiKey: boolean): "claude" | "gemini" {
    const now = Date.now();

    // Reset rate limit flags sau 60s
    if (claudeRateLimited && now > claudeRateLimitResetTime) {
        claudeRateLimited = false;
    }
    if (geminiRateLimited && now > geminiRateLimitResetTime) {
        geminiRateLimited = false;
    }

    // Không có Gemini key → chỉ Claude
    if (!hasGeminiKey) return "claude";

    // Cả 2 bị rate limit → dùng Claude (có retry built-in)
    if (claudeRateLimited && geminiRateLimited) return "claude";

    // 1 bị rate limit → dùng cái còn lại
    if (claudeRateLimited) return "gemini";
    if (geminiRateLimited) return "claude";

    // Cả 2 OK → round-robin
    requestCounter++;
    return requestCounter % 2 === 0 ? "claude" : "gemini";
}

// ======================== HÀM GỌI AI ========================

/**
 * Gọi Claude API (qua ezaiapi — OpenAI compatible format)
 */
async function callClaude(
    prompt: string,
    logId: string,
    label: string,
    timeoutMs: number
): Promise<string> {
    const url = `${CLAUDE_CONFIG.baseUrl}/chat/completions`;
    const requestBody = JSON.stringify({
        model: CLAUDE_CONFIG.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: CLAUDE_CONFIG.maxTokens,
    });

    addDebugLog({
        id: logId,
        timestamp: new Date(),
        method: "POST",
        url,
        requestHeaders: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${CLAUDE_CONFIG.apiKey.slice(0, 8)}...`,
        },
        requestBody,
        status: null,
        responseHeaders: {},
        responseBody: "(đang chờ Claude...)",
        duration: 0,
        error: null,
        label: `[Claude] ${label}`,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${CLAUDE_CONFIG.apiKey}`,
            },
            body: requestBody,
            signal: controller.signal,
        });

        const duration = Date.now() - parseInt(logId);
        const responseText = await response.text();

        updateDebugLog(logId, {
            status: response.status,
            responseBody: responseText,
            duration,
            error: response.ok ? null : `HTTP ${response.status}`,
        });

        if (response.status === 429 || response.status === 529) {
            claudeRateLimited = true;
            claudeRateLimitResetTime = Date.now() + 60000; // Reset after 60s
            throw new Error(`Claude rate limited (${response.status})`);
        }

        if (!response.ok) {
            throw new Error(`Claude API error ${response.status}: ${responseText}`);
        }

        const data = JSON.parse(responseText);
        return data.choices?.[0]?.message?.content || "";
    } finally {
        clearTimeout(timeout);
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
    geminiApiKey: string
): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CONFIG.model}:generateContent?key=${geminiApiKey}`;
    const requestBody = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens: GEMINI_CONFIG.maxTokens,
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: requestBody,
            signal: controller.signal,
        });

        const duration = Date.now() - parseInt(logId);
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
    timeoutMs?: number
): Promise<string> {
    const logId = generateLogId();
    const actualTimeout = timeoutMs || CLAUDE_CONFIG.timeoutMs;

    // Lấy Gemini API key
    const geminiKey = await getGeminiApiKey();
    const hasGeminiKey = !!geminiKey;

    // Chọn provider
    let provider: "claude" | "gemini";
    if (preferredProvider === "auto") {
        provider = pickProvider(hasGeminiKey);
    } else {
        provider = preferredProvider;
        // Nếu chọn gemini nhưng không có key → fallback claude
        if (provider === "gemini" && !hasGeminiKey) {
            provider = "claude";
        }
    }

    console.log(`[AI Provider] 🔀 ${label} → ${provider.toUpperCase()} (counter: ${requestCounter})`);

    // Gọi provider đã chọn
    try {
        if (provider === "claude") {
            return await callClaude(prompt, logId, label, actualTimeout);
        } else {
            return await callGemini(prompt, logId, label, actualTimeout, geminiKey!);
        }
    } catch (error) {
        const errMsg = String(error);
        console.warn(`[AI Provider] ⚠️ ${provider} failed: ${errMsg}`);

        // Rate limit → thử provider còn lại
        if (errMsg.includes("rate limit") || errMsg.includes("429") || errMsg.includes("529")) {
            const fallbackProvider = provider === "claude" ? "gemini" : "claude";

            // Kiểm tra fallback có available không
            if (fallbackProvider === "gemini" && !hasGeminiKey) {
                console.warn("[AI Provider] ❌ Gemini key không có, không thể fallback");
                throw error;
            }

            console.log(`[AI Provider] 🔄 Fallback → ${fallbackProvider.toUpperCase()}`);
            const fallbackLogId = generateLogId();

            if (fallbackProvider === "claude") {
                return await callClaude(prompt, fallbackLogId, `[Fallback] ${label}`, actualTimeout);
            } else {
                return await callGemini(prompt, fallbackLogId, `[Fallback] ${label}`, actualTimeout, geminiKey!);
            }
        }

        // Lỗi khác → throw nguyên
        throw error;
    }
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
