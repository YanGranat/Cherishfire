import React from "react";
import { Pressable } from "react-native";
import Entypo from "@expo/vector-icons/Entypo";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { sizes, zIndex } from "@/theme/tokens";
import { useTranslation } from "react-i18next";
import { useVisualColorScheme } from "@/components/ScreenPreferencesBoundary";
import { getAccentScheme } from "@/theme/colors";
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
interface FABProps {
  onPress: () => void;
  onPressIn?: () => void;
}
// A 56dp accent action button anchored to the bottom-right safe area.
export function FAB({ onPress, onPressIn }: FABProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const accent = getAccentScheme(useVisualColorScheme());
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  return (
    <AnimatedPressable
      onPress={() => {
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={t("creation.title")}
      onPressIn={() => {
        onPressIn?.();
        scale.value = withSpring(0.95);
      }}
      onPressOut={() => {
        scale.value = withSpring(1);
      }}
      style={[
        animatedStyle,
        {
          position: "absolute",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: accent.base,
          bottom: 16 + insets.bottom,
          right: 16,
          width: sizes.fab,
          height: sizes.fab,
          borderRadius: sizes.fab / 2,
          zIndex: zIndex.fab,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.2,
          shadowRadius: 8,
          elevation: 4,
        },
      ]}
    >
      <Entypo name="plus" size={34} color="#FFFFFF" />
    </AnimatedPressable>
  );
}
