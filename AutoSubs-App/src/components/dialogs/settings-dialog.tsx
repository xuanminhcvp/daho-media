import { Gauge, Clock, Key, Save, Eye, EyeOff } from "lucide-react";
import { TrackGuide } from "@/components/settings/track-guide";
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
import { saveGeminiApiKeys, getGeminiApiKeys, saveClaudeApiKeys, getClaudeApiKeys } from "@/services/saved-folders-service";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { settings, updateSetting, resetSettings } = useSettings();
  const { t } = useTranslation();
  const deleteIconRef = useRef<DeleteIconHandle>(null);

  // State cho Gemini API Keys (mảng) — load async từ settings.json
  const [audioApiKey, setAudioApiKey] = useState("");
  const [keyCount, setKeyCount] = useState(0);
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [showKey, setShowKey] = useState(false);

  // State cho Claude API Keys (mảng) — giống Gemini
  const [claudeKeysText, setClaudeKeysText] = useState("");
  const [claudeKeyCount, setClaudeKeyCount] = useState(0);
  const [claudeKeySaved, setClaudeKeySaved] = useState(false);
  const [showClaudeKey, setShowClaudeKey] = useState(false);

  // Load API keys khi dialog mở
  useEffect(() => {
    if (open) {
      // Load Gemini keys
      getGeminiApiKeys().then(keys => {
        setAudioApiKey(keys.join("\n"));
        setKeyCount(keys.length);
      });
      // Load Claude keys
      getClaudeApiKeys().then(keys => {
        setClaudeKeysText(keys.join("\n"));
        setClaudeKeyCount(keys.length);
      });
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
            {/* Claude API Keys — round-robin nhiều key tránh rate limit */}
            <div className="space-y-3">
              <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase flex items-center gap-2">
                🔑 Claude API Keys (ezaiapi)
                {claudeKeyCount > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-400 text-[10px] font-bold">
                    {claudeKeyCount} keys
                  </span>
                )}
              </h4>

              <FieldGroup>
                <Field>
                  <Item variant="outline" size="sm">
                    <ItemMedia variant="icon" className="bg-violet-100 dark:bg-violet-900/30">
                      <Key className="h-4 w-4 text-violet-600 dark:text-violet-400" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>Claude Keys (Round-Robin)</ItemTitle>
                      <ItemDescription className="text-xs leading-tight line-clamp-1">
                        Mỗi dòng 1 key — tự xoay vòng tránh rate limit
                      </ItemDescription>
                    </ItemContent>
                  </Item>

                  <div className="flex flex-col gap-2 mt-2">
                    <div className="relative">
                      <textarea
                        placeholder={"Nhập Claude API Keys (ezaiapi)...\nMỗi dòng 1 key\nVí dụ: sk-abc123..."}
                        className="w-full min-h-[80px] px-3 py-2 rounded-md border border-input bg-background text-xs font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
                        style={{ fontFamily: "monospace", fontSize: "11px" }}
                        value={showClaudeKey ? claudeKeysText : claudeKeysText.split("\n").map(k => k ? "••••••••" + k.slice(-6) : "").join("\n")}
                        onFocus={() => {
                          // Tự động hiện key khi focus vào textarea → gõ tự nhiên
                          if (!showClaudeKey) setShowClaudeKey(true);
                        }}
                        onChange={(e) => {
                          setClaudeKeysText(e.target.value);
                          const lines = e.target.value.split("\n").filter(l => l.trim().length > 0);
                          setClaudeKeyCount(lines.length);
                        }}
                      />
                    </div>

                    <div className="flex gap-2 justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5 text-xs"
                        onClick={() => setShowClaudeKey(!showClaudeKey)}
                      >
                        {showClaudeKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        {showClaudeKey ? "Ẩn" : "Hiện"}
                      </Button>

                      <Button
                        type="button"
                        variant={claudeKeySaved ? "secondary" : "outline"}
                        size="sm"
                        className={`h-8 gap-1.5 text-xs transition-all ${
                          claudeKeySaved
                            ? "bg-violet-500/20 border-violet-500/40 text-violet-400"
                            : "hover:border-violet-500/40 hover:text-violet-400"
                        }`}
                        onClick={() => {
                          const keys = claudeKeysText.split("\n").map(k => k.trim()).filter(k => k.length > 0);
                          saveClaudeApiKeys(keys);
                          setClaudeKeyCount(keys.length);
                          setClaudeKeySaved(true);
                          setTimeout(() => setClaudeKeySaved(false), 2000);
                        }}
                        disabled={!claudeKeysText.trim()}
                      >
                        {claudeKeySaved ? (
                          <span>✓ Đã lưu {claudeKeyCount} keys</span>
                        ) : (
                          <><Save className="h-3.5 w-3.5" /> Lưu Keys</>
                        )}
                      </Button>
                    </div>
                  </div>
                </Field>
              </FieldGroup>
            </div>
            {/* Gemini API Keys — round-robin nhiều key tránh rate limit */}
            <div className="space-y-3">
              <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase flex items-center gap-2">
                🔑 Gemini API Keys
                {/* Badge hiển thị số keys hiện có */}
                {keyCount > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-400 text-[10px] font-bold">
                    {keyCount} keys
                  </span>
                )}
              </h4>

              <FieldGroup>
                <Field>
                  <Item variant="outline" size="sm">
                    <ItemMedia variant="icon" className="bg-purple-100 dark:bg-purple-900/30">
                      <Key className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>API Keys (Round-Robin)</ItemTitle>
                      <ItemDescription className="text-xs leading-tight line-clamp-1">
                        Mỗi dòng 1 key — tự xoay vòng tránh rate limit
                      </ItemDescription>
                    </ItemContent>
                  </Item>

                  {/* Textarea nhập nhiều keys — mỗi dòng 1 key */}
                  <div className="flex flex-col gap-2 mt-2">
                    <div className="relative">
                      <textarea
                        placeholder={"Nhập Gemini API Keys...\nMỗi dòng 1 key\nVí dụ: AIzaSy..."}
                        className="w-full min-h-[100px] px-3 py-2 rounded-md border border-input bg-background text-xs font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
                        style={{ fontFamily: "monospace", fontSize: "11px" }}
                        value={showKey ? audioApiKey : audioApiKey.split("\n").map(k => k ? "••••••••" + k.slice(-6) : "").join("\n")}
                        onFocus={() => {
                          // Tự động hiện key khi focus vào textarea → gõ tự nhiên
                          if (!showKey) setShowKey(true);
                        }}
                        onChange={(e) => {
                          setAudioApiKey(e.target.value);
                          // Cập nhật key count real-time
                          const lines = e.target.value.split("\n").filter(l => l.trim().length > 0);
                          setKeyCount(lines.length);
                        }}
                      />
                    </div>

                    {/* Nút Show/Hide + Save */}
                    <div className="flex gap-2 justify-end">
                      {/* Toggle hiện/ẩn keys */}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5 text-xs"
                        onClick={() => setShowKey(!showKey)}
                      >
                        {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        {showKey ? "Ẩn" : "Hiện"}
                      </Button>

                      {/* Nút Save — lưu mảng keys */}
                      <Button
                        type="button"
                        variant={apiKeySaved ? "secondary" : "outline"}
                        size="sm"
                        className={`h-8 gap-1.5 text-xs transition-all ${
                          apiKeySaved
                            ? "bg-green-500/20 border-green-500/40 text-green-400"
                            : "hover:border-green-500/40 hover:text-green-400"
                        }`}
                        onClick={() => {
                          // Tách theo dòng, lọc rỗng, lưu mảng
                          const keys = audioApiKey.split("\n").map(k => k.trim()).filter(k => k.length > 0);
                          saveGeminiApiKeys(keys);
                          setKeyCount(keys.length);
                          setApiKeySaved(true);
                          setTimeout(() => setApiKeySaved(false), 2000);
                        }}
                        disabled={!audioApiKey.trim()}
                      >
                        {apiKeySaved ? (
                          <span>✓ Đã lưu {keyCount} keys</span>
                        ) : (
                          <><Save className="h-3.5 w-3.5" /> Lưu Keys</>
                        )}
                      </Button>
                    </div>
                  </div>
                </Field>
              </FieldGroup>
            </div>

            {/* ====== Track Layout Guide ====== */}
            <div className="space-y-3">
              <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                🎛️ Track Layout
              </h4>
              <div className="rounded-lg border p-3">
                <TrackGuide compact />
              </div>
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
