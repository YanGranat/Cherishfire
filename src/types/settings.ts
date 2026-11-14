export type ThemeMode = "system" | "dark" | "light";
export type StatisticsBlockId = "summary" | "heatmap" | "bar" | "habit";
export type StatisticsPeriod = "week" | "month" | "year";
export type StatisticsBlockOrders = Record<
  StatisticsPeriod,
  StatisticsBlockId[]
>;

export const DEFAULT_STATISTICS_BLOCK_ORDER: StatisticsBlockId[] = [
  "summary",
  "heatmap",
  "bar",
  "habit",
];
export const BUILTIN_COLOR_SCHEMES = [
  "orange",
  "sunset",
  "amber",
  "citron",
  "pistachio",
  "lime",
  "olive",
  "green",
  "emerald",
  "mint",
  "lagoon",
  "teal",
  "aqua",
  "cyan",
  "blue",
  "royal",
  "cobalt",
  "navy",
  "indigo",
  "lavender",
  "amethyst",
  "purple",
  "orchid",
  "pink",
  "berry",
  "slate",
] as const;

export type BuiltinColorScheme = (typeof BUILTIN_COLOR_SCHEMES)[number];
export type CustomColorScheme = `#${string}`;
export type ColorScheme = BuiltinColorScheme | CustomColorScheme;
export type BuiltinColorOverrides = Partial<
  Record<BuiltinColorScheme, CustomColorScheme>
>;

const BUILTIN_COLOR_SCHEME_SET = new Set<string>(BUILTIN_COLOR_SCHEMES);

export function isBuiltinColorScheme(
  value: unknown
): value is BuiltinColorScheme {
  return typeof value === "string" && BUILTIN_COLOR_SCHEME_SET.has(value);
}

export interface AppSettings {
  theme: ThemeMode;
  colorScheme: ColorScheme;
  colorSchemeOptions: ColorScheme[];
  builtinColorOverrides: BuiltinColorOverrides;
  // Compatibility projection for the frozen export-v5 settings contract.
  customColors: CustomColorScheme[];
  language: string; // Supported locale code.
  askFailureReason: boolean;
  askSkipReason: boolean;
  soundEnabled: boolean;
  reminderNotificationsEnabled: boolean;
  showArchivedHabitsInStatistics: boolean;
  statisticsBlockOrders: StatisticsBlockOrders;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  colorScheme: "orange",
  colorSchemeOptions: [...BUILTIN_COLOR_SCHEMES],
  builtinColorOverrides: {},
  customColors: [],
  language: "en",
  askFailureReason: true,
  askSkipReason: true,
  soundEnabled: true,
  reminderNotificationsEnabled: true,
  showArchivedHabitsInStatistics: true,
  statisticsBlockOrders: {
    week: [...DEFAULT_STATISTICS_BLOCK_ORDER],
    month: [...DEFAULT_STATISTICS_BLOCK_ORDER],
    year: [...DEFAULT_STATISTICS_BLOCK_ORDER],
  },
};

// Settings keys stored in the DB settings table
export const SETTINGS_KEYS = {
  THEME: "theme",
  COLOR_SCHEME: "color_scheme",
  COLOR_SCHEME_OPTIONS: "color_scheme_options",
  BUILTIN_COLOR_OVERRIDES: "color_scheme_builtin_overrides",
  CUSTOM_COLORS: "custom_colors",
  LANGUAGE: "language",
  ASK_FAILURE_REASON: "ask_failure_reason",
  ASK_SKIP_REASON: "ask_skip_reason",
  SOUND_ENABLED: "sound_enabled",
  REMINDER_NOTIFICATIONS_ENABLED: "reminder_notifications_enabled",
  SHOW_ARCHIVED_HABITS_IN_STATISTICS: "show_archived_habits_in_statistics",
  // Kept as the export-v5 compatibility fallback for older app builds.
  STATISTICS_BLOCK_ORDER: "statistics_block_order",
  STATISTICS_BLOCK_ORDER_WEEK: "statistics_block_order_week",
  STATISTICS_BLOCK_ORDER_MONTH: "statistics_block_order_month",
  STATISTICS_BLOCK_ORDER_YEAR: "statistics_block_order_year",
} as const;

export const STATISTICS_BLOCK_ORDER_KEYS = {
  week: SETTINGS_KEYS.STATISTICS_BLOCK_ORDER_WEEK,
  month: SETTINGS_KEYS.STATISTICS_BLOCK_ORDER_MONTH,
  year: SETTINGS_KEYS.STATISTICS_BLOCK_ORDER_YEAR,
} satisfies Record<StatisticsPeriod, string>;
