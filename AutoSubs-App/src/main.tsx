import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";
import { GlobalProvider } from "@/contexts/GlobalProvider";
import { Toaster } from "@/components/ui/sonner";

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

window.addEventListener("error", (event) => {
  // CHỈ LOG — KHÔNG gọi showFatalScreen() vì nó xóa React DOM → trắng app
  console.error("[window.error] >>>", event.error || event.message);
  console.error("[window.error] file:", event.filename, "line:", event.lineno, "col:", event.colno);
  if (event.error?.stack) console.error("[window.error] stack:", event.error.stack);
});

window.addEventListener("unhandledrejection", (event) => {
  // CHỈ LOG — async errors (AI request fail, timeout...) không nên crash app
  console.error("[unhandledrejection] >>>", event.reason);
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root was not found in index.html");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <GlobalProvider>
        <App />
        <Toaster />
      </GlobalProvider>
    </AppErrorBoundary>
  </React.StrictMode>
);
