/** @jsxImportSource nativewind */
import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { vars } from "nativewind";
import { getThemeVars } from "./colors";
import type { EffectiveColorMode } from "@/theme/system-appearance";

interface ThemeProviderProps {
  effectiveMode: EffectiveColorMode;
  children: React.ReactNode;
}

const FLEX_FILL = { flex: 1 } as const;
const themeVariableCache = new Map<EffectiveColorMode, ReturnType<typeof vars>>();

function getCachedThemeVariables(
  effectiveMode: EffectiveColorMode,
): ReturnType<typeof vars> {
  const cached = themeVariableCache.get(effectiveMode);
  if (cached) return cached;

  const created = vars(getThemeVars(effectiveMode));
  themeVariableCache.set(effectiveMode, created);
  return created;
}

export function prewarmThemeVariables(): void {
  getCachedThemeVariables("light");
  getCachedThemeVariables("dark");
}

function useThemeVariables(
  effectiveMode: EffectiveColorMode,
) {
  return useMemo(
    () => getCachedThemeVariables(effectiveMode),
    [effectiveMode]
  );
}

export function ThemeProvider({
  effectiveMode,
  children,
}: ThemeProviderProps) {
  const themeStyle = useThemeVariables(effectiveMode);
  const rootStyle = useMemo(() => [FLEX_FILL, themeStyle], [themeStyle]);

  return (
    <View style={rootStyle} className="bg-background">
      {children}
    </View>
  );
}

/**
 * Re-establishes NativeWind variables in a detached native subtree without
 * painting its own background. Android portal hosts do not inherit the
 * scene's variable context, while modal scrims must remain transparent.
 */
export function ThemeVariablesProvider({
  effectiveMode,
  children,
}: ThemeProviderProps) {
  const themeStyle = useThemeVariables(effectiveMode);
  const hostStyle = useMemo(
    () => [StyleSheet.absoluteFillObject, themeStyle],
    [themeStyle],
  );

  return (
    <View style={hostStyle}>{children}</View>
  );
}
