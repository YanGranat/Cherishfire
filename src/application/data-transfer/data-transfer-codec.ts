import { isCivilDateKey } from "@/domain/dates/civil-date";
import type {
  DataTransferRows,
  ExportData,
  ExportedDayRecordRow,
  ExportedHabitRow,
  ExportedNoteRow,
  ExportedSettingRow,
  ExportIntegrity,
  NormalizedImportData,
} from "@/application/data-transfer/data-transfer-model";
import {
  DEFAULT_STATISTICS_BLOCK_ORDER,
  DEFAULT_SETTINGS,
  BUILTIN_COLOR_SCHEMES,
  SETTINGS_KEYS,
  STATISTICS_BLOCK_ORDER_KEYS,
  isBuiltinColorScheme,
  type BuiltinColorOverrides,
  type ColorScheme,
  type CustomColorScheme,
} from "@/types/settings";
import { isCompleteStatisticsBlockOrder } from "@/utils/statistics-block-orders";
import type { ArchivePeriod } from "@/types/habit";
import { isSupportedLanguage } from "@/domain/settings/supported-language";
import { normalizeArchiveHistory } from "@/domain/habits/archive-periods";
import {
  isValidReminderTime,
  parseReminderTimes,
} from "@/domain/reminders/reminder-time";
import {
  DESCRIPTION_LINES_KEY_PREFIX,
  getDescriptionLinesSettingHabitId,
  isValidDescriptionLinesValue,
} from "@/application/settings/habit-description-lines-setting";
import { assertDataTransferImportTextSize } from "@/application/data-transfer/data-transfer-limits";

export const EXPORT_SCHEMA_VERSION = 5;
// Version 5 is the minimum supported compatibility baseline. Every
// future schema must keep importing the frozen v5 fixture, with an explicit
// migration when its shape changes.
export const MIN_SUPPORTED_EXPORT_SCHEMA_VERSION = 5;

export type {
  ExportData,
  ExportedDayRecordRow,
  ExportedHabitRow,
  ExportedNoteRow,
  ExportedSettingRow,
  ExportIntegrity,
  NormalizedImportData,
} from "@/application/data-transfer/data-transfer-model";
const REQUIRED_SETTINGS_DEFAULTS: ExportedSettingRow[] = [
  { key: SETTINGS_KEYS.THEME, value: JSON.stringify(DEFAULT_SETTINGS.theme) },
  {
    key: SETTINGS_KEYS.COLOR_SCHEME,
    value: JSON.stringify(DEFAULT_SETTINGS.colorScheme),
  },
  {
    key: SETTINGS_KEYS.CUSTOM_COLORS,
    value: JSON.stringify(DEFAULT_SETTINGS.customColors),
  },
  {
    key: SETTINGS_KEYS.LANGUAGE,
    value: JSON.stringify(DEFAULT_SETTINGS.language),
  },
  {
    key: SETTINGS_KEYS.ASK_FAILURE_REASON,
    value: JSON.stringify(DEFAULT_SETTINGS.askFailureReason),
  },
  {
    key: SETTINGS_KEYS.ASK_SKIP_REASON,
    value: JSON.stringify(DEFAULT_SETTINGS.askSkipReason),
  },
  {
    key: SETTINGS_KEYS.SOUND_ENABLED,
    value: JSON.stringify(DEFAULT_SETTINGS.soundEnabled),
  },
  {
    key: SETTINGS_KEYS.REMINDER_NOTIFICATIONS_ENABLED,
    value: JSON.stringify(DEFAULT_SETTINGS.reminderNotificationsEnabled),
  },
  {
    key: SETTINGS_KEYS.SHOW_ARCHIVED_HABITS_IN_STATISTICS,
    value: JSON.stringify(DEFAULT_SETTINGS.showArchivedHabitsInStatistics),
  },
  {
    key: SETTINGS_KEYS.STATISTICS_BLOCK_ORDER,
    value: JSON.stringify(DEFAULT_STATISTICS_BLOCK_ORDER),
  },
];

function ensureRequiredSettingsRows(
  rows: ExportedSettingRow[],
): ExportedSettingRow[] {
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.key, row.value);
  }
  for (const required of REQUIRED_SETTINGS_DEFAULTS) {
    if (!map.has(required.key)) {
      map.set(required.key, required.value);
    }
  }
  return Array.from(map.entries()).map(([key, value]) => ({ key, value }));
}

