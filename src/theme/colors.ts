import type {
  BuiltinColorScheme,
  ColorScheme,
  CustomColorScheme,
} from "@/types/settings";
import { isBuiltinColorScheme } from "@/types/settings";

export interface AccentScheme {
  base: string;
  pale: string;
  bright: string;
}

// Built-in accent palettes used throughout the interface.
// Each scheme: base, pale (Minimum checkbox), bright (Maximum checkbox)
export const accentSchemes = {
  orange: { base: "#F66133", pale: "#FF8A65", bright: "#E64A19" },
  sunset: { base: "#FF6A3D", pale: "#FFA083", bright: "#E5532D" },
  amber: { base: "#F9A825", pale: "#FFCA58", bright: "#F57F17" },
  citron: { base: "#CDDB3A", pale: "#E0E97A", bright: "#AFBE2E" },
  pistachio: { base: "#9BC53D", pale: "#C5E07C", bright: "#7FA42F" },
  lime: { base: "#7CB342", pale: "#AED581", bright: "#689F38" },
  olive: { base: "#6B8E23", pale: "#9FBC5A", bright: "#56731C" },
  green: { base: "#388E3C", pale: "#66BB6A", bright: "#2E7D32" },
  emerald: { base: "#10B981", pale: "#6EE7C8", bright: "#0E9D6E" },
  mint: { base: "#2BB673", pale: "#6ED7AE", bright: "#1F9A61" },
  lagoon: { base: "#089888", pale: "#47BCAE", bright: "#067A6D" },
  teal: { base: "#0F8B8D", pale: "#38B2AC", bright: "#0B6E70" },
  aqua: { base: "#00A8A8", pale: "#6BD1D1", bright: "#008C8C" },
  cyan: { base: "#0288D1", pale: "#4FC3F7", bright: "#0277BD" },
  blue: { base: "#497BFF", pale: "#7DA3FF", bright: "#2D5FD9" },
  royal: { base: "#5B6CFF", pale: "#97A2FF", bright: "#4352E0" },
  cobalt: { base: "#2962FF", pale: "#6D8DFF", bright: "#1E4FD9" },
  navy: { base: "#1E3A8A", pale: "#4F67B3", bright: "#172E6D" },
  indigo: { base: "#3F51B5", pale: "#7986CB", bright: "#303F9F" },
  lavender: { base: "#A683E6", pale: "#C3A9F0", bright: "#8D6BD1" },
  amethyst: { base: "#8263D0", pale: "#AC96E2", bright: "#6544B2" },
  purple: { base: "#7B1FA2", pale: "#AB47BC", bright: "#6A1B9A" },
  orchid: { base: "#E23DF6", pale: "#EE7CFB", bright: "#C52ED8" },
  pink: { base: "#C2185B", pale: "#EC407A", bright: "#AD1457" },
  berry: { base: "#F33F80", pale: "#F777A6", bright: "#D62F6E" },
  slate: { base: "#607D8B", pale: "#90A4AE", bright: "#455A64" },
} as const satisfies Record<BuiltinColorScheme, AccentScheme>;

const HEX_COLOR_PATTERN = /^#[0-9A-F]{6}$/;

export function normalizeHexColor(value: unknown): CustomColorScheme | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return HEX_COLOR_PATTERN.test(normalized)
    ? (normalized as CustomColorScheme)
    : null;
}

export function isCustomColorScheme(
  value: unknown
): value is CustomColorScheme {
  return normalizeHexColor(value) !== null;
}

