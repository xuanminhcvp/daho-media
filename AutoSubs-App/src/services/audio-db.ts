/**
 * audio-db.ts
 *
 * IndexedDB wrapper để lưu/đọc metadata nhạc nền & SFX.
 * Thay thế cách lưu file JSON cũ (autosubs_audio_db.json).
 *
 * Cấu trúc IndexedDB:
 *   Database: "autosubs-audio-library"
 *   Object Stores:
 *     - "musicLibrary": lưu AudioLibraryItem (key = filePath)
 *     - "sfxLibrary":   lưu AudioLibraryItem (key = filePath)
 *
 * Ưu điểm so với file JSON:
 *   - Không cần đọc/ghi file hệ thống
 *   - Nhanh hơn với dataset lớn
 *   - Dễ quản lý: xoá từng item, query theo key
 *   - Persist qua các session (không mất khi reload)
 */

import type { AudioLibraryItem } from "@/types/audio-types";

// ======================== CONSTANTS ========================

/** Tên database IndexedDB */
const DB_NAME = "autosubs-audio-library";

/** Version — tăng khi thay đổi schema */
const DB_VERSION = 1;

/** Tên 2 object store */
const MUSIC_STORE = "musicLibrary";
const SFX_STORE = "sfxLibrary";

// ======================== HELPER: MỞ DATABASE ========================

/**
 * Mở hoặc tạo IndexedDB database cho audio library.
 * Tự động tạo 2 object store nếu chưa có.
 */
function openAudioDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        // Được gọi khi cần tạo mới hoặc nâng cấp database
        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;

            // Tạo store cho nhạc nền (key = filePath)
            if (!db.objectStoreNames.contains(MUSIC_STORE)) {
                const musicStore = db.createObjectStore(MUSIC_STORE, { keyPath: "filePath" });
                // Index theo loại để lọc nhanh
                musicStore.createIndex("type", "type", { unique: false });
                musicStore.createIndex("scannedAt", "scannedAt", { unique: false });
                console.log("[AudioDB] ✅ Tạo musicLibrary store");
            }

            // Tạo store cho SFX (key = filePath)
            if (!db.objectStoreNames.contains(SFX_STORE)) {
                const sfxStore = db.createObjectStore(SFX_STORE, { keyPath: "filePath" });
                sfxStore.createIndex("type", "type", { unique: false });
                sfxStore.createIndex("scannedAt", "scannedAt", { unique: false });
                console.log("[AudioDB] ✅ Tạo sfxLibrary store");
            }
        };

        request.onsuccess = (event) => {
            resolve((event.target as IDBOpenDBRequest).result);
        };

        request.onerror = (event) => {
            console.error("[AudioDB] ❌ Lỗi mở database:", (event.target as IDBOpenDBRequest).error);
            reject((event.target as IDBOpenDBRequest).error);
        };
    });
}

/**
 * Xác định store name dựa trên type
 */
function getStoreName(type: "music" | "sfx"): string {
    return type === "music" ? MUSIC_STORE : SFX_STORE;
}

// ======================== CRUD OPERATIONS ========================

/**
 * Lưu 1 item vào IndexedDB (thêm mới hoặc cập nhật nếu đã tồn tại)
 * @param type - "music" hoặc "sfx"
 * @param item - AudioLibraryItem cần lưu
 */
export async function saveAudioItem(
    type: "music" | "sfx",
    item: AudioLibraryItem
): Promise<void> {
    const db = await openAudioDB();
    const storeName = getStoreName(type);

    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);

        // put = upsert (thêm mới hoặc cập nhật)
        const request = store.put(item);

        request.onsuccess = () => resolve();
        request.onerror = () => {
            console.error("[AudioDB] ❌ Lỗi lưu item:", request.error);
            reject(request.error);
        };

        tx.oncomplete = () => db.close();
    });
}

/**
 * Lưu nhiều items cùng lúc (batch upsert)
 * Dùng 1 transaction duy nhất cho hiệu suất cao
 * @param type - "music" hoặc "sfx"
 * @param items - Danh sách AudioLibraryItem cần lưu
 */