function assertUniqueSettingKeys(rows: readonly ExportedSettingRow[]): void {
  const keys = new Set<string>();
  for (let index = 0; index < rows.length; index += 1) {
    const key = rows[index].key;
    if (!key || keys.has(key)) {
      throw new Error(`Invalid settings[${index}].key`);
    }
    keys.add(key);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${field} item`);
  }
  return value;
}

function asString(
  value: unknown,
  field: string,
  options?: { nullable?: boolean },
): string | null {
  const nullable = options?.nullable === true;
  if (value == null) {
    if (nullable) return null;
    throw new Error(`Missing ${field}`);
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function asIsoDate(value: unknown, field: string): string {
  const normalized = asString(value, field);
  if (!normalized || !isCivilDateKey(normalized)) {
    throw new Error(`Invalid ${field}`);
  }
  return normalized;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new Error(`Invalid ${field}`);
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`Invalid ${field}`);
}

function asDate(
  value: unknown,
  field: string,
  options?: { nullable?: boolean },
): Date | null {
  const nullable = options?.nullable === true;
  if (value == null) {
    if (nullable) return null;
    throw new Error(`Missing ${field}`);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0 || !trimmed.endsWith("Z")) {
      throw new Error(`Invalid ${field}`);
    }
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime()) || date.toISOString() !== trimmed) {
      throw new Error(`Invalid ${field}`);
    }
    return date;
  }

  throw new Error(`Invalid ${field}`);
}

function asRepeatType(
  value: unknown,
  field: string,
): "daily" | "weekdays" | "monthly" | "interval" {
  if (
    value === "daily" ||
    value === "weekdays" ||
    value === "monthly" ||
    value === "interval"
  ) {
    return value;
  }
  throw new Error(`Invalid ${field}`);
}

function asDayStatus(
  value: unknown,
  field: string,
): "done" | "minimum" | "maximum" | "skipped" | "failure" {
  if (
    value === "done" ||
    value === "minimum" ||
    value === "maximum" ||
    value === "skipped" ||
    value === "failure"
  ) {
    return value;
  }
  throw new Error(`Invalid ${field}`);
}

function asRepeatConfig(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new Error(`Invalid ${field}`);
}

function ensureArray(value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new Error(`Missing ${field} array`);
}

function requireInteger(
  value: number,
  field: string,
  options?: { min?: number; max?: number },
): number {
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${field}`);
  if (options?.min != null && value < options.min) {
    throw new Error(`Invalid ${field}`);
  }
  if (options?.max != null && value > options.max) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function requireIntegerArray(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid ${field}`);
  }
  const result = value.map((item, index) =>
    requireInteger(asNumber(item, `${field}[${index}]`), `${field}[${index}]`, {
      min,
      max,
    }),
  );
  if (new Set(result).size !== result.length) {
    throw new Error(`Invalid ${field}`);
  }
  return result;
}

function validateRepeatScheduleObject(value: unknown, field: string): void {
  const schedule = ensureRecord(value, field);
  const type = asRepeatType(schedule.type, `${field}.type`);
  validateRepeatConfig(type, schedule, field, false);
}

function normalizedRepeatScheduleForComparison(
  type: "daily" | "weekdays" | "monthly" | "interval",
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (type === "weekdays") {
    return {
      type,
      days: [...(config.days as number[])].sort((a, b) => a - b),
    };
  }
  if (type === "monthly") {
    return {
      type,
      dates: [...(config.dates as number[])].sort((a, b) => a - b),
    };
  }
  if (type === "interval") {
    return {
      type,
      every: config.every,
      fromCompletion: config.fromCompletion === true,
    };
  }
  return { type: "daily" };
}

function validateRepeatConfig(
  type: "daily" | "weekdays" | "monthly" | "interval",
  config: Record<string, unknown>,
  field: string,
  validateHistory = true,
  currentStartDate?: string,
): void {
  if (type === "weekdays") {
    requireIntegerArray(config.days, `${field}.days`, 1, 7);
  } else if (type === "monthly") {
    requireIntegerArray(config.dates, `${field}.dates`, 1, 31);
  } else if (type === "interval") {
    requireInteger(asNumber(config.every, `${field}.every`), `${field}.every`, {
      min: 2,
      max: 365,
    });
    if (
      config.fromCompletion !== undefined &&
      typeof config.fromCompletion !== "boolean"
    ) {
      throw new Error(`Invalid ${field}.fromCompletion`);
    }
  }

  if (!validateHistory) return;
  if (
    !Array.isArray(config.scheduleHistory) ||
    config.scheduleHistory.length === 0
  ) {
    throw new Error(`Invalid ${field}.scheduleHistory`);
  }
  let previousEffectiveFrom: string | null = null;
  let finalEntry: Record<string, unknown> | null = null;
  for (let index = 0; index < config.scheduleHistory.length; index += 1) {
    const entry = ensureRecord(
      config.scheduleHistory[index],
      `${field}.scheduleHistory[${index}]`,
    );
    const effectiveFrom = asIsoDate(
      entry.effectiveFrom,
      `${field}.scheduleHistory[${index}].effectiveFrom`,
    );
    if (
      previousEffectiveFrom != null &&
      effectiveFrom <= previousEffectiveFrom
    ) {
      throw new Error(`Invalid ${field}.scheduleHistory order`);
    }
    previousEffectiveFrom = effectiveFrom;
    asIsoDate(entry.startDate, `${field}.scheduleHistory[${index}].startDate`);
    validateRepeatScheduleObject(
      entry.repeatSchedule,
      `${field}.scheduleHistory[${index}].repeatSchedule`,
    );
    finalEntry = entry;
  }

  if (finalEntry) {
    if (currentStartDate && finalEntry.startDate !== currentStartDate) {
      throw new Error(`Invalid ${field}.scheduleHistory current startDate`);
    }
    const finalSchedule = ensureRecord(
      finalEntry.repeatSchedule,
      `${field}.scheduleHistory current repeatSchedule`,
    );
    const finalType = asRepeatType(
      finalSchedule.type,
      `${field}.scheduleHistory current repeatSchedule.type`,
    );
    const expectedCurrent = normalizedRepeatScheduleForComparison(type, config);
    const actualCurrent = normalizedRepeatScheduleForComparison(
      finalType,
      finalSchedule,
    );
    if (stableSerialize(actualCurrent) !== stableSerialize(expectedCurrent)) {
      throw new Error(
        `Invalid ${field}.scheduleHistory current repeatSchedule`,
      );
    }
  }
}

function validateReminderValue(
  value: string | null,
  enabled: boolean,
  field: string,
): void {
  if (value == null || value.trim() === "") {
    if (enabled) throw new Error(`Invalid ${field}`);
    return;
  }
  const trimmed = value.trim();
  if (isValidReminderTime(trimmed)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`Invalid ${field}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Invalid ${field}`);
  }
  if (
    parsed.some(
      (item) => typeof item !== "string" || !isValidReminderTime(item),
    ) ||
    parseReminderTimes(trimmed).length !== parsed.length
  ) {
    throw new Error(`Invalid ${field}`);
  }
}

/**
 * Schema-v5 color semantics are frozen here deliberately. Presentation color
 * helpers may evolve with the editor, but that must not silently change which
 * persisted exports validate or how their bytes are normalized.
 */
const CUSTOM_COLOR_PATTERN = /^#[0-9A-F]{6}$/;

function normalizeTransferCustomColor(
  value: unknown,
): CustomColorScheme | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return CUSTOM_COLOR_PATTERN.test(normalized)
    ? (normalized as CustomColorScheme)
    : null;
}

function normalizeColorSchemeOption(value: unknown): ColorScheme | null {
  if (isBuiltinColorScheme(value)) return value;
  return normalizeTransferCustomColor(value);
}

function normalizeColorSchemeOptions(
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

function normalizeBuiltinColorOverrides(value: unknown): BuiltinColorOverrides {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const source = value as Record<string, unknown>;
  const normalized: BuiltinColorOverrides = {};
  const usedColors = new Set<CustomColorScheme>();
  for (const scheme of BUILTIN_COLOR_SCHEMES) {
    const color = normalizeTransferCustomColor(source[scheme]);
    if (!color || usedColors.has(color)) continue;
    normalized[scheme] = color;
    usedColors.add(color);
  }
  return normalized;
}

function getCustomColorsFromOptions(
  options: readonly ColorScheme[],
): CustomColorScheme[] {
  return options.flatMap((option) => {
    const custom = normalizeTransferCustomColor(option);
    return custom ? [custom] : [];
  });
}

function getTransferColorSchemeOptions(
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

function removeOrphanedHabitDescriptionSettings(
  rows: ExportedSettingRow[],
  habitIds: ReadonlySet<number>,
): ExportedSettingRow[] {
  return rows.filter((row) => {
    if (!row.key.startsWith(DESCRIPTION_LINES_KEY_PREFIX)) return true;
    const habitId = getDescriptionLinesSettingHabitId(row.key);
    // Keep malformed scoped keys so validation reports corruption instead of
    // silently hiding it. Only valid keys for deleted habits are stale metadata.
    return habitId == null || habitIds.has(habitId);
  });
}

function parseStoredSettingValue(
  row: ExportedSettingRow,
  field: string,
): unknown {
  try {
    return JSON.parse(row.value);
  } catch {
    throw new Error(`Invalid ${field}.value`);
  }
}

function prepareColorSettingsForTransfer(
  rows: ExportedSettingRow[],
): ExportedSettingRow[] {
  const optionsRow = rows.find(
    (row) => row.key === SETTINGS_KEYS.COLOR_SCHEME_OPTIONS,
  );
  if (!optionsRow) return rows;

  const options = normalizeColorSchemeOptions(
    parseStoredSettingValue(optionsRow, SETTINGS_KEYS.COLOR_SCHEME_OPTIONS),
  );
  const overridesRow = rows.find(
    (row) => row.key === SETTINGS_KEYS.BUILTIN_COLOR_OVERRIDES,
  );
  const overrides = normalizeBuiltinColorOverrides(
    overridesRow
      ? parseStoredSettingValue(
          overridesRow,
          SETTINGS_KEYS.BUILTIN_COLOR_OVERRIDES,
        )
      : null,
  );
  const transferOptions = getTransferColorSchemeOptions(options, overrides);
  const transferCustomColors = getCustomColorsFromOptions(transferOptions);
  const selectedRow = rows.find(
    (row) => row.key === SETTINGS_KEYS.COLOR_SCHEME,
  );
  const selected = selectedRow
    ? (parseStoredSettingValue(
        selectedRow,
        SETTINGS_KEYS.COLOR_SCHEME,
      ) as ColorScheme)
    : DEFAULT_SETTINGS.colorScheme;
  const transferSelection = transferOptions.includes(selected)
    ? selected
    : transferOptions[0];

  return rows.map((row) => {
    if (row.key === SETTINGS_KEYS.COLOR_SCHEME_OPTIONS) {
      return { ...row, value: JSON.stringify(transferOptions) };
    }
    if (row.key === SETTINGS_KEYS.CUSTOM_COLORS) {
      return { ...row, value: JSON.stringify(transferCustomColors) };
    }
    if (row.key === SETTINGS_KEYS.COLOR_SCHEME) {
      return { ...row, value: JSON.stringify(transferSelection) };
    }
    if (row.key === SETTINGS_KEYS.BUILTIN_COLOR_OVERRIDES) {
      return { ...row, value: JSON.stringify(overrides) };
    }
    return row;
  });
}

function validateSettingsSemantics(
  rows: ExportedSettingRow[],
  habitIds: Set<number>,
): void {
  const values = new Map<string, unknown>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const parsed = parseStoredSettingValue(row, `settings[${index}]`);
    values.set(row.key, parsed);

    if (row.key.startsWith(DESCRIPTION_LINES_KEY_PREFIX)) {
      const habitId = getDescriptionLinesSettingHabitId(row.key);
      if (
        habitId == null ||
        !habitIds.has(habitId) ||
        !isValidDescriptionLinesValue(parsed)
      ) {
        throw new Error(`Invalid settings[${index}] description size`);
      }
    }
  }

  const theme = values.get(SETTINGS_KEYS.THEME);
  if (theme !== "system" && theme !== "dark" && theme !== "light") {
    throw new Error(`Invalid setting ${SETTINGS_KEYS.THEME}`);
  }

  const language = values.get(SETTINGS_KEYS.LANGUAGE);
  if (typeof language !== "string" || !isSupportedLanguage(language)) {
    throw new Error(`Invalid setting ${SETTINGS_KEYS.LANGUAGE}`);
  }

  const customColors = values.get(SETTINGS_KEYS.CUSTOM_COLORS);
  if (
    !Array.isArray(customColors) ||
    customColors.some(
      (color) => typeof color !== "string" || !CUSTOM_COLOR_PATTERN.test(color),
    ) ||
    new Set(customColors).size !== customColors.length
  ) {
    throw new Error(`Invalid setting ${SETTINGS_KEYS.CUSTOM_COLORS}`);
  }

  const colorScheme = values.get(SETTINGS_KEYS.COLOR_SCHEME);
  const colorSchemeOptions = values.get(SETTINGS_KEYS.COLOR_SCHEME_OPTIONS);
  const builtinColorOverridesValue = values.get(
    SETTINGS_KEYS.BUILTIN_COLOR_OVERRIDES,
  );
  const builtinColorOverrides = normalizeBuiltinColorOverrides(
    builtinColorOverridesValue,
  );
  if (builtinColorOverridesValue !== undefined) {
    if (!isRecord(builtinColorOverridesValue)) {
      throw new Error(
        `Invalid setting ${SETTINGS_KEYS.BUILTIN_COLOR_OVERRIDES}`,
      );
    }
    const overrideEntries = Object.entries(builtinColorOverridesValue);
    if (
      overrideEntries.some(
        ([scheme, color]) =>
          !isBuiltinColorScheme(scheme) ||
          typeof color !== "string" ||
          !CUSTOM_COLOR_PATTERN.test(color),
      ) ||
      Object.keys(builtinColorOverrides).length !== overrideEntries.length ||
      new Set(overrideEntries.map(([, color]) => color)).size !==
        overrideEntries.length
    ) {
      throw new Error(
        `Invalid setting ${SETTINGS_KEYS.BUILTIN_COLOR_OVERRIDES}`,
      );
    }
  }
  if (colorSchemeOptions !== undefined) {
    if (
      !Array.isArray(colorSchemeOptions) ||
      colorSchemeOptions.length === 0 ||
      colorSchemeOptions.some(
        (option) =>
          !isBuiltinColorScheme(option) &&
          !(typeof option === "string" && CUSTOM_COLOR_PATTERN.test(option)),
      ) ||
      new Set(colorSchemeOptions).size !== colorSchemeOptions.length
    ) {
      throw new Error(`Invalid setting ${SETTINGS_KEYS.COLOR_SCHEME_OPTIONS}`);
    }

    const projectedCustomColors = colorSchemeOptions.filter(
      (option): option is string =>
        typeof option === "string" && CUSTOM_COLOR_PATTERN.test(option),
    );
    if (
      JSON.stringify(projectedCustomColors) !== JSON.stringify(customColors)
    ) {
      throw new Error(
        `Invalid setting ${SETTINGS_KEYS.COLOR_SCHEME_OPTIONS} projection`,
      );
    }
    if (!colorSchemeOptions.includes(colorScheme)) {
      throw new Error(`Invalid setting ${SETTINGS_KEYS.COLOR_SCHEME}`);
    }
    for (const [scheme, color] of Object.entries(builtinColorOverrides)) {
      if (
        colorSchemeOptions.includes(scheme) ||
        !colorSchemeOptions.includes(color)
      ) {
        throw new Error(
          `Invalid setting ${SETTINGS_KEYS.BUILTIN_COLOR_OVERRIDES} mapping`,
        );
      }
    }
  } else if (Object.keys(builtinColorOverrides).length > 0) {
    throw new Error(
      `Invalid setting ${SETTINGS_KEYS.BUILTIN_COLOR_OVERRIDES} mapping`,
    );
  } else if (
    !isBuiltinColorScheme(colorScheme) &&
    !(
      typeof colorScheme === "string" &&
      CUSTOM_COLOR_PATTERN.test(colorScheme) &&
      customColors.includes(colorScheme)
    )
  ) {
    throw new Error(`Invalid setting ${SETTINGS_KEYS.COLOR_SCHEME}`);
  }

  for (const key of [
    SETTINGS_KEYS.ASK_FAILURE_REASON,
    SETTINGS_KEYS.ASK_SKIP_REASON,
    SETTINGS_KEYS.SOUND_ENABLED,
    SETTINGS_KEYS.REMINDER_NOTIFICATIONS_ENABLED,
    SETTINGS_KEYS.SHOW_ARCHIVED_HABITS_IN_STATISTICS,
  ]) {
    if (typeof values.get(key) !== "boolean") {
      throw new Error(`Invalid setting ${key}`);
    }
  }

  const statisticsOrder = values.get(SETTINGS_KEYS.STATISTICS_BLOCK_ORDER);
  if (!isCompleteStatisticsBlockOrder(statisticsOrder)) {
    throw new Error(`Invalid setting ${SETTINGS_KEYS.STATISTICS_BLOCK_ORDER}`);
  }
  for (const period of ["week", "month", "year"] as const) {
    const key = STATISTICS_BLOCK_ORDER_KEYS[period];
    if (values.has(key) && !isCompleteStatisticsBlockOrder(values.get(key))) {
      throw new Error(`Invalid setting ${key}`);
    }
  }
}

function validateArchiveSemantics(
  habit: ExportedHabitRow,
  field: string,
): void {
  const history = normalizeImportedArchiveHistory(
    habit.archiveHistory,
    `${field}.archiveHistory`,
  );
  let openPeriod: ArchivePeriod | null = null;

  for (let index = 0; index < history.length; index += 1) {
    const period = history[index];
    if (index > 0) {
      const previous = history[index - 1];
      // Captured local dates can overlap after a timezone change.
      if (
        period.archivedAt < previous.archivedAt ||
        (previous.restoredAt != null &&
          period.archivedAt < previous.restoredAt)
      ) {
        throw new Error(`Invalid ${field}.archiveHistory overlap`);
      }
    }
    if (period.restoredAt == null) {
      if (openPeriod || index !== history.length - 1) {
        throw new Error(`Invalid ${field}.archiveHistory open period`);
      }
      openPeriod = period;
    }
  }

  if (habit.isArchived) {
    if (
      !openPeriod ||
      habit.archivedAt == null ||
      habit.archivedAt.getTime() !== openPeriod.archivedAt
    ) {
      throw new Error(`Invalid ${field} archived state`);
    }
  } else if (habit.archivedAt != null || openPeriod != null) {
    throw new Error(`Invalid ${field} active state`);
  }
}

function validateNormalizedImportRows(params: {
  habits: ExportedHabitRow[];
  dayRecords: ExportedDayRecordRow[];
  notes: ExportedNoteRow[];
  settings: ExportedSettingRow[];
}): void {
  const habitIds = new Set<number>();
  const displayOrders = new Set<number>();
  for (let index = 0; index < params.habits.length; index += 1) {
    const habit = params.habits[index];
    requireInteger(habit.id, `habits[${index}].id`, { min: 1 });
    requireInteger(habit.displayOrder, `habits[${index}].displayOrder`, {
      min: 0,
    });
    if (
      habitIds.has(habit.id) ||
      displayOrders.has(habit.displayOrder) ||
      habit.name.trim().length === 0
    ) {
      throw new Error(`Invalid habits[${index}]`);
    }
    if (!isCivilDateKey(habit.startDate)) {
      throw new Error(`Invalid habits[${index}].startDate`);
    }
    if (
      !(habit.createdAt instanceof Date) ||
      Number.isNaN(habit.createdAt.getTime()) ||
      !(habit.updatedAt instanceof Date) ||
      Number.isNaN(habit.updatedAt.getTime())
    ) {
      throw new Error(`Invalid habits[${index}] timestamps`);
    }
    validateArchiveSemantics(habit, `habits[${index}]`);
    habitIds.add(habit.id);
    displayOrders.add(habit.displayOrder);
    validateRepeatConfig(
      habit.repeatType,
      habit.repeatConfig,
      `habits[${index}].repeatConfig`,
      true,
      habit.startDate,
    );
    validateReminderValue(
      habit.reminderTime,
      habit.reminderEnabled,
      `habits[${index}].reminderTime`,
    );
  }

  const dayRecordIds = new Set<number>();
  const dayRecordKeys = new Set<string>();
  for (let index = 0; index < params.dayRecords.length; index += 1) {
    const record = params.dayRecords[index];
    requireInteger(record.id, `day_records[${index}].id`, { min: 1 });
    requireInteger(record.habitId, `day_records[${index}].habitId`, { min: 1 });
    if (!isCivilDateKey(record.date)) {
      throw new Error(`Invalid day_records[${index}].date`);
    }
    const key = `${record.habitId}:${record.date}`;
    if (
      dayRecordIds.has(record.id) ||
      dayRecordKeys.has(key) ||
      !habitIds.has(record.habitId)
    ) {
      throw new Error(`Invalid day_records[${index}]`);
    }
    dayRecordIds.add(record.id);
    dayRecordKeys.add(key);
    if (
      !(record.createdAt instanceof Date) ||
      Number.isNaN(record.createdAt.getTime()) ||
      !(record.updatedAt instanceof Date) ||
      Number.isNaN(record.updatedAt.getTime())
    ) {
      throw new Error(`Invalid day_records[${index}] timestamps`);
    }
  }

  const noteIds = new Set<number>();
  for (let index = 0; index < params.notes.length; index += 1) {
    const note = params.notes[index];
    requireInteger(note.id, `notes[${index}].id`, { min: 1 });
    requireInteger(note.habitId, `notes[${index}].habitId`, { min: 1 });
    if (!isCivilDateKey(note.date)) {
      throw new Error(`Invalid notes[${index}].date`);
    }
    if (noteIds.has(note.id) || !habitIds.has(note.habitId)) {
      throw new Error(`Invalid notes[${index}]`);
    }
    if (note.isFailureReason && note.reasonType !== "failure") {
      throw new Error(`Invalid notes[${index}].reasonType`);
    }
    if (
      !(note.createdAt instanceof Date) ||
      Number.isNaN(note.createdAt.getTime()) ||
      !(note.updatedAt instanceof Date) ||
      Number.isNaN(note.updatedAt.getTime())
    ) {
      throw new Error(`Invalid notes[${index}] timestamps`);
    }
    noteIds.add(note.id);
  }

  const settingKeys = new Set<string>();
  for (let index = 0; index < params.settings.length; index += 1) {
    const setting = params.settings[index];
    if (!setting.key || settingKeys.has(setting.key)) {
      throw new Error(`Invalid settings[${index}].key`);
    }
    try {
      JSON.parse(setting.value);
    } catch {
      throw new Error(`Invalid settings[${index}].value`);
    }
    settingKeys.add(setting.key);
  }
  validateSettingsSemantics(params.settings, habitIds);
}

function buildDateCountMap(rows: { date: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = row.date;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function buildSignatureFromEntries(entries: string[]): string {
  return fnv1aHash(entries.slice().sort().join("\n"));
}

function normalizeDateLikeToEpochMs(value: Date | null): number | null {
  if (value == null) return null;
  const ms = value.getTime();
  return Number.isNaN(ms) ? null : ms;
}

function normalizeRepeatConfigForSignature(value: unknown): unknown {
  return value;
}

function normalizeImportedArchiveHistory(
  value: unknown,
  field: string,
): ArchivePeriod[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${field}`);
  for (let index = 0; index < value.length; index += 1) {
    const item = ensureRecord(value[index], `${field}[${index}]`);
    if (
      typeof item.archivedAt !== "number" ||
      !Number.isFinite(item.archivedAt) ||
      typeof item.archivedDate !== "string" ||
      !isCivilDateKey(item.archivedDate)
    ) {
      throw new Error(`Invalid ${field}[${index}]`);
    }
    if (item.restoredAt == null) {
      if (item.restoredDate != null) {
        throw new Error(`Invalid ${field}[${index}].restoredDate`);
      }
    } else if (
      typeof item.restoredAt !== "number" ||
      !Number.isFinite(item.restoredAt) ||
      typeof item.restoredDate !== "string" ||
      !isCivilDateKey(item.restoredDate)
    ) {
      throw new Error(`Invalid ${field}[${index}]`);
    }
  }
  const normalized = normalizeArchiveHistory(value);
  if (normalized.length !== value.length) {
    throw new Error(`Invalid ${field}`);
  }
  return normalized;
}

