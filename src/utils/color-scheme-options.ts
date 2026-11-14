import { getAccentScheme, normalizeHexColor } from "@/theme/colors";
import {
  BUILTIN_COLOR_SCHEMES,
  DEFAULT_SETTINGS,
  isBuiltinColorScheme,
  type ColorScheme,
  type CustomColorScheme,
  type BuiltinColorOverrides,
  type BuiltinColorScheme,
} from "@/types/settings";
export function normalizeColorSchemeOption(value: unknown): ColorScheme | null {
  if (isBuiltinColorScheme(value)) return value;
  return normalizeHexColor(value);
}
export function normalizeColorSchemeOptions(
  value: unknown,
  legacyCustomColors: CustomColorScheme[] = [],
): ColorScheme[] {
  const source = Array.isArray(value)
    ? value
    : [...legacyCustomColors, ...BUILTIN_COLOR_SCHEMES];
  const normalized: ColorScheme[] = [];
  for (const item of source) {
    const option = normalizeColorSchemeOption(item);
    if (option && !normalized.includes(option)) normalized.push(option);
  }
  return normalized.length > 0 ? normalized : [DEFAULT_SETTINGS.colorScheme];
}
export function getCustomColorsFromOptions(
  options: ColorScheme[],
): CustomColorScheme[] {
  return options.flatMap((option) => {
    const custom = normalizeHexColor(option);
    return custom ? [custom] : [];
  });
}
export function normalizeBuiltinColorOverrides(
  value: unknown,
): BuiltinColorOverrides {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const source = value as Record<string, unknown>;
  const normalized: BuiltinColorOverrides = {};
  const usedColors = new Set<CustomColorScheme>();
  for (const scheme of BUILTIN_COLOR_SCHEMES) {
    const color = normalizeHexColor(source[scheme]);
    if (!color || usedColors.has(color)) continue;
    normalized[scheme] = color;
    usedColors.add(color);
  }
  return normalized;
}
export function reconcileBuiltinColorOverrides(
  overrides: BuiltinColorOverrides,
  options: ColorScheme[],
): BuiltinColorOverrides {
  const reconciled: BuiltinColorOverrides = {};
  for (const scheme of BUILTIN_COLOR_SCHEMES) {
    const color = overrides[scheme];
    if (color && options.includes(color) && !options.includes(scheme)) {
      reconciled[scheme] = color;
    }
  }
  return reconciled;
}
export function findOverriddenBuiltinColor(
  overrides: BuiltinColorOverrides,
  color: ColorScheme,
): BuiltinColorScheme | null {
  for (const scheme of BUILTIN_COLOR_SCHEMES) {
    if (overrides[scheme] === color) return scheme;
  }
  return null;
}
export function getTransferColorSchemeOptions(
  options: ColorScheme[],
  overrides: BuiltinColorOverrides,
): ColorScheme[] {
  const overrideColors = new Set(
    Object.values(overrides).filter(
      (color): color is CustomColorScheme => color != null,
    ),
  );
  const customColors = options.filter(
    (option): option is CustomColorScheme =>
      !isBuiltinColorScheme(option) && !overrideColors.has(option),
  );
  const restoredBuiltins = BUILTIN_COLOR_SCHEMES.map(
    (scheme) => overrides[scheme] ?? scheme,
  );
  return normalizeColorSchemeOptions([...customColors, ...restoredBuiltins]);
}
export function normalizeSelectedColorScheme(
  value: unknown,
  options: ColorScheme[],
): ColorScheme {
  const normalized = normalizeColorSchemeOption(value);
  if (normalized && options.includes(normalized)) return normalized;
  return options[0] ?? DEFAULT_SETTINGS.colorScheme;
}
export function getColorSchemeBase(option: ColorScheme): CustomColorScheme {
  return getAccentScheme(option).base.toUpperCase() as CustomColorScheme;
}
export function hasDuplicateColorSchemeBase(
  options: ColorScheme[],
  color: CustomColorScheme,
  excludedIndex = -1,
): boolean {
  return options.some(
    (option, index) =>
      index !== excludedIndex && getColorSchemeBase(option) === color,
  );
}
export function getSelectionAfterColorRemoval(
  options: ColorScheme[],
  removedIndex: number,
  selected: ColorScheme,
): ColorScheme {
  const removed = options[removedIndex];
  if (removed !== selected) return selected;
  const remaining = options.filter((_, index) => index !== removedIndex);
  return (
    remaining[Math.min(removedIndex, remaining.length - 1)] ??
    DEFAULT_SETTINGS.colorScheme
  );
}
