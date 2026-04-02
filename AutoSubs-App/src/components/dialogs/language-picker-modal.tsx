import * as React from "react";
import { useSettings } from "@/contexts/SettingsContext";
import { initI18n } from "@/i18n";

// LanguagePickerModal - KHÔNG hiển thị UI
// Tự động mặc định tiếng Anh và đánh dấu đã hoàn thành ngay khi settings load xong.
// Không cần user chọn ngôn ngữ nữa.
export function LanguagePickerModal() {
  const { settings, updateSetting, isHydrated } = useSettings();

  React.useEffect(() => {
    // Chỉ chạy khi settings đã được load từ storage (isHydrated)
    if (!isHydrated) return;

    // Nếu chưa hoàn thành prompt chọn ngôn ngữ → tự động set English và đánh dấu done
    if (!settings.uiLanguagePromptCompleted) {
      updateSetting("uiLanguage", "en");
      updateSetting("uiLanguagePromptCompleted", true);
      initI18n("en"); // Khởi tạo i18n với tiếng Anh
    }
  }, [isHydrated]); // Chỉ chạy 1 lần khi isHydrated thay đổi

  // Không render bất kỳ UI nào
  return null;
}