export async function saveAudioItems(
    type: "music" | "sfx",
    items: AudioLibraryItem[]
): Promise<void> {
    if (items.length === 0) return;

    const db = await openAudioDB();
    const storeName = getStoreName(type);

    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);

        // Lưu từng item trong cùng 1 transaction
        for (const item of items) {
            store.put(item);
        }

        tx.oncomplete = () => {
            db.close();
            resolve();
        };

        tx.onerror = () => {
            console.error("[AudioDB] ❌ Lỗi batch save:", tx.error);
            reject(tx.error);
        };
    });
}

/**
 * Lấy 1 item theo filePath
 * @param type - "music" hoặc "sfx"
 * @param filePath - Đường dẫn file audio
 * @returns AudioLibraryItem hoặc null nếu không tìm thấy
 */
export async function getAudioItem(
    type: "music" | "sfx",
    filePath: string
): Promise<AudioLibraryItem | null> {
    const db = await openAudioDB();
    const storeName = getStoreName(type);

    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        const request = store.get(filePath);

        request.onsuccess = () => {
            resolve(request.result as AudioLibraryItem | null);
        };

        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
    });
}

/**
 * Lấy toàn bộ items trong 1 store
 * @param type - "music" hoặc "sfx"
 * @returns Danh sách AudioLibraryItem
 */
export async function getAllAudioItems(
    type: "music" | "sfx"
): Promise<AudioLibraryItem[]> {
    const db = await openAudioDB();
    const storeName = getStoreName(type);

    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        const request = store.getAll();

        request.onsuccess = () => {
            resolve(request.result as AudioLibraryItem[]);
        };

        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
    });
}

/**
 * Xoá 1 item khỏi IndexedDB
 * @param type - "music" hoặc "sfx"
 * @param filePath - Đường dẫn file audio cần xoá
 */
export async function deleteAudioItem(
    type: "music" | "sfx",
    filePath: string
): Promise<void> {
    const db = await openAudioDB();
    const storeName = getStoreName(type);

    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        const request = store.delete(filePath);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
    });
}

/**
 * Xoá nhiều items cùng lúc (batch delete)
 * Dùng khi dọn dẹp các file đã bị xoá khỏi ổ cứng
 * @param type - "music" hoặc "sfx"
 * @param filePaths - Danh sách đường dẫn cần xoá
 */
export async function deleteAudioItems(
    type: "music" | "sfx",
    filePaths: string[]
): Promise<void> {
    if (filePaths.length === 0) return;

    const db = await openAudioDB();
    const storeName = getStoreName(type);

    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);

        for (const filePath of filePaths) {
            store.delete(filePath);
        }

        tx.oncomplete = () => {
            db.close();
            console.log(`[AudioDB] 🗑️ Đã xoá ${filePaths.length} items khỏi ${storeName}`);
            resolve();
        };

        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Đếm tổng số items trong 1 store
 * @param type - "music" hoặc "sfx"
 */
export async function countAudioItems(
    type: "music" | "sfx"
): Promise<number> {
    const db = await openAudioDB();
    const storeName = getStoreName(type);

    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        const request = store.count();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
    });
}

/**
 * Dọn dẹp: Xoá các items trong DB mà file đã không còn tồn tại trên ổ cứng
 * So sánh danh sách filePaths hiện có với DB → xoá những cái không có
 * @param type - "music" hoặc "sfx"
 * @param currentFilePaths - Danh sách filePath hiện đang tồn tại trên ổ cứng
 * @returns Số lượng items đã bị xoá
 */
export async function cleanupDeletedFiles(
    type: "music" | "sfx",
    currentFilePaths: Set<string>
): Promise<number> {
    // Lấy tất cả items trong DB
    const allItems = await getAllAudioItems(type);

    // Tìm items có trong DB nhưng KHÔNG CÒN trên ổ cứng
    const deletedPaths = allItems
        .filter(item => !currentFilePaths.has(item.filePath))
        .map(item => item.filePath);

    if (deletedPaths.length > 0) {
        await deleteAudioItems(type, deletedPaths);
        console.log(
            `[AudioDB] 🧹 Dọn dẹp: xoá ${deletedPaths.length} file ${type} đã bị xoá khỏi ổ cứng`
        );
    }

    return deletedPaths.length;
}
