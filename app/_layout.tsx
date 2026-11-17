import "../global.css";
import i18n from "@/i18n/config";

import React, { useEffect, useLayoutEffect, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  Text,
  View,
} from "react-native";
import { Stack, useNavigationContainerRef, useRouter } from "expo-router";
import type { ErrorBoundaryProps } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { format } from "date-fns/format";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { PortalProvider } from "@gorhom/portal";
import { useAppDatabaseMigrations } from "@/platform/database/use-app-database-migrations";
import { useSettingsStore } from "@/stores/settings-store";
import {
  refreshReminderNotificationTimezone,
  startPendingReminderWorkBeforeBackground,
  subscribeToReminderNotificationResponses,
  warmupHabitReminders,
} from "@/composition/reminders";
import { retryFailedSettingsPlatformEffects } from "@/composition/settings";
import { darkTheme, lightTheme } from "@/theme/colors";
import {
  applyNativeColorPreference,
  refreshNativeColorMode,
  useNativeColorMode,
} from "@/theme/native-appearance";
import { useUIStore } from "@/stores/ui-store";
import { setAndroidNavigationBarTheme } from "@/utils/system-navigation-bar";
import { runWhenUiIsIdle } from "@/utils/ui-scheduling";
import { subscribeToCurrentLocalDate } from "@/hooks/useCurrentLocalDate";
import {
  ScreenPreferencesBoundary,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";

function AppChromeBoundary({ children }: { children: React.ReactNode }) {
  const theme = useSettingsStore((state) => state.theme);
  const systemColorScheme = useNativeColorMode();
  const isDarkTheme =
    theme === "dark" || (theme === "system" && systemColorScheme === "dark");
  const stackBackgroundColor = isDarkTheme
    ? darkTheme.background
    : lightTheme.background;
  useLayoutEffect(() => {
    applyNativeColorPreference(theme);
  }, [theme]);
  useLayoutEffect(() => {
    setAndroidNavigationBarTheme(isDarkTheme);
  }, [isDarkTheme]);
  return (
    <View style={{ flex: 1, backgroundColor: stackBackgroundColor }}>
      <StatusBar style={isDarkTheme ? "light" : "dark"} />
      {children}
    </View>
  );
}

const AppNavigation = React.memo(function AppNavigation() {
  const effectiveMode = useVisualEffectiveMode();
  const stackBackgroundColor =
    effectiveMode === "dark" ? darkTheme.background : lightTheme.background;
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: "none",
        contentStyle: { backgroundColor: stackBackgroundColor },
      }}
    >
      <Stack.Screen name="index" options={{ freezeOnBlur: false }} />
    </Stack>
  );
});

function AppContent() {
  const router = useRouter();
  const navigationRef = useNavigationContainerRef();
  useEffect(
    () =>
      subscribeToReminderNotificationResponses(() => {
        const today = format(new Date(), "yyyy-MM-dd");
        useUIStore.getState().requestNotificationPresentation(today);
        useUIStore.getState().selectDate(today);
        const rootState = navigationRef.isReady()
          ? navigationRef.getRootState()
          : undefined;
        const rootRoute = rootState?.routes[rootState.index ?? 0];
        const sceneState = rootRoute?.state;
        const scene = sceneState?.routes[sceneState.index ?? 0];
        // Home is the leaf index of the root layout, not a nested settings index.
        const homeAlreadyMounted =
          rootState?.stale === false &&
          rootRoute?.name === "__root" &&
          sceneState?.stale === false &&
          scene?.name === "index" &&
          scene.state == null;
        if (!homeAlreadyMounted) router.replace("/");
      }),
    [navigationRef, router],
  );
  useEffect(() => {
    const unsubscribeLocalDate = subscribeToCurrentLocalDate(() => {
      if (AppState.currentState !== "active") return;
      void refreshReminderNotificationTimezone().catch(() => {
        // The next date or foreground transition retries uncertain native work.
      });
    });
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        refreshNativeColorMode();
        retryFailedSettingsPlatformEffects();
        void refreshReminderNotificationTimezone().catch(() => {
          // Uncertain native state is retried once on the next foreground transition.
        });
      } else {
        startPendingReminderWorkBeforeBackground();
      }
    });
    return () => {
      unsubscribeLocalDate();
      subscription.remove();
    };
  }, []);
  return (
    <AppChromeBoundary>
      <ScreenPreferencesBoundary>
        <PortalProvider>
          <AppNavigation />
        </PortalProvider>
      </ScreenPreferencesBoundary>
    </AppChromeBoundary>
  );
}

