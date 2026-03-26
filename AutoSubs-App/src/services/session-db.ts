/**
 * session-db.ts
 * 
 * IndexedDB wrapper để lưu/đọc/xóa sessions.
 * Mỗi session là một snapshot trạng thái app tại một thời điểm,
 * cho phép user quay lại và tiếp tục làm việc.
 * 
 * Sử dụng IndexedDB trực tiếp (không cần thư viện ngoài)
 * vì Tauri WebView hỗ trợ đầy đủ IndexedDB API.
 */

// ===== INTERFACE ĐỊNH NGHĨA CẤU TRÚC SESSION =====

/** Thông tin tối thiểu cần lưu cho một session */
export interface SessionData {
  /** ID duy nhất cho session (auto-generated UUID) */
  id: string;

  /** Tên hiển thị của session — user có thể đặt hoặc tự động sinh */
  name: string;

  /** Thời điểm tạo session */
  createdAt: number;

  /** Thời điểm cập nhật session gần nhất */
  updatedAt: number;

  /** @deprecated — không phân biệt nữa, giữ lại cho backward compatible */
  saveType?: 'auto' | 'manual';

  /** === SNAPSHOT TRẠNG THÁI APP === */

  /** Danh sách subtitles hiện tại */
  subtitles: any[];

  /** Danh sách speakers */
  speakers: any[];

  /** Settings hiện tại (snapshot toàn bộ) */
  settings: any;

  /** Timeline info (tên timeline, timelineId...) */
  timelineInfo: any;

  /** Tab đang active (subtitles, media-import, ...) */
  activeTab: string;

  /** File input hiện tại (standalone mode) */
  fileInput: string | null;

  /** Tên file transcript đang làm việc */
  currentTranscriptFilename: string | null;

  /** === DỮ LIỆU DỰ ÁN TOÀN APP (từ ProjectContext) === */
  /** Chứa shared data + per-tab data (Music, SFX, Highlight, VoicePacing...) */
  projectData?: any;

  /** === DEBUG LOGS (request/response từ Debug Panel) === */
  /** Lưu cùng session để có thể xem lại sau khi restore */
  debugLogs?: any[];
}

// ===== CONSTANTS =====

/** Tên database IndexedDB */
const DB_NAME = 'autosubs-sessions';

/** Version database — tăng khi thay đổi schema */
const DB_VERSION = 1;

/** Tên object store chính */
const STORE_NAME = 'sessions';

/** Số session tối đa được lưu — xóa cũ nhất khi vượt quá */
const MAX_SESSIONS = 50;

// ===== HELPER: MỞ KẾT NỐI DATABASE =====

/**
 * Mở hoặc tạo IndexedDB database.
 * Tự động tạo object store nếu chưa có (khi upgrade version).
 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    // Được gọi khi cần tạo mới hoặc nâng cấp database
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Tạo object store nếu chưa tồn tại
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });

        // Index theo thời gian cập nhật — phục vụ sort và cleanup
        store.createIndex('updatedAt', 'updatedAt', { unique: false });

        // Index theo loại lưu — lọc auto vs manual
        store.createIndex('saveType', 'saveType', { unique: false });

        console.log('[SessionDB] ✅ Tạo object store thành công');
      }
    };

    request.onsuccess = (event) => {
      resolve((event.target as IDBOpenDBRequest).result);
    };

    request.onerror = (event) => {
      console.error('[SessionDB] ❌ Lỗi mở database:', (event.target as IDBOpenDBRequest).error);
      reject((event.target as IDBOpenDBRequest).error);
    };
  });
}

// ===== GENERATE UUID =====

/** Tạo UUID v4 đơn giản cho session ID */
function generateId(): string {
  return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 9);
}

// ===== CRUD OPERATIONS =====

/**
 * Lưu một session mới vào IndexedDB.
 * Tự động gán ID và timestamps nếu chưa có.
 * Tự động xóa session cũ nhất nếu vượt quá MAX_SESSIONS.
 */
export async function saveSession(sessionData: Omit<SessionData, 'id' | 'createdAt' | 'updatedAt'>): Promise<SessionData> {
  const db = await openDatabase();

  const now = Date.now();
  const session: SessionData = {
    ...sessionData,
    id: generateId(),
    createdAt: now,
    updatedAt: now,
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    const addRequest = store.add(session);

    addRequest.onsuccess = () => {
      console.log(`[SessionDB] ✅ Đã lưu session: ${session.name} (${session.saveType})`);
      resolve(session);
    };

    addRequest.onerror = () => {
      console.error('[SessionDB] ❌ Lỗi lưu session:', addRequest.error);
      reject(addRequest.error);
    };

    tx.oncomplete = () => {
      db.close();
      // Dọn dẹp session cũ (async, không block)
      cleanupOldSessions().catch(err => console.warn('[SessionDB] Cleanup failed:', err));
    };
  });
}

