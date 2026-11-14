import { PixelRatio } from "react-native";
import { Easing } from "react-native-reanimated";

// Controls global animation speed.
// Increase to slow animations for debugging (e.g. 2, 3), decrease to speed up.
const SPEED_FACTOR = 0.25;

// Row geometry (must match HabitItem minHeight: 64)
export const ROW_HEIGHT = 64;
export const SEPARATOR_HEIGHT = 1;
// Use exactly three physical pixels. On fractional Android densities (for
// example 2.75), raw dp values can rasterize inconsistently by vertical phase.
export const SEPARATOR_RENDER_HEIGHT = 3 / PixelRatio.get();
export const SLOT_HEIGHT = ROW_HEIGHT + SEPARATOR_HEIGHT; // 65

// Shared move duration for list reflow and cross-section flight.
// Keeping these equal prevents visible desync (rows arriving before flight ends).
const MOVE_DURATION_MS = 250 * SPEED_FACTOR;

// Flight animation (habit moving between sections)
export const FLIGHT_DURATION_MS = MOVE_DURATION_MS;
// Keep constant perceived velocity along the whole path.
export const FLIGHT_EASING = Easing.linear;

// Row shift (other rows sliding to fill/make gap)
export const ROW_SHIFT_DURATION_MS = MOVE_DURATION_MS;
// Keep row reflow curve aligned with flight to avoid visual phase desync.
export const ROW_SHIFT_EASING = FLIGHT_EASING;

// Drag & drop
export const DRAG_ACTIVATE_MS = 150;
// Keep dragged row scale neutral to avoid a visible "final settle" step on drop.
export const DRAG_LIFT_SCALE = 1;
// Keep drop snappy even in debug-slow mode; long drop duration looks jittery.
export const DROP_DURATION_MS = 180;

// Expand / collapse completed section (manual toggle)
// Keep it noticeably smoother than transfer-driven row shifts.
export const EXPAND_DURATION_MS = 480 * SPEED_FACTOR;

// Overlay card z-index
export const FLIGHT_OVERLAY_Z = 30;
