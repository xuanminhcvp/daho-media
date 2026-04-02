/**
 * bugReportService.ts
 * Service trung tâm lưu trữ mọi bug + hành vi người dùng trong AutoSubs-App.
 * Dữ liệu lưu trong memory + localStorage để xuất report.
 *
 * Exports:
 *  - bugReportService  : singleton để dùng khắp app
 *  - BugEntry          : type của 1 bug entry
 *  - BehaviorEvent     : type của 1 hành vi người dùng
 *  - UXInsight         : insight UX phát hiện được
 *  - Annotation        : ghi chú trực tiếp trên UI
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type BugLevel = 'error' | 'warn' | 'info';

/** Một bug/lỗi được ghi nhận */
export interface BugEntry {
  id:       string;       // uuid ngắn
  ts:       number;       // Date.now()
  level:    BugLevel;
  source:   string;       // "console.error" | "Network" | "ReactBoundary" | ...
  message:  string;
  stack?:   string;
  extra?:   Record<string, any>;
  // Context tại thời điểm lỗi
  context?: {
    url:          string;
    activeTab?:   string;   // tab app đang mở (nếu có)
    lastActions:  string[]; // 5 hành động gần nhất của user
  };
}

/** Một hành động của người dùng */
export interface BehaviorEvent {
  id:      string;
  ts:      number;
  type:    BehaviorType;
  target:  string;    // mô tả element (id/text/tag)
  detail?: string;    // thông tin thêm
  x?:      number;    // tọa độ click (nếu có)
  y?:      number;
}

export type BehaviorType =
  | 'click'
  | 'rage_click'      // click liên tục > 3 lần / 2 giây
  | 'long_pause'      // pause > 5 giây không làm gì
  | 'text_copy'       // bôi chọn text thủ công
  | 'right_click'     // chuột phải
  | 'rapid_navigate'  // vào tab rồi thoát ngay trong < 2s
  | 'repeated_action' // lặp lại cùng 1 chuỗi > 3 lần
  | 'scroll'
  | 'input_change'
  | 'tab_switch'
  | 'page_error';     // khi React Error Boundary bắt được

/** Insight về UX được phát hiện tự động */
export interface UXInsight {
  id:       string;
  ts:       number;
  type:     'rage_click' | 'missing_copy' | 'confusion' | 'dead_tab' | 'repeated_workflow' | 'page_error';
  title:    string;
  detail:   string;
  severity: 'low' | 'medium' | 'high';
}

/** Ghi chú người dùng gắn trực tiếp lên UI */
export interface Annotation {
  id:          string;
  ts:          number;
  x:           number;   // vị trí pixel trên màn hình
  y:           number;
  note:        string;   // nội dung note
  elementDesc: string;   // mô tả element bên dưới
  url:         string;   // trang đang ở
  activeTab?:  string;   // tab app đang mở
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let _idCounter = 0;
function uid(): string {
  return `${Date.now()}-${++_idCounter}`;
}

/** Lấy tên đọc được của element từ event target */
function describeTarget(el: EventTarget | null): string {
  if (!el || !(el instanceof HTMLElement)) return 'unknown';
  const id   = el.id ? `#${el.id}` : '';
  const text = el.textContent?.slice(0, 40).trim() || '';
  const tag  = el.tagName.toLowerCase();
  const cls  = el.className?.toString()?.split(' ').slice(0, 2).join('.') || '';
  return `${tag}${id}${cls ? '.' + cls : ''}${text ? ` "${text}"` : ''}`;
}

// ── Service class ─────────────────────────────────────────────────────────────

const MAX_BUGS      = 500;  // giới hạn số bug lưu trong memory
const MAX_BEHAVIORS = 1000; // giới hạn events hành vi
const LOCAL_KEY     = '__autosubs_bug_report_session__'; // key riêng cho AutoSubs

class BugReportService {
  private bugs:        BugEntry[]      = [];
  private behaviors:   BehaviorEvent[] = [];
  private insights:    UXInsight[]     = [];
  private annotations: Annotation[]    = [];  // ghi chú trực tiếp trên UI
  private listeners: Array<() => void> = [];

  // Theo dõi rage click: { targetKey -> [timestamps] }
  private clickHistory: Map<string, number[]> = new Map();
  // Theo dõi active tab
  public  activeTab: string = '';

  constructor() {
    this._restoreFromStorage();
  }

  // ── Public: Thêm bug ────────────────────────────────────────────────────────