function habitSignatureEntry(row: ExportedHabitRow): string {
  return stableSerialize({
    id: row.id,
    name: row.name,
    description: row.description,
    descriptionVisible: row.descriptionVisible,
    repeatType: row.repeatType,
    repeatConfig: normalizeRepeatConfigForSignature(row.repeatConfig),
    startDate: row.startDate,
    reminderEnabled: row.reminderEnabled,
    reminderTime: row.reminderTime,
    displayOrder: row.displayOrder,
    isArchived: row.isArchived,
    archivedAt: normalizeDateLikeToEpochMs(row.archivedAt),
    archiveHistory: normalizeArchiveHistory(row.archiveHistory),
    createdAt: normalizeDateLikeToEpochMs(row.createdAt),
    updatedAt: normalizeDateLikeToEpochMs(row.updatedAt),
  });
}

function dayRecordSignatureEntry(row: ExportedDayRecordRow): string {
  return stableSerialize({
    id: row.id,
    habitId: row.habitId,
    date: row.date,
    status: row.status,
    createdAt: normalizeDateLikeToEpochMs(row.createdAt),
    updatedAt: normalizeDateLikeToEpochMs(row.updatedAt),
  });
}

function noteSignatureEntry(row: ExportedNoteRow): string {
  return stableSerialize({
    id: row.id,
    habitId: row.habitId,
    date: row.date,
    text: row.text,
    isFailureReason: row.isFailureReason,
    reasonType: row.reasonType,
    createdAt: normalizeDateLikeToEpochMs(row.createdAt),
    updatedAt: normalizeDateLikeToEpochMs(row.updatedAt),
  });
}

