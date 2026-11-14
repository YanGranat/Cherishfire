import { Platform, processColor } from "react-native";
import Constants, { ExecutionEnvironment } from "expo-constants";
import * as NavigationBar from "expo-navigation-bar";
import { darkTheme, lightTheme } from "@/theme/colors";
type NavigationBarButtonStyle = "light" | "dark";
type NativeNavigationBarModule = {
  setBackgroundColorAsync?: (color: number) => Promise<void>;
  setBorderColorAsync?: (color: number) => Promise<void>;
  setButtonStyleAsync?: (style: NavigationBarButtonStyle) => Promise<void>;
};
let expoGoNavigationBarModule: NativeNavigationBarModule | null | undefined;
function getExpoGoNavigationBarModule(): NativeNavigationBarModule | null {
  if (expoGoNavigationBarModule !== undefined) {
    return expoGoNavigationBarModule;
  }
  try {
    // Expo Go owns its native window and does not contain this project's
    // edge-to-edge theme plugin. Use its included native module directly so
    // an opaque host navigation bar receives both a background and buttons.
    const module =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("expo-navigation-bar/build/ExpoNavigationBar.android") as NativeNavigationBarModule & {
        default?: NativeNavigationBarModule;
      };
    expoGoNavigationBarModule = module.default ?? module;
  } catch {
    expoGoNavigationBarModule = null;
  }
  return expoGoNavigationBarModule ?? null;
}
function setExpoGoNavigationBarTheme(isDarkTheme: boolean): void {
  const module = getExpoGoNavigationBarModule();
  if (!module) return;
  const backgroundColor = isDarkTheme
    ? darkTheme.background
    : lightTheme.background;
  const processedBackground = processColor(backgroundColor);
  const buttonStyle: NavigationBarButtonStyle = isDarkTheme ? "light" : "dark";
  const runBestEffort = (task: () => Promise<void>): void => {
    try {
      void task().catch(() => {});
    } catch {}
  };
  if (typeof processedBackground === "number") {
    if (module.setBackgroundColorAsync) {
      runBestEffort(() => module.setBackgroundColorAsync!(processedBackground));
    }
    if (module.setBorderColorAsync) {
      runBestEffort(() => module.setBorderColorAsync!(processedBackground));
    }
  }
  if (module.setButtonStyleAsync) {
    runBestEffort(() => module.setButtonStyleAsync!(buttonStyle));
  }
}
// In edge-to-edge mode the application owns the background beneath Android's
// navigation bar. Only the foreground buttons need an explicit theme style.
export function setAndroidNavigationBarTheme(isDarkTheme: boolean): void {
  if (Platform.OS !== "android") return;
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    setExpoGoNavigationBarTheme(isDarkTheme);
    return;
  }
  try {
    NavigationBar.setStyle(isDarkTheme ? "dark" : "light");
  } catch {}
}
