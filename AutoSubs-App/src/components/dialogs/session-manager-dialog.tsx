/**
 * session-manager-dialog.tsx
 * 
 * Dialog UI hiển thị danh sách sessions đã lưu.
 * User có thể:
 *  - Khôi phục (restore) session
 *  - Xóa session
 *  - Đổi tên session
 *  - Bật/tắt auto-save
 *  - Lưu session thủ công
 * 
 * Được mở từ nút trên titlebar hoặc bằng Ctrl+Shift+S.
 */

import { useState, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Save,
  RotateCcw,
  Trash2,
  Pencil,
  Check,
  X,
  Clock,
  HardDrive,
  RefreshCw,
  Search,
} from 'lucide-react';
import type { SessionData } from '@/services/session-db';

// ===== INTERFACE =====

interface SessionManagerDialogProps {
  /** Dialog đang mở hay không */
  open: boolean;
  /** Callback khi đóng dialog */
  onOpenChange: (open: boolean) => void;

  /** Danh sách sessions từ hook */
  sessions: SessionData[];
  /** ID của session đang active (null = không có) */
  currentSessionId: string | null;
  /** Đang loading */
  isLoading: boolean;
  /** Thời điểm lưu gần nhất */
  lastSavedAt: number | null;
  /** Auto-save đang bật/tắt */
  autoSaveEnabled: boolean;

  /** Toggle auto-save */
  onAutoSaveChange: (enabled: boolean) => void;
  /** Lưu session */
  onSave: () => Promise<any>;
  /** Khôi phục session */
  onRestore: (sessionId: string) => Promise<boolean>;
  /** Xóa session */
  onDelete: (sessionId: string) => Promise<void>;
  /** Đổi tên session */
  onRename: (sessionId: string, newName: string) => Promise<void>;
  /** Refresh danh sách */
  onRefresh: () => Promise<void>;
}

// ===== HELPER: HIỂN THỊ THỜI GIAN TƯƠNG ĐỐI =====

/**
 * Chuyển timestamp thành chuỗi thời gian tương đối.
 * Ví dụ: "Vừa xong", "3 phút trước", "2 giờ trước", "Hôm qua"...
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'Vừa xong';
  if (diffMin < 60) return `${diffMin} phút trước`;
  if (diffHour < 24) return `${diffHour} giờ trước`;
  if (diffDay < 7) return `${diffDay} ngày trước`;

  // Hiển thị ngày cụ thể
  return new Date(timestamp).toLocaleDateString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Hiển thị thời gian chi tiết (cho tooltip).
 */
function formatFullTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('vi-VN', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// ===== HELPER: PHÂN TÍCH DỮ LIỆU SESSION =====

/** Một mục dữ liệu đã có trong session */
interface DataBadge {
  /** Nhãn hiển thị (ví dụ: "🎵 Music") */
  label: string;
  /** Mô tả chi tiết (cho tooltip) */
  detail: string;
  /** Màu badge */
  color: string;
}

/**
 * Phân tích SessionData → trả về danh sách các phần dữ liệu đã có.
 * Duyệt qua subtitles, transcript, projectData (các tab) để báo cáo.
 */
function getSessionDataSummary(session: SessionData): DataBadge[] {
  const badges: DataBadge[] = [];
  const pd = session.projectData;

  // 1. Subtitles / SRT
  const subCount = session.subtitles?.length || 0;
  if (subCount > 0) {
    badges.push({
      label: '📝 Subs',
      detail: `${subCount} subtitles`,
      color: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400',
    });
  }

  // 2. Speakers
  const speakerCount = session.speakers?.length || 0;
  if (speakerCount > 0) {
    badges.push({
      label: '👤 Speakers',
      detail: `${speakerCount} speakers`,
      color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
    });
  }

  // 3. Transcript file
  if (session.currentTranscriptFilename) {
    badges.push({
      label: '🎙️ Transcript',
      detail: `File: ${session.currentTranscriptFilename}`,
      color: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
    });
  }

  if (!pd) return badges;

  // 4. Shared: matchingSentences
  const matchCount = pd.matchingSentences?.length || 0;
  if (matchCount > 0) {
    badges.push({
      label: '🔗 Matching',
      detail: `${matchCount} câu matching | Folder: ${pd.matchingFolder?.split?.(/[/\\]/)?.pop?.() || '—'}`,
      color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
    });
  }

  // 5. Shared: scriptText
  if (pd.scriptText && pd.scriptText.trim().length > 0) {
    const lineCount = pd.scriptText.split('\n').filter((l: string) => l.trim()).length;
    badges.push({
      label: '📄 Script',
      detail: `${lineCount} dòng script`,
      color: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
    });
  }

  // 6. Media Import
  const mi = pd.mediaImport;
  if (mi?.matchedSentences?.length > 0) {
    badges.push({
      label: '🎬 Media',
      detail: `${mi.matchedSentences.length} câu matched | ${mi.mediaFiles?.length || 0} files`,
      color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    });
  }

  // 7. Image Import
  const ii = pd.imageImport;
  if (ii?.matchResults?.length > 0 || ii?.imageFiles?.length > 0) {
    const matchedCount = ii.matchResults?.filter?.((r: any) => r.quality === 'matched')?.length || 0;
    badges.push({
      label: '🖼️ Image',
      detail: `${ii.imageFiles?.length || 0} ảnh | ${matchedCount} matched`,
      color: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400',
    });
  }

  // 8. Music Library
  const ml = pd.musicLibrary;
  if (ml?.directorResult || ml?.musicItems?.length > 0) {
    badges.push({
      label: '🎵 Music',
      detail: `${ml.musicItems?.length || 0} tracks${ml.directorResult ? ' | Có AI Director' : ''}`,
      color: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
    });
  }

  // 9. SFX Library
  const sfx = pd.sfxLibrary;
  if (sfx?.sfxPlan || sfx?.sfxItems?.length > 0) {
    badges.push({
      label: '🔊 SFX',
      detail: `${sfx.sfxItems?.length || 0} sfx items${sfx.sfxPlan ? ' | Có kế hoạch AI' : ''}`,
      color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    });
  }

  // 10. Highlight Text
  const ht = pd.highlightText;
  if (ht?.highlightPlan) {
    badges.push({
      label: '✨ Highlight',
      detail: 'Có kế hoạch highlight text',
      color: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
    });
  }

  // 11. Voice Pacing
  const vp = pd.voicePacing;
  if (vp?.pauseResults?.length > 0 || vp?.srtMappedSentences?.length > 0) {
    badges.push({
      label: '🎤 Pacing',
      detail: `${vp.pauseResults?.length || 0} pause results | ${vp.srtMappedSentences?.length || 0} SRT mapped`,
      color: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
    });
  }

  // 12. Template Assignment
  const ta = pd.templateAssignment;
  if (ta?.assignmentResult?.assignments?.length > 0) {
    badges.push({
      label: '🏷️ Template',
      detail: `${ta.assignmentResult.assignments.length} câu đã gán template`,
      color: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
    });
  }

  return badges;
}

// ===== SESSION ITEM COMPONENT =====

interface SessionItemProps {
  session: SessionData;
  /** Session này có đang active không */
  isActive: boolean;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, newName: string) => void;
  isRestoring: boolean;
}

