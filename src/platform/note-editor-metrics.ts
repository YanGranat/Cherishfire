import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

export type NoteEditorCaretMetrics = {
  top: number;
  bottom: number;
  hostWidth: number;
  hostHeight: number;
  textLength: number;
  selectionStart: number;
  selectionEnd: number;
};

type NativeNoteEditorMetrics = {
  getCaretMetrics(
    viewTag: number,
    expectedEventCount: number | null,
    expectedText: string | null,
  ): Promise<unknown>;
};

function loadNativeMetrics(): NativeNoteEditorMetrics | null {
  if (Platform.OS === "web") return null;
  try {
    const module = requireOptionalNativeModule<NativeNoteEditorMetrics>("NoteEditorMetrics");
    return typeof module?.getCaretMetrics === "function" ? module : null;
  } catch {
    return null;
  }
}

const nativeMetrics = loadNativeMetrics();

export const hasNoteEditorCaretMetrics = nativeMetrics !== null;

export async function readNoteEditorCaretMetrics(
  viewTag: number,
  expectedEventCount: number | null,
  expectedText: string | null = null,
): Promise<NoteEditorCaretMetrics | null> {
  if (!nativeMetrics || !Number.isSafeInteger(viewTag) || viewTag <= 0 ||
      (expectedText !== null && typeof expectedText !== "string") ||
      (expectedEventCount !== null &&
       (!Number.isSafeInteger(expectedEventCount) || expectedEventCount < 0))) {
    return null;
  }

  try {
    const value = await nativeMetrics.getCaretMetrics(viewTag, expectedEventCount, expectedText);
    if (!value || typeof value !== "object") return null;
    const metrics = value as NoteEditorCaretMetrics;
    if (![metrics.top, metrics.bottom, metrics.hostWidth, metrics.hostHeight].every(Number.isFinite) ||
        metrics.hostWidth <= 0 || metrics.hostHeight <= 0 || metrics.top < 0 ||
        metrics.bottom <= metrics.top || metrics.bottom > metrics.hostHeight ||
        !Number.isSafeInteger(metrics.textLength) || metrics.textLength < 0 ||
        !Number.isSafeInteger(metrics.selectionStart) || metrics.selectionStart < 0 ||
        metrics.selectionStart !== metrics.selectionEnd || metrics.selectionEnd > metrics.textLength) {
      return null;
    }
    return metrics;
  } catch {
    return null;
  }
}
