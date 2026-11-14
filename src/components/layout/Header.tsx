/** @jsxImportSource nativewind */
import React from "react";
import { View, Text, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "@/components/ui/Icon";
import { sizes } from "@/theme/tokens";
import type MaterialIcons from "@expo/vector-icons/MaterialIcons";
import type Ionicons from "@expo/vector-icons/Ionicons";
import { useTranslation } from "react-i18next";
interface HeaderAction {
  disabled?: boolean;
  icon?: keyof typeof MaterialIcons.glyphMap | keyof typeof Ionicons.glyphMap;
  iconFamily?: "material" | "ionicons";
  iconSize?: number;
  customIcon?: React.ReactNode;
  label?: string;
  accessibilityLabel?: string;
  onPressIn?: () => void;
  onPress: () => void;
}
interface HeaderProps {
  title: string;
  showBack?: boolean;
  onBack?: () => void;
  rightActions?: HeaderAction[];
  centerTitle?: boolean;
  onTitlePress?: () => void;
  backgroundColor?: string;
}
// The 56dp header keeps separate leading, title, and action areas.
function HeaderComponent({
  title,
  showBack = false,
  onBack,
  rightActions = [],
  centerTitle = false,
  onTitlePress,
  backgroundColor,
}: HeaderProps) {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const touchSize = sizes.headerIconTouch;
  const rightActionsWidth = rightActions.length * touchSize;
  const balancedSideWidth = centerTitle
    ? Math.max(showBack ? touchSize : 0, rightActionsWidth)
    : 0;
  return (
    <View
      className="bg-background flex-row items-center"
      style={{
        height: sizes.headerHeight + insets.top,
        paddingTop: insets.top,
        paddingLeft: centerTitle ? 8 : 16,
        paddingRight: 8,
        backgroundColor,
      }}
    >
      <View
        className="items-start justify-center"
        style={centerTitle ? { width: balancedSideWidth } : undefined}
      >
        {showBack ? (
          <Pressable
            onPress={() => {
              onBack?.();
            }}
            accessibilityRole="button"
            accessibilityLabel={t("common.back")}
            className="items-center justify-center active:opacity-60"
            style={{
              width: touchSize,
              height: touchSize,
            }}
          >
            <Icon name="arrow-back" size={sizes.headerIcon} />
          </Pressable>
        ) : null}
      </View>

      {onTitlePress ? (
        <Pressable
          className={`${centerTitle ? "flex-1 items-center" : "flex-1"} active:opacity-60`}
          onPress={() => {
            onTitlePress?.();
          }}
          accessibilityRole="button"
          accessibilityLabel={title}
        >
          <Text
            className={`text-primary font-semibold ${centerTitle ? "text-center" : ""}`}
            style={{ fontSize: 20 }}
            numberOfLines={1}
          >
            {title}
          </Text>
        </Pressable>
      ) : (
        <Text
          className={`text-primary font-semibold flex-1 ${centerTitle ? "text-center" : ""}`}
          style={{ fontSize: 20 }}
          numberOfLines={1}
        >
          {title}
        </Text>
      )}

      <View
        className="flex-row items-center justify-end"
        style={centerTitle ? { width: balancedSideWidth } : undefined}
      >
        {rightActions.map((action, i) => (
          <Pressable
            key={i}
            disabled={action.disabled}
            onPressIn={action.onPressIn}
            onPress={() => {
              action.onPress();
            }}
            accessibilityRole="button"
            accessibilityLabel={action.accessibilityLabel ?? action.label}
            accessibilityState={{ disabled: action.disabled === true }}
            className="items-center justify-center active:opacity-60"
            style={{
              minWidth: touchSize,
              height: touchSize,
              paddingHorizontal: action.label ? 8 : 0,
            }}
          >
            {action.customIcon ? (
              action.customIcon
            ) : action.label ? (
              <Text className="text-primary text-sm font-semibold">
                {action.label}
              </Text>
            ) : action.icon ? (
              <Icon
                name={action.icon}
                family={action.iconFamily}
                size={action.iconSize ?? sizes.headerIcon}
              />
            ) : null}
          </Pressable>
        ))}
      </View>
    </View>
  );
}
export const Header = React.memo(HeaderComponent);
