import { readFileSync } from "node:fs";
import Module from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";

type DependencyList = readonly unknown[] | undefined;

export interface AuditElement {
  key: string | number | null;
  props: Record<string, unknown> & { children?: unknown };
  type: unknown;
}

interface MemoType {
  readonly auditKind: "memo";
  readonly render: (...args: never[]) => unknown;
}

interface CommonJsModuleInstance extends NodeModule {
  _compile(source: string, fileName: string): void;
}

interface CommonJsModuleConstructor {
  new (id?: string, parent?: NodeModule): CommonJsModuleInstance;
  _load(request: string, parent: NodeModule | null, isMain: boolean): unknown;
  _nodeModulePaths(from: string): string[];
}

interface HookSlot {
  dependencies?: DependencyList;
  value: unknown;
}

function dependenciesChanged(
  previous: DependencyList,
  next: DependencyList,
): boolean {
  return (
    previous == null ||
    next == null ||
    previous.length !== next.length ||
    next.some((value, index) => !Object.is(value, previous[index]))
  );
}

class ShallowReactRuntime {
  private readonly slots: HookSlot[] = [];
  private hookIndex = 0;

  readonly Fragment = Symbol("AuditFragment");

  readonly createElement = (
    type: unknown,
    inputProps: Record<string, unknown> | null,
    ...children: unknown[]
  ): AuditElement => {
    const props = { ...(inputProps ?? {}) };
    const key = (props.key as string | number | null | undefined) ?? null;
    delete props.key;
    if (children.length === 1) props.children = children[0];
    else if (children.length > 1) props.children = children;
    return { type, key, props };
  };

  readonly memo = <T extends (...args: never[]) => unknown>(
    render: T,
  ): MemoType => Object.freeze({ auditKind: "memo", render });

  readonly useRef = <T>(initial: T): { current: T } => {
    const index = this.hookIndex++;
    if (!this.slots[index]) this.slots[index] = { value: { current: initial } };
    return this.slots[index].value as { current: T };
  };

  readonly useMemo = <T>(create: () => T, dependencies: DependencyList): T => {
    const index = this.hookIndex++;
    const slot = this.slots[index];
    if (!slot || dependenciesChanged(slot.dependencies, dependencies)) {
      const next = { value: create(), dependencies };
      this.slots[index] = next;
      return next.value as T;
    }
    return slot.value as T;
  };

  readonly useCallback = <T extends (...args: never[]) => unknown>(
    callback: T,
    dependencies: DependencyList,
  ): T => this.useMemo(() => callback, dependencies);

  readonly useEffect = () => undefined;
  readonly useLayoutEffect = () => undefined;

  render<T>(component: () => T): T {
    this.hookIndex = 0;
    return component();
  }

  getReactMock(): Record<string, unknown> {
    return {
      Fragment: this.Fragment,
      createElement: this.createElement,
      memo: this.memo,
      useCallback: this.useCallback,
      useEffect: this.useEffect,
      useLayoutEffect: this.useLayoutEffect,
      useMemo: this.useMemo,
      useRef: this.useRef,
    };
  }
}

function transpileTsx(fileName: string, source: string): string {
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
    },
    fileName,
    reportDiagnostics: true,
  });
  const diagnostics = transpiled.diagnostics?.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (diagnostics?.length) {
    throw new Error(
      `Statistics render audit transpile failed: ${diagnostics
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        )
        .join("; ")}`,
    );
  }
  return transpiled.outputText;
}

function compileTsx(
  fileName: string,
  source: string,
  mocks: ReadonlyMap<string, unknown>,
): Record<string, unknown> {
  const outputText = transpileTsx(fileName, source);
  const ModuleInternals = Module as unknown as CommonJsModuleConstructor;
  const originalLoad = ModuleInternals._load;
  const compiledModule = new ModuleInternals(fileName);
  compiledModule.filename = fileName;
  compiledModule.paths = ModuleInternals._nodeModulePaths(dirname(fileName));
  ModuleInternals._load = (request, parent, isMain) => {
    if (mocks.has(request)) return mocks.get(request);
    return originalLoad(request, parent, isMain);
  };
  try {
    compiledModule._compile(outputText, fileName);
  } finally {
    ModuleInternals._load = originalLoad;
  }
  return compiledModule.exports as Record<string, unknown>;
}

