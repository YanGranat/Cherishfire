/** @jsxImportSource nativewind */
import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  Text,
  View,
  useWindowDimensions,
  type ListRenderItemInfo,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { CustomColorDialog } from "@/features/settings/components/CustomColorDialog";
import { SettingsErrorBanner } from "@/features/settings/components/SettingsErrorBanner";
import { SettingsScreenShell } from "@/features/settings/components/SettingsScreenShell";
import { useSettingsStore } from "@/stores/settings-store";
import { getAccentScheme, settingsScreenBackgrounds } from "@/theme/colors";
import { useVisualEffectiveMode } from "@/components/ScreenPreferencesBoundary";
import { sizes } from "@/theme/tokens";
import {
  isBuiltinColorScheme,
  type ColorScheme,
  type CustomColorScheme,
} from "@/types/settings";
const SETTINGS_ROW_HEIGHT = 56;
interface ColorRowProps {
  color: ColorScheme;
  label: string;
  accent: string;
  onSelect: (color: ColorScheme) => boolean;
  onEdit: (color: ColorScheme) => void;
  editHint: string;
  editLabel: string;
}
const ColorListHeader = React.memo(function ColorListHeader() {
  return (
    <>
      <SettingsErrorBanner />
      <View className="border-t border-divider" />
    </>
  );
});
const ColorRow = React.memo(function ColorRow({
  color,
  label,
  accent,
  onSelect,
  onEdit,
  editHint,
  editLabel,
}: ColorRowProps) {
  const longPressTriggeredRef = useRef(false);
  // Keep selection local so one accent change updates only the old and new
  // checkmarks instead of invalidating every virtualized list row.
  const selected = useSettingsStore((state) => state.colorScheme === color);
  return (
    <Pressable
      onPressIn={() => {
        longPressTriggeredRef.current = false;
      }}
      onLongPress={() => {
        longPressTriggeredRef.current = true;
        onEdit(color);
      }}
      delayLongPress={180}
      onPress={() => {
        if (longPressTriggeredRef.current) {
          longPressTriggeredRef.current = false;
          return;
        }
        onSelect(color);
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      accessibilityHint={editHint}
      className="flex-row items-center justify-between px-base border-b border-divider active:bg-press-highlight"
      style={{ minHeight: SETTINGS_ROW_HEIGHT }}
    >
      <View className="flex-row items-center flex-1" style={{ minWidth: 0 }}>
        <Pressable
          onPress={(event) => {
            event.stopPropagation();
            onEdit(color);
          }}
          accessibilityRole="button"
          accessibilityLabel={editLabel}
          hitSlop={10}
          style={{
            width: sizes.colorPreviewCircle,
            height: 44,
            marginRight: 12,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View
            style={{
              width: sizes.colorPreviewCircle,
              height: sizes.colorPreviewCircle,
              borderRadius: sizes.colorPreviewCircle / 2,
              backgroundColor: accent,
            }}
          />
        </Pressable>
        <Text
          className="flex-shrink text-primary text-base"
          style={{ minWidth: 0 }}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {label}
        </Text>
      </View>

      {selected ? (
        <MaterialIcons
          name="check"
          size={24}
          color={accent}
          style={{ marginLeft: 8 }}
        />
      ) : null}
    </Pressable>
  );
});
interface ColorPickerControllerHandle {
  openAdd(): void;
  openEdit(scheme: ColorScheme): void;
}
interface ColorPickerControllerProps {
  existingColors: CustomColorScheme[];
  canDelete: boolean;
}
/**
 * Opening and closing the portal dialog must not rebuild the FlatList behind
 * it. The controller owns the complete retained picker session; the list only
 * changes when a color is actually added, updated or removed in the store.
 */
const ColorPickerController = React.memo(
  React.forwardRef<ColorPickerControllerHandle, ColorPickerControllerProps>(
    function ColorPickerController({ existingColors, canDelete }, ref) {
      const addColorScheme = useSettingsStore((state) => state.addColorScheme);
      const updateColorScheme = useSettingsStore(
        (state) => state.updateColorScheme,
      );
      const removeColorScheme = useSettingsStore(
        (state) => state.removeColorScheme,
      );
      const [pickerVisible, setPickerVisible] = useState(false);
      const [editingScheme, setEditingScheme] = useState<ColorScheme | null>(
        null,
      );
      const [pickerInitialColor, setPickerInitialColor] =
        useState<CustomColorScheme | null>(null);
      const pickerOperationRef = useRef(0);
      const openAdd = useCallback(() => {
        pickerOperationRef.current += 1;
        setEditingScheme(null);
        setPickerInitialColor(null);
        setPickerVisible(true);
      }, []);
      const openEdit = useCallback((scheme: ColorScheme) => {
        pickerOperationRef.current += 1;
        setEditingScheme(scheme);
        setPickerInitialColor(
          getAccentScheme(scheme).base.toUpperCase() as CustomColorScheme,
        );
        setPickerVisible(true);
      }, []);
      React.useImperativeHandle(ref, () => ({ openAdd, openEdit }), [
        openAdd,
        openEdit,
      ]);
      const closePicker = useCallback(() => {
        pickerOperationRef.current += 1;
        setPickerVisible(false);
        setEditingScheme(null);
        setPickerInitialColor(null);
      }, []);
      const handleSubmit = useCallback(
        async (color: CustomColorScheme) => {
          if (
            editingScheme &&
            getAccentScheme(editingScheme).base.toUpperCase() === color
          ) {
            closePicker();
            return true;
          }
          const operationId = pickerOperationRef.current + 1;
          pickerOperationRef.current = operationId;
          const originalEditingScheme = editingScheme;
          const persistence = editingScheme
            ? updateColorScheme(editingScheme, color)
            : addColorScheme(color);
          // Store validation and optimistic publication are synchronous. The
          // retained dialog closes over that already-correct state while the
          // durable write finishes independently.
          setPickerVisible(false);
          let saved: boolean;
          try {
            saved = await persistence;
          } catch (error) {
            if (pickerOperationRef.current === operationId) {
              setEditingScheme(originalEditingScheme);
              setPickerInitialColor(color);
              setPickerVisible(true);
            }
            throw error;
          }
          if (pickerOperationRef.current !== operationId) return saved;
          if (saved) {
            setEditingScheme(null);
            setPickerInitialColor(null);
            return true;
          }
          setEditingScheme(originalEditingScheme);
          setPickerInitialColor(color);
          setPickerVisible(true);
          return false;
        },
        [addColorScheme, closePicker, editingScheme, updateColorScheme],
      );
      const handleDelete = useCallback(async () => {
        if (!editingScheme) return false;
        const operationId = pickerOperationRef.current + 1;
        pickerOperationRef.current = operationId;
        const originalEditingScheme = editingScheme;
        const originalColor = getAccentScheme(
          editingScheme,
        ).base.toUpperCase() as CustomColorScheme;
        const persistence = removeColorScheme(editingScheme);
        setPickerVisible(false);
        let deleted: boolean;
        try {
          deleted = await persistence;
        } catch (error) {
          if (pickerOperationRef.current === operationId) {
            setEditingScheme(originalEditingScheme);
            setPickerInitialColor(originalColor);
            setPickerVisible(true);
          }
          throw error;
        }
        if (pickerOperationRef.current !== operationId) return deleted;
        if (deleted) {
          setEditingScheme(null);
          setPickerInitialColor(null);
          return true;
        }
        setEditingScheme(originalEditingScheme);
        setPickerInitialColor(originalColor);
        setPickerVisible(true);
        return false;
      }, [editingScheme, removeColorScheme]);
      const editingColor = useMemo(
        () =>
          pickerInitialColor ??
          (editingScheme
            ? (getAccentScheme(
                editingScheme,
              ).base.toUpperCase() as CustomColorScheme)
            : null),
        [editingScheme, pickerInitialColor],
      );
      return (
        <CustomColorDialog
          visible={pickerVisible}
          initialColor={editingColor}
          editing={editingScheme != null}
          existingColors={existingColors}
          onCancel={closePicker}
          onSubmit={handleSubmit}
          canDelete={canDelete}
          onDelete={editingScheme ? handleDelete : undefined}
        />
      );
    },
  ),
);
export default function ColorSchemeScreen() {
  const { t } = useTranslation();
  const backgroundColor = settingsScreenBackgrounds[useVisualEffectiveMode()];
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const colorSchemeOptions = useSettingsStore(
    (state) => state.colorSchemeOptions,
  );
  const setColorScheme = useSettingsStore((state) => state.setColorScheme);
  const pickerControllerRef = useRef<ColorPickerControllerHandle>(null);
  const openAdd = useCallback(() => {
    pickerControllerRef.current?.openAdd();
  }, []);
  const openEdit = useCallback((scheme: ColorScheme) => {
    pickerControllerRef.current?.openEdit(scheme);
  }, []);
  const selectColor = useCallback(
    (scheme: ColorScheme) => {
      if (useSettingsStore.getState().colorScheme === scheme) return false;
      void setColorScheme(scheme);
      return true;
    },
    [setColorScheme],
  );
  const colorRows = useMemo(
    () =>
      colorSchemeOptions.map((scheme) => ({
        scheme,
        accent: getAccentScheme(scheme).base,
        label: isBuiltinColorScheme(scheme)
          ? t(`colorSchemeScreen.${scheme}`)
          : scheme,
      })),
    [colorSchemeOptions, t],
  );
  const existingColors = useMemo(
    () =>
      colorRows.map(({ accent }) => accent.toUpperCase() as CustomColorScheme),
    [colorRows],
  );
  const editHint = t("colorSchemeScreen.editHint");
  const editColorLabel = t("colorSchemeScreen.editColor");
  const addColorLabel = t("colorSchemeScreen.addColor");
  const rightActions = useMemo(
    () => [
      {
        icon: "add" as const,
        iconSize: 28,
        onPress: openAdd,
        accessibilityLabel: addColorLabel,
      },
    ],
    [addColorLabel, openAdd],
  );
  const availableListHeight = Math.max(
    SETTINGS_ROW_HEIGHT,
    windowHeight - insets.top - sizes.headerHeight,
  );
  const initialRowsToRender = Math.min(
    colorRows.length,
    Math.ceil(availableListHeight / SETTINGS_ROW_HEIGHT) + 1,
  );
  const colorListContentStyle = useMemo(
    () => ({ paddingBottom: insets.bottom + 16 }),
    [insets.bottom],
  );
  const renderColorRow = useCallback(
    ({ item }: ListRenderItemInfo<(typeof colorRows)[number]>) => (
      <ColorRow
        color={item.scheme}
        label={item.label}
        accent={item.accent}
        onSelect={selectColor}
        onEdit={openEdit}
        editHint={editHint}
        editLabel={`${editColorLabel}: ${item.label}`}
      />
    ),
    [editColorLabel, editHint, openEdit, selectColor],
  );
  const colorRowKey = useCallback(
    (item: (typeof colorRows)[number]) => item.scheme,
    [],
  );
  return (
    <SettingsScreenShell
      title={t("colorSchemeScreen.title")}
      rightActions={rightActions}
      scrollableBody={false}
    >
      <FlatList
        cssInterop={false}
        style={{ flex: 1, backgroundColor }}
        data={colorRows}
        renderItem={renderColorRow}
        keyExtractor={colorRowKey}
        initialNumToRender={initialRowsToRender}
        maxToRenderPerBatch={initialRowsToRender}
        removeClippedSubviews={false}
        keyboardShouldPersistTaps="always"
        ListHeaderComponent={ColorListHeader}
        contentContainerStyle={colorListContentStyle}
      />

      <ColorPickerController
        ref={pickerControllerRef}
        existingColors={existingColors}
        canDelete={colorSchemeOptions.length > 1}
      />
    </SettingsScreenShell>
  );
}
