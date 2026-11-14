/** @jsxImportSource nativewind */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Dimensions,
  GestureResponderEvent,
  Keyboard,
  KeyboardEvent,
  LayoutChangeEvent,
  PanResponder,
  PanResponderGestureState,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/Dialog";
import { DropdownMenu } from "@/components/overlays/DropdownMenu";
import { useVisualEffectiveMode } from "@/components/ScreenPreferencesBoundary";
import { darkTheme, lightTheme, normalizeHexColor } from "@/theme/colors";
import { radii, sizes } from "@/theme/tokens";
import type { CustomColorScheme } from "@/types/settings";
import { useRetainedModalSession } from "@/hooks/useRetainedModalSession";
interface HsvColor {
  h: number;
  s: number;
  v: number;
}
interface CustomColorDialogProps {
  visible: boolean;
  initialColor?: CustomColorScheme | null;
  editing?: boolean;
  existingColors: CustomColorScheme[];
  onCancel: () => void;
  onSubmit: (color: CustomColorScheme) => Promise<boolean> | boolean;
  canDelete?: boolean;
  onDelete?: () => Promise<boolean> | boolean;
}
interface CustomColorDialogSessionProps extends CustomColorDialogProps {
  onDismiss: () => void;
}
type CustomColorDialogSessionSnapshot = Pick<
  CustomColorDialogProps,
  "initialColor" | "editing" | "canDelete" | "onDelete"