function transformSource(
  fileName: string,
  exportName: string,
  transform?: (source: string) => string,
): string {
  const original = readFileSync(fileName, "utf8");
  const transformed = transform ? transform(original) : original;
  return `${transformed}\nexport { ${exportName} };\n`;
}

function createStats(marker: string) {
  return {
    marker,
    isEmpty: false,
    emptyReason: null,
    periodProgress: 50,
    perfectDays: 1,
    heatmapData: [{ date: "2026-11-13" }],
    barChartData: [],
    habitBreakdown: [
      {
        habitId: 1,
        name: marker,
        completionRate: 50,
        currentStreak: 2,
      },
    ],
  };
}

export interface StatisticsScreenAuditState {
  effectiveMode?: "light" | "dark";
  error?: string | null;
  isLoading?: boolean;
  language?: string;
  period?: "week" | "month" | "year";
  periodBaseCivilDate?: string;
  periodOffset?: number;
  periodRange?: {
    startDay: number;
    endDay: number;
    startDate: string;
    endDate: string;
  };
  retainedScene?: {
    period: "week" | "month" | "year";
    presentationRevision: number;
    stats: ReturnType<typeof createStats>;
    todayStr: string;
  } | null;
  sceneActive?: boolean;
  statisticsBlockOrders?: Record<string, readonly string[]>;
}

export interface StatisticsScreenAuditHarness {
  readonly periodSceneType: unknown;
  render(next?: StatisticsScreenAuditState): AuditElement;
}

