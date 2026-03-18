/**
 * ProjectContext.tsx
 *
 * Context chung lưu trữ TOÀN BỘ dữ liệu dự án.
 * Dữ liệu từ tab này → dùng tiếp ở tab khác.
 * Session manager sẽ save/restore toàn bộ state này.
 *
 * Cấu trúc:
 *  - Shared data (matchingFolder, matchingSentences, scriptText)
 *  - Per-tab data (mediaImport, imageImport, musicLibrary, sfxLibrary,
 *                  highlightText, voicePacing, templateAssignment)
 */

import React, { createContext, useContext, useState, useCallback } from 'react';

// ===== IMPORT TYPES TỪ CÁC MODULE =====
import type { MatchingSentence, AISfxPlanResult, AIHighlightPlanResult } from '@/services/audio-director-service';
import type { ScriptSentence } from '@/utils/media-matcher';
import type { AudioLibraryItem, AIDirectorResult, SubtitleLine } from '@/types/audio-types';
import type { PauseResult } from '@/services/voice-pacing-service';
import type { ImageMatchResult } from '@/utils/image-matcher';
import type { AITemplateAssignmentResult } from '@/services/template-assignment-service';
import type { WordMatchResult } from '@/utils/whisper-words-matcher';

// ===== INTERFACE: DỮ LIỆU TỪNG TAB =====

/** Tab Media Import — import video vào timeline */
export interface MediaImportData {
  mediaFolder: string;
  mediaFiles: string[];
  matchedSentences: ScriptSentence[];
  selectedTrack: string;
}

/** Tab Image Import — import ảnh vào timeline */
export interface ImageImportData {
  imageFolder: string;
  imageFiles: string[];
  /** Script text dạng đánh số (user paste trực tiếp) */
  scriptText: string;
  matchedSentences: ScriptSentence[];
  matchResults: ImageMatchResult[];
  selectedTrack: string;
  /** Danh sách scene number đã import thành công lên timeline */
  importedScenes: number[];
}

/** Tab Music Library — quản lý nhạc nền + AI gợi ý */
export interface MusicLibraryData {
  musicFolder: string;
  musicItems: AudioLibraryItem[];
  directorResult: AIDirectorResult | null;
}

/** Tab SFX Library — kế hoạch hiệu ứng âm thanh */
export interface SfxLibraryData {
  sfxPlan: AISfxPlanResult | null;
  sfxFolder: string;
  sfxItems: AudioLibraryItem[];
  /** Đường dẫn file autosubs_whisper_words.txt — dùng cho matching timing chính xác */
  whisperWordsPath: string;
}

/** Tab Highlight Text — các cụm từ đắt giá */
export interface HighlightTextData {
  highlightPlan: AIHighlightPlanResult | null;
}

/** Tab Voice Pacing — chỉnh nhịp voice */
export interface VoicePacingData {
  mediaFolder: string;
  matchedSentences: ScriptSentence[];
  audioFile: string;
  srtFile: string;
  pauseResults: PauseResult[];
  srtMappedSentences: ScriptSentence[];
  scriptText: string;
}

/** Tab Template Assignment — gán template cho subtitle */
export interface TemplateAssignmentData {
  /** Thư mục chứa matching.json (riêng cho tab này, khác với shared matchingFolder) */
  matchingFolder: string;
  /** Danh sách câu từ matching.json */
  sentences: MatchingSentence[] | null;
  /** Kết quả AI gán template */
  assignmentResult: AITemplateAssignmentResult | null;
  /** Đường dẫn file whisper words đã load */
  whisperWordsPath: string;
  /** Kết quả matching whisper words — lưu dạng array [sentenceNum, WordMatchResult] (Map không serializable) */
  wordMatchResults: [number, WordMatchResult][];
  /** Track video đích khi áp dụng lên DaVinci */
  selectedTrack: string;
}

/** Tab Phụ Đề — phụ đề stories import lên timeline */
export interface SubtitleData {
  /** Thư mục chứa matching.json dùng để lấy whisper words */
  matchingFolder: string;
  /** Kiịch bản gốc (user paste) — dùng để so khớp phụ đề */
  scriptText: string;
  /** Danh sách dòng phụ đề (sau khi AI tách câu + gán timing) */
  subtitleLines: SubtitleLine[];
  /** Template phụ đề đang chọn trong DaVinci Media Pool */
  selectedTemplate: string;
  /** Track video đích khi import lên DaVinci */
  selectedTrack: string;
  /** Font size cho phụ đề (mặc định 0.04 = Medium) */
  fontSize: number;
}

