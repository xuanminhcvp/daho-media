// concurrency-limiter.ts
// "Quản đốc" — Giới hạn số luồng API chạy đồng thời toàn cục
//
// Dùng cho: AI calls, FFmpeg jobs, hoặc bất kỳ tác vụ nặng nào
// Nguyên lý: Semaphore pattern — acquire() trước khi chạy, release() khi xong
//
// Ví dụ:
//   const limiter = new ConcurrencyLimiter(6);
//   await limiter.run(() => callAI("prompt"));

/**
 * ConcurrencyLimiter — Giới hạn số tác vụ chạy đồng thời
 * 
 * Khi đạt giới hạn, tác vụ mới sẽ chờ cho đến khi có slot trống.
 * Đảm bảo API slots luôn "đỏ lửa 100%" — slot trống được lấp ngay.
 */
export class ConcurrencyLimiter {
    private maxConcurrency: number
    private activeTasks: number = 0
    private waitQueue: Array<() => void> = []

    constructor(maxConcurrency: number = 6) {
        this.maxConcurrency = Math.max(1, maxConcurrency)
    }

    /**
     * Chạy 1 tác vụ với giới hạn concurrency
     * Nếu đã đạt limit → chờ đến khi có slot trống
     */
    async run<T>(taskFn: () => Promise<T>): Promise<T> {
        // Chờ slot trống nếu đã đầy
        if (this.activeTasks >= this.maxConcurrency) {
            await new Promise<void>(resolve => {
                this.waitQueue.push(resolve)
            })
        }

        this.activeTasks++
        try {
            return await taskFn()
        } finally {
            this.activeTasks--
            // Nhả slot → cho tác vụ đang chờ chạy
            const next = this.waitQueue.shift()
            if (next) next()
        }
    }

    /**
     * Chạy nhiều tác vụ song song (tối đa maxConcurrency cùng lúc)
     * Trả về kết quả theo thứ tự ban đầu
     */
    async runAll<T>(taskFns: Array<() => Promise<T>>): Promise<T[]> {
        return Promise.all(taskFns.map(fn => this.run(fn)))
    }

    /** Số tác vụ đang chạy */
    get activeCount() { return this.activeTasks }
    /** Số tác vụ đang chờ slot */
    get waitingCount() { return this.waitQueue.length }
    /** Tổng (đang chạy + đang chờ) */
    get totalCount() { return this.activeTasks + this.waitQueue.length }
}

// ======================== GLOBAL INSTANCE ========================
// Dùng chung 1 instance toàn cục cho Auto Media Pipeline
// Đảm bảo tổng API calls (Match + Music + SFX + Footage) không vượt limit

let _globalLimiter: ConcurrencyLimiter | null = null

/**
 * Lấy ConcurrencyLimiter toàn cục (singleton)
 * Tự động load maxConcurrency từ Settings
 */
export async function getGlobalLimiter(): Promise<ConcurrencyLimiter> {
    if (_globalLimiter) return _globalLimiter

    let maxConcurrency = 6 // mặc định

    try {
        const { load } = await import('@tauri-apps/plugin-store')
        const store = await load('autosubs-store.json')
        const settings = await store.get<any>('settings')
        if (settings?.aiMaxConcurrency) {
            maxConcurrency = settings.aiMaxConcurrency
        }
    } catch {
        console.warn('[ConcurrencyLimiter] Không đọc được settings, dùng mặc định:', maxConcurrency)
    }

    _globalLimiter = new ConcurrencyLimiter(maxConcurrency)
    console.log(`[ConcurrencyLimiter] 🏭 Quản đốc toàn cục: tối đa ${maxConcurrency} luồng song song`)
    return _globalLimiter
}

/** Reset global limiter (khi settings thay đổi) */
export function resetGlobalLimiter() {
    _globalLimiter = null
}