function createScreenMocks(
  runtime: ShallowReactRuntime,
  readState: () => Required<StatisticsScreenAuditState>,
): Map<string, unknown> {
  const reactMock = runtime.getReactMock();
  const marker = (name: string) => Object.freeze({ auditComponent: name });
  const noOp = () => undefined;
  const settingsState = () => ({
    setStatisticsBlockOrder: noOp,
    statisticsBlockOrders: readState().statisticsBlockOrders,
  });
  const useSettingsStore = (
    selector: (state: ReturnType<typeof settingsState>) => unknown,
  ) => selector(settingsState());
  const jsx = (
    type: unknown,
    props: Record<string, unknown> | null,
    key?: string | number,
  ) => runtime.createElement(type, key == null ? props : { ...props, key });
  return new Map<string, unknown>([
    ["react", { __esModule: true, default: reactMock, ...reactMock }],
    [
      "nativewind/jsx-runtime",
      {
        Fragment: runtime.Fragment,
        jsx,
        jsxs: jsx,
      },
    ],
    [
      "react-native",
      {
        ActivityIndicator: marker("ActivityIndicator"),
        Pressable: marker("Pressable"),
        StyleSheet: { create: <T>(styles: T) => styles },
        Text: marker("Text"),
        View: marker("View"),
      },
    ],
    [
      "@expo/vector-icons/MaterialIcons",
      { __esModule: true, default: marker("MaterialIcons") },
    ],
    ["@react-navigation/native", { useFocusEffect: noOp }],
    ["expo-router", { useRouter: () => ({ back: noOp }) }],
    ["react-i18next", { useTranslation: () => ({ t: (key: string) => key }) }],
    ["@/components/layout/Header", { Header: marker("Header") }],
    [
      "@/components/layout/ScreenWrapper",
      { ScreenWrapper: marker("ScreenWrapper") },
    ],
    [
      "@/features/statistics/components/BarChart",
      { BarChart: marker("BarChart") },
    ],
    [
      "@/features/statistics/components/HabitBreakdown",
      { HabitBreakdown: marker("HabitBreakdown") },
    ],
    [
      "@/features/statistics/components/Heatmap",
      { Heatmap: marker("Heatmap") },
    ],
    [
      "@/features/statistics/components/PeriodSelector",
      { PeriodSelector: marker("PeriodSelector") },
    ],
    [
      "@/features/statistics/components/ReorderableStatisticsBlocks",
      {
        ReorderableStatisticsBlocks: marker("ReorderableStatisticsBlocks"),
      },
    ],
    [
      "@/features/statistics/components/SummaryCards",
      { SummaryCards: marker("SummaryCards") },
    ],
    [
      "@/features/statistics/hooks/useStatistics",
      {
        useStatistics: () => {
          const state = readState();
          return {
            period: state.period,
            setPeriod: noOp,
            periodBaseCivilDate: state.periodBaseCivilDate,
            periodOffset: state.periodOffset,
            periodRange: state.periodRange,
            canNavigatePrevious: true,
            canNavigateNext: false,
            resolveNavigationTarget: () => ({
              period: state.period,
              periodOffset: 0,
            }),
            navigatePeriod: noOp,
            stats: state.retainedScene?.stats ?? createStats("empty-request"),
            presentationRevision:
              state.retainedScene?.presentationRevision ?? 0,
            statsCacheHit: false,
            statsIncludeArchived: false,
            retainedScene: state.retainedScene,
            sceneActive: state.sceneActive,
            isLoading: state.isLoading,
            error: state.error,
            reload: noOp,
          };
        },
      },
    ],
    ["@/stores/settings-store", { useSettingsStore }],
    [
      "@/components/ScreenPreferencesBoundary",
      {
        useVisualLanguage: () => readState().language,
        useVisualEffectiveMode: () => readState().effectiveMode,
      },
    ],
    [
      "@/features/settings/components/SettingsErrorBanner",
      {
        SettingsErrorBanner: marker("SettingsErrorBanner"),
      },
    ],
    [
      "@/theme/colors",
      {
        darkTheme: { primary: "dark-primary", muted: "dark-muted" },
        lightTheme: {
          border: "light-border",
          muted: "light-muted",
          primary: "light-primary",
          surfaceElevated: "light-surface",
        },
      },
    ],
    [
      "@/types/settings",
      {
        DEFAULT_STATISTICS_BLOCK_ORDER: ["summary", "heatmap", "bar", "habit"],
      },
    ],
    [
      "@/utils/statistics-block-orders",
      {
        normalizeStatisticsBlockOrder: (order: readonly string[]) => order,
      },
    ],
    [
      "@/utils/date",
      {
        getMonthLabels: () => [],
        getWeekdayLabels: () => [],
        getWeekLabels: () => [],
      },
    ],
    ["@/application/statistics/statistics-session", {}],
  ]);
}

function normalizeScreenState(
  state: StatisticsScreenAuditState,
): Required<StatisticsScreenAuditState> {
  const stats = createStats("retained");
  return {
    effectiveMode: state.effectiveMode ?? "light",
    error: state.error ?? null,
    isLoading: state.isLoading ?? false,
    language: state.language ?? "en",
    period: state.period ?? "week",
    periodBaseCivilDate: state.periodBaseCivilDate ?? "2026-11-13",
    periodOffset: state.periodOffset ?? 0,
    periodRange: state.periodRange ?? {
      startDay: 0,
      endDay: 6,
      startDate: "2026-11-09",
      endDate: "2026-11-15",
    },
    retainedScene:
      state.retainedScene === undefined
        ? {
            period: "week",
            presentationRevision: 7,
            stats,
            todayStr: "2026-11-13",
          }
        : state.retainedScene,
    sceneActive: state.sceneActive ?? true,
    statisticsBlockOrders: state.statisticsBlockOrders ?? {
      week: ["summary", "heatmap", "bar", "habit"],
      month: ["summary", "heatmap", "habit", "bar"],
      year: ["summary", "heatmap", "habit", "bar"],
    },
  };
}

export function validateStatisticsScreenAuditTransform(
  transform?: (source: string) => string,
): void {
  const fileName = resolve(import.meta.dirname, "../../app/statistics.tsx");
  transpileTsx(
    fileName,
    transformSource(fileName, "StatisticsPeriodScene", transform),
  );
}

