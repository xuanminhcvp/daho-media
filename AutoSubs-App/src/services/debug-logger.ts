// debug-logger.ts
// Service lưu trữ log request/response để debug
// Tất cả HTTP request đều được log lại với đầy đủ thông tin

// ======================== TYPES ========================
export interface DebugLogEntry {
    id: string;
    timestamp: Date;
    // Request info
    method: string;
    url: string;
    requestHeaders: Record<string, string>;
    requestBody: string;
    // Response info (null nếu chưa có response hoặc lỗi)
    status: number | null;
    responseHeaders: Record<string, string>;
    responseBody: string;
    // Metadata
    duration: number; // ms
    error: string | null;
    label: string; // Tên ngắn gọn, vd: "AI Batch 1"
}

// ======================== STORE ========================
// Lưu tối đa 100 log entries
const MAX_LOGS = 100;
let _logs: DebugLogEntry[] = [];
let _listeners: (() => void)[] = [];

// ======================== API ========================

/** Lấy tất cả logs */
export function getDebugLogs(): DebugLogEntry[] {
    return _logs;
}

/** Xóa tất cả logs */
export function clearDebugLogs(): void {
    _logs = [];
    _notifyListeners();
}

/** Ghi đè toàn bộ logs (dùng khi restore session) */
export function setDebugLogs(logs: DebugLogEntry[]): void {
    _logs = logs.slice(0, MAX_LOGS);
    _notifyListeners();
}

/** Subscribe để nhận thông báo khi có log mới */
export function subscribeDebugLogs(listener: () => void): () => void {
    _listeners.push(listener);
    // Trả về unsubscribe function
    return () => {
        _listeners = _listeners.filter((l) => l !== listener);
    };
}

// ======================== BẢO MẬT ========================
// Mặc định: chỉ log ở DEV.
// Bổ sung: nếu đang chạy trong desktop Tauri thì vẫn cho phép log local
// để Debug Panel hoạt động cả ở bản build/release trên máy người dùng.
// Lưu ý: log chỉ nằm trong memory runtime (không tự đẩy ra ngoài).
const IS_TAURI_RUNTIME =
    typeof window !== "undefined" &&
    ("__TAURI__" in window || "__TAURI_INTERNALS__" in window);
const IS_DEV = import.meta.env.DEV || IS_TAURI_RUNTIME;

/** Thêm 1 log entry — chỉ hoạt động khi dev */
export function addDebugLog(entry: DebugLogEntry): void {
    // Production: không ghi log gì → return sớm
    if (!IS_DEV) return;
    _logs = [entry, ..._logs].slice(0, MAX_LOGS); // Mới nhất ở đầu
    _notifyListeners();
}

/** Cập nhật log entry (khi response về) — chỉ hoạt động khi dev */
export function updateDebugLog(
    id: string,
    updates: Partial<DebugLogEntry>
): void {
    // Production: không ghi log gì → return sớm
    if (!IS_DEV) return;
    _logs = _logs.map((log) =>
        log.id === id ? { ...log, ...updates } : log
    );
    _notifyListeners();
}

function _notifyListeners() {
    _listeners.forEach((l) => l());
}

// ======================== HELPER: Tạo ID unique ========================
let _counter = 0;
export function generateLogId(): string {
    _counter++;
    return `log-${Date.now()}-${_counter}`;
}
