/**
 * useSessionManager.ts
 * 
 * Hook quản lý session: tự động lưu mỗi 5 phút, lưu khi Ctrl+S,
 * và cung cấp hàm khôi phục session.
 * 
 * Hook này kết nối với các Context hiện có (Transcript, Settings, Resolve, Project)
 * để thu thập trạng thái app và lưu vào IndexedDB.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranscript } from '@/contexts/TranscriptContext';
import { useSettings } from '@/contexts/SettingsContext';
import { useResolve } from '@/contexts/ResolveContext';
import { useProject } from '@/contexts/ProjectContext';
import type { ProjectData } from '@/contexts/ProjectContext';
import { getDebugLogs, setDebugLogs, DebugLogEntry } from '@/services/debug-logger';
import {
  saveSession,
  updateSession,
  getAllSessions,
  getSession,
  deleteSession,
  renameSession,
  SessionData,
} from '@/services/session-db';

// ===== CONSTANTS =====

/** Thời gian auto-save: 5 phút (ms) */
const AUTO_SAVE_INTERVAL_MS = 5 * 60 * 1000;

// ===== INTERFACE =====

/** Callback khi restore session — truyền active tab để parent component set lại */
export interface SessionRestoreCallbacks {
  setActiveTab?: (tab: string) => void;
  setFileInput?: (file: string | null) => void;
}

/** Return type của hook */
export interface SessionManagerReturn {
  /** Danh sách tất cả sessions */
  sessions: SessionData[];

  /** Session đang active hiện tại (null = chưa có session nào) */
  currentSession: SessionData | null;

  /** Đang loading danh sách sessions */
  isLoading: boolean;

  /** Thời điểm lưu gần nhất (hiển thị "Saved 2 min ago") */
  lastSavedAt: number | null;

  /** Tự động lưu đang bật/tắt */
  autoSaveEnabled: boolean;

  /** Bật/tắt auto-save */
  setAutoSaveEnabled: (enabled: boolean) => void;

  /** Lưu session thủ công (Ctrl+S) */
  saveManualSession: () => Promise<SessionData | null>;

  /** Khôi phục (restore) một session */
  restoreSession: (sessionId: string) => Promise<boolean>;

  /** Xóa một session */
  removeSession: (sessionId: string) => Promise<void>;

  /** Đổi tên session */
  renameSessionById: (sessionId: string, newName: string) => Promise<void>;

  /** Refresh danh sách sessions từ DB */
  refreshSessions: () => Promise<void>;
}

// ===== HELPER: TẠO TÊN SESSION TỰ ĐỘNG =====

/**
 * Sinh tên session tự động dựa trên ngữ cảnh hiện tại.
 * Ví dụ: "Timeline A - 12/03 22:30" hoặc "Standalone - video.mp4"
 */
function generateSessionName(
  timelineName: string | undefined,
  fileInput: string | null,
  isStandaloneMode: boolean,
  saveType: 'auto' | 'manual'
): string {
  // Lấy timestamp hiển thị
  const now = new Date();
  const timeStr = now.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  // Prefix theo loại save
  const prefix = saveType === 'auto' ? '🔄' : '💾';

  // Tên dựa trên context
  if (isStandaloneMode && fileInput) {
    // Lấy tên file từ đường dẫn
    const fileName = fileInput.split('/').pop()?.split('\\').pop() || fileInput;
    return `${prefix} ${fileName} — ${timeStr}`;
  } else if (timelineName) {
    return `${prefix} ${timelineName} — ${timeStr}`;
  } else {
    return `${prefix} Session — ${timeStr}`;
  }
}

// ===== HOOK CHÍNH =====