export function loadStatisticsScreenForAudit(
  initial: StatisticsScreenAuditState = {},
  transform?: (source: string) => string,
): StatisticsScreenAuditHarness {
  const fileName = resolve(import.meta.dirname, "../../app/statistics.tsx");
  const runtime = new ShallowReactRuntime();
  let state = normalizeScreenState(initial);
  const exports = compileTsx(
    fileName,
    transformSource(fileName, "StatisticsPeriodScene", transform),
    createScreenMocks(runtime, () => state),
  );
  const component = exports.default;
  if (typeof component !== "function") {
    throw new Error("Compiled Statistics screen has no default component");
  }
  const periodSceneType = exports.StatisticsPeriodScene;
  if (periodSceneType == null) {
    throw new Error("Compiled Statistics screen has no period scene export");
  }
  return {
    periodSceneType,
    render(next = {}) {
      state = normalizeScreenState({ ...state, ...next });
      return runtime.render(component as () => AuditElement);
    },
  };
}

export interface HabitBreakdownAuditHarness {
  readonly itemType: unknown;
  render(
    habits: readonly {
      habitId: number;
      name: string;
      completionRate: number;
      currentStreak: number;
    }[],
    appearance?: { colorScheme?: string; effectiveMode?: "light" | "dark" },
  ): AuditElement;
}

export function validateHabitBreakdownAuditTransform(
  transform?: (source: string) => string,
): void {
  const fileName = resolve(
    import.meta.dirname,
    "../../src/features/statistics/components/HabitBreakdown.tsx",
  );
  transpileTsx(
    fileName,
    transformSource(fileName, "HabitBreakdownItem", transform),
  );
}

export function loadHabitBreakdownForAudit(
  transform?: (source: string) => string,
): HabitBreakdownAuditHarness {
  const fileName = resolve(
    import.meta.dirname,
    "../../src/features/statistics/components/HabitBreakdown.tsx",
  );
  const runtime = new ShallowReactRuntime();
  let colorScheme = "amber";
  let effectiveMode: "light" | "dark" = "light";
  const reactMock = runtime.getReactMock();
  const marker = (name: string) => Object.freeze({ auditComponent: name });
  const noOp = () => undefined;
  const router = { push: noOp };
  const runNavigationIntent = () => ({ status: "dispatched" });
  const jsx = (
    type: unknown,
    props: Record<string, unknown> | null,
    key?: string | number,
  ) => runtime.createElement(type, key == null ? props : { ...props, key });
  const mocks = new Map<string, unknown>([
    ["react", { __esModule: true, default: reactMock, ...reactMock }],
    [
      "nativewind/jsx-runtime",
      {
        Fragment: runtime.Fragment,
        jsx,
        jsxs: jsx,
      },
    ],
    [
      "react-native",
      {
        Pressable: marker("Pressable"),
        Text: marker("Text"),
        View: marker("View"),
      },
    ],
    ["expo-router", { useRouter: () => router }],
    ["react-i18next", { useTranslation: () => ({ t: (key: string) => key }) }],
    [
      "@expo/vector-icons/MaterialIcons",
      { __esModule: true, default: marker("MaterialIcons") },
    ],
    [
      "@expo/vector-icons/Octicons",
      { __esModule: true, default: marker("Octicons") },
    ],
    ["@/components/ui/Icon", { Icon: marker("Icon") }],
    [
      "@/theme/colors",
      {
        getAccentScheme: (scheme: string) => ({ base: `accent-${scheme}` }),
        darkTheme: { muted: "dark-muted" },
        lightTheme: {
          border: "light-border",
          divider: "light-divider",
          muted: "light-muted",
          surface: "light-surface",
          surfaceElevated: "light-elevated",
        },
      },
    ],
    [
      "@/components/ScreenPreferencesBoundary",
      {
        useVisualColorScheme: () => colorScheme,
        useVisualEffectiveMode: () => effectiveMode,
      },
    ],
    ["@/theme/tokens", { sizes: { progressBarHeight: 3 } }],
    [
      "@/hooks/useNavigationIntentGate",
      {
        useNavigationIntentGate: () => runNavigationIntent,
      },
    ],
  ]);
  const exports = compileTsx(
    fileName,
    transformSource(fileName, "HabitBreakdownItem", transform),
    mocks,
  );
  const component = exports.HabitBreakdown;
  if (typeof component !== "function") {
    throw new Error("Compiled HabitBreakdown has no component export");
  }
  const itemType = exports.HabitBreakdownItem;
  if (itemType == null) {
    throw new Error("Compiled HabitBreakdown has no item export");
  }
  return {
    itemType,
    render(habits, appearance = {}) {
      colorScheme = appearance.colorScheme ?? colorScheme;
      effectiveMode = appearance.effectiveMode ?? effectiveMode;
      return runtime.render(() =>
        (component as (props: { habits: typeof habits }) => AuditElement)({
          habits,
        }),
      );
    },
  };
}

