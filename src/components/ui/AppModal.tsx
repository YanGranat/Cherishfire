import React from "react";
import {
  Animated,
  BackHandler,
  Easing,
  Modal,
  Platform,
  StyleSheet,
  View,
  type ModalProps,
} from "react-native";
import { Portal, usePortal } from "@gorhom/portal";
import {
  VisualPreferencesSnapshotProvider,
  useVisualColorScheme,
  useVisualEffectiveMode,
  useVisualLanguage,
  useVisualTheme,
  type VisualPreferencesSnapshot,
} from "@/components/ScreenPreferencesBoundary";
import {
  createIOSAppModalNativeLifecycle,
  isCurrentAndroidAppModalFadeCompletion,
  reconcileIOSAppModalDesiredVisibility,
  recordIOSAppModalNativeDismissed,
  recordIOSAppModalNativeShown,
  resolveAndroidAppModalPointerEvents,
  shouldAttachAndroidAppModalHost,
  shouldDetachHiddenAndroidAppModalHost,
  type IOSAppModalNativeLifecycle,
} from "@/components/ui/app-modal-native-lifecycle";
import { ThemeVariablesProvider } from "@/theme/provider";
interface AppModalProps extends ModalProps {
  /**
   * Keeps an empty Android Portal host attached while the overlay is hidden.
   * This is reserved for expensive, animation-free overlays whose first open
   * would otherwise wait for @gorhom/portal's passive mount effect.
   */
  keepMountedOnAndroid?: boolean;
}
interface ModalTransitionSnapshot {
  generation: number;
  visible: boolean;
}
interface AndroidFadeCommitSnapshot {
  generation: number;
  visible: boolean;
}
let nextLayoutSynchronizedPortalId = 1;
/**
 * @gorhom/portal publishes changed children from a passive effect. That is
 * correct for ordinary static overlays, but retained content and a grouped
 * opacity fade both need their changed native props committed before the next
 * visible frame. Keep this narrowly scoped adapter local to AppModal instead
 * of changing the library or every portal in the application.
 */
