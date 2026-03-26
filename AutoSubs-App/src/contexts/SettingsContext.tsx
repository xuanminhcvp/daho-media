import React, { createContext, useContext, useState, useEffect } from 'react';
import { load, Store } from '@tauri-apps/plugin-store';
import { Settings } from '@/types/interfaces';
import { initI18n, normalizeUiLanguage } from '@/i18n';
import { models, modelSupportsLanguage, getFirstRecommendedModelForLanguage } from '@/lib/models';

export const DEFAULT_SETTINGS: Settings = {
  // Mode
  isStandaloneMode: false,

  // UI settings
  uiLanguage: "en",
  uiLanguagePromptCompleted: false,
  showEnglishOnlyModels: false,

  // Survey notification settings
  timesDismissedSurvey: 0,
  lastSurveyDate: new Date().toISOString(),

  // Processing settings
  model: 0,
  language: "auto",
  translate: false,
  targetLanguage: "en",
  enableDTW: true,
  enableGpu: true, // gpu enabled by default on mac and linux, disabled by default on windows
  enableDiarize: false,
  maxSpeakers: null,

  // Text settings
  textDensity: "standard",
  maxLinesPerSubtitle: 1,
  splitOnPunctuation: true,
  textCase: "none",
  removePunctuation: false,
  enableCensor: false,
  censoredWords: [],

  // Resolve settings
  selectedInputTracks: ["2"],
  selectedOutputTrack: "1",
  selectedTemplate: { value: "Default Template", label: "Default Template" },

  // Animation settings
  animationType: "none",
  highlightType: "none",
  highlightColor: "#000000",
};

interface SettingsContextType {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  resetSettings: () => void;
  isHydrated: boolean;
};

const SettingsContext = createContext<SettingsContextType | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [store, setStore] = useState<Store | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);

  async function initializeStore() {
    try {
      const storeLoadPromise = load('autosubs-store.json', { autoSave: false });
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Store initialization timed out after 4000ms')), 4000);
      });
      const loadedStore = await Promise.race([storeLoadPromise, timeoutPromise]);
      setStore(loadedStore);

      // If you store settings as a single object, you can get it all at once
      // Alternatively, if they are stored individually, you can reconstruct the object here.
      const storedSettings = await loadedStore.get<any>('settings');
      const hydratedSettings = storedSettings
        ? ({ ...DEFAULT_SETTINGS, ...storedSettings, uiLanguage: normalizeUiLanguage(storedSettings.uiLanguage) } as Settings)
        : DEFAULT_SETTINGS;

      initI18n(hydratedSettings.uiLanguage);
      setSettings(hydratedSettings);
    } catch (error) {
      console.error('Error initializing store. Falling back to defaults:', error);
      initI18n(DEFAULT_SETTINGS.uiLanguage);
      setSettings(DEFAULT_SETTINGS);
    } finally {
      setIsHydrated(true);
    }
  }

  // Initialization useEffect
  useEffect(() => {
    initializeStore();
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    initI18n(settings.uiLanguage);
  }, [settings.uiLanguage, isHydrated]);

  // Whenever settings change, persist them
  useEffect(() => {
    async function saveState() {
      // ⚠️ Bug fix #16: không save khi chưa hydrate xong
      // Tránh ghi đè settings đã lưu bằng DEFAULT_SETTINGS
      if (!store || !isHydrated) return;
      try {
        await store.set('settings', settings);
        await store.save();
      } catch (error) {
        console.error('Error saving state:', error);
      }
    }

    saveState();
  }, [settings, store, isHydrated]);

  // A handy reset function
  function resetSettings() {
    setSettings(DEFAULT_SETTINGS);
  }

  // Update a setting
  // This enforces that key is a valid Settings property, and value must match its type
  function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings(prev => {
      const newSettings = {
        ...prev,
        [key]: key === 'uiLanguage' ? normalizeUiLanguage(value as string) : value
      };

      // Check if language changed and current model supports the new language
      if (key === 'language' && value !== prev.language) {
        const currentModel = models[prev.model];
        if (!modelSupportsLanguage(currentModel, value as string)) {
          // Find first recommended model that supports the new language
          const recommendedModel = getFirstRecommendedModelForLanguage(value as string);
          if (recommendedModel) {
            const modelIndex = models.findIndex(m => m.value === recommendedModel.value);
            if (modelIndex !== -1) {
              newSettings.model = modelIndex;
            }
          }
        }
      }

      return newSettings;
    });
  }

  return (
    <SettingsContext.Provider value={{
      settings,
      updateSetting,
      resetSettings,
      isHydrated,
    }}>
      {!isHydrated ? (
        <div className="h-screen w-screen bg-background" />
      ) : (
        <div className="h-screen w-screen bg-background">
          {children}
        </div>
      )}
    </SettingsContext.Provider>
  );
}

export const useSettings = () => {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
};

export type { Settings };
