import { Gauge, Clock, Key, Save, Eye, EyeOff } from "lucide-react";
import { DeleteIcon, type DeleteIconHandle } from "@/components/ui/icons/delete";
import { useSettings } from "@/contexts/SettingsContext";
import { ask } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Field, FieldGroup } from "@/components/ui/field";
import { initI18n, normalizeUiLanguage } from "@/i18n";
import { useRef, useState, useEffect } from "react";
import { saveAudioScanApiKey, getAudioScanApiKey } from "@/services/saved-folders-service";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { settings, updateSetting, resetSettings } = useSettings();
  const { t } = useTranslation();
  const deleteIconRef = useRef<DeleteIconHandle>(null);

  // State cho Gemini API Key (Audio Scan) — load async từ settings.json
  const [audioApiKey, setAudioApiKey] = useState("");
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [showKey, setShowKey] = useState(false);

  // Load API key khi dialog mở
  useEffect(() => {
    if (open) {
      getAudioScanApiKey().then(key => setAudioApiKey(key));
    }
  }, [open]);

  const handleResetSettings = async () => {
    const shouldReset = await ask(t("settings.reset.confirm"), {
      title: t("settings.reset.confirmTitle"),
      kind: "warning"
    });
    
    if (shouldReset) {
      resetSettings();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <form>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{t("settings.title")}</DialogTitle>
            <DialogDescription className="text-xs">
              {t("settings.description")}
            </DialogDescription>
          </DialogHeader>

          <div className="py-2 space-y-6">
            {/* Language Settings */}
            <div className="space-y-3">
              <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {t("settings.sections.language")}
              </h4>

              <FieldGroup>
                <Field>
                  <Item variant="outline" size="sm">
                    <ItemContent>
                      <ItemTitle>{t("settings.uiLanguage.title")}</ItemTitle>
                      <ItemDescription className="text-xs leading-tight line-clamp-1">
                        {t("settings.uiLanguage.description")}
                      </ItemDescription>
                    </ItemContent>

                    <ItemActions className="w-[170px] shrink-0 justify-end">
                      <Select
                        value={normalizeUiLanguage(settings.uiLanguage)}
                        onValueChange={(value) => {
                          const normalized = normalizeUiLanguage(value);
                          updateSetting("uiLanguage", normalized);
                          initI18n(normalized);
                        }}
                      >
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="en">English</SelectItem>
                          <SelectItem value="es">Español</SelectItem>
                          <SelectItem value="fr">Français</SelectItem>
                          <SelectItem value="de">Deutsch</SelectItem>
                          <SelectItem value="ja">日本語</SelectItem>
                          <SelectItem value="ko">한국어</SelectItem>
                          <SelectItem value="zh">中文</SelectItem>
                        </SelectContent>
                      </Select>
                    </ItemActions>
                  </Item>
                </Field>
              </FieldGroup>
            </div>

            {/* Transcription Settings */}
            <div className="space-y-3">
              <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {t("settings.sections.transcription")}
              </h4>

              <FieldGroup className="gap-3">
                <Field>
                  <Item variant="outline" size="sm">
                    <ItemMedia variant="icon" className="bg-yellow-100 dark:bg-yellow-900/30">
                      <Gauge className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{t("settings.gpu.title")}</ItemTitle>
                      <ItemDescription className="text-xs leading-tight line-clamp-1">
                        {t("settings.gpu.description")}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Switch
                        checked={settings.enableGpu}
                        onCheckedChange={(checked) => updateSetting("enableGpu", checked)}
                      />
                    </ItemActions>
                  </Item>
                </Field>

                <Field>
                  <Item variant="outline" size="sm">
                    <ItemMedia variant="icon" className="bg-blue-100 dark:bg-blue-900/30">
                      <Clock className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{t("settings.dtw.title")}</ItemTitle>
                      <ItemDescription className="text-xs leading-tight line-clamp-1">
                        {t("settings.dtw.description")}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Switch
                        checked={settings.enableDTW}
                        onCheckedChange={(checked) => updateSetting("enableDTW", checked)}
                      />
                    </ItemActions>
                  </Item>
                </Field>
              </FieldGroup>
            </div>

            {/* Gemini API Key — dùng cho Audio Scan */}
            <div className="space-y-3">
              <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                🔑 Gemini API Key (Audio Scan)
              </h4>

              <FieldGroup>
                <Field>
                  <Item variant="outline" size="sm">
                    <ItemMedia variant="icon" className="bg-purple-100 dark:bg-purple-900/30">
                      <Key className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>API Key</ItemTitle>
                      <ItemDescription className="text-xs leading-tight line-clamp-1">
                        Dùng cho AI phân tích nhạc nền & SFX (Gemini 2.5 Pro)
                      </ItemDescription>
                    </ItemContent>
                  </Item>

                  {/* Ô nhập API key + nút show/hide + nút Save */}
                  <div className="flex gap-2 mt-2">
                    <div className="relative flex-1">
                      <input
                        type={showKey ? "text" : "password"}
                        placeholder="Nhập Gemini API Key..."
                        className="w-full h-9 px-3 pr-9 rounded-md border border-input bg-background text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        value={audioApiKey}
                        onChange={(e) => setAudioApiKey(e.target.value)}
                      />
                      {/* Nút toggle hiện/ẩn key */}
                      <button
                        type="button"
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => setShowKey(!showKey)}
                        tabIndex={-1}
                      >
                        {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>

                    {/* Nút Save */}
                    <Button
                      type="button"
                      variant={apiKeySaved ? "secondary" : "outline"}
                      size="sm"
                      className={`h-9 gap-1.5 shrink-0 transition-all ${
                        apiKeySaved
                          ? "bg-green-500/20 border-green-500/40 text-green-400"
                          : "hover:border-green-500/40 hover:text-green-400"
                      }`}
                      onClick={() => {
                        saveAudioScanApiKey(audioApiKey.trim());
                        setApiKeySaved(true);
                        setTimeout(() => setApiKeySaved(false), 2000);
                      }}
                      disabled={!audioApiKey.trim()}
                    >
                      {apiKeySaved ? (
                        <span>✓ Đã lưu</span>
                      ) : (
                        <><Save className="h-3.5 w-3.5" /> Save</>
                      )}
                    </Button>
                  </div>
                </Field>
              </FieldGroup>
            </div>
          </div>

          <DialogFooter>
            <Button 
              variant="destructive" 
              size="sm" 
              onClick={handleResetSettings}
              onMouseEnter={() => deleteIconRef.current?.startAnimation()}
              onMouseLeave={() => deleteIconRef.current?.stopAnimation()}
            >
              <DeleteIcon ref={deleteIconRef} />
              {t("settings.reset.button")}
            </Button>
            <DialogClose asChild>
              <Button variant="secondary" size="sm">
                {t("common.close")}
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </form>
    </Dialog>
  );
}