function asStatusReasonType(
  value: unknown,
  field: string,
): "failure" | "skipped" | null {
  if (value == null) return null;
  if (value === "failure" || value === "skipped") {
    return value;
  }
  throw new Error(`Invalid ${field}`);
}

function settingSignatureEntry(row: ExportedSettingRow): string {
  return stableSerialize({
    key: row.key,
    value: row.value,
  });
}

function buildDateSignatureMap<T extends { date: string }>(
  rows: T[],
  toSignatureEntry: (row: T) => string,
): Record<string, string> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const existing = grouped.get(row.date);
    const entry = toSignatureEntry(row);
    if (existing) {
      existing.push(entry);
    } else {
      grouped.set(row.date, [entry]);
    }
  }

  const signatures: Record<string, string> = {};
  const dates = Array.from(grouped.keys()).sort();
  for (const date of dates) {
    const entries = grouped.get(date) ?? [];
    signatures[date] = buildSignatureFromEntries(entries);
  }
  return signatures;
}

function buildIntegrityFromRows(params: {
  habits: ExportedHabitRow[];
  day_records: ExportedDayRecordRow[];
  notes: ExportedNoteRow[];
  settings: ExportedSettingRow[];
}): ExportIntegrity {
  const habitEntries = params.habits.map((row) => habitSignatureEntry(row));
  const dayRecordEntries = params.day_records.map((row) =>
    dayRecordSignatureEntry(row),
  );
  const noteEntries = params.notes.map((row) => noteSignatureEntry(row));
  const settingEntries = params.settings.map((row) =>
    settingSignatureEntry(row),
  );

  return {
    habits_count: params.habits.length,
    archived_habits_count: params.habits.filter((h) => h.isArchived).length,
    day_records_count: params.day_records.length,
    notes_count: params.notes.length,
    settings_count: params.settings.length,
    day_records_by_date: buildDateCountMap(params.day_records),
    notes_by_date: buildDateCountMap(params.notes),
    habits_signature: buildSignatureFromEntries(habitEntries),
    day_records_signature: buildSignatureFromEntries(dayRecordEntries),
    notes_signature: buildSignatureFromEntries(noteEntries),
    settings_signature: buildSignatureFromEntries(settingEntries),
    day_records_date_signatures: buildDateSignatureMap(
      params.day_records,
      dayRecordSignatureEntry,
    ),
    notes_date_signatures: buildDateSignatureMap(
      params.notes,
      noteSignatureEntry,
    ),
  };
}