// ===== INTERFACE: TOÀN BỘ DỮ LIỆU DỰ ÁN =====

export interface ProjectData {
  // === Dữ liệu chia sẻ giữa nhiều tab ===

  /** Thư mục chứa autosubs_matching.json (dùng bởi Music, SFX, Highlight, Template, VoicePacing) */
  matchingFolder: string;

  /** Danh sách câu từ matching.json (dùng bởi Music, SFX, Highlight, Template) */
  matchingSentences: MatchingSentence[] | null;

  /** Script text (kịch bản đánh số) — dùng bởi MediaImport, VoicePacing */
  scriptText: string;

  // === Dữ liệu riêng từng tab ===
  mediaImport: MediaImportData;
  imageImport: ImageImportData;
  musicLibrary: MusicLibraryData;
  sfxLibrary: SfxLibraryData;
  highlightText: HighlightTextData;
  voicePacing: VoicePacingData;
  templateAssignment: TemplateAssignmentData;
  subtitleData: SubtitleData;
}

// ===== GIÁ TRỊ MẶC ĐỊNH =====

export const DEFAULT_PROJECT_DATA: ProjectData = {
  // Shared
  matchingFolder: '',
  matchingSentences: null,
  scriptText: '',

  // Media Import
  mediaImport: {
    mediaFolder: '',
    mediaFiles: [],
    matchedSentences: [],
    selectedTrack: '1',
  },

  // Image Import
  imageImport: {
    imageFolder: '',
    imageFiles: [],
    scriptText: '',
    matchedSentences: [],
    matchResults: [],
    selectedTrack: '1',
    importedScenes: [],
  },

  // Music Library
  musicLibrary: {
    musicFolder: '',
    musicItems: [],
    directorResult: null,
  },

  // SFX Library
  sfxLibrary: {
    sfxPlan: null,
    sfxFolder: '',
    sfxItems: [],
    whisperWordsPath: '',
  },

  // Highlight Text
  highlightText: {
    highlightPlan: null,
  },

  // Voice Pacing
  voicePacing: {
    mediaFolder: '',
    matchedSentences: [],
    audioFile: '',
    srtFile: '',
    pauseResults: [],
    srtMappedSentences: [],
    scriptText: '',
  },

  // Template Assignment
  templateAssignment: {
    matchingFolder: '',
    sentences: null,
    assignmentResult: null,
    whisperWordsPath: '',
    wordMatchResults: [],
    selectedTrack: '2',
  },

  // Subtitle (Phụ Đề)
  subtitleData: {
    matchingFolder: '',
    scriptText: '',
    subtitleLines: [],
    selectedTemplate: 'Subtitle Default',
    selectedTrack: '0',
    fontSize: 0.04,
  },
};

// ===== CONTEXT TYPE =====

interface ProjectContextType {
  /** Toàn bộ dữ liệu dự án */
  project: ProjectData;

  // --- Setter cho shared data ---
  setMatchingFolder: (folder: string) => void;
  setMatchingSentences: (sentences: MatchingSentence[] | null) => void;
  setScriptText: (text: string) => void;

  // --- Setter cho từng tab section (merge partial) ---
  updateMediaImport: (partial: Partial<MediaImportData>) => void;
  updateImageImport: (partial: Partial<ImageImportData>) => void;
  updateMusicLibrary: (partial: Partial<MusicLibraryData>) => void;
  updateSfxLibrary: (partial: Partial<SfxLibraryData>) => void;
  updateHighlightText: (partial: Partial<HighlightTextData>) => void;
  updateVoicePacing: (partial: Partial<VoicePacingData>) => void;
  updateTemplateAssignment: (partial: Partial<TemplateAssignmentData>) => void;
  updateSubtitleData: (partial: Partial<SubtitleData>) => void;

  /** Ghi đè toàn bộ project data (dùng khi restore session) */
  setProjectData: (data: ProjectData) => void;

  /** Reset về trạng thái ban đầu */
  resetProject: () => void;
}

const ProjectContext = createContext<ProjectContextType | null>(null);