function LayoutSynchronizedPortal({ children }: { children: React.ReactNode }) {
  const { addPortal, updatePortal, removePortal } = usePortal();
  const nameRef = React.useRef<string | null>(null);
  if (nameRef.current == null) {
    nameRef.current = `app-modal-retained-${nextLayoutSynchronizedPortalId}`;
    nextLayoutSynchronizedPortalId += 1;
  }
  const name = nameRef.current;
  const mountedRef = React.useRef(false);
  const publishedChildrenRef = React.useRef<React.ReactNode>(null);
  React.useLayoutEffect(() => {
    mountedRef.current = true;
    publishedChildrenRef.current = children;
    addPortal(name, children);
    return () => {
      mountedRef.current = false;
      publishedChildrenRef.current = null;
      removePortal(name);
    };
    // The provider dispatchers are stable; changed children are published below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addPortal, name, removePortal]);
  React.useLayoutEffect(() => {
    if (!mountedRef.current || publishedChildrenRef.current === children)
      return;
    publishedChildrenRef.current = children;
    updatePortal(name, children);
  }, [children, name, updatePortal]);
  return null;
}
function AndroidFadeCommitMarker({
  transition,
  compositingActive,
  onCommit,
}: {
  transition: AndroidFadeCommitSnapshot;
  compositingActive: boolean;
  onCommit: (transition: AndroidFadeCommitSnapshot) => void;
}) {
  React.useLayoutEffect(() => {
    if (!compositingActive) return;
    onCommit(transition);
  }, [compositingActive, onCommit, transition]);
  return null;
}
// Unified modal wrapper.
export function AppModal({
  keepMountedOnAndroid = false,
  visible = false,
  transparent = false,
  animationType = "none",
  children,
  onDismiss,
  onRequestClose,
  onShow,
  navigationBarTranslucent,
  ...props
}: AppModalProps) {
  const usesAndroidPortal = Platform.OS === "android";
  const usesIOSNativeModal = Platform.OS === "ios";
  const visualTheme = useVisualTheme();
  const visualEffectiveMode = useVisualEffectiveMode();
  const visualColorScheme = useVisualColorScheme();
  const visualLanguage = useVisualLanguage();
  const currentVisualPreferences = React.useMemo<VisualPreferencesSnapshot>(
    () => ({
      theme: visualTheme,
      effectiveMode: visualEffectiveMode,
      colorScheme: visualColorScheme,
      language: visualLanguage,
    }),
    [visualColorScheme, visualEffectiveMode, visualLanguage, visualTheme],
  );
  const shouldFade = animationType === "fade";
  const initialOpacity = visible && !shouldFade ? 1 : 0;
  const opacity = React.useRef(new Animated.Value(initialOpacity)).current;
  const [androidFadeCompositingActive, setAndroidFadeCompositingActive] =
    React.useState(usesAndroidPortal && shouldFade && visible);
  const androidFadeStartedRef = React.useRef<{
    generation: number;
    visible: boolean;
  } | null>(null);
  const androidFadeCompletedRef = React.useRef<{
    generation: number;
    visible: boolean;
  } | null>(null);
  const androidImmediateCompletedRef = React.useRef<{
    generation: number;
    visible: boolean;
  } | null>(
    usesAndroidPortal && !shouldFade ? { generation: 0, visible } : null,
  );
  const [androidFadeIntent, setAndroidFadeIntent] =
    React.useState<AndroidFadeCommitSnapshot>({
      generation: 0,
      visible,
    });
  const [androidFadePortalCommit, setAndroidFadePortalCommit] =
    React.useState<AndroidFadeCommitSnapshot | null>(null);
  const shouldRetainAndroidPortal =
    usesAndroidPortal && keepMountedOnAndroid && !shouldFade;
  const [portalMounted, setPortalMounted] = React.useState(
    visible || shouldRetainAndroidPortal,
  );
  const portalMountedRef = React.useRef(visible || shouldRetainAndroidPortal);
  const [portalHostCommitted, setPortalHostCommitted] = React.useState(false);
  const portalHostCommittedRef = React.useRef(false);
  const androidPortalMounted = visible || portalMounted;
  const [iosNativeLifecycle, setIOSNativeLifecycle] = React.useState(() =>
    createIOSAppModalNativeLifecycle(visible),
  );
  const iosNativeLifecycleRef = React.useRef(iosNativeLifecycle);
  const transitionRef = React.useRef<ModalTransitionSnapshot>({
    generation: 0,
    visible,
  });
  const observedVisibilityRef = React.useRef(false);
  const onDismissRef = React.useRef(onDismiss);
  const onRequestCloseRef = React.useRef(onRequestClose);
  const onShowRef = React.useRef(onShow);
  onDismissRef.current = onDismiss;
  onRequestCloseRef.current = onRequestClose;
  onShowRef.current = onShow;
  const commitIOSNativeLifecycle = React.useCallback(
    (next: IOSAppModalNativeLifecycle) => {
      if (iosNativeLifecycleRef.current === next) return;
      iosNativeLifecycleRef.current = next;
      setIOSNativeLifecycle(next);
    },
    [],
  );
  const portalOpacityStyle = React.useMemo(
    () => ({
      opacity: shouldFade
        ? opacity
        : shouldRetainAndroidPortal && !visible
          ? 0
          : 1,
    }),
    [opacity, shouldFade, shouldRetainAndroidPortal, visible],
  );
  const setPortalVisibility = React.useCallback(
    (mounted: boolean) => {
      const nextMounted = mounted || shouldRetainAndroidPortal;
      portalMountedRef.current = nextMounted;
      if (!nextMounted) {
        portalHostCommittedRef.current = false;
        setPortalHostCommitted(false);
      }
      setPortalMounted(nextMounted);
    },
    [shouldRetainAndroidPortal],
  );
  const setPortalHostNode = React.useCallback((node: View | null) => {
    if (node == null) {
      return;
    }
    if (portalHostCommittedRef.current) return;
    portalHostCommittedRef.current = true;
    setPortalHostCommitted(true);
  }, []);
  const recordAndroidFadePortalCommit = React.useCallback(
    (committed: AndroidFadeCommitSnapshot) => {
      const transition = transitionRef.current;
      if (
        transition.generation !== committed.generation ||
        transition.visible !== committed.visible
      ) {
        return;
      }
      setAndroidFadePortalCommit((current) =>
        current?.generation === committed.generation &&
        current.visible === committed.visible
          ? current
          : committed,
      );
    },
    [],
  );
  const finishAndroidFade = React.useCallback(
    (state: "shown" | "dismissed", generation: number) => {
      const transition = transitionRef.current;
      if (
        !isCurrentAndroidAppModalFadeCompletion(
          transition.generation,
          transition.visible,
          generation,
          state === "shown",
        )
      ) {
        return;
      }
      androidFadeStartedRef.current = null;
      androidFadeCompletedRef.current = {
        generation,
        visible: state === "shown",
      };
      if (state === "shown") {
        setAndroidFadeCompositingActive(false);
        onShowRef.current?.({ nativeEvent: {} } as Parameters<
          NonNullable<ModalProps["onShow"]>
        >[0]);
        return;
      }
      setAndroidFadeCompositingActive(false);
      setPortalVisibility(false);
      onDismissRef.current?.();
    },
    [setPortalVisibility],
  );
  React.useLayoutEffect(() => {
    const previousVisible = observedVisibilityRef.current;
    const visibilityChanged = previousVisible !== visible;
    observedVisibilityRef.current = visible;
    if (!visibilityChanged) return;
    const previousTransition = transitionRef.current;
    const transition: ModalTransitionSnapshot = {
      generation: previousTransition.generation + 1,
      visible,
    };
    transitionRef.current = transition;
    if (usesAndroidPortal && shouldFade) {
      // Stop a superseded native animation immediately. The replacement starts
      // only after the portal has committed both the new semantic intent and
      // its group-compositing layer, so a reversal cannot pass through a stale
      // fully transparent frame.
      opacity.stopAnimation();
      setAndroidFadeIntent({
        generation: transition.generation,
        visible: transition.visible,
      });
    }
  }, [
    animationType,
    shouldFade,
    opacity,
    usesIOSNativeModal,
    usesAndroidPortal,
    visible,
  ]);
  React.useLayoutEffect(() => {
    if (!usesIOSNativeModal) return;
    commitIOSNativeLifecycle(
      reconcileIOSAppModalDesiredVisibility(
        iosNativeLifecycleRef.current,
        visible,
      ),
    );
  }, [commitIOSNativeLifecycle, usesIOSNativeModal, visible]);
  React.useLayoutEffect(() => {
    if (!usesAndroidPortal) return;
    if (
      shouldAttachAndroidAppModalHost({
        visible,
        retainHiddenHost: shouldRetainAndroidPortal,
        portalMounted: portalMountedRef.current,
      })
    ) {
      setPortalVisibility(true);
    }
    const transition = transitionRef.current;
    if (transition.visible !== visible) return;
    if (shouldFade) {
      if (
        androidFadeIntent.generation !== transition.generation ||
        androidFadeIntent.visible !== visible
      ) {
        return;
      }
      const completed = androidFadeCompletedRef.current;
      if (
        completed?.generation === transition.generation &&
        completed.visible === visible
      ) {
        return;
      }
      const started = androidFadeStartedRef.current;
      if (
        started?.generation === transition.generation &&
        started.visible === visible
      ) {
        return;
      }
      // Group alpha must be committed natively before the first non-opaque
      // animation frame. Starting Animated.timing in the same layout pass as
      // this state change can let elevation/text paint one frame separately.
      if (!androidFadeCompositingActive) {
        setAndroidFadeCompositingActive(true);
        return;
      }
      if (
        androidFadePortalCommit?.generation !== transition.generation ||
        androidFadePortalCommit.visible !== visible
      ) {
        return;
      }
    }
    // @gorhom/portal attaches its child through a passive effect. Starting the
    // native animation before this ref exists advances the fade while nothing
    // is paintable, which makes the scrim/card appear to jump out of sync.
    if (!portalHostCommitted) return;
    opacity.stopAnimation();
    if (!shouldFade) {
      const completed = androidImmediateCompletedRef.current;
      if (
        completed?.generation === transition.generation &&
        completed.visible === visible
      ) {
        if (
          shouldDetachHiddenAndroidAppModalHost({
            visible,
            retainHiddenHost: shouldRetainAndroidPortal,
            portalMounted: portalMountedRef.current,
          })
        ) {
          setPortalVisibility(false);
        }
        return;
      }
    }
    if (visible) {
      if (!portalMountedRef.current) setPortalVisibility(true);
      if (!shouldFade) {
        androidImmediateCompletedRef.current = {
          generation: transition.generation,
          visible: true,
        };
        opacity.setValue(1);
        onShowRef.current?.({ nativeEvent: {} } as Parameters<
          NonNullable<ModalProps["onShow"]>
        >[0]);
        return;
      }
      androidFadeStartedRef.current = {
        generation: transition.generation,
        visible: true,
      };
      // A fully dismissed portal is already at zero. If close is interrupted
      // by an immediate reopen, preserve the in-flight opacity instead of
      // flashing through one completely transparent frame.
      Animated.timing(opacity, {
        toValue: 1,
        duration: 150,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (!finished) return;
        finishAndroidFade("shown", transition.generation);
      });
      return;
    }
    if (!portalMountedRef.current) return;
    if (!shouldFade) {
      androidImmediateCompletedRef.current = {
        generation: transition.generation,
        visible: false,
      };
      setPortalVisibility(false);
      onDismissRef.current?.();
      return;
    }
    androidFadeStartedRef.current = {
      generation: transition.generation,
      visible: false,
    };
    Animated.timing(opacity, {
      toValue: 0,
      duration: 120,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) return;
      finishAndroidFade("dismissed", transition.generation);
    });
  }, [
    animationType,
    androidFadeCompositingActive,
    androidFadeIntent,
    androidFadePortalCommit,
    opacity,
    finishAndroidFade,
    portalHostCommitted,
    setPortalVisibility,
    shouldFade,
    shouldRetainAndroidPortal,
    usesAndroidPortal,
    visible,
  ]);
  React.useLayoutEffect(
    () => () => {
      opacity.stopAnimation();
    },
    [opacity],
  );
  const iosNativeSceneDeparting =
    usesIOSNativeModal &&
    (!visible || iosNativeLifecycle.phase === "dismissing");
  const androidFadeSceneDeparting = usesAndroidPortal && shouldFade && !visible;
  const modalSceneDeparting =
    iosNativeSceneDeparting || androidFadeSceneDeparting;
  const currentModalPresentation = React.useMemo(
    () => ({
      children,
      visualPreferences: currentVisualPreferences,
    }),
    [children, currentVisualPreferences],
  );
  const stableDepartingPresentationRef = React.useRef(currentModalPresentation);
  const modalPresentation = modalSceneDeparting
    ? stableDepartingPresentationRef.current
    : currentModalPresentation;
  React.useLayoutEffect(() => {
    if (modalSceneDeparting) return;
    stableDepartingPresentationRef.current = currentModalPresentation;
  }, [currentModalPresentation, modalSceneDeparting]);
  React.useEffect(() => {
    if (!usesAndroidPortal || !androidPortalMounted) return;
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        if (!transitionRef.current.visible) {
          // A fading-out portal still owns the screen until its tuned close
          // animation unmounts. The permanently retained, already hidden date
          // picker host is different: it is empty and must not intercept Back.
          return shouldRetainAndroidPortal ? false : true;
        }
        onRequestCloseRef.current?.({ nativeEvent: {} } as Parameters<
          NonNullable<ModalProps["onRequestClose"]>
        >[0]);
        return true;
      },
    );
    return () => subscription.remove();
  }, [androidPortalMounted, shouldRetainAndroidPortal, usesAndroidPortal]);
  // For transparent overlays on Android, keep nav bar translucent too.
  // Otherwise the system can draw a near-black nav area under the modal window.
  const resolvedNavigationBarTranslucent =
    navigationBarTranslucent ?? Boolean(transparent);
  if (usesAndroidPortal) {
    if (!androidPortalMounted) return null;
    const portalContent = (
      <VisualPreferencesSnapshotProvider
        {...modalPresentation.visualPreferences}
      >
        <ThemeVariablesProvider
          effectiveMode={modalPresentation.visualPreferences.effectiveMode}
        >
          <Animated.View
            ref={setPortalHostNode}
            accessibilityViewIsModal={visible}
            importantForAccessibility={visible ? "yes" : "no-hide-descendants"}
            pointerEvents={resolveAndroidAppModalPointerEvents({
              visible,
              fading: shouldFade,
            })}
            needsOffscreenAlphaCompositing={androidFadeCompositingActive}
            renderToHardwareTextureAndroid={androidFadeCompositingActive}
            style={[
              StyleSheet.absoluteFillObject,
              portalOpacityStyle,
              { backgroundColor: "transparent" },
            ]}
          >
            {shouldFade ? (
              <AndroidFadeCommitMarker
                transition={androidFadeIntent}
                compositingActive={androidFadeCompositingActive}
                onCommit={recordAndroidFadePortalCommit}
              />
            ) : null}
            <>
              <View style={styles.portalContent}>
                {modalPresentation.children}
              </View>
            </>
          </Animated.View>
        </ThemeVariablesProvider>
      </VisualPreferencesSnapshotProvider>
    );
    return shouldRetainAndroidPortal || shouldFade ? (
      <LayoutSynchronizedPortal>{portalContent}</LayoutSynchronizedPortal>
    ) : (
      <Portal>{portalContent}</Portal>
    );
  }
  const nativeModalGeneration = usesIOSNativeModal
    ? iosNativeLifecycle.generation
    : 0;
  const nativeModalVisible = usesIOSNativeModal
    ? iosNativeLifecycle.nativeVisible
    : visible;
  return (
    <Modal
      visible={nativeModalVisible}
      transparent={transparent}
      animationType={animationType}
      onRequestClose={(event) => {
        // UIKit can still deliver a close request while the previous native
        // controller is finishing its dismissal. The latest reopen intent is
        // queued until onDismiss; do not let the departing modal invoke stale
        // product callbacks in that interval.
        if (
          usesIOSNativeModal &&
          (!iosNativeLifecycleRef.current.desiredVisible ||
            iosNativeLifecycleRef.current.phase === "dismissing")
        ) {
          return;
        }
        onRequestClose?.(event);
      }}
      onShow={(event) => {
        if (usesIOSNativeModal) {
          const nativeEvent = recordIOSAppModalNativeShown(
            iosNativeLifecycleRef.current,
            nativeModalGeneration,
          );
          if (!nativeEvent.accepted) return;
          commitIOSNativeLifecycle(nativeEvent.state);
          if (!nativeEvent.state.desiredVisible) return;
        }
        const transition = transitionRef.current;
        if (!transition.visible) return;
        onShow?.(event);
      }}
      onDismiss={() => {
        if (usesIOSNativeModal) {
          const nativeEvent = recordIOSAppModalNativeDismissed(
            iosNativeLifecycleRef.current,
            nativeModalGeneration,
          );
          if (!nativeEvent.accepted) return;
          commitIOSNativeLifecycle(nativeEvent.state);
          if (nativeEvent.reopened) return;
        }
        const transition = transitionRef.current;
        if (transition.visible) return;
        onDismiss?.();
      }}
      navigationBarTranslucent={resolvedNavigationBarTranslucent}
      {...props}
    >
      <VisualPreferencesSnapshotProvider
        {...modalPresentation.visualPreferences}
      >
        <ThemeVariablesProvider
          effectiveMode={modalPresentation.visualPreferences.effectiveMode}
        >
          <>
            <View
              collapsable={false}
              // `visible` is the desired state, while iOS may still be dismissing
              // the previous native controller before a queued reopen. Only the
              // currently owned native presentation may dispatch child actions.
              pointerEvents={
                visible && !iosNativeSceneDeparting ? "auto" : "box-only"
              }
              accessibilityElementsHidden={!visible || iosNativeSceneDeparting}
              importantForAccessibility={
                visible && !iosNativeSceneDeparting
                  ? "yes"
                  : "no-hide-descendants"
              }
              style={styles.portalContent}
            >
              {modalPresentation.children}
            </View>
          </>
        </ThemeVariablesProvider>
      </VisualPreferencesSnapshotProvider>
    </Modal>
  );
}
const styles = StyleSheet.create({
  portalContent: {
    flex: 1,
  },
});