function parseDateCountMap(
  value: unknown,
  field: string,
): Record<string, number> {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${field}`);
  }
  const result: Record<string, number> = {};
  for (const [date, rawCount] of Object.entries(value)) {
    if (!isCivilDateKey(date)) {
      throw new Error(`Invalid ${field}.${date}`);
    }
    const count = asNumber(rawCount, `${field}.${date}`);
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`Invalid ${field}.${date}`);
    }
    result[date] = count;
  }
  return result;
}

function parseDateSignatureMap(
  value: unknown,
  field: string,
): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${field}`);
  }
  const result: Record<string, string> = {};
  for (const [date, rawSignature] of Object.entries(value)) {
    if (!isCivilDateKey(date)) {
      throw new Error(`Invalid ${field}.${date}`);
    }
    const signature = asString(rawSignature, `${field}.${date}`);
    if (!signature || signature.trim().length === 0) {
      throw new Error(`Invalid ${field}.${date}`);
    }
    result[date] = signature;
  }
  return result;
}

function parseRequiredSignature(value: unknown, field: string): string {
  const signature = asString(value, field);
  if (!signature || signature.trim().length === 0) {
    throw new Error(`Invalid ${field}`);
  }
  return signature;
}

function parseIntegrity(value: unknown): ExportIntegrity {
  if (!isRecord(value)) throw new Error("Invalid integrity");
  const habitsCount = asNumber(value.habits_count, "integrity.habits_count");
  const archivedHabitsCount = asNumber(
    value.archived_habits_count,
    "integrity.archived_habits_count",
  );
  const dayRecordsCount = asNumber(
    value.day_records_count,
    "integrity.day_records_count",
  );
  const notesCount = asNumber(value.notes_count, "integrity.notes_count");
  const settingsCount = asNumber(
    value.settings_count,
    "integrity.settings_count",
  );

  const dayRecordsByDate = parseDateCountMap(
    value.day_records_by_date,
    "integrity.day_records_by_date",
  );
  const notesByDate = parseDateCountMap(
    value.notes_by_date,
    "integrity.notes_by_date",
  );
  const habitsSignature = parseRequiredSignature(
    value.habits_signature,
    "integrity.habits_signature",
  );
  const dayRecordsSignature = parseRequiredSignature(
    value.day_records_signature,
    "integrity.day_records_signature",
  );
  const notesSignature = parseRequiredSignature(
    value.notes_signature,
    "integrity.notes_signature",
  );
  const settingsSignature = parseRequiredSignature(
    value.settings_signature,
    "integrity.settings_signature",
  );
  const dayRecordsDateSignatures = parseDateSignatureMap(
    value.day_records_date_signatures,
    "integrity.day_records_date_signatures",
  );
  const notesDateSignatures = parseDateSignatureMap(
    value.notes_date_signatures,
    "integrity.notes_date_signatures",
  );

  return {
    habits_count: habitsCount,
    archived_habits_count: archivedHabitsCount,
    day_records_count: dayRecordsCount,
    notes_count: notesCount,
    settings_count: settingsCount,
    day_records_by_date: dayRecordsByDate,
    notes_by_date: notesByDate,
    habits_signature: habitsSignature,
    day_records_signature: dayRecordsSignature,
    notes_signature: notesSignature,
    settings_signature: settingsSignature,
    day_records_date_signatures: dayRecordsDateSignatures,
    notes_date_signatures: notesDateSignatures,
  };
}

