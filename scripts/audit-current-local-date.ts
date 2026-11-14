import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { addDays } from "date-fns/addDays";
import { format } from "date-fns/format";
import { isBefore } from "date-fns/isBefore";
import { parseISO } from "date-fns/parseISO";
import { startOfDay } from "date-fns/startOfDay";
import { createCurrentLocalDateStore } from "../src/utils/current-local-date-store";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

let localDate = "2026-08-29";
let nextTimerId = 1;
let appActiveListener: (() => void) | null = null;
let appStateSubscriptions = 0;
let appStateUnsubscriptions = 0;
const timers = new Map<number, () => void>();

const store = createCurrentLocalDateStore({
  readLocalDate: () => localDate,
  millisecondsUntilNextLocalDay: () => 42_000,
  setTimer: (callback) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, callback);
    return id;
  },
  clearTimer: (timer) => {
    timers.delete(timer);
  },
  subscribeToAppActive: (listener) => {
    assert.equal(
      appActiveListener,
      null,
      "only one AppState owner may be live",
    );
    appStateSubscriptions += 1;
    appActiveListener = listener;
    return () => {
      appStateUnsubscriptions += 1;
      appActiveListener = null;
    };
  },
});

assert.equal(store.getSnapshot(), "2026-08-29");
assert.equal(appStateSubscriptions, 0);

let firstNotifications = 0;
let secondNotifications = 0;
const unsubscribeFirst = store.subscribe(() => {
  firstNotifications += 1;
});
const unsubscribeSecond = store.subscribe(() => {
  secondNotifications += 1;
});

assert.equal(
  appStateSubscriptions,
  1,
  "consumers must share one AppState listener",
);
assert.equal(timers.size, 1, "consumers must share one midnight timer");

localDate = "2026-08-30";
assert.ok(appActiveListener);
(appActiveListener as () => void)();
assert.equal(store.getSnapshot(), "2026-08-30");
assert.equal(firstNotifications, 1);
assert.equal(secondNotifications, 1);
assert.equal(
  timers.size,
  1,
  "refresh must replace rather than multiply timers",
);

(appActiveListener as () => void)();
assert.equal(
  firstNotifications,
  1,
  "same-day refresh must not notify consumers",
);
assert.equal(secondNotifications, 1);
assert.equal(timers.size, 1);

const midnightCallback = [...timers.values()][0];
localDate = "2026-08-31";
midnightCallback();
assert.equal(store.getSnapshot(), "2026-08-31");
assert.equal(firstNotifications, 2);
assert.equal(secondNotifications, 2);
assert.equal(timers.size, 1);

unsubscribeFirst();
assert.equal(appStateUnsubscriptions, 0);
assert.equal(timers.size, 1);
unsubscribeSecond();
assert.equal(appStateUnsubscriptions, 1);
assert.equal(timers.size, 0);

localDate = "2026-09-01";
assert.equal(
  store.getSnapshot(),
  "2026-09-01",
  "an unmounted store must still give the first render the real local date",
);

const hookSource = read("src/hooks/useCurrentLocalDate.ts");
const homeSource = read("app/index.tsx");
const rootLayoutSource = read("app/_layout.tsx");
assert.match(hookSource, /useSyncExternalStore/);
assert.doesNotMatch(hookSource, /\buse(?:Effect|LayoutEffect|State)\b/);
assert.equal(
  hookSource.match(/AppState\.addEventListener/g)?.length,
  1,
  "the process-wide date owner must install AppState only once",
);
assert.match(hookSource, /format\(new Date\(\), "yyyy-MM-dd"\)/);
assert.match(hookSource, /nextDay\.setDate\(now\.getDate\(\) \+ 1\)/);
assert.match(hookSource, /nextDay\.setHours\(0, 0, 1, 0\)/);
assert.match(hookSource, /export function getCurrentLocalDateSnapshot/);