export interface BarChartAuditHarness {
  render(
    data: readonly {
      label: string;
      value: number;
      isFuture: boolean;
      isToday: boolean;
    }[],
    labels: readonly string[],
  ): AuditElement;
}

export function validateBarChartAuditTransform(
  transform?: (source: string) => string,
): void {
  const fileName = resolve(
    import.meta.dirname,
    "../../src/features/statistics/components/BarChart.tsx",
  );
  transpileTsx(
    fileName,
    transformSource(fileName, "createBarChartSlots", transform),
  );
}

export function loadBarChartForAudit(
  transform?: (source: string) => string,
): BarChartAuditHarness {
  const fileName = resolve(
    import.meta.dirname,
    "../../src/features/statistics/components/BarChart.tsx",
  );
  const runtime = new ShallowReactRuntime();
  const reactMock = runtime.getReactMock();
  const marker = (name: string) => Object.freeze({ auditComponent: name });
  const jsx = (
    type: unknown,
    props: Record<string, unknown> | null,
    key?: string | number,
  ) => runtime.createElement(type, key == null ? props : { ...props, key });
  const mocks = new Map<string, unknown>([
    ["react", { __esModule: true, default: reactMock, ...reactMock }],
    [
      "nativewind/jsx-runtime",
      {
        Fragment: runtime.Fragment,
        jsx,
        jsxs: jsx,
      },
    ],
    [
      "react-native",
      {
        Text: marker("Text"),
        View: marker("View"),
      },
    ],
    [
      "@expo/vector-icons/MaterialIcons",
      {
        __esModule: true,
        default: marker("MaterialIcons"),
      },
    ],
    [
      "react-i18next",
      {
        useTranslation: () => ({ t: (key: string) => key }),
      },
    ],
    [
      "@/theme/colors",
      {
        getAccentScheme: () => ({ base: "accent" }),
        lightTheme: {
          border: "border",
          divider: "divider",
          muted: "muted",
          surface: "surface",
          surfaceElevated: "elevated",
        },
      },
    ],
    [
      "@/components/ScreenPreferencesBoundary",
      {
        useVisualColorScheme: () => "amber",
        useVisualEffectiveMode: () => "light",
      },
    ],
  ]);
  const exports = compileTsx(
    fileName,
    transformSource(fileName, "createBarChartSlots", transform),
    mocks,
  );
  const component = exports.BarChart;
  if (typeof component !== "function") {
    throw new Error("Compiled BarChart has no component export");
  }
  return {
    render(data, labels) {
      return runtime.render(() =>
        (
          component as (props: {
            data: typeof data;
            labels: typeof labels;
            period: "week";
          }) => AuditElement
        )({ data, labels, period: "week" }),
      );
    },
  };
}

export function findAuditElements(
  root: unknown,
  predicate: (element: AuditElement) => boolean,
): AuditElement[] {
  const found: AuditElement[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node == null || typeof node !== "object") return;
    const candidate = node as Partial<AuditElement>;
    if ("type" in candidate && "props" in candidate) {
      const element = candidate as AuditElement;
      if (predicate(element)) found.push(element);
      visit(element.props.children);
    }
  };
  visit(root);
  return found;
}

export function shallowPropsEqual(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.is(left[key], right[key]))
  );
}