// ===== PROVIDER =====

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const [project, setProject] = useState<ProjectData>(DEFAULT_PROJECT_DATA);

  // --- Setter cho shared data ---

  const setMatchingFolder = useCallback((folder: string) => {
    setProject(prev => ({ ...prev, matchingFolder: folder }));
  }, []);

  const setMatchingSentences = useCallback((sentences: MatchingSentence[] | null) => {
    setProject(prev => ({ ...prev, matchingSentences: sentences }));
  }, []);

  const setScriptText = useCallback((text: string) => {
    setProject(prev => ({ ...prev, scriptText: text }));
  }, []);

  // --- Setter cho từng tab (merge partial data) ---

  const updateMediaImport = useCallback((partial: Partial<MediaImportData>) => {
    setProject(prev => ({
      ...prev,
      mediaImport: { ...prev.mediaImport, ...partial },
    }));
  }, []);

  const updateImageImport = useCallback((partial: Partial<ImageImportData>) => {
    setProject(prev => ({
      ...prev,
      imageImport: { ...prev.imageImport, ...partial },
    }));
  }, []);

  const updateMusicLibrary = useCallback((partial: Partial<MusicLibraryData>) => {
    setProject(prev => ({
      ...prev,
      musicLibrary: { ...prev.musicLibrary, ...partial },
    }));
  }, []);

  const updateSfxLibrary = useCallback((partial: Partial<SfxLibraryData>) => {
    setProject(prev => ({
      ...prev,
      sfxLibrary: { ...prev.sfxLibrary, ...partial },
    }));
  }, []);

  const updateHighlightText = useCallback((partial: Partial<HighlightTextData>) => {
    setProject(prev => ({
      ...prev,
      highlightText: { ...prev.highlightText, ...partial },
    }));
  }, []);

  const updateVoicePacing = useCallback((partial: Partial<VoicePacingData>) => {
    setProject(prev => ({
      ...prev,
      voicePacing: { ...prev.voicePacing, ...partial },
    }));
  }, []);

  const updateTemplateAssignment = useCallback((partial: Partial<TemplateAssignmentData>) => {
    setProject(prev => ({
      ...prev,
      templateAssignment: { ...prev.templateAssignment, ...partial },
    }));
  }, []);

  const updateSubtitleData = useCallback((partial: Partial<SubtitleData>) => {
    setProject(prev => ({
      ...prev,
      subtitleData: { ...prev.subtitleData, ...partial },
    }));
  }, []);

  // --- Bulk operations ---

  const setProjectData = useCallback((data: ProjectData) => {
    // Merge với DEFAULT_PROJECT_DATA để đảm bảo các trường mới (như subtitleData) 
    // không bị undefined khi khôi phục từ session cũ.
    setProject({
      ...DEFAULT_PROJECT_DATA,
      ...data,
      mediaImport: { ...DEFAULT_PROJECT_DATA.mediaImport, ...(data.mediaImport || {}) },
      imageImport: { ...DEFAULT_PROJECT_DATA.imageImport, ...(data.imageImport || {}) },
      musicLibrary: { ...DEFAULT_PROJECT_DATA.musicLibrary, ...(data.musicLibrary || {}) },
      sfxLibrary: { ...DEFAULT_PROJECT_DATA.sfxLibrary, ...(data.sfxLibrary || {}) },
      highlightText: { ...DEFAULT_PROJECT_DATA.highlightText, ...(data.highlightText || {}) },
      voicePacing: { ...DEFAULT_PROJECT_DATA.voicePacing, ...(data.voicePacing || {}) },
      templateAssignment: { ...DEFAULT_PROJECT_DATA.templateAssignment, ...(data.templateAssignment || {}) },
      subtitleData: { ...DEFAULT_PROJECT_DATA.subtitleData, ...(data.subtitleData || {}) },
    });
  }, []);

  const resetProject = useCallback(() => {
    setProject(DEFAULT_PROJECT_DATA);
  }, []);

  return (
    <ProjectContext.Provider value={{
      project,
      setMatchingFolder,
      setMatchingSentences,
      setScriptText,
      updateMediaImport,
      updateImageImport,
      updateMusicLibrary,
      updateSfxLibrary,
      updateHighlightText,
      updateVoicePacing,
      updateTemplateAssignment,
      updateSubtitleData,
      setProjectData,
      resetProject,
    }}>
      {children}
    </ProjectContext.Provider>
  );
}

// ===== HOOK =====

export const useProject = () => {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error('useProject must be used within a ProjectProvider');
  }
  return context;
};