function mixHex(
  base: CustomColorScheme,
  target: "#FFFFFF" | "#000000",
  amount: number
): string {
  const baseChannels = [1, 3, 5].map((offset) =>
    Number.parseInt(base.slice(offset, offset + 2), 16)
  );
  const targetChannel = target === "#FFFFFF" ? 255 : 0;
  const channels = baseChannels.map((channel) =>
    Math.round(channel + (targetChannel - channel) * amount)
  );
  return `#${channels
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}

export function createCustomAccentScheme(
  base: CustomColorScheme
): AccentScheme {
  return {
    base,
    pale: mixHex(base, "#FFFFFF", 0.36),
    bright: mixHex(base, "#000000", 0.18),
  };
}

export function getAccentScheme(scheme: ColorScheme): AccentScheme {
  const custom = normalizeHexColor(scheme);
  if (custom) return createCustomAccentScheme(custom);
  return isBuiltinColorScheme(scheme)
    ? accentSchemes[scheme]
    : accentSchemes.orange;
}

// Semantic colors (calendar, heatmap) - independent from accent
export const semantic = {
  success: "#4CAF50",
  successPale: "#D7E1D7",
  successBright: "#43A047",
  failure: "#EF4444",
  archived: "#42A5F5",
  onAccent: "#FFFFFF",
} as const;

// Neutral gray accent for each effective theme.
export const lightTheme = {
  background: "#F2F2F2",
  surface: "#FFFFFF",
  surfaceElevated: "#FFFFFF",
  menuSurface: "#FFFFFF",
  divider: "#D8D8D8",
  border: "#E0E0E0",
  disabled: "#BDBDBD",
  muted: "#757575",
  primary: "#212121",
  icon: "#505050",
  metric: "#424242",
  onSurface: "#212121",
  pressHighlight: "#F5F5F5",
  menuHighlight: "#F0F0F0",
  neutral: "#9E9E9E",
  unmarkedPast: "#BDBDBD",
} as const;

export const darkTheme = {
  background: "#2C2C2C", // Header, calendar, habit list area (lighter)
  surface: "#2C2C2C",
  surfaceElevated: "#333333",
  menuSurface: "#0F0F0F",
  divider: "#474747",
  border: "#3A3A3A",
  disabled: "#616161",
  muted: "#9E9E9E",
  primary: "#E8E7E7",
  icon: "#E8E7E7",
  metric: "#E8E7E7",
  onSurface: "#E8E7E7",
  pressHighlight: "#333333",
  menuHighlight: "#3A3A3A",
  neutral: "#616161",
  unmarkedPast: "#616161",
} as const;

export const settingsScreenBackgrounds = {
  light: "#FAFAFA",
  dark: darkTheme.background,
} as const;

// Heatmap intensity levels from empty through complete.
export const heatmapLevels = {
  light: {
    0: "#EEEEEE",
    1: "#0E4429",
    2: "#006D32",
    3: "#26A641",
    4: "#39D353",
    "-1": "#E86161",
    "-2": "#EF4444",
    "-3": "#DC2626",
    "-4": "#FC0505",
  },
  dark: {
    0: "#2A2A2A",
    1: "#0E4429",
    2: "#006D32",
    3: "#26A641",
    4: "#39D353",
    "-1": "#E86161",
    "-2": "#EF4444",
    "-3": "#DC2626",
    "-4": "#FC0505",
  },
} as const;

export const scrimColor = "rgba(0, 0, 0, 0.5)";

// Convert hex to RGB triplet for NativeWind CSS variables
function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r} ${g} ${b}`;
}

// Generate NativeWind CSS variables for the effective light/dark theme.
export function getThemeVars(
  mode: "light" | "dark"
): Record<string, string> {
  const theme = mode === "light" ? lightTheme : darkTheme;

  return {
    "--color-background": hexToRgb(theme.background),
    "--color-surface": hexToRgb(theme.surface),
    "--color-surface-elevated": hexToRgb(theme.surfaceElevated),
    "--color-border": hexToRgb(theme.border),
    "--color-muted": hexToRgb(theme.muted),
    "--color-primary": hexToRgb(theme.primary),
    "--color-divider": hexToRgb(theme.divider),
    "--color-destructive": hexToRgb(semantic.failure),
    "--color-press-highlight": hexToRgb(theme.pressHighlight),
  };
}