  addBug(params: Omit<BugEntry, 'id' | 'ts' | 'context'>) {
    const entry: BugEntry = {
      ...params,
      id:  uid(),
      ts:  Date.now(),
      context: {
        url:         window.location.href,
        activeTab:   this.activeTab,
        lastActions: this.getLastActions(5),
      },
    };

    // Kiểm tra trùng lặp trong 10 giây (cùng message + source)
    const isDuplicate = this.bugs.some(
      b => b.message === entry.message && b.source === entry.source
        && (entry.ts - b.ts) < 10_000
    );
    if (isDuplicate) return;

    this.bugs.push(entry);
    if (this.bugs.length > MAX_BUGS) this.bugs.shift(); // xoá bug cũ nhất

    this._saveToStorage();
    this._notify();
  }

  // ── Public: Ghi nhận hành vi ────────────────────────────────────────────────

  addBehavior(params: Omit<BehaviorEvent, 'id' | 'ts'>) {
    const event: BehaviorEvent = {
      ...params,
      id: uid(),
      ts: Date.now(),
    };

    this.behaviors.push(event);
    if (this.behaviors.length > MAX_BEHAVIORS) this.behaviors.shift();

    this._saveToStorage();
    this._notify();
  }

  // ── Public: Bắt rage click từ click event ─────────────────────────────────

  handleClick(el: EventTarget | null, x?: number, y?: number) {
    const targetKey = describeTarget(el as HTMLElement);
    const now = Date.now();

    // Ghi event click bình thường
    this.addBehavior({ type: 'click', target: targetKey, x, y });

    // Phát hiện rage click
    const history = this.clickHistory.get(targetKey) || [];
    history.push(now);
    // Giữ lại click trong 2 giây gần nhất
    const recent = history.filter(t => now - t < 2000);
    this.clickHistory.set(targetKey, recent);

    if (recent.length >= 3) {
      // Đã rage click! Tạo insight
      this._addInsight({
        type:     'rage_click',
        title:    `Rage Click: "${targetKey.slice(0, 60)}"`,
        detail:   `Người dùng click ${recent.length} lần trong 2 giây vào cùng 1 element. Có thể nút không phản hồi hoặc cần loading indicator.`,
        severity: 'high',
      });
      // Reset để không spam insight
      this.clickHistory.set(targetKey, []);
    }
  }

  // ── Public: Bắt text selection ─────────────────────────────────────────────

  handleTextSelection(selectedText: string) {
    if (selectedText.length < 10) return;

    this.addBehavior({
      type:   'text_copy',
      target: `Selected text (${selectedText.length} chars)`,
      detail: `"${selectedText.slice(0, 100)}"`,
    });
  }

  // ── Public: Đặt active tab hiện tại ───────────────────────────────────────

  setActiveTab(tabName: string) {
    const prev = this.activeTab;
    this.activeTab = tabName;

    if (prev) {
      this.addBehavior({ type: 'tab_switch', target: tabName, detail: `From: ${prev}` });
    }
  }

  // ── Public: Thêm insight thủ công (từ ErrorBoundary, ...) ─────────────────

  addInsightPublic(params: Omit<UXInsight, 'id' | 'ts'>) {
    this._addInsight(params);
  }

  // ── Public: Getters ────────────────────────────────────────────────────────

  getBugs():      BugEntry[]      { return [...this.bugs]; }
  getBehaviors(): BehaviorEvent[] { return [...this.behaviors]; }
  getInsights():  UXInsight[]     { return [...this.insights]; }

  getErrorCount(): number { return this.bugs.filter(b => b.level === 'error').length; }
  getWarnCount():  number { return this.bugs.filter(b => b.level === 'warn').length;  }

  /** Thêm annotation (ghi chú trực tiếp trên UI) */
  addAnnotation(params: Omit<Annotation, 'id' | 'ts'>) {
    const entry: Annotation = {
      ...params,
      id: uid(),
      ts: Date.now(),
    };
    this.annotations.push(entry);
    this._saveToStorage();
    this._notify();
  }

  /** Xoá annotation theo id */
  removeAnnotation(id: string) {
    this.annotations = this.annotations.filter(a => a.id !== id);
    this._saveToStorage();
    this._notify();
  }

  getAnnotations(): Annotation[] { return [...this.annotations]; }

  /** N hành động gần nhất dạng string */
  getLastActions(n = 5): string[] {
    return this.behaviors
      .slice(-n)
      .map(b => `[${b.type}] ${b.target}`);
  }

  // ── Public: Tạo report đầy đủ dạng text (dễ paste vào chat) ───────────────