function compareDateCountMaps(
  expected: Record<string, number>,
  actual: Record<string, number>,
  label: string,
): string | null {
  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(actual);
  if (expectedKeys.length !== actualKeys.length) {
    return `${label}: expected ${expectedKeys.length} dates, got ${actualKeys.length}`;
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(actual, key)) {
      return `${label}: missing date ${key}`;
    }
    if (actual[key] !== expected[key]) {
      return `${label}: date ${key} expected ${expected[key]}, got ${actual[key]}`;
    }
  }
  return null;
}

function compareDateSignatureMaps(
  expected: Record<string, string>,
  actual: Record<string, string>,
  label: string,
): string | null {
  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(actual);
  if (expectedKeys.length !== actualKeys.length) {
    return `${label}: expected ${expectedKeys.length} dates, got ${actualKeys.length}`;
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(actual, key)) {
      return `${label}: missing date ${key}`;
    }
    if (actual[key] !== expected[key]) {
      return `${label}: date ${key} signature mismatch`;
    }
  }
  return null;
}

function compareIntegrity(
  expected: ExportIntegrity,
  actual: ExportIntegrity,
): string | null {
  if (expected.habits_count !== actual.habits_count) {
    return `habits_count mismatch: ${expected.habits_count} vs ${actual.habits_count}`;
  }
  if (expected.archived_habits_count !== actual.archived_habits_count) {
    return `archived_habits_count mismatch: ${expected.archived_habits_count} vs ${actual.archived_habits_count}`;
  }
  if (expected.day_records_count !== actual.day_records_count) {
    return `day_records_count mismatch: ${expected.day_records_count} vs ${actual.day_records_count}`;
  }
  if (expected.notes_count !== actual.notes_count) {
    return `notes_count mismatch: ${expected.notes_count} vs ${actual.notes_count}`;
  }
  if (expected.settings_count !== actual.settings_count) {
    return `settings_count mismatch: ${expected.settings_count} vs ${actual.settings_count}`;
  }
  if (expected.habits_signature !== actual.habits_signature) {
    return "habits_signature mismatch";
  }
  if (expected.day_records_signature !== actual.day_records_signature) {
    return "day_records_signature mismatch";
  }
  if (expected.notes_signature !== actual.notes_signature) {
    return "notes_signature mismatch";
  }
  if (expected.settings_signature !== actual.settings_signature) {
    return "settings_signature mismatch";
  }
  const dayRecordsMapMismatch = compareDateCountMaps(
    expected.day_records_by_date,
    actual.day_records_by_date,
    "day_records_by_date",
  );
  if (dayRecordsMapMismatch) return dayRecordsMapMismatch;
  const notesMapMismatch = compareDateCountMaps(
    expected.notes_by_date,
    actual.notes_by_date,
    "notes_by_date",
  );
  if (notesMapMismatch) return notesMapMismatch;
  const dayRecordsSignaturesMismatch = compareDateSignatureMaps(
    expected.day_records_date_signatures,
    actual.day_records_date_signatures,
    "day_records_date_signatures",
  );
  if (dayRecordsSignaturesMismatch) return dayRecordsSignaturesMismatch;
  const notesSignaturesMismatch = compareDateSignatureMaps(
    expected.notes_date_signatures,
    actual.notes_date_signatures,
    "notes_date_signatures",
  );
  if (notesSignaturesMismatch) return notesSignaturesMismatch;
  return null;
}

