import { requireNativeView, requireOptionalNativeModule } from "expo";
import { Platform, View, type ViewProps } from "react-native";

const nativeMetrics = Platform.OS === "android"
  ? requireOptionalNativeModule<{ supportsViewport?: boolean }>("NoteEditorMetrics")
  : null;

export const hasNativeNoteEditorViewport = nativeMetrics?.supportsViewport === true;

export const NoteEditorViewport = hasNativeNoteEditorViewport
  ? requireNativeView<ViewProps>("NoteEditorMetrics")
  : View;
