/**
 * useBugReporter.ts
 * Hook React để:
 * 1. Subscribe vào bugReportService (re-render khi có bug mới)
 * 2. Cung cấp handlers để dùng trong JSX (onClick, onTextSelect...)
 * 3. Expose helpers để set active tab
 */

import { useState, useEffect, useCallback } from 'react';
import { bugReportService } from '@/services/bugReportService';
import type { BugEntry, UXInsight, BehaviorEvent, Annotation } from '@/services/bugReportService';

export interface UseBugReporterReturn {
  bugs:          BugEntry[];
  insights:      UXInsight[];
  behaviors:     BehaviorEvent[];
  annotations:   Annotation[];       // ghi chú trực tiếp trên UI
  errorCount:    number;
  warnCount:     number;
  insightCount:  number;

  /** Đặt tab hiện tại để bug context biết đang ở đâu */
  setActiveTab:  (tabName: string) => void;

  /** Tạo report dạng text để copy paste cho AI */
  generateReport: () => string;

  /** Export JSON đầy đủ */
  exportJSON: () => string;

  /** Xoá toàn bộ session — KHÔNG xoá cache hay IndexedDB */
  clearAll: () => void;

  /** Thêm bug thủ công (ví dụ từ ErrorBoundary) */
  addBug: (params: Omit<BugEntry, 'id' | 'ts' | 'context'>) => void;

  /** Thêm / xoá annotation */
  addAnnotation:    (params: Omit<Annotation, 'id' | 'ts'>) => void;
  removeAnnotation: (id: string) => void;
}

export function useBugReporter(): UseBugReporterReturn {
  // State local — sẽ sync với service
  const [bugs,        setBugs]        = useState<BugEntry[]>(()       => bugReportService.getBugs());
  const [insights,    setInsights]    = useState<UXInsight[]>(()      => bugReportService.getInsights());
  const [behaviors,   setBehaviors]   = useState<BehaviorEvent[]>(()  => bugReportService.getBehaviors());
  const [annotations, setAnnotations] = useState<Annotation[]>(()     => bugReportService.getAnnotations());

  // Subscribe: mỗi khi service notify → cập nhật state → panel re-render
  useEffect(() => {
    const unsubscribe = bugReportService.subscribe(() => {
      setBugs([...bugReportService.getBugs()]);
      setInsights([...bugReportService.getInsights()]);
      setBehaviors([...bugReportService.getBehaviors()]);
      setAnnotations([...bugReportService.getAnnotations()]);
    });
    return unsubscribe; // cleanup khi unmount
  }, []);

  const setActiveTab   = useCallback((tabName: string) => bugReportService.setActiveTab(tabName), []);
  const generateReport = useCallback(() => bugReportService.generateReport(), []);
  const exportJSON     = useCallback(() => bugReportService.exportJSON(), []);
  const clearAll       = useCallback(() => bugReportService.clearAll(), []);
  const addBug         = useCallback(
    (params: Omit<BugEntry, 'id' | 'ts' | 'context'>) => bugReportService.addBug(params), []
  );
  const addAnnotation    = useCallback(
    (params: Omit<Annotation, 'id' | 'ts'>) => bugReportService.addAnnotation(params), []
  );
  const removeAnnotation = useCallback(
    (id: string) => bugReportService.removeAnnotation(id), []
  );

  return {
    bugs,
    insights,
    behaviors,
    annotations,
    errorCount:   bugs.filter(b => b.level === 'error').length,
    warnCount:    bugs.filter(b => b.level === 'warn').length,
    insightCount: insights.length,
    setActiveTab,
    generateReport,
    exportJSON,
    clearAll,
    addBug,
    addAnnotation,
    removeAnnotation,
  };
}
