import { create } from "zustand";
import {
  createSettingsMutationSnapshot,
  type ColorSettingsBundle,
  type SettingMutationScope,
} from "@/application/settings/settings-mutation-coordinator";
import {
  applyLoadedSettingsLanguage,
  getResolvedSettingsLanguage,
  readPersistedSettings,
  registerLoadedSettingsPlatformEffects,
  settingsMutationCoordinator,
} from "@/composition/settings";
import { normalizeLanguageCode } from "@/i18n/languages";
import { normalizeHexColor } from "@/theme/colors";
import type {
  ThemeMode,
  ColorScheme,
  CustomColorScheme,
  AppSettings,
  StatisticsBlockId,
  StatisticsPeriod,
  BuiltinColorOverrides,
} from "@/types/settings";
import {
  DEFAULT_STATISTICS_BLOCK_ORDER,
  DEFAULT_SETTINGS,
  SETTINGS_KEYS,
  STATISTICS_BLOCK_ORDER_KEYS,
  isBuiltinColorScheme,
} from "@/types/settings";
import {
  findOverriddenBuiltinColor,
  getCustomColorsFromOptions,
  getSelectionAfterColorRemoval,
  hasDuplicateColorSchemeBase,
  normalizeColorSchemeOption,
  normalizeColorSchemeOptions,
  normalizeBuiltinColorOverrides,
  normalizeSelectedColorScheme,
  reconcileBuiltinColorOverrides,
} from "@/utils/color-scheme-options";
import {
  normalizeStatisticsBlockOrder,
  replaceStatisticsBlockOrder,
} from "@/utils/statistics-block-orders";
import { parsePersistedDescriptionLines } from "@/application/settings/habit-description-lines-setting";
interface SettingsStore extends AppSettings {
  isLoading: boolean;
  error: string | null;
  loadSettings(): Promise<boolean>;
  setTheme(theme: ThemeMode): Promise<boolean>;
  setColorScheme(scheme: ColorScheme): Promise<boolean>;
  addColorScheme(color: string): Promise<boolean>;
  updateColorScheme(
    previousScheme: ColorScheme,
    nextColor: string,
  ): Promise<boolean>;
  removeColorScheme(scheme: ColorScheme): Promise<boolean>;
  setLanguage(language: string): Promise<boolean>;
  setAskFailureReason(enabled: boolean): Promise<boolean>;
  setAskSkipReason(enabled: boolean): Promise<boolean>;
  setSoundEnabled(enabled: boolean): Promise<boolean>;
  setReminderNotificationsEnabled(enabled: boolean): Promise<boolean>;
  setShowArchivedHabitsInStatistics(enabled: boolean): Promise<boolean>;
  setStatisticsBlockOrder(
    period: StatisticsPeriod,
    order: StatisticsBlockId[],
  ): Promise<boolean>;
  clearError(): void;
}
type SettingsLoadMode = "settled" | "committed-import";
type RepairableSettingsKey = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS];
type SettingsRepair = readonly [key: RepairableSettingsKey, value: unknown];
function assertNeverRepairKey(key: never): never {
  throw new Error(`Unhandled settings repair key: ${key}`);
}
function getRepairMutationScopes(
  key: RepairableSettingsKey,
): SettingMutationScope[] {
  switch (key) {
    case SETTINGS_KEYS.THEME:
      return ["theme"];
    case SETTINGS_KEYS.COLOR_SCHEME:
    case SETTINGS_KEYS.COLOR_SCHEME_OPTIONS:
    case SETTINGS_KEYS.BUILTIN_COLOR_OVERRIDES:
    case SETTINGS_KEYS.CUSTOM_COLORS:
      return ["color"];
    case SETTINGS_KEYS.LANGUAGE:
      return ["language"];
    case SETTINGS_KEYS.ASK_FAILURE_REASON:
      return ["askFailureReason"];
    case SETTINGS_KEYS.ASK_SKIP_REASON:
      return ["askSkipReason"];
    case SETTINGS_KEYS.SOUND_ENABLED:
      return ["sound"];
    case SETTINGS_KEYS.REMINDER_NOTIFICATIONS_ENABLED:
      return ["reminderNotifications"];
    case SETTINGS_KEYS.SHOW_ARCHIVED_HABITS_IN_STATISTICS:
      return ["archiveStatistics"];
    case SETTINGS_KEYS.STATISTICS_BLOCK_ORDER_WEEK:
      return ["statisticsOrder:week"];
    case SETTINGS_KEYS.STATISTICS_BLOCK_ORDER_MONTH:
      return ["statisticsOrder:month"];
    case SETTINGS_KEYS.STATISTICS_BLOCK_ORDER_YEAR:
      return ["statisticsOrder:year"];
    case SETTINGS_KEYS.STATISTICS_BLOCK_ORDER:
      // The legacy fallback row is not owned by any one visible period. A
      // week/month/year reorder writes its own key and must not cancel this
      // independent compatibility repair.
      return [];
    default:
      return assertNeverRepairKey(key);
  }
}
function cloneColorSettingsBundle(
  value: Pick<
    AppSettings,
    | "colorScheme"
    | "colorSchemeOptions"
    | "builtinColorOverrides"
    | "customColors"
  >,
): ColorSettingsBundle {
  return {
    colorScheme: value.colorScheme,
    colorSchemeOptions: [...value.colorSchemeOptions],
    builtinColorOverrides: { ...value.builtinColorOverrides },
    customColors: [...value.customColors],
  };
}
function settingErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to save settings";
}
function readSettingFromMap<T>(
  values: ReadonlyMap<string, string>,
  key: string,
  fallback: T,
): T {
  const value = values.get(key);
  if (value == null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
function normalizeThemeMode(value: unknown): ThemeMode {
  return value === "system" || value === "dark" || value === "light"
    ? value
    : DEFAULT_SETTINGS.theme;
}
function normalizeBooleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
function normalizeCustomColors(value: unknown): CustomColorScheme[] {
  if (!Array.isArray(value)) return [];
  const normalized: CustomColorScheme[] = [];
  for (const item of value) {
    const color = normalizeHexColor(item);
    if (color && !normalized.includes(color)) normalized.push(color);
  }
  return normalized;
}
export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ...DEFAULT_SETTINGS,
  isLoading: true,
  error: null,
  async loadSettings(mode = "settled") {
    set({ isLoading: true, error: null });
    try {
      const loadToken =
        mode === "settled"
          ? await settingsMutationCoordinator.captureSettledLoadToken()
          : null;
      const rows = await readPersistedSettings();
      const habitDescriptionLines = parsePersistedDescriptionLines(rows);
      const values = new Map(rows.map((row) => [row.key, row.value]));
      const themeRaw = readSettingFromMap<unknown>(
        values,
        SETTINGS_KEYS.THEME,
        null,
      );
      const theme = normalizeThemeMode(themeRaw);
      const colorSchemeRaw = readSettingFromMap<string>(
        values,
        SETTINGS_KEYS.COLOR_SCHEME,
        DEFAULT_SETTINGS.colorScheme,
      );
      const colorSchemeOptionsRaw = readSettingFromMap<unknown>(
        values,
        SETTINGS_KEYS.COLOR_SCHEME_OPTIONS,
        null,
      );
      const builtinColorOverridesRaw = readSettingFromMap<unknown>(
        values,
        SETTINGS_KEYS.BUILTIN_COLOR_OVERRIDES,
        null,
      );
      const customColorsRaw = readSettingFromMap<unknown>(
        values,
        SETTINGS_KEYS.CUSTOM_COLORS,
        DEFAULT_SETTINGS.customColors,
      );
      const storedLanguage = readSettingFromMap<unknown>(
        values,
        SETTINGS_KEYS.LANGUAGE,
        null,
      );
      const askFailureReasonRaw = readSettingFromMap<unknown>(
        values,
        SETTINGS_KEYS.ASK_FAILURE_REASON,
        null,
      );
      const askSkipReasonRaw = readSettingFromMap<unknown>(
        values,
        SETTINGS_KEYS.ASK_SKIP_REASON,
        null,
      );
      const soundEnabledRaw = readSettingFromMap<unknown>(
        values,
        SETTINGS_KEYS.SOUND_ENABLED,
        null,
      );
      const reminderNotificationsEnabledRaw = readSettingFromMap<unknown>(
        values,
        SETTINGS_KEYS.REMINDER_NOTIFICATIONS_ENABLED,
        null,
      );
      const showArchivedHabitsInStatisticsRaw = readSettingFromMap<unknown>(
        values,
        SETTINGS_KEYS.SHOW_ARCHIVED_HABITS_IN_STATISTICS,
        null,
      );
      const statisticsBlockOrderRaw = readSettingFromMap<unknown>(
        values,
        SETTINGS_KEYS.STATISTICS_BLOCK_ORDER,
        DEFAULT_STATISTICS_BLOCK_ORDER,
      );
      const statisticsBlockOrderByPeriodRaw = {
        week: readSettingFromMap<unknown>(
          values,
          STATISTICS_BLOCK_ORDER_KEYS.week,
          null,
        ),
        month: readSettingFromMap<unknown>(
          values,
          STATISTICS_BLOCK_ORDER_KEYS.month,
          null,
        ),
        year: readSettingFromMap<unknown>(
          values,
          STATISTICS_BLOCK_ORDER_KEYS.year,
          null,
        ),
      };
      const normalizedLanguage = normalizeLanguageCode(
        storedLanguage ?? getResolvedSettingsLanguage(),
      );
      const askFailureReason = normalizeBooleanSetting(
        askFailureReasonRaw,
        DEFAULT_SETTINGS.askFailureReason,
      );
      const askSkipReason = normalizeBooleanSetting(
        askSkipReasonRaw,
        DEFAULT_SETTINGS.askSkipReason,
      );
      const soundEnabled = normalizeBooleanSetting(
        soundEnabledRaw,
        DEFAULT_SETTINGS.soundEnabled,
      );
      const reminderNotificationsEnabled = normalizeBooleanSetting(
        reminderNotificationsEnabledRaw,
        DEFAULT_SETTINGS.reminderNotificationsEnabled,
      );
      const showArchivedHabitsInStatistics = normalizeBooleanSetting(
        showArchivedHabitsInStatisticsRaw,
        DEFAULT_SETTINGS.showArchivedHabitsInStatistics,
      );
      const legacyCustomColors = normalizeCustomColors(customColorsRaw);
      const colorSchemeOptions = normalizeColorSchemeOptions(
        colorSchemeOptionsRaw,
        legacyCustomColors,
      );
      const builtinColorOverrides = reconcileBuiltinColorOverrides(
        normalizeBuiltinColorOverrides(builtinColorOverridesRaw),
        colorSchemeOptions,
      );
      const customColors = getCustomColorsFromOptions(colorSchemeOptions);
      const colorScheme = normalizeSelectedColorScheme(
        colorSchemeRaw,
        colorSchemeOptions,
      );
      const legacyStatisticsBlockOrder = normalizeStatisticsBlockOrder(
        statisticsBlockOrderRaw,
      );
      const statisticsBlockOrders = {
        week: normalizeStatisticsBlockOrder(
          statisticsBlockOrderByPeriodRaw.week,
          legacyStatisticsBlockOrder,
        ),
        month: normalizeStatisticsBlockOrder(
          statisticsBlockOrderByPeriodRaw.month,
          legacyStatisticsBlockOrder,
        ),
        year: normalizeStatisticsBlockOrder(
          statisticsBlockOrderByPeriodRaw.year,
          legacyStatisticsBlockOrder,
        ),
      };
      const repairs: SettingsRepair[] = [];
      if (values.has(SETTINGS_KEYS.THEME) && theme !== themeRaw) {
        repairs.push([SETTINGS_KEYS.THEME, theme]);
      }
      if (colorScheme !== colorSchemeRaw) {
        repairs.push([SETTINGS_KEYS.COLOR_SCHEME, colorScheme]);
      }
      if (
        JSON.stringify(colorSchemeOptions) !==
        JSON.stringify(colorSchemeOptionsRaw)
      ) {
        repairs.push([SETTINGS_KEYS.COLOR_SCHEME_OPTIONS, colorSchemeOptions]);
      }
      if (
        JSON.stringify(builtinColorOverrides) !==
        JSON.stringify(builtinColorOverridesRaw)
      ) {
        repairs.push([
          SETTINGS_KEYS.BUILTIN_COLOR_OVERRIDES,
          builtinColorOverrides,
        ]);
      }
      if (storedLanguage == null || storedLanguage !== normalizedLanguage) {
        repairs.push([SETTINGS_KEYS.LANGUAGE, normalizedLanguage]);
      }
      for (const [key, rawValue, normalizedValue] of [
        [
          SETTINGS_KEYS.ASK_FAILURE_REASON,
          askFailureReasonRaw,
          askFailureReason,
        ],
        [SETTINGS_KEYS.ASK_SKIP_REASON, askSkipReasonRaw, askSkipReason],
        [SETTINGS_KEYS.SOUND_ENABLED, soundEnabledRaw, soundEnabled],
        [
          SETTINGS_KEYS.REMINDER_NOTIFICATIONS_ENABLED,
          reminderNotificationsEnabledRaw,
          reminderNotificationsEnabled,
        ],
        [
          SETTINGS_KEYS.SHOW_ARCHIVED_HABITS_IN_STATISTICS,
          showArchivedHabitsInStatisticsRaw,
          showArchivedHabitsInStatistics,
        ],
      ] as const) {
        if (values.has(key) && rawValue !== normalizedValue) {
          repairs.push([key, normalizedValue]);
        }
      }
      if (JSON.stringify(customColors) !== JSON.stringify(customColorsRaw)) {
        repairs.push([SETTINGS_KEYS.CUSTOM_COLORS, customColors]);
      }
      if (
        JSON.stringify(statisticsBlockOrderRaw) !==
        JSON.stringify(legacyStatisticsBlockOrder)
      ) {
        repairs.push([
          SETTINGS_KEYS.STATISTICS_BLOCK_ORDER,
          legacyStatisticsBlockOrder,
        ]);
      }
      for (const period of ["week", "month", "year"] as const) {
        if (
          JSON.stringify(statisticsBlockOrderByPeriodRaw[period]) !==
          JSON.stringify(statisticsBlockOrders[period])
        ) {
          repairs.push([
            STATISTICS_BLOCK_ORDER_KEYS[period],
            statisticsBlockOrders[period],
          ]);
        }
      }
      // Language changes local in-memory resources and must be ready before the
      // first loaded screen is published. Database repairs and native reminder
      // setup do not affect that first paint, so they continue in the background.
      if (
        loadToken != null &&
        !settingsMutationCoordinator.isLoadTokenCurrent(loadToken)
      ) {
        set({ isLoading: false });
        return false;
      }
      await applyLoadedSettingsLanguage(normalizedLanguage);
      const loadedSettings: AppSettings = {
        theme,
        colorScheme,
        colorSchemeOptions,
        builtinColorOverrides,
        customColors,
        language: normalizedLanguage,
        askFailureReason,
        askSkipReason,
        soundEnabled,
        reminderNotificationsEnabled,
        showArchivedHabitsInStatistics,
        statisticsBlockOrders,
      };
      if (
        !settingsMutationCoordinator.replaceConfirmedSnapshot(
          createSettingsMutationSnapshot(loadedSettings, habitDescriptionLines),
          loadToken ?? undefined,
        )
      ) {
        // A local mutation appeared while language resources were changing.
        // Never publish the older database snapshot over that newer intent.
        await applyLoadedSettingsLanguage(get().language);
        set({ isLoading: false });
        return false;
      }
      set({
        ...loadedSettings,
        isLoading: false,
        error: null,
      });
      // A reload/import can change the language without changing the reminder
      // master switch or the habit schedule signature. Refresh the already
      // scheduled native notification text through the global tracked queue.
      registerLoadedSettingsPlatformEffects();
      if (mode === "settled" && repairs.length > 0) {
        // These values are already normalized in memory. Let the first screen
        // enqueue its essential reads before a one-time upgrade repair writes
        // back old or missing settings.
        void settingsMutationCoordinator
          .scheduleRepair(
            repairs.map((entry) => ({
              entry,
              scopes: getRepairMutationScopes(entry[0]),
            })),
          )
          .catch((error) => {
            set({ error: settingErrorMessage(error) });
          });
      }
      return true;
    } catch (e) {
      set({
        isLoading: false,
        error: e instanceof Error ? e.message : "Failed to load settings",
      });
      return false;
    }
  },
  async setTheme(theme) {
    const scope = "theme" as const;
    if (theme === get().theme) return true;
    const submission = settingsMutationCoordinator.submit({
      scope,
      value: theme,
    });
    set({ theme, error: null });
    const result = await submission.completion;
    if (result.status === "superseded") return true;
    if (result.status === "committed") {
      return true;
    }
    if (settingsMutationCoordinator.isLatest(submission)) {
      set({
        theme: result.confirmedValue,
        error: settingErrorMessage(result.error),
      });
    }
    return false;
  },
  async setColorScheme(scheme) {
    const scope = "color" as const;
    const current = get();
    const normalized = normalizeSelectedColorScheme(
      scheme,
      current.colorSchemeOptions,
    );
    if (normalized === current.colorScheme) return true;
    const nextColorSettings = cloneColorSettingsBundle({
      ...current,
      colorScheme: normalized,
    });
    const submission = settingsMutationCoordinator.submit({
      scope,
      value: nextColorSettings,
      operation: "select",
    });
    // Selection changes only one visible field. Keep the option arrays stable
    // so their subscribers and memoized rows do not rerender needlessly, and
    // persist only the selected key; edits to the option collection still use
    // the full atomic bundle path.
    set({ colorScheme: normalized, error: null });
    const result = await submission.completion;
    if (result.status === "superseded") return true;
    if (result.status === "committed") {
      return true;
    }
    if (settingsMutationCoordinator.isLatest(submission)) {
      set({
        ...cloneColorSettingsBundle(result.confirmedValue),
        error: settingErrorMessage(result.error),
      });
    }
    return false;
  },
  async addColorScheme(color) {
    const scope = "color" as const;
    const normalized = normalizeHexColor(color);
    const current = get();
    if (
      !normalized ||
      hasDuplicateColorSchemeBase(current.colorSchemeOptions, normalized)
    ) {
      return false;
    }
    const colorSchemeOptions = [normalized, ...current.colorSchemeOptions];
    const customColors = getCustomColorsFromOptions(colorSchemeOptions);
    const nextColorSettings = cloneColorSettingsBundle({
      colorSchemeOptions,
      builtinColorOverrides: current.builtinColorOverrides,
      customColors,
      colorScheme: normalized,
    });
    const submission = settingsMutationCoordinator.submit({
      scope,
      value: nextColorSettings,
      operation: "replace-bundle",
    });
    set({ ...nextColorSettings, error: null });
    const result = await submission.completion;
    if (result.status === "superseded") return true;
    if (result.status === "committed") {
      return true;
    }
    if (settingsMutationCoordinator.isLatest(submission)) {
      set({
        ...cloneColorSettingsBundle(result.confirmedValue),
        error: settingErrorMessage(result.error),
      });
    }
    return false;
  },
  async updateColorScheme(previousScheme, nextColor) {
    const scope = "color" as const;
    const previous = normalizeColorSchemeOption(previousScheme);
    const next = normalizeHexColor(nextColor);
    if (!previous || !next) return false;
    const previousState = get();
    const currentOptions = previousState.colorSchemeOptions;
    const previousIndex = currentOptions.indexOf(previous);
    if (previousIndex < 0) return false;
    if (hasDuplicateColorSchemeBase(currentOptions, next, previousIndex)) {
      return false;
    }
    const colorSchemeOptions = [...currentOptions];
    colorSchemeOptions[previousIndex] = next;
    const builtinColorOverrides: BuiltinColorOverrides = {
      ...previousState.builtinColorOverrides,
    };
    const overriddenBuiltin = isBuiltinColorScheme(previous)
      ? previous
      : findOverriddenBuiltinColor(
          previousState.builtinColorOverrides,
          previous,
        );
    if (overriddenBuiltin) builtinColorOverrides[overriddenBuiltin] = next;
    const customColors = getCustomColorsFromOptions(colorSchemeOptions);
    const colorScheme = next;
    const nextColorSettings = cloneColorSettingsBundle({
      colorSchemeOptions,
      builtinColorOverrides,
      customColors,
      colorScheme,
    });
    const submission = settingsMutationCoordinator.submit({
      scope,
      value: nextColorSettings,
      operation: "replace-bundle",
    });
    set({ ...nextColorSettings, error: null });
    const result = await submission.completion;
    if (result.status === "superseded") return true;
    if (result.status === "committed") {
      return true;
    }
    if (settingsMutationCoordinator.isLatest(submission)) {
      set({
        ...cloneColorSettingsBundle(result.confirmedValue),
        error: settingErrorMessage(result.error),
      });
    }
    return false;
  },
  async removeColorScheme(scheme) {
    const scope = "color" as const;
    const normalized = normalizeColorSchemeOption(scheme);
    const current = get();
    if (!normalized || current.colorSchemeOptions.length <= 1) return false;
    const removedIndex = current.colorSchemeOptions.indexOf(normalized);
    if (removedIndex < 0) return false;
    const colorScheme = getSelectionAfterColorRemoval(
      current.colorSchemeOptions,
      removedIndex,
      current.colorScheme,
    );
    const colorSchemeOptions = current.colorSchemeOptions.filter(
      (_, index) => index !== removedIndex,
    );
    const builtinColorOverrides: BuiltinColorOverrides = {
      ...current.builtinColorOverrides,
    };
    const removedOverride = findOverriddenBuiltinColor(
      current.builtinColorOverrides,
      normalized,
    );
    if (removedOverride) delete builtinColorOverrides[removedOverride];
    const customColors = getCustomColorsFromOptions(colorSchemeOptions);
    const nextColorSettings = cloneColorSettingsBundle({
      colorSchemeOptions,
      builtinColorOverrides,
      customColors,
      colorScheme,
    });
    const submission = settingsMutationCoordinator.submit({
      scope,
      value: nextColorSettings,
      operation: "replace-bundle",
    });
    set({ ...nextColorSettings, error: null });
    const result = await submission.completion;
    if (result.status === "superseded") return true;
    if (result.status === "committed") {
      return true;
    }
    if (settingsMutationCoordinator.isLatest(submission)) {
      set({
        ...cloneColorSettingsBundle(result.confirmedValue),
        error: settingErrorMessage(result.error),
      });
    }
    return false;
  },
  async setLanguage(language) {
    const scope = "language" as const;
    const normalizedLanguage = normalizeLanguageCode(language);
    if (normalizedLanguage === get().language) return true;
    const submission = settingsMutationCoordinator.submit({
      scope,
      value: normalizedLanguage,
    });
    // Focused scenes render through an immutable, prewarmed i18n clone. The
    // durable write is independent from background/global i18n reconciliation.
    set({ language: normalizedLanguage, error: null });
    const result = await submission.completion;
    if (result.status === "superseded") return true;
    if (result.status === "committed") {
      return true;
    }
    if (settingsMutationCoordinator.isLatest(submission)) {
      set({
        language: result.confirmedValue,
        error: settingErrorMessage(result.error),
      });
    }
    return false;
  },
  async setAskFailureReason(enabled) {
    const scope = "askFailureReason" as const;
    const submission = settingsMutationCoordinator.submit({
      scope,
      value: enabled,
    });
    set({ askFailureReason: enabled, error: null });
    const result = await submission.completion;
    if (result.status !== "failed") return true;
    if (settingsMutationCoordinator.isLatest(submission)) {
      set({
        askFailureReason: result.confirmedValue,
        error: settingErrorMessage(result.error),
      });
    }
    return false;
  },
  async setAskSkipReason(enabled) {
    const scope = "askSkipReason" as const;
    const submission = settingsMutationCoordinator.submit({
      scope,
      value: enabled,
    });
    set({ askSkipReason: enabled, error: null });
    const result = await submission.completion;
    if (result.status !== "failed") return true;
    if (settingsMutationCoordinator.isLatest(submission)) {
      set({
        askSkipReason: result.confirmedValue,
        error: settingErrorMessage(result.error),
      });
    }
    return false;
  },
  async setSoundEnabled(enabled) {
    const scope = "sound" as const;
    const submission = settingsMutationCoordinator.submit({
      scope,
      value: enabled,
    });
    set({ soundEnabled: enabled, error: null });
    const result = await submission.completion;
    if (result.status !== "failed") return true;
    if (settingsMutationCoordinator.isLatest(submission)) {
      set({
        soundEnabled: result.confirmedValue,
        error: settingErrorMessage(result.error),
      });
    }
    return false;
  },
  async setReminderNotificationsEnabled(enabled) {
    const scope = "reminderNotifications" as const;
    const submission = settingsMutationCoordinator.submit({
      scope,
      value: enabled,
    });
    set({ reminderNotificationsEnabled: enabled, error: null });
    const result = await submission.completion;
    if (result.status !== "failed") return true;
    if (settingsMutationCoordinator.isLatest(submission)) {
      set({
        reminderNotificationsEnabled: result.confirmedValue,
        error: settingErrorMessage(result.error),
      });
    }
    return false;
  },
  async setShowArchivedHabitsInStatistics(enabled) {
    const scope = "archiveStatistics" as const;
    const submission = settingsMutationCoordinator.submit({
      scope,
      value: enabled,
    });
    set({ showArchivedHabitsInStatistics: enabled, error: null });
    const result = await submission.completion;
    if (result.status !== "failed") return true;
    if (settingsMutationCoordinator.isLatest(submission)) {
      set({
        showArchivedHabitsInStatistics: result.confirmedValue,
        error: settingErrorMessage(result.error),
      });
    }
    return false;
  },
  async setStatisticsBlockOrder(period, order) {
    const scope = `statisticsOrder:${period}` as const;
    const normalized = normalizeStatisticsBlockOrder(order);
    const currentOrders = get().statisticsBlockOrders;
    const nextOrders = replaceStatisticsBlockOrder(
      currentOrders,
      period,
      normalized,
    );
    if (nextOrders === currentOrders) return true;
    const submission = settingsMutationCoordinator.submit({
      scope,
      value: normalized,
    });
    set({ statisticsBlockOrders: nextOrders, error: null });
    const result = await submission.completion;
    if (result.status !== "failed") return true;
    if (settingsMutationCoordinator.isLatest(submission)) {
      set((state) => ({
        statisticsBlockOrders: replaceStatisticsBlockOrder(
          state.statisticsBlockOrders,
          period,
          result.confirmedValue,
        ),
        error: settingErrorMessage(result.error),
      }));
    }
    return false;
  },
  clearError() {
    set({ error: null });
  },
}));
const settingsActions = useSettingsStore.getState();
const loadSettingsSnapshot = settingsActions.loadSettings as (
  mode?: SettingsLoadMode,
) => Promise<boolean>;
const loadSettingsForUi = (): Promise<boolean> =>
  loadSettingsSnapshot("settled");
/**
 * Publishes the database generation committed by import without waiting for
 * post-cutoff settings commands. Those commands are still held by the import
 * fence and are discarded only after this publication succeeds.
 */
export function loadSettingsFromCommittedImport(): Promise<boolean> {
  return loadSettingsSnapshot("committed-import");
}
useSettingsStore.setState({
  loadSettings: loadSettingsForUi,
});