>;
const DEFAULT_COLOR: CustomColorScheme = "#3B82F6";
const HUE_COLORS = [
  "#FF0000",
  "#FFFF00",
  "#00FF00",
  "#00FFFF",
  "#0000FF",
  "#FF00FF",
  "#FF0000",
] as const;
const HUE_GRADIENT_COLORS: [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
] = [...HUE_COLORS];
type ColorPanHandlers = ReturnType<typeof PanResponder.create>["panHandlers"];
interface SaturationValueControlProps {
  hsv: HsvColor;
  hueColor: string;
  disabled: boolean;
  accessibilityLabel: string;
  panHandlers: ColorPanHandlers;
  onSize: (width: number, height: number) => void;
}
const SaturationValueControl = React.memo(function SaturationValueControl({
  hsv,
  hueColor,
  disabled,
  accessibilityLabel,
  panHandlers,
  onSize,
}: SaturationValueControlProps) {
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      onSize(width, height);
      setLayout((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
    },
    [onSize],
  );
  return (
    <View
      onLayout={handleLayout}
      pointerEvents={disabled ? "none" : "auto"}
      style={[styles.saturationValue, { backgroundColor: hueColor }]}
      accessibilityLabel={accessibilityLabel}
      {...panHandlers}
    >
      <LinearGradient
        pointerEvents="none"
        colors={["#FFFFFF", "rgba(255,255,255,0)"]}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={styles.saturationValueGradient}
      />
      <LinearGradient
        pointerEvents="none"
        colors={["rgba(0,0,0,0)", "#000000"]}
        locations={[0, 0.98]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={styles.saturationValueGradient}
      />
      <View
        pointerEvents="none"
        style={[
          styles.saturationValueMarker,
          {
            left: hsv.s * layout.width - 10,
            top: (1 - hsv.v) * layout.height - 10,
            opacity: layout.width > 0 ? 1 : 0,
          },
        ]}
      />
    </View>
  );
});
interface HueControlProps {
  hue: number;
  disabled: boolean;
  accessibilityLabel: string;
  panHandlers: ColorPanHandlers;
  onWidth: (width: number) => void;
}
const HueControl = React.memo(function HueControl({
  hue,
  disabled,
  accessibilityLabel,
  panHandlers,
  onWidth,
}: HueControlProps) {
  const [width, setWidth] = useState(0);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const nextWidth = event.nativeEvent.layout.width;
      onWidth(nextWidth);
      setWidth((current) => (current === nextWidth ? current : nextWidth));
    },
    [onWidth],
  );
  return (
    <View
      onLayout={handleLayout}
      pointerEvents={disabled ? "none" : "auto"}
      style={styles.hueTrack}
      accessibilityLabel={accessibilityLabel}
      {...panHandlers}
    >
      <LinearGradient
        pointerEvents="none"
        colors={HUE_GRADIENT_COLORS}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={StyleSheet.absoluteFill}
      />
      <View
        pointerEvents="none"
        style={[
          styles.hueMarker,
          {
            left: (hue / 360) * width - 4,
            opacity: width > 0 ? 1 : 0,
          },
        ]}
      />
    </View>
  );
});
function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function hsvToHex({ h, s, v }: HsvColor): CustomColorScheme {
  const hue = ((h % 360) + 360) % 360;
  const chroma = v * s;
  const section = hue / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  const [r1, g1, b1] =
    section < 1
      ? [chroma, x, 0]
      : section < 2
        ? [x, chroma, 0]
        : section < 3
          ? [0, chroma, x]
          : section < 4
            ? [0, x, chroma]
            : section < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const match = v - chroma;
  const channels = [r1, g1, b1].map((channel) =>
    Math.round((channel + match) * 255),
  );
  return `#${channels
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase() as CustomColorScheme;
}
function hexToHsv(hex: CustomColorScheme): HsvColor {
  const red = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const green = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (max === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  return {
    h: hue < 0 ? hue + 360 : hue,
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
}
function CustomColorDialogSession({
  visible,
  initialColor,
  editing,
  existingColors,
  onCancel,
  onSubmit,
  canDelete = false,
  onDelete,
  onDismiss,
}: CustomColorDialogSessionProps) {
  const { t } = useTranslation();
  const effectiveMode = useVisualEffectiveMode();
  const { width: windowWidth } = useWindowDimensions();
  const isDarkTheme = effectiveMode === "dark";
  const palette = isDarkTheme ? darkTheme : lightTheme;
  const isEditing = editing ?? Boolean(initialColor);
  const initial = initialColor ?? DEFAULT_COLOR;
  const initialHsv = hexToHsv(initial);
  const [hsv, setHsv] = useState<HsvColor>(initialHsv);
  const hsvRef = useRef(initialHsv);
  const [hexInput, setHexInput] = useState<string>(initial);
  const hexInputRef = useRef<TextInput>(null);
  const [isHexInputFocused, setIsHexInputFocused] = useState(false);
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const dialogHeightRef = useRef(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submissionInFlightRef = useRef(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuTop, setMenuTop] = useState(56);
  const submittedColorRef = useRef<CustomColorScheme | null>(null);
  const saturationValueSize = useRef({ width: 1, height: 1 });
  const hueWidth = useRef(1);
  const saturationValueDragStart = useRef({ x: 0, y: 0 });
  const hueDragStartX = useRef(0);
  useEffect(() => {
    if (!visible) return;
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSubscription = Keyboard.addListener(
      showEvent,
      (event: KeyboardEvent) => {
        setIsHexInputFocused(true);
        setKeyboardTop(event.endCoordinates.screenY);
      },
    );
    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      setIsHexInputFocused(false);
      setKeyboardTop(null);
    });
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [visible]);
  const updateHsv = useCallback(
    (updater: (current: HsvColor) => HsvColor): HsvColor => {
      const next = updater(hsvRef.current);
      hsvRef.current = next;
      setHsv(next);
      setHexInput(hsvToHex(next));
      return next;
    },
    [],
  );
  const updateSaturationValueAt = useCallback(
    (x: number, y: number) => {
      const { width, height } = saturationValueSize.current;
      const saturation = clamp(x / width);
      const value = 1 - clamp(y / height);
      updateHsv((current) => ({ ...current, s: saturation, v: value }));
    },
    [updateHsv],
  );
  const updateHueAt = useCallback(
    (x: number) => {
      const hue = clamp(x / hueWidth.current) * 360;
      updateHsv((current) => ({ ...current, h: hue }));
    },
    [updateHsv],
  );
  const beginSaturationValueDrag = useCallback(
    (event: GestureResponderEvent) => {
      const { width, height } = saturationValueSize.current;
      const x = clamp(event.nativeEvent.locationX, 0, width);
      const y = clamp(event.nativeEvent.locationY, 0, height);
      saturationValueDragStart.current = { x, y };
      updateSaturationValueAt(x, y);
    },
    [updateSaturationValueAt],
  );
  const moveSaturationValueDrag = useCallback(
    (_event: GestureResponderEvent, gestureState: PanResponderGestureState) => {
      const { width, height } = saturationValueSize.current;
      const x = clamp(
        saturationValueDragStart.current.x + gestureState.dx,
        0,
        width,
      );
      const y = clamp(
        saturationValueDragStart.current.y + gestureState.dy,
        0,
        height,
      );
      updateSaturationValueAt(x, y);
    },
    [updateSaturationValueAt],
  );
  const beginHueDrag = useCallback(
    (event: GestureResponderEvent) => {
      const x = clamp(event.nativeEvent.locationX, 0, hueWidth.current);
      hueDragStartX.current = x;
      updateHueAt(x);
    },
    [updateHueAt],
  );
  const moveHueDrag = useCallback(
    (_event: GestureResponderEvent, gestureState: PanResponderGestureState) => {
      const x = clamp(
        hueDragStartX.current + gestureState.dx,
        0,
        hueWidth.current,
      );
      updateHueAt(x);
    },
    [updateHueAt],
  );
  const saturationValueResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: beginSaturationValueDrag,
        onPanResponderMove: moveSaturationValueDrag,
      }),
    [beginSaturationValueDrag, moveSaturationValueDrag],
  );
  const hueResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: beginHueDrag,
        onPanResponderMove: moveHueDrag,
      }),
    [beginHueDrag, moveHueDrag],
  );
  const handleSaturationValueSize = useCallback(
    (width: number, height: number) => {
      saturationValueSize.current = { width, height };
    },
    [],
  );
  const handleHueWidth = useCallback((width: number) => {
    hueWidth.current = width;
  }, []);
  const handleHexChange = (value: string) => {
    const normalizedInput = value.toUpperCase().replace(/[^#0-9A-F]/g, "");
    const withSingleHash = normalizedInput.startsWith("#")
      ? `#${normalizedInput.slice(1).replace(/#/g, "")}`
      : normalizedInput;
    const nextInput = withSingleHash.slice(0, 7);
    setHexInput(nextInput);
    const normalized = normalizeHexColor(nextInput);
    if (normalized) {
      const nextHsv = hexToHsv(normalized);
      hsvRef.current = nextHsv;
      setHsv(nextHsv);
    }
  };
  const normalizedColor = normalizeHexColor(hexInput);
  const isDuplicate = Boolean(
    normalizedColor &&
      normalizedColor !== initialColor &&
      existingColors.includes(normalizedColor),
  );
  const isSubmittedColorUpdate = Boolean(
    isSubmitting && normalizedColor === submittedColorRef.current,
  );
  const errorKey = !normalizedColor
    ? "colorSchemeScreen.invalidHex"
    : isDuplicate && !isSubmittedColorUpdate
      ? "colorSchemeScreen.duplicateColor"
      : null;
  const previewColor = normalizedColor ?? hsvToHex(hsv);
  const hueColor = hsvToHex({ h: hsv.h, s: 1, v: 1 });
  const dialogWidth = Math.min(320, windowWidth - 32);
  const screenHeight = Dimensions.get("screen").height;
  const keyboardTranslateY = useMemo(() => {
    if (!isHexInputFocused) return 0;
    const dialogHeight = dialogHeightRef.current;
    if (keyboardTop == null || dialogHeight <= 0) return -112;
    const centeredDialogBottom = (screenHeight + dialogHeight) / 2;
    const overlap = centeredDialogBottom - keyboardTop;
    const requiredShift = Math.max(0, overlap + 16);
    const highestSafeShift = Math.max(
      0,
      (screenHeight - dialogHeight) / 2 - 12,
    );
    return -Math.min(requiredShift, highestSafeShift);
  }, [isHexInputFocused, keyboardTop, screenHeight]);
  const handleSubmit = async () => {
    if (!normalizedColor || isDuplicate || submissionInFlightRef.current) {
      return;
    }
    submissionInFlightRef.current = true;
    submittedColorRef.current = normalizedColor;
    setIsSubmitting(true);
    try {
      const saved = await onSubmit(normalizedColor);
      if (!saved) {
        submissionInFlightRef.current = false;
        submittedColorRef.current = null;
        setIsSubmitting(false);
      }
    } catch (submitError) {
      console.error("Failed to save color", submitError);
      submissionInFlightRef.current = false;
      submittedColorRef.current = null;
      setIsSubmitting(false);
    }
  };
  const handleDelete = async () => {
    if (!onDelete || !canDelete || submissionInFlightRef.current) {
      return;
    }
    submissionInFlightRef.current = true;
    submittedColorRef.current = null;
    setIsSubmitting(true);
    try {
      const deleted = await onDelete();
      if (!deleted) {
        submissionInFlightRef.current = false;
        setIsSubmitting(false);
      }
    } catch (deleteError) {
      console.error("Failed to delete color", deleteError);
      submissionInFlightRef.current = false;
      setIsSubmitting(false);
    }
  };
  const menuAnchorRight = Math.max(12, (windowWidth - dialogWidth) / 2 + 14);
  return (
    <>
      <Dialog
        visible={visible}
        onDismiss={onDismiss}
        title={
          isEditing
            ? t("colorSchemeScreen.editColor")
            : t("colorSchemeScreen.addColor")
        }
        titleAction={
          isEditing && onDelete
            ? {
                icon: "more-vert",
                accessibilityLabel: t("colorSchemeScreen.colorOptions"),
                onPress: (event) => {
                  const { pageY, locationY } = event.nativeEvent;
                  setMenuTop(pageY - locationY + sizes.touchTargetMin - 4);
                  setMenuVisible(true);
                },
                disabled: isSubmitting,
              }
            : undefined
        }
        contentStyle={[
          {
            width: dialogWidth,
            paddingTop: 17,
            transform: [{ translateY: keyboardTranslateY }],
          },
        ]}
        titleStyle={{ marginBottom: 13 }}
        onContentLayout={(event) => {
          const nextHeight = event.nativeEvent.layout.height;
          dialogHeightRef.current = nextHeight;
        }}
        contentBackgroundColor={
          isDarkTheme ? palette.menuSurface : palette.surfaceElevated
        }
        actionsContainerStyle={{ marginTop: 18 }}
        actions={[
          {
            label: t("colorSchemeScreen.cancel"),
            onPress: onCancel,
            role: "cancel",
            disabled: isSubmitting,
          },
          {
            label: isEditing
              ? t("colorSchemeScreen.save")
              : t("colorSchemeScreen.add"),
            onPress: () => void handleSubmit(),
            disabled: !normalizedColor || isDuplicate || isSubmitting,
            tone: "accent",
          },
        ]}
      >
        <SaturationValueControl
          hsv={hsv}
          hueColor={hueColor}
          disabled={isSubmitting}
          accessibilityLabel={t("colorSchemeScreen.saturationValuePicker")}
          panHandlers={saturationValueResponder.panHandlers}
          onSize={handleSaturationValueSize}
        />

        <HueControl
          hue={hsv.h}
          disabled={isSubmitting}
          accessibilityLabel={t("colorSchemeScreen.huePicker")}
          panHandlers={hueResponder.panHandlers}
          onWidth={handleHueWidth}
        />

        <View className="flex-row items-center mt-md">
          <View
            style={[
              styles.preview,
              { backgroundColor: previewColor, borderColor: palette.border },
            ]}
          />
          <TextInput
            ref={hexInputRef}
            value={hexInput}
            onChange={(event) => handleHexChange(event.nativeEvent.text)}
            onFocus={() => {
              setIsHexInputFocused(true);
            }}
            onBlur={() => {
              setIsHexInputFocused(false);
            }}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!isSubmitting}
            maxLength={7}
            selectTextOnFocus
            accessibilityLabel={t("colorSchemeScreen.hexLabel")}
            style={[
              styles.hexInput,
              {
                color: palette.primary,
                borderColor: errorKey ? "#EF4444" : palette.border,
                backgroundColor: palette.surface,
              },
            ]}
          />
        </View>

        <Text
          className="text-xs mt-xs"
          style={{ color: errorKey ? "#EF4444" : palette.muted }}
        >
          {errorKey ? t(errorKey) : " "}
        </Text>
      </Dialog>

      <DropdownMenu
        visible={visible && menuVisible}
        onClose={() => setMenuVisible(false)}
        anchorRight={menuAnchorRight}
        anchorTop={menuTop}
        items={[
          {
            label: t("colorSchemeScreen.deleteColor"),
            icon: "trash-sharp",
            iconFamily: "ionicons",
            destructive: true,
            disabled: !canDelete || isSubmitting,
            accessibilityHint: !canDelete
              ? t("colorSchemeScreen.lastColorCannotDelete")
              : undefined,
            onPress: () => void handleDelete(),
            deferUntilClosed: true,
          },
        ]}
      />
    </>
  );
}
function CustomColorDialogComponent(props: CustomColorDialogProps) {
  const { session, handleDismiss } =
    useRetainedModalSession<CustomColorDialogSessionSnapshot>(
      props.visible,
      () => ({
        initialColor: props.initialColor,
        editing: props.editing,
        canDelete: props.canDelete,
        onDelete: props.onDelete,
      }),
    );
  if (session == null) return null;
  const snapshot = session.snapshot;
  return (
    <CustomColorDialogSession
      key={session.key}
      visible={props.visible}
      initialColor={snapshot.initialColor}
      editing={snapshot.editing}
      existingColors={props.existingColors}
      onCancel={props.onCancel}
      onSubmit={props.onSubmit}
      canDelete={snapshot.canDelete}
      onDelete={snapshot.onDelete}
      onDismiss={handleDismiss}
    />
  );
}
export const CustomColorDialog = React.memo(CustomColorDialogComponent);
const styles = StyleSheet.create({
  saturationValue: {
    width: "100%",
    height: 176,
    borderRadius: radii.input,
    overflow: "hidden",
  },
  saturationValueMarker: {
    position: "absolute",
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: "#FFFFFF",
    backgroundColor: "transparent",
    shadowColor: "#000000",
    shadowOpacity: 0.6,
    shadowRadius: 2,
    elevation: 2,
  },
  saturationValueGradient: {
    position: "absolute",
    top: -1,
    right: -1,
    bottom: -1,
    left: -1,
  },
  hueTrack: {
    width: "100%",
    height: 24,
    marginTop: 12,
    borderRadius: 12,
    overflow: "hidden",
  },
  hueMarker: {
    position: "absolute",
    top: 0,
    width: 8,
    height: 24,
    borderWidth: 2,
    borderColor: "#FFFFFF",
    borderRadius: 4,
    backgroundColor: "transparent",
  },
  preview: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    marginRight: 12,
  },
  hexInput: {
    flex: 1,
    height: 44,
    borderWidth: 1,
    borderRadius: radii.input,
    paddingHorizontal: 12,
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
});