export function useSessionManager(callbacks?: SessionRestoreCallbacks) {
  // === Lấy state từ các Context ===
  const { subtitles, speakers, setSubtitles, setSpeakers, setCurrentTranscriptFilename } = useTranscript();
  const { settings } = useSettings();
  const { timelineInfo } = useResolve();
  // ProjectContext — lưu toàn bộ dữ liệu dự án (tất cả các tab)
  const { project, setProjectData } = useProject();

  // === Local state ===
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [currentSession, setCurrentSession] = useState<SessionData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true);

  // Ref để tránh stale closures trong timer
  const stateRef = useRef({
    subtitles,
    speakers,
    settings,
    timelineInfo,
    autoSaveEnabled,
    project, // Thêm project data vào ref
  });

  // Cập nhật ref mỗi khi state thay đổi
  useEffect(() => {
    stateRef.current = {
      subtitles,
      speakers,
      settings,
      timelineInfo,
      autoSaveEnabled,
      project, // Track project data thay đổi
    };
  }, [subtitles, speakers, settings, timelineInfo, autoSaveEnabled, project]);

  // Ref cho currentSession — để saveCurrentSession luôn đọc được giá trị mới nhất
  const currentSessionRef = useRef<SessionData | null>(null);

  // Wrapper setCurrentSession: đồng bộ cả state lẫn ref
  const updateCurrentSession = useCallback((session: SessionData | null) => {
    currentSessionRef.current = session;
    setCurrentSession(session);
  }, []);

  // ===== THU THẬP TRẠNG THÁI HIỆN TẠI =====

  /**
   * Thu thập toàn bộ trạng thái app để lưu vào session.
   * Bao gồm cả project data (dữ liệu từ tất cả các tab).
   * Đọc từ ref để có giá trị mới nhất (tránh stale closure).
   */
  const collectCurrentState = useCallback(() => {
    const state = stateRef.current;
    return {
      subtitles: state.subtitles,
      speakers: state.speakers,
      settings: state.settings,
      timelineInfo: state.timelineInfo,
      activeTab: 'subtitles', // Mặc định, sẽ được override bởi parent
      fileInput: null as string | null,
      currentTranscriptFilename: null as string | null,
      // ⭐ Kèm theo toàn bộ project data (Music, SFX, Highlight, VoicePacing, Media Import...)
      projectData: state.project,
      // ⭐ Kèm theo debug logs (request/response) nếu có
      debugLogs: getDebugLogs(),
    };
  }, []);

  // ===== LƯU SESSION (CẢ THỦ CÔNG Ctrl+S LẪN AUTO-SAVE) =====
  // Logic chung: đã có currentSession → cập nhật (overwrite), chưa có → tạo mới

  /**
   * Lưu session: nếu đã có session active thì UPDATE, chưa có thì TẠO MỚI.
   * Ctrl+S và auto-save đều gọi hàm này.
   * @param source - 'manual' (Ctrl+S) hoặc 'auto' (timer) — chỉ dùng cho log
   */
  const saveCurrentSession = useCallback(async (source: 'manual' | 'auto' = 'manual'): Promise<SessionData | null> => {
    try {
      const currentState = collectCurrentState();
      const state = stateRef.current;

      // Lấy ID session đang active (nếu có)
      const activeId = currentSessionRef.current?.id || null;

      if (activeId) {
        // ===== CẬP NHẬT session đang active =====
        const updated = await updateSession(activeId, {
          // Giữ nguyên tên cũ (user đã đổi tên thì giữ)
          ...currentState,
        });

        if (updated) {
          setLastSavedAt(Date.now());
          updateCurrentSession(updated);
          await refreshSessions();
          console.log(`[SessionManager] 💾 Đã cập nhật session (${source}):`, updated.name);
          return updated;
        }

        // Nếu update thất bại (session đã bị xóa?) → tạo mới bên dưới
        console.warn('[SessionManager] ⚠️ Update thất bại, tạo session mới...');
      }

      // ===== TẠO MỚI session =====
      const session = await saveSession({
        name: generateSessionName(
          state.timelineInfo?.name,
          currentState.fileInput,
          state.settings.isStandaloneMode,
          source
        ),
        saveType: source, // Chỉ dùng cho badge hiển thị lần đầu
        ...currentState,
      });

      setLastSavedAt(Date.now());
      updateCurrentSession(session);
      await refreshSessions();

      console.log(`[SessionManager] 💾 Đã tạo session mới (${source}):`, session.name);
      return session;
    } catch (error) {
      console.error(`[SessionManager] ❌ Lỗi lưu session (${source}):`, error);
      return null;
    }
  }, [collectCurrentState]);

  // Wrapper cho Ctrl+S (giữ interface cũ)
  const saveManualSession = useCallback(async (): Promise<SessionData | null> => {
    return saveCurrentSession('manual');
  }, [saveCurrentSession]);

  // ===== TỰ ĐỘNG LƯU (MỖI 5 PHÚT) =====

  const performAutoSave = useCallback(async () => {
    // Bỏ qua nếu auto-save tắt
    if (!stateRef.current.autoSaveEnabled) return;

    // Bỏ qua nếu không có dữ liệu gì để lưu
    if (stateRef.current.subtitles.length === 0 && !stateRef.current.timelineInfo?.timelineId) {
      console.log('[SessionManager] ⏭️ Bỏ qua auto-save: không có dữ liệu');
      return;
    }

    await saveCurrentSession('auto');
  }, [saveCurrentSession]);

  // ===== DEBOUNCED AUTO-SAVE KHI PROJECT DATA THAY ĐỔI =====
  // Khi có thay đổi quan trọng (matching, music, script...) → lưu sau 10 giây
  // Tránh mất data nếu user chạy matching nhưng auto-save 5 phút chưa kịp lưu

  const debounceSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track giá trị trước đó để detect sự thay đổi thực sự
  const prevProjectFingerprintRef = useRef<string>('');

  useEffect(() => {
    // Chỉ chạy khi đã có session active (đã tạo/restore rồi)
    if (!currentSessionRef.current) return;
    if (!stateRef.current.autoSaveEnabled) return;

    // Tạo "fingerprint" đơn giản từ các trường quan trọng
    const p = project;
    const fingerprint = [
      p.matchingSentences?.length || 0,
      p.matchingFolder || '',
      p.scriptText?.length || 0,
      p.mediaImport?.matchedSentences?.length || 0,
      p.imageImport?.matchResults?.length || 0,
      p.musicLibrary?.musicItems?.length || 0,
      p.musicLibrary?.directorResult ? 'Y' : 'N',
      p.sfxLibrary?.sfxPlan ? 'Y' : 'N',
      p.highlightText?.highlightPlan ? 'Y' : 'N',
      p.voicePacing?.pauseResults?.length || 0,
      p.templateAssignment?.assignmentResult ? 'Y' : 'N',
    ].join('|');

    // Chỉ trigger save khi fingerprint thay đổi (tránh loop vô tận)
    if (fingerprint === prevProjectFingerprintRef.current) return;
    prevProjectFingerprintRef.current = fingerprint;

    // Clear debounce cũ
    if (debounceSaveRef.current) clearTimeout(debounceSaveRef.current);

    // Debounce 10 giây — đủ thời gian cho data ổn định
    debounceSaveRef.current = setTimeout(() => {
      console.log('[SessionManager] 🔄 Project data thay đổi → auto-save debounced (10s)');
      saveCurrentSession('auto');
    }, 10000);

    return () => {
      if (debounceSaveRef.current) clearTimeout(debounceSaveRef.current);
    };
  }, [project, saveCurrentSession]);

  // ===== KHÔI PHỤC SESSION =====

  const restoreSession = useCallback(async (sessionId: string): Promise<boolean> => {
    try {
      const session = await getSession(sessionId);
      if (!session) {
        console.warn('[SessionManager] ⚠️ Không tìm thấy session:', sessionId);
        return false;
      }

      // Khôi phục subtitles & speakers
      if (session.subtitles) {
        setSubtitles(session.subtitles);
      }
      if (session.speakers) {
        setSpeakers(session.speakers);
      }

      // Khôi phục transcript filename
      if (session.currentTranscriptFilename) {
        setCurrentTranscriptFilename(session.currentTranscriptFilename);
      }

      // ⭐ Khôi phục toàn bộ project data (Music, SFX, VoicePacing, Media Import...)
      if (session.projectData) {
        setProjectData(session.projectData as ProjectData);
        console.log('[SessionManager] 📦 Đã khôi phục project data');
      }

      // ⭐ Khôi phục debug logs (request/response từ Debug Panel)
      if (session.debugLogs && Array.isArray(session.debugLogs)) {
        // Chuyển lại timestamp từ string về Date (JSON serialize thành string)
        const restoredLogs = (session.debugLogs as DebugLogEntry[]).map(log => ({
          ...log,
          timestamp: new Date(log.timestamp),
        }));
        setDebugLogs(restoredLogs);
        console.log(`[SessionManager] 🔍 Đã khôi phục ${restoredLogs.length} debug logs`);
      }

      // Khôi phục active tab thông qua callback
      if (session.activeTab && callbacks?.setActiveTab) {
        callbacks.setActiveTab(session.activeTab);
      }

      // Khôi phục file input thông qua callback
      if (session.fileInput !== undefined && callbacks?.setFileInput) {
        callbacks.setFileInput(session.fileInput);
      }

      // Đánh dấu session đang active khi restore
      updateCurrentSession(session);

      console.log('[SessionManager] ✅ Đã khôi phục session:', session.name);
      return true;
    } catch (error) {
      console.error('[SessionManager] ❌ Lỗi khôi phục session:', error);
      return false;
    }
  }, [setSubtitles, setSpeakers, setCurrentTranscriptFilename, callbacks]);

  // ===== XÓA SESSION =====

  const removeSession = useCallback(async (sessionId: string) => {
    try {
      await deleteSession(sessionId);
      // Nếu xóa session đang active, reset currentSession
      if (currentSessionRef.current?.id === sessionId) {
        updateCurrentSession(null);
      }
      await refreshSessions();
      console.log('[SessionManager] 🗑️ Đã xóa session:', sessionId);
    } catch (error) {
      console.error('[SessionManager] ❌ Lỗi xóa session:', error);
    }
  }, []);

  // ===== ĐỔI TÊN SESSION =====

  const renameSessionById = useCallback(async (sessionId: string, newName: string) => {
    try {
      const updated = await renameSession(sessionId, newName);
      // Cập nhật currentSession nếu đang rename session active
      if (updated) {
        if (currentSessionRef.current?.id === sessionId) {
          updateCurrentSession(updated);
        }
      }
      await refreshSessions();
    } catch (error) {
      console.error('[SessionManager] ❌ Lỗi đổi tên session:', error);
    }
  }, []);

  // ===== REFRESH DANH SÁCH =====

  const refreshSessions = useCallback(async () => {
    setIsLoading(true);
    try {
      const allSessions = await getAllSessions();
      setSessions(allSessions);
    } catch (error) {
      console.error('[SessionManager] ❌ Lỗi đọc danh sách sessions:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // ===== EFFECT: LOAD SESSIONS KHI MOUNT =====

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  // ===== EFFECT: AUTO-SAVE TIMER (MỖI 5 PHÚT) =====

  useEffect(() => {
    if (!autoSaveEnabled) return;

    const timer = setInterval(() => {
      performAutoSave();
    }, AUTO_SAVE_INTERVAL_MS);

    console.log('[SessionManager] ⏰ Bắt đầu auto-save timer (5 phút)');

    return () => {
      clearInterval(timer);
      console.log('[SessionManager] ⏰ Dừng auto-save timer');
    };
  }, [autoSaveEnabled, performAutoSave]);

  // ===== EFFECT: BẮT CTRL+S =====

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+S (Windows/Linux) hoặc Cmd+S (macOS)
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault(); // Ngăn hành vi mặc định của trình duyệt
        console.log('[SessionManager] ⌨️ Ctrl+S detected — lưu session thủ công');
        saveManualSession();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [saveManualSession]);

  // ===== RETURN =====

  return {
    sessions,
    currentSession,
    isLoading,
    lastSavedAt,
    autoSaveEnabled,
    setAutoSaveEnabled,
    saveManualSession,
    restoreSession,
    removeSession,
    renameSessionById,
    refreshSessions,
  } satisfies SessionManagerReturn;
}
