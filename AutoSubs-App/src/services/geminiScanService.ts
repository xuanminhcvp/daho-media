// geminiScanService.ts
// Service giao tiếp HTTP với Python Gemini Scan Server (port 5679)
// Tất cả function trả về dữ liệu chuẩn, component chỉ cần gọi.
//
// Cơ chế:
// - HTTP REST cho start/stop/status/close
// - SSE (Server-Sent Events) cho scan-batch → nhận kết quả từng file real-time

// Port của Python Gemini Server (khác Flow server 5678)
const BASE_URL = 'http://localhost:5679';

// ═══════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════

/** Trạng thái server */
export type GeminiServerStatus =
    | 'disconnected'
    | 'connecting'
    | 'waiting_login'
    | 'ready'
    | 'scanning'
    | 'error';

/** Trạng thái server trả về từ GET /gemini/status */
export interface GeminiStatusResponse {
    status: GeminiServerStatus;
    message: string;
    current_file: string | null;
    progress: {
        done: number;
        total: number;
        failed: number;
    };
}

/** Loại file cần scan */
export type GeminiScanType = 'audio' | 'image';

/** 1 job scan gửi xuống server */
export interface GeminiScanJob {
    job_id: string;       // ID duy nhất (ví dụ: "audio_0", "image_3")
    file_path: string;    // Đường dẫn tuyệt đối tới file trên máy
    file_name: string;    // Tên file ngắn (để hiển thị UI)
    prompt: string;       // Prompt gửi vào Gemini
}

/** Kết quả từ SSE event "done" — 1 file scan xong */
export interface GeminiScanResult {
    job_id: string;
    file_path: string;
    file_name: string;
    scan_type: GeminiScanType;
    response_text: string;   // Text thô từ Gemini (chứa JSON bên trong)
    done: number;
    total: number;
}

/** SSE Event nhận từ stream */
export interface GeminiSSEEvent {
    // Các event type mới bao gồm debug_step và bug_report từ server v1.1
    event: 'processing' | 'done' | 'error' | 'stopped' | 'complete' | 'debug_step' | 'bug_report';
    data: {
        // Các fields cho processing / done / error / complete
        job_id?: string;
        file_name?: string;
        file_path?: string;
        scan_type?: GeminiScanType;
        response_text?: string;
        index?: number;
        total?: number;
        done?: number;
        failed?: number;
        error?: string;
        message?: string;
        bug_report?: any;       // Report tổng hợp cuối batch
        // Fields cho debug_step (screenshot + DOM info)
        step?: string;
        step_index?: number;
        timestamp?: number;
        screenshot_base64?: string;
        dom_info?: any;
        extra?: any;
        is_error?: boolean;
        // Fields cho bug_report event (per-file)
        report?: any;
    };
}

// ═══════════════════════════════════════════════════
// API FUNCTIONS
// ═══════════════════════════════════════════════════

/** Kiểm tra Python server có đang chạy không */
export async function checkGeminiServerHealth(): Promise<boolean> {
    try {
        const res = await fetch(`${BASE_URL}/gemini/status`, {
            signal: AbortSignal.timeout(3000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/** Lấy trạng thái hiện tại của server */
export async function getGeminiStatus(): Promise<GeminiStatusResponse> {
    const res = await fetch(`${BASE_URL}/gemini/status`);
    if (!res.ok) throw new Error(`Status error: ${res.status}`);
    return res.json();
}

/** Mở Chrome + vào gemini.google.com */
export async function startGeminiSession(): Promise<{ ok: boolean; message?: string; error?: string }> {
    const res = await fetch(`${BASE_URL}/gemini/start-session`, { method: 'POST' });
    return res.json();
}

/** Xác nhận đã đăng nhập Google */
export async function confirmGeminiLogin(): Promise<{ ok: boolean; message?: string; error?: string }> {
    const res = await fetch(`${BASE_URL}/gemini/confirm-login`, { method: 'POST' });
    return res.json();
}

/** Dừng scan đang chạy */
export async function stopGeminiScan(): Promise<void> {
    await fetch(`${BASE_URL}/gemini/stop`, { method: 'POST' });
}

/** Đóng Chrome session */
export async function closeGeminiSession(): Promise<void> {
    await fetch(`${BASE_URL}/gemini/close-session`, { method: 'POST' });
}

/**
 * Scan hàng loạt file — kết nối SSE stream
 *
 * @param scanType - "audio" hoặc "image"
 * @param jobs - Danh sách file cần scan
 * @param onEvent - Callback nhận từng SSE event
 * @param abortSignal - Signal để huỷ stream
 */
export async function scanBatchSSE(
    scanType: GeminiScanType,
    jobs: GeminiScanJob[],
    onEvent: (event: GeminiSSEEvent) => Promise<void> | void,
    abortSignal?: AbortSignal,
): Promise<void> {
    const res = await fetch(`${BASE_URL}/gemini/scan-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scan_type: scanType, jobs }),
        signal: abortSignal,
    });

    if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errData.error || `Server error ${res.status}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('Không thể đọc SSE stream');

    const decoder = new TextDecoder();
    let buffer = '';

    // Parse 1 SSE event block (phân cách bởi \n\n)
    const processEventBlock = async (block: string) => {
        const lines = block.split(/\r?\n/);
        let eventName = '';
        const dataLines: string[] = [];

        for (const rawLine of lines) {
            const line = rawLine.trimEnd();
            if (!line || line.startsWith(':')) continue;
            if (line.startsWith('event:')) {
                eventName = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trimStart());
            }
        }

        if (!eventName || dataLines.length === 0) return;
        const dataText = dataLines.join('\n');

        try {
            const parsed = JSON.parse(dataText);
            await onEvent({
                event: eventName as GeminiSSEEvent['event'],
                data: parsed,
            });
        } catch (e) {
            console.warn('[GeminiScan] SSE parse error:', { eventName, preview: dataText.slice(0, 200), error: e });
        }
    };

    // Đọc stream chunk-by-chunk
    while (true) {
        if (abortSignal?.aborted) {
            reader.cancel();
            break;
        }

        const { done, value } = await reader.read();
        if (done) {
            if (buffer.trim()) await processEventBlock(buffer);
            break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Xử lý từng event block kết thúc bằng \n\n
        while (true) {
            const nn = buffer.indexOf('\n\n');
            const rr = buffer.indexOf('\r\n\r\n');
            if (nn === -1 && rr === -1) break;

            let separatorIndex: number;
            if (nn === -1) separatorIndex = rr;
            else if (rr === -1) separatorIndex = nn;
            else separatorIndex = Math.min(nn, rr);

            const sepLen = buffer.startsWith('\r\n\r\n', separatorIndex) ? 4 : 2;
            const block = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + sepLen);

            if (block.trim()) await processEventBlock(block);
        }
    }
}
