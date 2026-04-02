import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";
import { GlobalProvider } from "@/contexts/GlobalProvider";
import { Toaster } from "@/components/ui/sonner";
// Import service để bắt mọi lỗi tự động
import { bugReportService } from "@/services/bugReportService";

type FatalState = {
  error: Error | null;
};

class AppErrorBoundary extends React.Component<React.PropsWithChildren, FatalState> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): FatalState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[AppErrorBoundary] Uncaught render error:", error, errorInfo);
    // Ghi lỗi vào BugReporter để user thấy trong panel
    bugReportService.addBug({
      level:   'error',
      source:  'ReactErrorBoundary',
      message: error.message,
      stack:   error.stack,
      extra:   { componentStack: errorInfo.componentStack?.slice(0, 500) },
    });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-screen w-screen bg-[#111] text-white p-4 overflow-auto">
          <h1 className="text-lg font-semibold mb-2">App crashed while rendering</h1>
          <p className="text-sm opacity-80 mb-4">Open DevTools to inspect the full stack trace.</p>
          <pre className="text-xs whitespace-pre-wrap break-words opacity-90">
            {this.state.error.stack || this.state.error.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function showFatalScreen(title: string, details: string) {
  // Log chi tiết ra console TRƯỚC (dù UI bị trắng vẫn thấy ở DevTools)
  console.error(`\n${"=".repeat(60)}\n🚨 FATAL: ${title}\n${"=".repeat(60)}\n${details}\n${"=".repeat(60)}`);

  const root = document.getElementById("root");
  if (!root) return;

  // Dừng React render để không bị overwrite
  root.innerHTML = `
    <div style="height:100vh;width:100vw;background:#111;color:#fff;padding:16px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">
      <h1 style="font-size:18px;margin:0 0 8px 0;color:#ff6b6b">🚨 ${title}</h1>
      <p style="font-size:13px;opacity:.8;margin:0 0 12px 0">Check DevTools console (F12) for full stack trace.</p>
      <button onclick="location.reload()" style="background:#333;color:#fff;border:1px solid #555;padding:8px 16px;cursor:pointer;margin-bottom:12px;border-radius:4px">🔄 Reload App</button>
      <pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;opacity:.92;background:#1a1a1a;padding:12px;border-radius:4px;border:1px solid #333">${details}</pre>
    </div>
  `;
  document.title = `❌ ${title}`;
}

// ── Patch console.error/warn → tự động pipe vào BugReporter ──────────────────
// Giữ nguyên hàm gốc để vẫn in ra DevTools
const _originalConsoleError = console.error.bind(console);
const _originalConsoleWarn  = console.warn.bind(console);

// Guard chống infinite loop: nếu BugReporter tự ghi lỗi
// → console.error bị gọi → BugReporter lại ghi lỗi → vòng lặp vô tận
let _isPatching = false;

/** Safe stringify — tránh crash với circular reference và object phức tạp */
function safeStringify(val: unknown): string {
  if (val instanceof Error) return `${val.message}\n${val.stack || ''}`;
  if (typeof val === 'string') return val;
  if (val === null || val === undefined) return String(val);
  try {
    // Gửi circular reference bằng WeakSet
    const seen = new WeakSet();
    return JSON.stringify(val, (_k, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    }, 2);
  } catch {
    return String(val);
  }
}

/**
 * Danh sách pattern của các log "noise" — bỏ qua, không đưa vào BugReporter.
 * Đây là các lỗi/warning "expected" xảy ra trong vận hành bình thường.
 */
const NOISE_PATTERNS = [
  // Resolve offline khi chưa mở DaVinci — polling 5s, bình thường
  'Resolve offline',
  'Link to Resolve is offline',
  'tcp connect error',
  'Connection refused',
  '127.0.0.1:56003',
  // Vite HMR dev warnings — không liên quan runtime
  'Could not Fast Refresh',
  '[vite]',
];

/** Kiểm tra xem message có phải noise không */
function isNoise(message: string): boolean {
  return NOISE_PATTERNS.some(p => message.includes(p));
}

console.error = (...args: any[]) => {
  // Vẫn in ra DevTools như bình thường
  _originalConsoleError(...args);
  // Guard: nếu đang xử lý (do BugReporter gọi), bỏ qua → không tạo vòng lặp
  if (_isPatching) return;
  _isPatching = true;
  try {
    const message = args.map(safeStringify).join(' ');
    // Bỏ qua nếu là noise (lỗi expected, không cần report)
    if (isNoise(message)) return;
    const firstArg = args[0];
    const stack    = firstArg instanceof Error ? firstArg.stack : undefined;
    bugReportService.addBug({ level: 'error', source: 'console.error', message, stack });
  } finally {
    _isPatching = false;
  }
};

console.warn = (...args: any[]) => {
  // Vẫn in ra DevTools
  _originalConsoleWarn(...args);
  // Guard: không tạo vòng lặp
  if (_isPatching) return;
  _isPatching = true;
  try {
    const message = args.map(safeStringify).join(' ');
    // Bỏ qua nếu là noise (warning expected, không cần hiện trong panel)
    if (isNoise(message)) return;
    bugReportService.addBug({ level: 'warn', source: 'console.warn', message });
  } finally {
    _isPatching = false;
  }
};

// ── Bắt lỗi JavaScript toàn cục — gọi console gốc để không trigger patch ─────
window.addEventListener("error", (event) => {
  // In ra DevTools qua hàm GỐC — không qua patch để tránh double-report
  _originalConsoleError("[window.error] >>>", event.error || event.message);
  _originalConsoleError("[window.error] file:", event.filename, "line:", event.lineno, "col:", event.colno);
  if (event.error?.stack) _originalConsoleError("[window.error] stack:", event.error.stack);
  // Ghi trực tiếp vào BugReporter — không qua console.error để tránh double-entry
  bugReportService.addBug({
    level:   'error',
    source:  `JS Error [${event.filename?.split('/').pop() || 'unknown'}:${event.lineno}]`,
    message: event.error?.message || event.message,
    stack:   event.error?.stack,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  // In ra DevTools qua hàm gốc
  _originalConsoleError("[unhandledrejection] >>>", event.reason);
  // Ghi trực tiếp vào BugReporter
  bugReportService.addBug({
    level:   'error',
    source:  'UnhandledPromise',
    message: event.reason instanceof Error
      ? event.reason.message
      : typeof event.reason === 'string'
      ? event.reason
      : safeStringify(event.reason),
    stack:   event.reason instanceof Error ? event.reason.stack : undefined,
  });
});

// ── Global behavior trackers — setup 1 lần ở module level ────────────────────
// KHÔNG đặt trong component (useEffect) vì React StrictMode sẽ mount/unmount/remount
// → listener bị đăng ký nhiều lần → 1 click ghi 4 lần

// 1. Bắt mọi click → rage click detector + behavior log
document.addEventListener('click', (e: MouseEvent) => {
  bugReportService.handleClick(e.target, e.clientX, e.clientY);
}, { capture: true });  // capture: true để bắt trước khi bị stopPropagation

// 2. Bắt text selection (mouseup) → text_copy behavior
document.addEventListener('mouseup', () => {
  const selected = window.getSelection()?.toString() || '';
  if (selected.length >= 10) {
    bugReportService.handleTextSelection(selected);
  }
});

// 3. Bắt chuột phải → right_click behavior
document.addEventListener('contextmenu', (e: MouseEvent) => {
  bugReportService.addBehavior({
    type:   'right_click',
    target: (e.target as HTMLElement)?.tagName?.toLowerCase() || 'unknown',
    x:      e.clientX,
    y:      e.clientY,
  });
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root was not found in index.html");
}

// License Gate duy nhất nằm trong App.tsx (Tauri Store-based)
// Không cần gate thứ 2 ở đây nữa
function Root() {
  return (
    <AppErrorBoundary>
      <GlobalProvider>
        <App />
        <Toaster />
      </GlobalProvider>
    </AppErrorBoundary>
  );
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
