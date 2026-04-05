import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Nút reload toàn bộ app.
 * - Dùng window.location.reload() để tải lại giao diện Tauri WebView hiện tại.
 * - Đặt ở ngoài menu để user thấy ngay khi mở app.
 */
export function AppReloadButton() {
  const handleReloadApp = () => {
    window.location.reload();
  };

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-6 gap-1 text-[10px] font-medium px-2 rounded-full border border-blue-500/70 text-blue-700 dark:text-blue-400 bg-blue-500/15 dark:bg-blue-500/10 hover:bg-blue-500/25 dark:hover:bg-blue-500/20"
      onClick={handleReloadApp}
      data-tauri-drag-region="false"
      title="Reload toàn bộ app"
    >
      <RotateCcw className="h-3 w-3" />
      Reload App
    </Button>
  );
}
