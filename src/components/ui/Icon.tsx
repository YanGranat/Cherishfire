import React from "react";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import Ionicons from "@expo/vector-icons/Ionicons";
import { type StyleProp, type TextStyle } from "react-native";
import { useVisualEffectiveMode } from "@/components/ScreenPreferencesBoundary";
import { lightTheme, darkTheme } from "@/theme/colors";
type MaterialIconName = keyof typeof MaterialIcons.glyphMap;
type IoniconName = keyof typeof Ionicons.glyphMap;
interface IconProps {
  name: MaterialIconName | IoniconName;
  family?: "material" | "ionicons";
  size?: number;
  color?: string;
  variant?: "primary" | "muted" | "white";
  style?: StyleProp<TextStyle>;
}
// Themed icon wrapper. MaterialIcons does not support NativeWind className.
// Use this component instead of MaterialIcons directly when theme color is needed.
export function Icon({
  name,
  family = "material",
  size = 24,
  color,
  variant = "primary",
  style,
}: IconProps) {
  const effectiveMode = useVisualEffectiveMode();
  const isDark = effectiveMode === "dark";
  const palette = isDark ? darkTheme : lightTheme;
  const resolvedColor =
    color ??
    (variant === "muted"
      ? palette.muted
      : variant === "white"
        ? "#FFFFFF"
        : palette.icon);
  return family === "ionicons" ? (
    <Ionicons
      name={name as IoniconName}
      size={size}
      color={resolvedColor}
      style={style}
    />
  ) : (
    <MaterialIcons
      name={name as MaterialIconName}
      size={size}
      color={resolvedColor}
      style={style}
    />
  );
}