function SessionItem({ session, isActive, onRestore, onDelete, onRename, isRestoring }: SessionItemProps) {
  // State cho chế độ đổi tên
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(session.name);

  // State cho confirm xóa
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Xử lý lưu tên mới
  const handleSaveName = () => {
    if (editName.trim() && editName !== session.name) {
      onRename(session.id, editName.trim());
    }
    setIsEditing(false);
  };

  // Hủy đổi tên
  const handleCancelEdit = () => {
    setEditName(session.name);
    setIsEditing(false);
  };

  // Số subtitle trong session
  const subtitleCount = session.subtitles?.length || 0;

  return (
    <>
      <div className={`group flex items-start gap-3 p-3 rounded-lg border transition-colors
        ${isActive
          ? 'bg-primary/5 border-primary/30 ring-1 ring-primary/20'
          : 'bg-card hover:bg-accent/50 border-border'
        }`}
      >
        {/* Icon session */}
        <div className="mt-0.5 flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm
          bg-green-100 text-green-600 dark:bg-green-900/50 dark:text-green-400"
        >
          <Save className="h-3.5 w-3.5" />
        </div>

        {/* Nội dung chính */}
        <div className="flex-1 min-w-0">
          {isEditing ? (
            /* Chế độ đổi tên */
            <div className="flex items-center gap-1.5">
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="h-7 text-sm"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveName();
                  if (e.key === 'Escape') handleCancelEdit();
                }}
              />
              <Button variant="ghost" size="icon-sm" className="h-7 w-7" onClick={handleSaveName}>
                <Check className="h-3.5 w-3.5 text-green-600" />
              </Button>
              <Button variant="ghost" size="icon-sm" className="h-7 w-7" onClick={handleCancelEdit}>
                <X className="h-3.5 w-3.5 text-red-500" />
              </Button>
            </div>
          ) : (
            /* Hiển thị tên session */
            <p className="text-sm font-medium truncate flex items-center gap-1.5">
              {session.name}
              {/* Badge đang dùng */}
              {isActive && (
                <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-semibold uppercase tracking-wider">
                  Đang dùng
                </span>
              )}
            </p>
          )}

          {/* Thông tin phụ */}
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            {/* Thời gian */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-1 cursor-default">
                  <Clock className="h-3 w-3" />
                  {formatRelativeTime(session.updatedAt)}
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>Tạo: {formatFullTime(session.createdAt)}</p>
                <p>Cập nhật: {formatFullTime(session.updatedAt)}</p>
              </TooltipContent>
            </Tooltip>

            {/* Số subtitles */}
            <span className="flex items-center gap-1">
              <HardDrive className="h-3 w-3" />
              {subtitleCount} subs
            </span>
          </div>

          {/* Timeline info */}
          {session.timelineInfo?.name && (
            <p className="text-[11px] text-muted-foreground mt-1 truncate">
              📁 {session.timelineInfo.projectName && `${session.timelineInfo.projectName} › `}
              {session.timelineInfo.name}
            </p>
          )}

          {/* === Badges dữ liệu đã có trong session === */}
          {(() => {
            const badges = getSessionDataSummary(session);
            if (badges.length === 0) return null;
            return (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {badges.map((badge, idx) => (
                  <Tooltip key={idx}>
                    <TooltipTrigger asChild>
                      <span
                        className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium leading-tight cursor-default ${badge.color}`}
                      >
                        {badge.label}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-[11px]">
                      {badge.detail}
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            );
          })()}
        </div>

        {/* Nút hành động — LUÔN HIỆN để user dễ thấy */}
        <div className="flex items-center gap-1 flex-shrink-0 ml-auto">
          {/* Khôi phục */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-8 w-8 text-blue-600 hover:text-blue-700 hover:bg-blue-100 dark:text-blue-400 dark:hover:bg-blue-900/50"
                onClick={() => onRestore(session.id)}
                disabled={isRestoring}
              >
                <RotateCcw className={`h-4 w-4 ${isRestoring ? 'animate-spin' : ''}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Khôi phục bản này</TooltipContent>
          </Tooltip>

          {/* Đổi tên */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setEditName(session.name);
                  setIsEditing(true);
                }}
              >
                <Pencil className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Sửa tên</TooltipContent>
          </Tooltip>

          {/* Xoá */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/50"
                onClick={() => setShowDeleteConfirm(true)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Xoá bỏ</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Confirm dialog xóa */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xóa session?</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn có chắc muốn xóa session "{session.name}"?
              Hành động này không thể hoàn tác.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => onDelete(session.id)}
            >
              Xóa
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ===== DIALOG COMPONENT CHÍNH =====

export function SessionManagerDialog({
  open,
  onOpenChange,
  sessions,
  currentSessionId,
  isLoading,
  lastSavedAt,
  autoSaveEnabled,
  onAutoSaveChange,
  onSave,
  onRestore,
  onDelete,
  onRename,
  onRefresh,
}: SessionManagerDialogProps) {
  // State cho tìm kiếm
  const [searchQuery, setSearchQuery] = useState('');
  // State cho quá trình restoring
  const [restoringId, setRestoringId] = useState<string | null>(null);
  // State cho saving
  const [isSaving, setIsSaving] = useState(false);

  // Lọc sessions theo search query
  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const query = searchQuery.toLowerCase();
    return sessions.filter(s =>
      s.name.toLowerCase().includes(query) ||
      s.timelineInfo?.name?.toLowerCase().includes(query) ||
      s.timelineInfo?.projectName?.toLowerCase().includes(query)
    );
  }, [sessions, searchQuery]);

  // Tách sessions theo ngày
  const groupedSessions = useMemo(() => {
    const groups: { label: string; sessions: SessionData[] }[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    let todaySessions: SessionData[] = [];
    let yesterdaySessions: SessionData[] = [];
    let olderSessions: SessionData[] = [];

    for (const session of filteredSessions) {
      const sessionDate = new Date(session.updatedAt);
      sessionDate.setHours(0, 0, 0, 0);

      if (sessionDate.getTime() === today.getTime()) {
        todaySessions.push(session);
      } else if (sessionDate.getTime() === yesterday.getTime()) {
        yesterdaySessions.push(session);
      } else {
        olderSessions.push(session);
      }
    }

    if (todaySessions.length > 0) groups.push({ label: 'Hôm nay', sessions: todaySessions });
    if (yesterdaySessions.length > 0) groups.push({ label: 'Hôm qua', sessions: yesterdaySessions });
    if (olderSessions.length > 0) groups.push({ label: 'Trước đó', sessions: olderSessions });

    return groups;
  }, [filteredSessions]);

  // Xử lý restore
  const handleRestore = async (sessionId: string) => {
    setRestoringId(sessionId);
    try {
      const success = await onRestore(sessionId);
      if (success) {
        // Đóng dialog sau khi restore thành công
        onOpenChange(false);
      }
    } finally {
      setRestoringId(null);
    }
  };

  // Xử lý save manual
  const handleSaveManual = async () => {
    setIsSaving(true);
    try {
      await onSave();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Save className="h-5 w-5" />
            Sessions
          </DialogTitle>
          <DialogDescription className="text-[13px]">
            Lưu và khôi phục trạng thái làm việc. <kbd className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono border">⌘S</kbd> lưu • <kbd className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono border">⌘⇧S</kbd> mở dialog này.
          </DialogDescription>
        </DialogHeader>

        {/* Thanh công cụ trên cùng */}
        <div className="flex items-center justify-between gap-3 py-2">
          {/* Auto-save toggle */}
          <div className="flex items-center gap-2">
            <Switch
              id="auto-save-toggle"
              checked={autoSaveEnabled}
              onCheckedChange={onAutoSaveChange}
            />
            <Label htmlFor="auto-save-toggle" className="text-sm cursor-pointer">
              Auto-save (5 phút)
            </Label>
          </div>

          <div className="flex items-center gap-2">
            {/* Hiển thị "Last saved..." */}
            {lastSavedAt && (
              <span className="text-xs text-muted-foreground">
                Đã lưu {formatRelativeTime(lastSavedAt)}
              </span>
            )}

            {/* Nút lưu thủ công */}
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={handleSaveManual}
              disabled={isSaving}
            >
              <Save className={`h-3.5 w-3.5 ${isSaving ? 'animate-pulse' : ''}`} />
              {isSaving ? 'Đang lưu...' : 'Lưu ngay'}
            </Button>

            {/* Nút dọn dẹp (Cleanup) */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="h-8 w-8 text-amber-600 hover:bg-amber-100"
                  onClick={async () => {
                    if (confirm('Dọn dẹp các session cũ, chỉ giữ lại 50 bản mới nhất?')) {
                      await onRefresh();
                    }
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Dọn dẹp (Giữ 50 bản mới nhất)</TooltipContent>
            </Tooltip>

            {/* Nút refresh */}
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-8 w-8"
              onClick={onRefresh}
              disabled={isLoading}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>

        <Separator />

        {/* Thanh tìm kiếm */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Tìm session..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-9"
          />
        </div>

        {/* Danh sách sessions — scroll khi vượt quá */}
        <ScrollArea className="flex-1 min-h-0 -mx-3 px-3">
          {isLoading ? (
            /* Loading state */
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <RefreshCw className="h-5 w-5 animate-spin mr-2" />
              Đang tải...
            </div>
          ) : filteredSessions.length === 0 ? (
            /* Empty state — ấm áp, hướng dẫn rõ ràng */
            <div className="text-center py-10">
              <div className="w-14 h-14 mx-auto rounded-full bg-muted/80 flex items-center justify-center mb-4">
                <Save className="h-6 w-6 text-muted-foreground/50" />
              </div>
              <p className="text-sm font-medium text-foreground">
                {searchQuery ? 'Không tìm thấy session nào' : 'Chưa có session nào'}
              </p>
              <p className="text-xs text-muted-foreground mt-1.5 max-w-[280px] mx-auto">
                {searchQuery
                  ? 'Thử từ khóa khác'
                  : 'Bấm ⌘S (Ctrl+S) để lưu session đầu tiên. App sẽ tự động cập nhật mỗi 5 phút.'}
              </p>
            </div>
          ) : (
            /* Danh sách grouped */
            <div className="space-y-4 pb-2">
              {groupedSessions.map(group => (
                <div key={group.label}>
                  {/* Label nhóm */}
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">
                    {group.label} ({group.sessions.length})
                  </p>

                  {/* Sessions trong nhóm */}
                  <div className="space-y-2">
                    {group.sessions.map(session => (
                      <SessionItem
                        key={session.id}
                        session={session}
                        isActive={currentSessionId === session.id}
                        onRestore={handleRestore}
                        onDelete={onDelete}
                        onRename={onRename}
                        isRestoring={restoringId === session.id}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        {/* Footer — thống kê */}
        {sessions.length > 0 && (
          <>
            <Separator />
            <div className="flex items-center justify-between text-xs text-muted-foreground pt-1">
              <span>
                Tổng: {sessions.length} sessions
              </span>
              <span className="flex items-center gap-1">
                <HardDrive className="h-3 w-3" />
                IndexedDB
              </span>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
