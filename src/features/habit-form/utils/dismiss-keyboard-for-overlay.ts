import { Keyboard } from "react-native";
/**
 * Dismiss the active editor before opening a habit-form overlay.
 */
export function dismissKeyboardForHabitFormOverlay(): void {
  Keyboard.dismiss();
}
