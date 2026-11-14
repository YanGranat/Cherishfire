import { useMemo } from "react";
import { Animated, Easing, View, useWindowDimensions } from "react-native";
import {
  type ParamListBase,
  type StackNavigationState,
} from "@react-navigation/native";
import {
  createStackNavigator,
  type StackCardStyleInterpolator,
  type StackNavigationEventMap,
  type StackNavigationOptions,
} from "@react-navigation/stack";
import { withLayoutContext } from "expo-router";
import { useVisualEffectiveMode } from "@/components/ScreenPreferencesBoundary";
import { settingsScreenBackgrounds } from "@/theme/colors";
const { Navigator } = createStackNavigator();
const OPEN_DURATION_MS = 98;
const CLOSE_DURATION_MS = 80;
const OPEN_EASING = Easing.linear;
const CLOSE_EASING = Easing.linear;
const INCOMING_SHIFT_RATIO = 0.2;
const OUTGOING_SHIFT_RATIO = 0.2;
const SettingsStack = withLayoutContext<
  StackNavigationOptions,
  typeof Navigator,
  StackNavigationState<ParamListBase>,
  StackNavigationEventMap
>(Navigator);
// Both cards translate within a bounded fraction of the screen width while
// their opacity follows the same transition progress.
const createIncomingOnlyInterpolator =
  (windowWidth: number): StackCardStyleInterpolator =>
  ({ current, next, closing, layouts }) => {
    const baseWidth = Math.min(layouts.screen.width, windowWidth);
    const incomingShiftPx = baseWidth * INCOMING_SHIFT_RATIO;
    const outgoingShiftPx = baseWidth * OUTGOING_SHIFT_RATIO;
    if (next) {
      const nextTranslateX = next.progress.interpolate({
        inputRange: [0, 1],
        outputRange: [0, -outgoingShiftPx],
        extrapolate: "clamp",
      });
      return {
        containerStyle: { overflow: "hidden" },
        cardStyle: {
          opacity: nextTranslateX.interpolate({
            inputRange: [-outgoingShiftPx, -outgoingShiftPx * 0.5, 0],
            outputRange: [0, 0.5, 1],
            extrapolate: "clamp",
          }),
          transform: [
            {
              translateX: nextTranslateX,
            },
          ],
        },
      };
    }
    const currentTranslateX = Animated.add(
      Animated.multiply(
        current.progress.interpolate({
          inputRange: [0, 1],
          outputRange: [incomingShiftPx, 0],
          extrapolate: "clamp",
        }),
        closing.interpolate({
          inputRange: [0, 1],
          outputRange: [1, 0],
          extrapolate: "clamp",
        }),
      ),
      Animated.multiply(
        current.progress.interpolate({
          inputRange: [0, 1],
          outputRange: [incomingShiftPx, 0],
          extrapolate: "clamp",
        }),
        closing,
      ),
    );
    return {
      containerStyle: { overflow: "hidden" },
      cardStyle: {
        opacity: currentTranslateX.interpolate({
          inputRange: [0, incomingShiftPx],
          outputRange: [1, 0],
          extrapolate: "clamp",
        }),
        transform: [
          {
            translateX: currentTranslateX,
          },
        ],
      },
    };
  };
function SettingsNavigator() {
  const { width: windowWidth } = useWindowDimensions();
  const effectiveMode = useVisualEffectiveMode();
  const stackBackgroundColor = settingsScreenBackgrounds[effectiveMode];
  const cardStyleInterpolator = useMemo(
    () => createIncomingOnlyInterpolator(windowWidth),
    [windowWidth],
  );
  const screenOptions = useMemo<StackNavigationOptions>(
    () => ({
      headerShown: false,
      cardStyle: { backgroundColor: stackBackgroundColor },
      gestureEnabled: false,
      transitionSpec: {
        open: {
          animation: "timing",
          config: { duration: OPEN_DURATION_MS, easing: OPEN_EASING },
        },
        close: {
          animation: "timing",
          config: { duration: CLOSE_DURATION_MS, easing: CLOSE_EASING },
        },
      },
      cardStyleInterpolator,
    }),
    [cardStyleInterpolator, stackBackgroundColor],
  );
  return (
    <View style={{ flex: 1, backgroundColor: stackBackgroundColor }}>
      <SettingsStack detachInactiveScreens screenOptions={screenOptions} />
    </View>
  );
}
export default function SettingsLayout() {
  return <SettingsNavigator />;
}