export function normalizeImportData(jsonString: string): NormalizedImportData {
  // Validate the bounded source before JSON.parse can allocate a much larger
  // object graph. Platform readers also reject oversized files before reading;
  // this second boundary protects every direct/application caller.
  assertDataTransferImportTextSize(jsonString);
  const parsed = JSON.parse(jsonString);
  if (!isRecord(parsed)) {
    throw new Error("Invalid JSON structure");
  }

  const version = asNumber(parsed.version, "version");
  requireInteger(version, "version");
  if (version < MIN_SUPPORTED_EXPORT_SCHEMA_VERSION) {
    throw new Error(`Unsupported old export version: ${version}`);
  }
  if (version > EXPORT_SCHEMA_VERSION) {
    throw new Error(`Unsupported future export version: ${version}`);
  }
  asDate(parsed.exported_at, "exported_at");
  const habitsRaw = ensureArray(parsed.habits, "habits");
  const dayRecordsRaw = ensureArray(parsed.day_records, "day_records");
  const notesRaw = ensureArray(parsed.notes, "notes");
  const settingsRaw = ensureArray(parsed.settings, "settings");

  const normalizedHabits: ExportedHabitRow[] = habitsRaw.map((item, index) => {
    const row = ensureRecord(item, `habits[${index}]`);
    const isArchived = asBoolean(row.isArchived, `habits[${index}].isArchived`);
    const archivedAt = asDate(row.archivedAt, `habits[${index}].archivedAt`, {
      nullable: true,
    });
    const archiveHistory = normalizeImportedArchiveHistory(
      row.archiveHistory,
      `habits[${index}].archiveHistory`,
    );
    return {
      id: asNumber(row.id, `habits[${index}].id`),
      name: asString(row.name, `habits[${index}].name`)!,
      description: asString(row.description, `habits[${index}].description`, {
        nullable: true,
      }),
      descriptionVisible: asBoolean(
        row.descriptionVisible,
        `habits[${index}].descriptionVisible`,
      ),
      repeatType: asRepeatType(row.repeatType, `habits[${index}].repeatType`),
      repeatConfig: asRepeatConfig(
        row.repeatConfig,
        `habits[${index}].repeatConfig`,
      ),
      startDate: asIsoDate(row.startDate, `habits[${index}].startDate`),
      reminderEnabled: asBoolean(
        row.reminderEnabled,
        `habits[${index}].reminderEnabled`,
      ),
      reminderTime: asString(
        row.reminderTime,
        `habits[${index}].reminderTime`,
        {
          nullable: true,
        },
      ),
      displayOrder: asNumber(row.displayOrder, `habits[${index}].displayOrder`),
      isArchived,
      archivedAt,
      archiveHistory,
      createdAt: asDate(row.createdAt, `habits[${index}].createdAt`)!,
      updatedAt: asDate(row.updatedAt, `habits[${index}].updatedAt`)!,
    };
  });

  const normalizedDayRecords: ExportedDayRecordRow[] = dayRecordsRaw.map(
    (item, index) => {
      const row = ensureRecord(item, `day_records[${index}]`);
      return {
        id: asNumber(row.id, `day_records[${index}].id`),
        habitId: asNumber(row.habitId, `day_records[${index}].habitId`),
        date: asIsoDate(row.date, `day_records[${index}].date`),
        status: asDayStatus(row.status, `day_records[${index}].status`),
        createdAt: asDate(row.createdAt, `day_records[${index}].createdAt`)!,
        updatedAt: asDate(row.updatedAt, `day_records[${index}].updatedAt`)!,
      };
    },
  );

  const normalizedNotes: ExportedNoteRow[] = notesRaw.map((item, index) => {
    const row = ensureRecord(item, `notes[${index}]`);
    return {
      id: asNumber(row.id, `notes[${index}].id`),
      habitId: asNumber(row.habitId, `notes[${index}].habitId`),
      date: asIsoDate(row.date, `notes[${index}].date`),
      text: asString(row.text, `notes[${index}].text`)!,
      isFailureReason: asBoolean(
        row.isFailureReason,
        `notes[${index}].isFailureReason`,
      ),
      reasonType: asStatusReasonType(
        row.reasonType,
        `notes[${index}].reasonType`,
      ),
      createdAt: asDate(row.createdAt, `notes[${index}].createdAt`)!,
      updatedAt: asDate(row.updatedAt, `notes[${index}].updatedAt`)!,
    };
  });

  const normalizedSettings: ExportedSettingRow[] = settingsRaw.map(
    (item, index) => {
      const row = ensureRecord(item, `settings[${index}]`);
      const key = asString(row.key, `settings[${index}].key`)!;
      const value = asString(row.value, `settings[${index}].value`)!;
      return { key, value };
    },
  );
  assertUniqueSettingKeys(normalizedSettings);
  const completedSettings = ensureRequiredSettingsRows(normalizedSettings);

  validateNormalizedImportRows({
    habits: normalizedHabits,
    dayRecords: normalizedDayRecords,
    notes: normalizedNotes,
    settings: completedSettings,
  });
  const normalizedIntegrity = parseIntegrity(parsed.integrity);
  const sourceIntegrity = buildIntegrityFromRows({
    habits: normalizedHabits,
    day_records: normalizedDayRecords,
    notes: normalizedNotes,
    settings: normalizedSettings,
  });
  const sourceMismatch = compareIntegrity(normalizedIntegrity, sourceIntegrity);
  if (sourceMismatch) {
    throw new Error(`Import integrity check failed: ${sourceMismatch}`);
  }

  const transferSettings = prepareColorSettingsForTransfer(completedSettings);
  validateNormalizedImportRows({
    habits: normalizedHabits,
    dayRecords: normalizedDayRecords,
    notes: normalizedNotes,
    settings: transferSettings,
  });
  const transferIntegrity = buildIntegrityFromRows({
    habits: normalizedHabits,
    day_records: normalizedDayRecords,
    notes: normalizedNotes,
    settings: transferSettings,
  });

  return {
    version,
    habits: normalizedHabits,
    day_records: normalizedDayRecords,
    notes: normalizedNotes,
    settings: transferSettings,
    integrity: transferIntegrity,
  };
}