function loadHomeDerivedValue(
  name: string,
  environment: Record<string, unknown>,
): () => unknown {
  const tree = ts.createSourceFile("Home.tsx", homeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer) {
      expression = node.initializer.getText(tree);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(expression, `Home must derive ${name}`);
  let memo: { dependencies: unknown[]; value: unknown } | null = null;
  const context = {
    ...environment,
    useMemo: (factory: () => unknown, dependencies: unknown[]) => {
      if (memo && memo.dependencies.length === dependencies.length &&
          memo.dependencies.every((value, index) => Object.is(value, dependencies[index]))) {
        return memo.value;
      }
      memo = { dependencies, value: factory() };
      return memo.value;
    },
  };
  const code = ts.transpileModule(`(${expression})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return () => {
    Object.assign(context, environment);
    return runInNewContext(code, context);
  };
}

const derivedEnvironment = {
  headerSelectedDay: parseISO("2026-11-13"),
  resolvedDateForList: "2026-11-13",
  listSelectedDay: parseISO("2026-11-14"),
  interactiveDateForLists: "2026-11-14",
  language: "en",
  todayDateStr: "2026-11-14",
  t: (key: string) => key,
  getDateFnsLocale: () => undefined,
  format,
  addDays,
  parseISO,
  isBefore,
  startOfDay,
  isToday: (date: Date) => format(date, "yyyy-MM-dd") === derivedEnvironment.todayDateStr,
  isYesterday: (date: Date) => format(date, "yyyy-MM-dd") === format(addDays(parseISO(derivedEnvironment.todayDateStr), -1), "yyyy-MM-dd"),
  isTomorrow: (date: Date) => format(date, "yyyy-MM-dd") === format(addDays(parseISO(derivedEnvironment.todayDateStr), 1), "yyyy-MM-dd"),
};
const readHeaderTitle = loadHomeDerivedValue("headerTitle", derivedEnvironment);
const readListIsPast = loadHomeDerivedValue("listIsPast", derivedEnvironment);
assert.equal(readHeaderTitle(), "habits.titleYesterday");
assert.equal(readListIsPast(), false);
derivedEnvironment.todayDateStr = "2026-11-15";
assert.equal(readHeaderTitle(), "Nov 13, 2026", "relative header labels must refresh on local date rollover");
assert.equal(readListIsPast(), true, "an unchanged selected date becomes past when the local clock advances");
derivedEnvironment.todayDateStr = "2026-11-13";
assert.equal(readHeaderTitle(), "habits.titleToday", "clock changes must also reconcile backward");
assert.equal(readListIsPast(), false);

function auditReminderDateSubscription(): void {
  const tree = ts.createSourceFile("RootLayout.tsx", rootLayoutSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effectText: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect" &&
        node.arguments[0]?.getText(tree).includes("AppState.addEventListener")) {
      assert.equal(effectText, undefined, "one root lifecycle effect owns reminder refresh");
      effectText = node.arguments[0].getText(tree);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(effectText);
  let onDateChanged: (() => void) | null = null;
  let onAppState: ((state: string) => void) | null = null;
  let dateUnsubscriptions = 0;
  let appStateUnsubscriptions = 0;
  let refreshes = 0;
  let backgroundDrains = 0;
  const appState = {
    currentState: "active",
    addEventListener: (_event: string, callback: (state: string) => void) => {
      onAppState = callback;
      return { remove: () => { appStateUnsubscriptions += 1; } };
    },
  };
  const effect = runInNewContext(ts.transpileModule(`(${effectText})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    AppState: appState,
    subscribeToCurrentLocalDate: (callback: () => void) => {
      onDateChanged = callback;
      return () => { dateUnsubscriptions += 1; };
    },
    refreshReminderNotificationTimezone: () => {
      refreshes += 1;
      return Promise.resolve();
    },
    refreshSystemColorMode: () => {},
    retryFailedSettingsPlatformEffects: () => {},
    startPendingReminderWorkBeforeBackground: () => { backgroundDrains += 1; },
  }) as () => () => void;
  const cleanup = effect();
  assert.equal(typeof onDateChanged, "function", "root must subscribe to the shared local-date owner");
  assert.equal(typeof onAppState, "function");
  (onDateChanged as unknown as () => void)();
  assert.equal(refreshes, 1, "active midnight must refill reminders without another foreground event");
  (onAppState as unknown as (state: string) => void)("active");
  assert.equal(refreshes, 2, "foreground and date events reach the same coalescing service owner");
  appState.currentState = "background";
  (onDateChanged as unknown as () => void)();
  assert.equal(refreshes, 2, "a background clock event must defer native work until foreground");
  (onAppState as unknown as (state: string) => void)("background");
  assert.equal(backgroundDrains, 1);
  cleanup();
  assert.equal(dateUnsubscriptions, 1, "root unmount must release the shared date subscription");
  assert.equal(appStateUnsubscriptions, 1, "root unmount must release its AppState subscription");
}
auditReminderDateSubscription();

console.log("Current local date owner and hidden Home work audit passed.");