  generateReport(): string {
    const now = new Date().toLocaleString('vi-VN');
    const errors = this.bugs.filter(b => b.level === 'error');
    const warns  = this.bugs.filter(b => b.level === 'warn');

    const bugSection = errors.length === 0 && warns.length === 0
      ? '  (Không có lỗi)\n'
      : [...errors, ...warns].map(b => {
          const time = new Date(b.ts).toLocaleTimeString('vi-VN');
          return [
            `  [${b.level.toUpperCase()}] ${time} | ${b.source}`,
            `  Message : ${b.message.slice(0, 300)}`,
            b.stack ? `  Stack   : ${b.stack.split('\n').slice(0, 3).join(' | ')}` : '',
            `  Context : Tab="${b.context?.activeTab || '–'}" | Last actions: ${b.context?.lastActions?.join(' → ') || '–'}`,
            '',
          ].filter(Boolean).join('\n');
        }).join('\n');

    const insightSection = this.insights.length === 0
      ? '  (Không có insight)\n'
      : this.insights.map(i => {
          const time = new Date(i.ts).toLocaleTimeString('vi-VN');
          return `  [${i.severity.toUpperCase()}] ${time} | ${i.title}\n  → ${i.detail}`;
        }).join('\n\n');

    // Phần ghi chú người dùng
    const annotationSection = this.annotations.length === 0
      ? '  (Không có ghi chú)\n'
      : this.annotations.map((a, idx) => {
          const time = new Date(a.ts).toLocaleTimeString('vi-VN');
          return [
            `  [${idx + 1}] ${time} | tại Tab="${a.activeTab || '–'}"`,
            `  Element : ${a.elementDesc}`,
            `  Vị trí  : x=${a.x}, y=${a.y}`,
            `  📌 NOTE : ${a.note}`,
            '',
          ].join('\n');
        }).join('\n');

    const timelineSection = this.behaviors
      .slice(-15)  // chỉ lấy 15 hành động gần nhất — đồng bộ với UI
      .map(b => {
        const time = new Date(b.ts).toLocaleTimeString('vi-VN');
        return `  ${time} | ${b.type.padEnd(16)} | ${b.target.slice(0, 60)}`;
      }).join('\n');

    return [
      `╔══════════════════════════════════════════════════════════╗`,
      `║        BUG REPORT — AutoSubs App — ${now}        ║`,
      `╚══════════════════════════════════════════════════════════╝`,
      ``,
      `🐛 BUGS (${errors.length} errors, ${warns.length} warnings):`,
      bugSection,
      ``,
      `📌 USER NOTES / GHI CHÚ TRỰC TIẾP (${this.annotations.length} notes):`,
      annotationSection,
      ``,
      `🎯 UX INSIGHTS (${this.insights.length} phát hiện):`,
      insightSection,
      ``,
      `📋 LAST 15 USER ACTIONS:`,
      timelineSection || '  (Chưa có hành động)',
      ``,
      `══ END REPORT ══`,
    ].join('\n');
  }

  // ── Public: Export JSON đầy đủ ────────────────────────────────────────────

  exportJSON(): string {
    return JSON.stringify({
      exportedAt:  new Date().toISOString(),
      appName:     'AutoSubs-App',
      bugs:        this.bugs,
      behaviors:   this.behaviors.slice(-200),
      insights:    this.insights,
      annotations: this.annotations,
    }, null, 2);
  }

  // ── Public: Xoá session ────────────────────────────────────────────────────

  clearAll() {
    this.bugs        = [];
    this.behaviors   = [];
    this.insights    = [];
    this.annotations = [];
    this.clickHistory.clear();
    // KHÔNG xoá toàn bộ localStorage — chỉ xoá key của BugReporter
    localStorage.removeItem(LOCAL_KEY);
    this._notify();
  }

  // ── Public: Subscribe ──────────────────────────────────────────────────────

  subscribe(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _notify() {
    this.listeners.forEach(fn => fn());
  }

  private _addInsight(params: Omit<UXInsight, 'id' | 'ts'>) {
    // Tránh duplicate insight trong 10 giây
    const recent = this.insights.find(
      i => i.type === params.type && i.title === params.title
        && Date.now() - i.ts < 10_000
    );
    if (recent) return;

    this.insights.push({ ...params, id: uid(), ts: Date.now() });
    if (this.insights.length > 100) this.insights.shift();
    this._notify();
  }

  /** Lưu vào localStorage (chỉ lưu 50 bug + 50 insight + tất cả annotations) */
  private _saveToStorage() {
    try {
      const snapshot = {
        bugs:        this.bugs.slice(-50),
        insights:    this.insights.slice(-50),
        annotations: this.annotations, // lưu tất cả annotations
      };
      localStorage.setItem(LOCAL_KEY, JSON.stringify(snapshot));
    } catch { /* bỏ qua nếu localStorage đầy */ }
  }

  /** Khôi phục từ localStorage khi app reload */
  private _restoreFromStorage() {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      this.bugs        = data.bugs        || [];
      this.insights    = data.insights    || [];
      this.annotations = data.annotations || [];
    } catch { /* bỏ qua nếu data hỏng */ }
  }
}

// Singleton export — dùng 1 instance duy nhất trong toàn app
export const bugReportService = new BugReportService();