/**
 * Cập nhật session đã tồn tại (dùng cho auto-save overwrite).
 * Cập nhật lại updatedAt timestamp.
 */
export async function updateSession(id: string, data: Partial<SessionData>): Promise<SessionData | null> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    // Đọc session hiện tại
    const getRequest = store.get(id);

    getRequest.onsuccess = () => {
      const existing = getRequest.result as SessionData | undefined;
      if (!existing) {
        console.warn(`[SessionDB] ⚠️ Không tìm thấy session ID: ${id}`);
        resolve(null);
        return;
      }

      // Merge dữ liệu mới vào session cũ
      const updated: SessionData = {
        ...existing,
        ...data,
        id: existing.id, // Không cho phép thay đổi ID
        createdAt: existing.createdAt, // Giữ nguyên thời gian tạo
        updatedAt: Date.now(), // Cập nhật thời gian sửa
      };

      const putRequest = store.put(updated);

      putRequest.onsuccess = () => {
        console.log(`[SessionDB] ✅ Đã cập nhật session: ${updated.name}`);
        resolve(updated);
      };

      putRequest.onerror = () => {
        reject(putRequest.error);
      };
    };

    getRequest.onerror = () => {
      reject(getRequest.error);
    };

    tx.oncomplete = () => db.close();
  });
}

/**
 * Lấy danh sách tất cả sessions, sắp xếp theo updatedAt giảm dần (mới nhất trước).
 */
export async function getAllSessions(): Promise<SessionData[]> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('updatedAt');

    // Duyệt ngược (mới nhất trước) bằng prev cursor direction
    const sessions: SessionData[] = [];
    const cursorRequest = index.openCursor(null, 'prev');

    cursorRequest.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        sessions.push(cursor.value as SessionData);
        cursor.continue();
      } else {
        resolve(sessions);
      }
    };

    cursorRequest.onerror = () => {
      reject(cursorRequest.error);
    };

    tx.oncomplete = () => db.close();
  });
}

/**
 * Lấy một session theo ID.
 */
export async function getSession(id: string): Promise<SessionData | null> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);

    request.onsuccess = () => {
      resolve(request.result as SessionData | null);
    };

    request.onerror = () => {
      reject(request.error);
    };

    tx.oncomplete = () => db.close();
  });
}

/**
 * Xóa một session theo ID.
 */
export async function deleteSession(id: string): Promise<void> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);

    request.onsuccess = () => {
      console.log(`[SessionDB] 🗑️ Đã xóa session: ${id}`);
      resolve();
    };

    request.onerror = () => {
      reject(request.error);
    };

    tx.oncomplete = () => db.close();
  });
}

/**
 * Đổi tên session.
 */
export async function renameSession(id: string, newName: string): Promise<SessionData | null> {
  return updateSession(id, { name: newName });
}

/**
 * Xóa sessions cũ nhất nếu tổng số vượt quá MAX_SESSIONS.
 * Đơn giản: xóa cũ nhất trước (đã sort mới nhất → cuối = cũ nhất).
 */
async function cleanupOldSessions(): Promise<void> {
  const sessions = await getAllSessions();

  if (sessions.length <= MAX_SESSIONS) return;

  // Xóa session cũ nhất (cuối danh sách — đã sort mới nhất trước)
  const toDelete = sessions.length - MAX_SESSIONS;
  const oldest = sessions.slice(-toDelete);

  for (const session of oldest) {
    await deleteSession(session.id);
  }

  console.log(`[SessionDB] 🧹 Đã dọn dẹp ${toDelete} sessions cũ`);
}

/**
 * Lấy session auto-save gần nhất (nếu có).
 * Dùng để tìm session auto-save cũ và overwrite thay vì tạo mới liên tục.
 */
export async function getLatestAutoSaveSession(): Promise<SessionData | null> {
  const sessions = await getAllSessions();
  // Đã sort mới nhất trước, tìm auto-save đầu tiên
  return sessions.find(s => s.saveType === 'auto') || null;
}

/**
 * Đếm số sessions hiện có.
 */
export async function getSessionCount(): Promise<number> {
  const sessions = await getAllSessions();
  return sessions.length;
}
