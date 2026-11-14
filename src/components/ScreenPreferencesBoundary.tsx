import React from "react";
import { I18nextProvider } from "react-i18next";
import { getSceneI18n } from "@/i18n/scene-instance";
import { useSettingsStore } from "@/stores/settings-store";
import { ThemeProvider } from "@/theme/provider";
import {
  useSystemColorMode,
  type EffectiveColorMode,
} from "@/theme/system-appearance";
import {
  DEFAULT_SETTINGS,
  type ColorScheme,
  type ThemeMode,
} from "@/types/settings";
export interface VisualPreferencesSnapshot {
  theme: ThemeMode;
  effectiveMode: EffectiveColorMode;
  colorScheme: ColorScheme;
  language: string;
}
function useLiveVisualPreferences(): VisualPreferencesSnapshot {
  const theme = useSettingsStore((state) => state.theme);
  const colorScheme = useSettingsStore((state) => state.colorScheme);
  const language = useSettingsStore((state) => state.language);
  const systemMode = useSystemColorMode();
  const effectiveMode = theme === "system" ? systemMode : theme;
  return React.useMemo(
    () => ({ theme, effectiveMode, colorScheme, language }),
    [colorScheme, effectiveMode, language, theme],
  );
}
const VisualThemeContext = React.createContext<ThemeMode>(
  DEFAULT_SETTINGS.theme,
);
const VisualEffectiveModeContext =
  React.createContext<EffectiveColorMode>("light");
const VisualColorSchemeContext = React.createContext<ColorScheme>(
  DEFAULT_SETTINGS.colorScheme,
);
const VisualLanguageContext = React.createContext<string>(
  DEFAULT_SETTINGS.language,
);
export function VisualPreferencesSnapshotProvider({
  theme,
  effectiveMode,
  colorScheme,
  language,
  children,
}: VisualPreferencesSnapshot & {
  children: React.ReactNode;
}) {
  const sceneI18n = React.useMemo(() => getSceneI18n(language), [language]);
  return (
    <I18nextProvider i18n={sceneI18n} defaultNS="translation">
      <VisualLanguageContext.Provider value={language}>
        <VisualEffectiveModeContext.Provider value={effectiveMode}>
          <VisualThemeContext.Provider value={theme}>
            <VisualColorSchemeContext.Provider value={colorScheme}>
              {children}
            </VisualColorSchemeContext.Provider>
          </VisualThemeContext.Provider>
        </VisualEffectiveModeContext.Provider>
      </VisualLanguageContext.Provider>
    </I18nextProvider>
  );
}
function ScreenVisualTree({
  snapshot,
  children,
}: {
  snapshot: VisualPreferencesSnapshot;
  children: React.ReactNode;
}) {
  return (
    <VisualPreferencesSnapshotProvider
      theme={snapshot.theme}
      effectiveMode={snapshot.effectiveMode}
      colorScheme={snapshot.colorScheme}
      language={snapshot.language}
    >
      <ThemeProvider effectiveMode={snapshot.effectiveMode}>
        {children}
      </ThemeProvider>
    </VisualPreferencesSnapshotProvider>
  );
}
/**
 * Keeps Home visually current without forcing its large retained row tree into
 * the foreground update that changes a covered settings screen. React may
 * reconcile the deferred revision in interruptible background work; as soon as
 * Home is focused, its React render selects the live visual revision.
 */
export function FocusDeferredScreenPreferencesBoundary({
  focused,
  children,
}: {
  focused: boolean;
  children: React.ReactNode;
}) {
  const live = useLiveVisualPreferences();
  const deferred = React.useDeferredValue(live);
  const presented = focused ? live : deferred;
  return <ScreenVisualTree snapshot={presented}>{children}</ScreenVisualTree>;
}
/**
 * Publishes one application-wide visual revision. A hidden retained screen is
 * updated when the user changes theme, accent or language rather than waiting
 * for a focus callback to publish the new preferences.
 */
export function ScreenPreferencesBoundary({
  children,
}: {
  children: React.ReactNode;
}) {
  const visible = useLiveVisualPreferences();
  return <ScreenVisualTree snapshot={visible}>{children}</ScreenVisualTree>;
}
export function useVisualTheme(): ThemeMode {
  return React.useContext(VisualThemeContext);
}
export function useVisualEffectiveMode(): EffectiveColorMode {
  return React.useContext(VisualEffectiveModeContext);
}
export function useVisualColorScheme(): ColorScheme {
  return React.useContext(VisualColorSchemeContext);
}
export function useVisualLanguage(): string {
  return React.useContext(VisualLanguageContext);
}