function StartupState({
  error,
  errorMessage,
  onRetry,
  mode,
}: {
  error?: boolean;
  errorMessage?: string;
  onRetry?: () => void;
  mode?: "light" | "dark";
}) {
  const systemColorScheme = useNativeColorMode();
  const isDarkTheme = (mode ?? systemColorScheme) === "dark";
  const palette = isDarkTheme ? darkTheme : lightTheme;
  useLayoutEffect(() => {
    setAndroidNavigationBarTheme(isDarkTheme);
  }, [isDarkTheme]);
  return (
    <>
      <StatusBar style={isDarkTheme ? "light" : "dark"} />
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: 32,
          backgroundColor: palette.background,
        }}
      >
        {error ? (
          <>
            <Text
              style={{
                color: palette.primary,
                fontSize: 16,
                textAlign: "center",
              }}
            >
              {errorMessage ?? i18n.t("common.migrationError")}
            </Text>
            <Pressable
              onPress={onRetry}
              accessibilityRole="button"
              accessibilityLabel={i18n.t("common.retry")}
              style={{ minHeight: 44, justifyContent: "center", marginTop: 12 }}
            >
              <Text
                style={{
                  color: palette.primary,
                  fontSize: 15,
                  fontWeight: "600",
                }}
              >
                {i18n.t("common.retry")}
              </Text>
            </Pressable>
          </>
        ) : (
          <ActivityIndicator size="small" color={palette.muted} />
        )}
      </View>
    </>
  );
}

function MigratedApp({ onRetry }: { onRetry: () => void }) {
  const { success, error } = useAppDatabaseMigrations();
  const loadSettings = useSettingsStore((state) => state.loadSettings);
  const [bootstrapReady, setBootstrapReady] = useState(false);
  const [settingsLoadFailed, setSettingsLoadFailed] = useState(false);
  useEffect(() => {
    if (!success) return;
    let active = true;
    void (async () => {
      let loaded = false;
      try {
        loaded = await loadSettings();
      } catch {
        loaded = false;
      }
      if (active) {
        setSettingsLoadFailed(!loaded);
        setBootstrapReady(true);
      }
      if (loaded) {
        // Best-effort module preparation must not hold the startup screen.
        runWhenUiIsIdle(() => {
          void warmupHabitReminders();
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [success, loadSettings]);
  if (error) {
    console.error("Database migration failed", error);
    return <StartupState error onRetry={onRetry} />;
  }
  if (success && bootstrapReady && settingsLoadFailed) {
    return (
      <StartupState
        error
        errorMessage={i18n.t("common.dataErrorMessage")}
        onRetry={onRetry}
      />
    );
  }
  if (!success || !bootstrapReady) return <StartupState />;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppContent />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default function RootLayout() {
  const [migrationAttempt, setMigrationAttempt] = useState(0);
  return (
    <MigratedApp
      key={migrationAttempt}
      onRetry={() => setMigrationAttempt((attempt) => attempt + 1)}
    />
  );
}

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => { console.error("Screen rendering failed", error); }, [error]);
  const theme = useSettingsStore((state) => state.theme);
  const systemColorScheme = useNativeColorMode();
  const mode = theme === "system" ? systemColorScheme : theme;
  return (
    <StartupState
      error
      errorMessage={i18n.t("common.dataErrorMessage")}
      mode={mode === "dark" ? "dark" : "light"}
      onRetry={() => { void retry(); }}
    />
  );
}
