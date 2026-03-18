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

function showFatalScreen(title: string, details: string) {
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = `
    <div style="height:100vh;width:100vw;background:#111;color:#fff;padding:16px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">
      <h1 style="font-size:18px;margin:0 0 8px 0">${title}</h1>
      <p style="font-size:13px;opacity:.8;margin:0 0 12px 0">Check DevTools console for more details.</p>
      <pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;opacity:.92">${details}</pre>
    </div>
  `;
}

window.addEventListener("error", (event) => {
  const message = event.error?.stack || event.message || "Unknown runtime error";
  console.error("[window.error]", event.error || event.message);
  showFatalScreen("Runtime error", String(message));
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = (event.reason as any)?.stack || (event.reason as any)?.message || String(event.reason);
  console.error("[unhandledrejection]", event.reason);
  showFatalScreen("Unhandled promise rejection", String(reason));
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
