/** @jsxImportSource nativewind */
import React from "react";
import { View, Text, Pressable, TextInput } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useTranslation } from "react-i18next";
import { darkTheme, getAccentScheme, lightTheme } from "@/theme/colors";
import {
  useVisualColorScheme,
  useVisualLanguage,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
import { sizes } from "@/theme/tokens";
import { Toggle } from "@/components/ui/Toggle";
import { normalizeIntervalDraft } from "@/features/habit-form/utils/repeat-interval";
import { getEveryNDaysLabel } from "@/features/habits/presentation/repeat-labels";
interface RepeatIntervalTabProps {
  value: string;
  onChange: (value: string) => void;
  fromCompletion: boolean;
  onFromCompletionChange: (value: boolean) => void;
}
const MIN_INTERVAL = 2;
const MAX_INTERVAL = 365;
// Numeric interval input and stepper share the latest normalized draft.
export function RepeatIntervalTab({
  value,
  onChange,
  fromCompletion,
  onFromCompletionChange,
}: RepeatIntervalTabProps) {
  const { t } = useTranslation();
  const colorScheme = useVisualColorScheme();
  const language = useVisualLanguage();
  const effectiveMode = useVisualEffectiveMode();
  const isDarkTheme = effectiveMode === "dark";
  const accent = getAccentScheme(colorScheme).base;
  const dividerColor = isDarkTheme ? darkTheme.divider : lightTheme.divider;
  const disabledIconColor = isDarkTheme
    ? darkTheme.disabled
    : lightTheme.disabled;
  const normalizedValue = normalizeIntervalDraft(value);
  const normalizedValueRef = React.useRef(normalizedValue);
  const canDecrement = normalizedValue > MIN_INTERVAL;
  const canIncrement = normalizedValue < MAX_INTERVAL;
  React.useLayoutEffect(() => {
    normalizedValueRef.current = normalizedValue;
  }, [normalizedValue]);
  const decrement = () => {
    const currentValue = normalizedValueRef.current;
    if (currentValue > MIN_INTERVAL) {
      const expectedValue = currentValue - 1;
      normalizedValueRef.current = expectedValue;
      onChange(String(expectedValue));
    }
  };
  const increment = () => {
    const currentValue = normalizedValueRef.current;
    if (currentValue < MAX_INTERVAL) {
      const expectedValue = currentValue + 1;
      normalizedValueRef.current = expectedValue;
      onChange(String(expectedValue));
    }
  };
  const handleTextChange = (text: string) => {
    const nextValue = text.replace(/\D/g, "").slice(0, 3);
    normalizedValueRef.current = normalizeIntervalDraft(nextValue);
    onChange(nextValue);
  };
  const handleTextBlur = () => {
    const nextValue = String(normalizedValueRef.current);
    onChange(nextValue);
  };
  return (
    <View className="items-center py-xl">
      <Text className="text-muted text-sm mb-lg">
        {getEveryNDaysLabel(normalizedValue, t, language)}
      </Text>

      <View className="flex-row items-center gap-xl">
        {/* Decrement */}
        <Pressable
          onPress={decrement}
          disabled={!canDecrement}
          accessibilityRole="button"
          accessibilityLabel={t("repeat.decreaseInterval")}
          accessibilityState={{ disabled: !canDecrement }}
          className="items-center justify-center border border-border rounded-full"
          style={{ width: sizes.stepperButton, height: sizes.stepperButton }}
        >
          <MaterialIcons
            name="remove"
            size={24}
            color={canDecrement ? accent : disabledIconColor}
          />
        </Pressable>

        {/* Number */}
        <TextInput
          value={value}
          onChange={(event) => handleTextChange(event.nativeEvent.text)}
          onBlur={handleTextBlur}
          keyboardType="number-pad"
          accessibilityLabel={t("repeat.intervalValue")}
          className="text-primary text-center"
          style={{ fontSize: 28, fontWeight: "700", width: 80 }}
        />

        {/* Increment */}
        <Pressable
          onPress={increment}
          disabled={!canIncrement}
          accessibilityRole="button"
          accessibilityLabel={t("repeat.increaseInterval")}
          accessibilityState={{ disabled: !canIncrement }}
          className="items-center justify-center border border-border rounded-full"
          style={{ width: sizes.stepperButton, height: sizes.stepperButton }}
        >
          <MaterialIcons
            name="add"
            size={24}
            color={canIncrement ? accent : disabledIconColor}
          />
        </Pressable>
      </View>

      <View
        className="w-full mt-xl"
        style={{
          borderTopWidth: 1,
          borderBottomWidth: 1,
          borderColor: dividerColor,
        }}
      >
        <View
          className="px-xl flex-row items-center justify-between"
          style={{ height: Math.max(44, sizes.rowHeight - 6) }}
        >
          <Text
            className="text-primary text-base"
            numberOfLines={1}
            style={{ flex: 1, paddingRight: 12 }}
          >
            {t("repeat.fromCompletion")}
          </Text>
          <Toggle
            value={fromCompletion}
            onValueChange={onFromCompletionChange}
            accessibilityLabel={t("repeat.fromCompletion")}
          />
        </View>
      </View>
    </View>
  );
}
