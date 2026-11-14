import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigation } from "@react-navigation/native";
import {
  createNavigationIntentGateController,
  createNavigationIntentWatchdog,
  type NavigationIntentToken,
} from "@/utils/navigation-intent-gate";
const DEFAULT_SILENT_DISPATCH_TIMEOUT_MS = 500;
export type NavigationIntentDispatchResult =
  | {
      status: "dispatched";
      token: NavigationIntentToken;
    }
  | {
      status: "blocked";
      active: NavigationIntentToken;
    }
  | {
      status: "failed";
      error: unknown;
    };
interface RunNavigationIntentArgs {
  target: string;
  dispatch: () => void;
}
/**
 * Prevents duplicate pushes without leaving a retained source screen locked
 * forever when a navigation dispatch is synchronously rejected or silently
 * ignored.
 */
export function useNavigationIntentGate(
  silentDispatchTimeoutMs = DEFAULT_SILENT_DISPATCH_TIMEOUT_MS,
) {
  const navigation = useNavigation();
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const [controller] = useState(() => createNavigationIntentGateController());
  const [watchdog] = useState(() =>
    createNavigationIntentWatchdog({
      controller,
      isSourceFocused: () => navigationRef.current.isFocused(),
      scheduler: {
        schedule: (callback, delayMs) => setTimeout(callback, delayMs),
        cancel: (handle) => clearTimeout(handle),
      },
    }),
  );
  const clearWatchdog = useCallback(() => {
    watchdog.clear();
  }, [watchdog]);
  useEffect(() => {
    const unsubscribeBlur = navigation.addListener("blur", clearWatchdog);
    const unsubscribeFocus = navigation.addListener("focus", () => {
      clearWatchdog();
      controller.reset();
    });
    return () => {
      clearWatchdog();
      controller.reset();
      unsubscribeBlur();
      unsubscribeFocus();
    };
  }, [clearWatchdog, controller, navigation]);
  return useCallback(
    ({
      target,
      dispatch,
    }: RunNavigationIntentArgs): NavigationIntentDispatchResult => {
      const token = controller.acquire(target);
      if (token == null) {
        const active = controller.getActive();
        if (active == null) {
          // JavaScript is single-threaded, so this can only happen if a future
          // controller implementation releases between acquire and read.
          return {
            status: "failed",
            error: new Error("Navigation intent gate lost its active token"),
          };
        }
        return { status: "blocked", active };
      }
      try {
        dispatch();
      } catch (error) {
        clearWatchdog();
        controller.release(token);
        return { status: "failed", error };
      }
      clearWatchdog();
      if (navigation.isFocused()) {
        watchdog.arm(token, silentDispatchTimeoutMs);
      }
      return { status: "dispatched", token };
    },
    [clearWatchdog, controller, navigation, watchdog, silentDispatchTimeoutMs],
  );
}
