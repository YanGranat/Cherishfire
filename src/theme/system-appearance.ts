import * as React from "react";
import { Appearance, type ColorSchemeName } from "react-native";

export type EffectiveColorMode = "light" | "dark";

function normalizeColorScheme(
  colorScheme: ColorSchemeName,
): EffectiveColorMode {
  return colorScheme === "dark" ? "dark" : "light";
}

let currentMode = normalizeColorScheme(Appearance.getColorScheme());
const listeners = new Set<() => void>();
let appearanceSubscription: ReturnType<
  typeof Appearance.addChangeListener
> | null = null;

function publishColorMode(nextMode: EffectiveColorMode): void {
  if (nextMode === currentMode) return;
  currentMode = nextMode;
  for (const listener of [...listeners]) listener();
}

function ensureAppearanceSubscription(): void {
  if (appearanceSubscription != null) return;
  appearanceSubscription = Appearance.addChangeListener(({ colorScheme }) => {
    publishColorMode(normalizeColorScheme(colorScheme));
  });
}

export function subscribeSystemColorMode(listener: () => void): () => void {
  listeners.add(listener);
  ensureAppearanceSubscription();
  return () => {
    listeners.delete(listener);
    if (listeners.size !== 0) return;
    appearanceSubscription?.remove();
    appearanceSubscription = null;
  };
}

export function getSystemColorMode(): EffectiveColorMode {
  // Refresh the initial module snapshot before the first subscriber mounts.
  // This also covers a system theme change while the process was suspended.
  if (listeners.size === 0) {
    currentMode = normalizeColorScheme(Appearance.getColorScheme());
  }
  return currentMode;
}

/** Re-checks the native value after process resume in case no event was delivered. */
export function refreshSystemColorMode(): void {
  publishColorMode(normalizeColorScheme(Appearance.getColorScheme()));
}

export function useSystemColorMode(): EffectiveColorMode {
  return React.useSyncExternalStore(
    subscribeSystemColorMode,
    getSystemColorMode,
    getSystemColorMode,
  );
}
