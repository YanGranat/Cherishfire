export type IOSAppModalNativePhase =
  | "hidden"
  | "presenting"
  | "shown"
  | "dismissing";
export interface IOSAppModalNativeLifecycle {
  desiredVisible: boolean;
  generation: number;
  nativeVisible: boolean;
  phase: IOSAppModalNativePhase;
}
export interface IOSAppModalNativeEventResult {
  accepted: boolean;
  reopened: boolean;
  state: IOSAppModalNativeLifecycle;
}
export function createIOSAppModalNativeLifecycle(
  desiredVisible: boolean,
): IOSAppModalNativeLifecycle {
  return desiredVisible
    ? {
        desiredVisible: true,
        generation: 1,
        nativeVisible: true,
        phase: "presenting",
      }
    : {
        desiredVisible: false,
        generation: 0,
        nativeVisible: false,
        phase: "hidden",
      };
}
/**
 * Serializes UIKit presentation and dismissal. A request that reverses while
 * UIKit is still presenting/dismissing is retained as the latest intent and
 * applied only after the matching native completion callback.
 */
export function reconcileIOSAppModalDesiredVisibility(
  state: IOSAppModalNativeLifecycle,
  desiredVisible: boolean,
): IOSAppModalNativeLifecycle {
  if (state.desiredVisible === desiredVisible) return state;
  if (desiredVisible) {
    if (state.phase === "hidden") {
      return {
        desiredVisible: true,
        generation: state.generation + 1,
        nativeVisible: true,
        phase: "presenting",
      };
    }
    return {
      ...state,
      desiredVisible: true,
    };
  }
  if (state.phase === "shown") {
    return {
      ...state,
      desiredVisible: false,
      nativeVisible: false,
      phase: "dismissing",
    };
  }
  return {
    ...state,
    desiredVisible: false,
  };
}
export function recordIOSAppModalNativeShown(
  state: IOSAppModalNativeLifecycle,
  generation: number,
): IOSAppModalNativeEventResult {
  if (state.generation !== generation || state.phase !== "presenting") {
    return { accepted: false, reopened: false, state };
  }
  if (!state.desiredVisible) {
    return {
      accepted: true,
      reopened: false,
      state: {
        ...state,
        nativeVisible: false,
        phase: "dismissing",
      },
    };
  }
  return {
    accepted: true,
    reopened: false,
    state: {
      ...state,
      phase: "shown",
    },
  };
}
export function recordIOSAppModalNativeDismissed(
  state: IOSAppModalNativeLifecycle,
  generation: number,
): IOSAppModalNativeEventResult {
  if (state.generation !== generation || state.phase !== "dismissing") {
    return { accepted: false, reopened: false, state };
  }
  if (state.desiredVisible) {
    return {
      accepted: true,
      reopened: true,
      state: {
        desiredVisible: true,
        generation: state.generation + 1,
        nativeVisible: true,
        phase: "presenting",
      },
    };
  }
  return {
    accepted: true,
    reopened: false,
    state: {
      desiredVisible: false,
      generation: state.generation,
      nativeVisible: false,
      phase: "hidden",
    },
  };
}
/**
 * While an Android portal fades out, its full-screen host remains the sole hit
 * target: descendants cannot run stale actions and touches cannot fall through
 * to the scene below.
 */
export function resolveAndroidAppModalPointerEvents(params: {
  visible: boolean;
  fading: boolean;
}): "auto" | "box-only" | "none" {
  if (params.visible) return "auto";
  return params.fading ? "box-only" : "none";
}
/**
 * A completed hidden host may stay mounted only while its owning route still
 * grants explicit retention. Revoking that permission is a physical lifecycle
 * change even though semantic visibility did not change again.
 */
export function shouldDetachHiddenAndroidAppModalHost(params: {
  visible: boolean;
  retainHiddenHost: boolean;
  portalMounted: boolean;
}): boolean {
  return params.portalMounted && !params.visible && !params.retainHiddenHost;
}
/**
 * A route may reacquire hidden-host retention after it regains focus. The
 * physical host must be mounted again even though semantic visibility remains
 * false throughout the focus round-trip.
 */
export function shouldAttachAndroidAppModalHost(params: {
  visible: boolean;
  retainHiddenHost: boolean;
  portalMounted: boolean;
}): boolean {
  return !params.portalMounted && (params.visible || params.retainHiddenHost);
}
/**
 * A native-driver completion may arrive after a close/open reversal. Only the
 * completion that still owns both the current generation and direction may
 * publish onShow/onDismiss or unmount the Android portal.
 */
export function isCurrentAndroidAppModalFadeCompletion(
  currentGeneration: number,
  currentVisible: boolean,
  completedGeneration: number,
  completedVisible: boolean,
): boolean {
  return (
    currentGeneration === completedGeneration &&
    currentVisible === completedVisible
  );
}