export function buildExportJsonFromRows(params: {
  habits: ExportedHabitRow[];
  dayRecords: ExportedDayRecordRow[];
  notes: ExportedNoteRow[];
  settings: ExportedSettingRow[];
  exportedAt: string;
}): string {
  const habitIds = new Set(params.habits.map((habit) => habit.id));
  const exportableSettings = removeOrphanedHabitDescriptionSettings(
    params.settings,
    habitIds,
  );
  assertUniqueSettingKeys(exportableSettings);
  const completedSettings = ensureRequiredSettingsRows(exportableSettings);
  validateNormalizedImportRows({
    habits: params.habits,
    dayRecords: params.dayRecords,
    notes: params.notes,
    settings: completedSettings,
  });
  const allSettings = prepareColorSettingsForTransfer(completedSettings);
  validateNormalizedImportRows({
    habits: params.habits,
    dayRecords: params.dayRecords,
    notes: params.notes,
    settings: allSettings,
  });
  const exportedAt = params.exportedAt;
  if (new Date(exportedAt).toISOString() !== exportedAt) {
    throw new Error("Invalid exported_at");
  }
  const integrity = buildIntegrityFromRows({
    habits: params.habits,
    day_records: params.dayRecords,
    notes: params.notes,
    settings: allSettings,
  });

  const data: ExportData = {
    version: EXPORT_SCHEMA_VERSION,
    exported_at: exportedAt,
    habits: params.habits,
    day_records: params.dayRecords,
    notes: params.notes,
    settings: allSettings,
    integrity,
  };

  return JSON.stringify(data, null, 2);
}

export type ImportPreview = {
  habitsCount: number;
  archivedHabitsCount: number;
  dayRecordsCount: number;
  notesCount: number;
};

export function previewNormalizedImportData(
  data: NormalizedImportData,
): ImportPreview {
  return {
    habitsCount: data.habits.length,
    archivedHabitsCount: data.habits.filter((habit) => habit.isArchived).length,
    dayRecordsCount: data.day_records.length,
    notesCount: data.notes.length,
  };
}

export function previewImportData(jsonString: string): ImportPreview {
  return previewNormalizedImportData(normalizeImportData(jsonString));
}

// Validate the JSON structure before applying any imported rows.
export function validateImportData(jsonString: string): {
  valid: boolean;
  error?: string;
} {
  try {
    normalizeImportData(jsonString);
    return { valid: true };
  } catch (e) {
    return {
      valid: false,
      error: e instanceof Error ? e.message : "Invalid JSON",
    };
  }
}

export function verifyRestoredImportRows(
  data: NormalizedImportData,
  restored: DataTransferRows,
): void {
  const restoredIntegrity = buildIntegrityFromRows({
    habits: restored.habits,
    day_records: restored.dayRecords,
    notes: restored.notes,
    settings: restored.settings,
  });
  const mismatch = compareIntegrity(data.integrity, restoredIntegrity);
  if (mismatch) {
    throw new Error(`Import integrity check failed: ${mismatch}`);
  }
}
