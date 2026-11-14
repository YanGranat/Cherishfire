import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadSourceCallableForAudit } from "./fixtures/load-source-callable-for-audit";

import {
  createNavigationIntentGateController,
  createNavigationIntentWatchdog,
} from "../src/utils/navigation-intent-gate";

const navigationGate = createNavigationIntentGateController();
const statisticsIntent = navigationGate.acquire("/statistics");
assert.ok(statisticsIntent);
assert.equal(navigationGate.getActive(), statisticsIntent);
assert.equal(navigationGate.acquire("/statistics"), null);
assert.equal(navigationGate.acquire("/habit/7"), null);
assert.equal(navigationGate.release(statisticsIntent), true);
assert.equal(navigationGate.getActive(), null);

const staleIntent = navigationGate.acquire("/statistics");
assert.ok(staleIntent);
navigationGate.reset();
const currentIntent = navigationGate.acquire("/habit/8");
assert.ok(currentIntent);
assert.ok(currentIntent.generation > staleIntent.generation);
assert.equal(
  navigationGate.release(staleIntent),
  false,
  "a stale watchdog cannot release a newer navigation generation",
);
assert.equal(navigationGate.getActive(), currentIntent);
assert.equal(navigationGate.release(currentIntent), true);

type FakeTimer = { id: number; callback: () => void; cancelled: boolean };
let nextTimerId = 1;
const scheduledTimers: FakeTimer[] = [];
let sourceFocused = true;
const watchdogGate = createNavigationIntentGateController();
const watchdog = createNavigationIntentWatchdog({
  controller: watchdogGate,
  isSourceFocused: () => sourceFocused,
  scheduler: {
    schedule(callback) {
      const timer = { id: nextTimerId, callback, cancelled: false };
      nextTimerId += 1;
      scheduledTimers.push(timer);
      return timer;
    },
    cancel(timer) {
      timer.cancelled = true;
    },
  },
});
const ignoredIntent = watchdogGate.acquire("/statistics");
assert.ok(ignoredIntent);
watchdog.arm(ignoredIntent, 500);
assert.equal(watchdogGate.acquire("/statistics"), null);
const ignoredTimer = scheduledTimers.at(-1);
assert.ok(ignoredTimer);
ignoredTimer.callback();
assert.equal(watchdogGate.getActive(), null);
assert.equal(
  watchdogGate.release(ignoredIntent),
  false,
  "a focused ignored dispatch must release exactly its originating generation",
);

const staleWatchdogIntent = watchdogGate.acquire("/statistics");
assert.ok(staleWatchdogIntent);
watchdog.arm(staleWatchdogIntent, 500);
const staleTimer = scheduledTimers.at(-1);
assert.ok(staleTimer);
watchdog.clear();
watchdogGate.reset();
const replacementWatchdogIntent = watchdogGate.acquire("/habit/9");
assert.ok(replacementWatchdogIntent);
watchdog.arm(replacementWatchdogIntent, 500);
const replacementTimer = scheduledTimers.at(-1);
assert.ok(replacementTimer);
staleTimer.callback();
assert.equal(
  watchdogGate.getActive(),
  replacementWatchdogIntent,
  "a callback already queued before clear must not release a newer generation",
);
assert.equal(staleTimer.cancelled, true);
replacementTimer.callback();
assert.equal(watchdogGate.getActive(), null);

const blurredIntent = watchdogGate.acquire("/statistics");
assert.ok(blurredIntent);
watchdog.arm(blurredIntent, 500);
const blurredTimer = scheduledTimers.at(-1);
assert.ok(blurredTimer);
sourceFocused = false;
blurredTimer.callback();
assert.equal(
  watchdogGate.getActive(),
  blurredIntent,
  "a timer racing with blur must not reinterpret a real route transition as ignored",
);
sourceFocused = true;
watchdogGate.reset();

const homeSnapshotSource = readFileSync(
  "src/features/habits/presentation/home-snapshot.ts",
  "utf8",
);
const screenPreferencesSource = readFileSync(
  "src/components/ScreenPreferencesBoundary.tsx",
  "utf8",
);
const homeSource = readFileSync("app/index.tsx", "utf8");
const archiveSource = readFileSync("app/archive.tsx", "utf8");
const settingsSource = readFileSync("app/settings/index.tsx", "utf8");
const habitDetailSource = readFileSync("app/habit/[id].tsx", "utf8");
const rootLayoutSource = readFileSync("app/_layout.tsx", "utf8");
const navigationHookSource = readFileSync(
  "src/hooks/useNavigationIntentGate.ts",
  "utf8",
);
const habitBreakdownSource = readFileSync(
  "src/features/statistics/components/HabitBreakdown.tsx",
  "utf8",
);

assert.match(
  homeSource,
  /createHomeSnapshotController[\s\S]{0,220}useHabitStore\.getState\(\)/,
);
assert.match(
  homeSnapshotSource,
  /latestDayRecordsByDate = current\.dayRecordsByDate[\s\S]{0,500}getDayRecordsWitness/,
  "Home may retain a non-reactive date-cache witness without publishing the full map",
);
assert.match(
  screenPreferencesSource,
  /function useLiveVisualPreferences\(\)[\s\S]{0,240}useSettingsStore\(\(state\) => state\.theme\)[\s\S]{0,240}useSystemColorMode\(\)/,
  "the application must publish visual preferences while the covered scene is still hidden",
);
assert.doesNotMatch(screenPreferencesSource, /snapshotRef\.current/);
assert.match(
  screenPreferencesSource,
  /const visible = useLiveVisualPreferences\(\)/,
  "the visual boundary must use the one live application snapshot",
);
assert.doesNotMatch(
  screenPreferencesSource,
  /useNavigation|navigation\.addListener|createFocusedSnapshotController/,
  "visual correctness must not wait for a focus event after the Back transition starts",
);
assert.match(
  rootLayoutSource,
  /import \{ Stack, useNavigationContainerRef, useRouter \} from "expo-router"[\s\S]*?<Stack[\s\S]*?contentStyle: \{ backgroundColor: stackBackgroundColor \}/,
  "the root must use the native Expo Router stack with an opaque live-theme background",
);
assert.match(
  rootLayoutSource,
  /<Stack\.Screen name="index" options=\{\{ freezeOnBlur: false \}\}\s*\/>/,
  "hidden Home must be allowed to commit live theme and visible data before Back reveals it",
);
assert.doesNotMatch(
  rootLayoutSource,
  /createStackNavigator|detachInactiveScreens=\{false\}/,
);

assert.match(
  navigationHookSource,
  /navigation\.addListener\("blur", clearWatchdog\)/,
);
assert.match(navigationHookSource, /navigation\.addListener\("focus"/);
assert.match(
  navigationHookSource,
  /catch \(error\)[\s\S]{0,180}controller\.release\(token\)/,
  "a synchronous dispatch failure must unlock immediately",
);
assert.match(
  navigationHookSource,
  /watchdog\.arm\(token, silentDispatchTimeoutMs\)/,
  "a silently ignored dispatch must be watched under its exact token",
);
assert.match(
  navigationHookSource,
  /return \(\) => \{[\s\S]{0,180}clearWatchdog\(\);[\s\S]{0,120}controller\.reset\(\)/,
  "unmount must invalidate every delayed generation",
);
assert.match(
  homeSource,
  /const runNavigationIntent = useNavigationIntentGate\(\)/,
);
assert.doesNotMatch(homeSource, /statisticsNavigationCommittedRef/);
assert.match(
  homeSource,
  /target: "\/statistics"[\s\S]{0,900}router\.push\("\/statistics"\)/,
);
assert.match(
  homeSource,
  /const openHabitDetail = useCallback\([\s\S]{0,600}runNavigationIntent\(\{[\s\S]{0,160}target,[\s\S]{0,260}router\.push\(target\)/,
  "habit-row navigation must share the generation-safe Home navigation owner",
);
assert.match(
  homeSource,
  /<FAB[\s\S]{0,300}runNavigationIntent\(\{[\s\S]{0,120}target: "\/create"[\s\S]{0,300}pathname: "\/create"/,
  "Create navigation must share the generation-safe Home navigation owner",
);
const homeMainMenuSource = homeSource.slice(
  homeSource.indexOf("const HomeMainMenuController"),
  homeSource.indexOf("const HomeAboutDialogController"),
);
assert.match(
  homeMainMenuSource,
  /const runNavigationIntent = useNavigationIntentGate\(\)/,
  "Home menu destinations must share one isolated generation-safe navigation owner",
);
assert.match(homeMainMenuSource, /navigateFromMenu\("\/settings"\)/);
assert.match(homeMainMenuSource, /navigateFromMenu\("\/archive"\)/);
assert.match(
  archiveSource,
  /const runNavigationIntent = useNavigationIntentGate\(\)[\s\S]*const handleOpenHabit = useCallback\([\s\S]{0,700}runNavigationIntent\(\{[\s\S]{0,120}target,[\s\S]{0,180}router\.push\(target\)/,
  "Archive habit navigation must reject rapid duplicate pushes and release ignored dispatches",
);
assert.match(
  habitBreakdownSource,
  /const runNavigationIntent = useNavigationIntentGate\(\)/,
);
assert.match(
  settingsSource,
  /const runNavigationIntent = useNavigationIntentGate\(\)/,
  "Settings row navigation must use the generation-safe navigation owner",
);
assert.doesNotMatch(
  settingsSource,
  /navigationPendingRef|useFocusEffect/,
  "Settings must not keep a raw boolean lock that can survive an ignored dispatch",
);
assert.match(
  settingsSource,
  /target: row\.route,[\s\S]{0,260}router\.push\(row\.route\)/,
  "every Settings destination must use the guarded route dispatch",
);
const habitDetailContentStart = habitDetailSource.indexOf(
  "function HabitDetailScreenContent",
);
const habitDetailContentEnd = habitDetailSource.indexOf(
  "export default function HabitDetailScreen",
);
assert.ok(
  habitDetailContentStart >= 0 &&
    habitDetailContentEnd > habitDetailContentStart,
  "Habit detail navigation proof cannot isolate its screen-local owner",
);
const habitDetailContentSource = habitDetailSource.slice(
  habitDetailContentStart,
  habitDetailContentEnd,
);
assert.match(
  habitDetailContentSource,
  /const router = useRouter\(\);\s*const runNavigationIntent = useNavigationIntentGate\(\);/,
  "Habit detail must own an isolated generation-safe navigation gate",
);
const openNotesStart = habitDetailContentSource.indexOf(
  "const openNotes = useCallback(",
);
const openNotesEnd = habitDetailContentSource.indexOf(
  "// UI state",
  openNotesStart,
);
assert.ok(
  openNotesStart >= 0 && openNotesEnd > openNotesStart,
  "Habit detail navigation proof cannot isolate openNotes",
);
const openNotesSource = habitDetailContentSource.slice(
  openNotesStart,
  openNotesEnd,
);
assert.match(
  openNotesSource,
  /const target = `\/habit\/\$\{habitId\}\/notes`;[\s\S]{0,180}const result = runNavigationIntent\(\{[\s\S]{0,120}target,[\s\S]{0,180}router\.push\(target\);/,
  "openNotes must dispatch the exact notes target through the screen-local navigation gate",
);
assert.match(
  openNotesSource,
  /if \(result\.status === "failed"\)[\s\S]{0,180}console\.error/,
  "a failed notes dispatch must retain its failure handling",
);
const notesHeaderActions =
  habitDetailContentSource.match(/onPress: openNotes/g);
assert.equal(
  notesHeaderActions?.length,
  1,
  "the shared Habit detail notes action must route through openNotes",
);
assert.match(
  habitDetailContentSource,
  /return isArchived\s*\?\s*\[notesAction\]\s*:\s*\[\s*notesAction,\s*\{/,
  "both archived and active Habit detail headers must share the gated notes action",
);
assert.match(
  habitDetailContentSource,
  /rightActions=\{headerActions\}/,
  "the memoized header must receive the stable actions array",
);
function auditBreakdownNavigation(source: string): void {
  const leafCalls: number[] = [];
  const press = loadSourceCallableForAudit<() => void>(source, "handlePress", {
    habitId: 41,
    onOpenHabit: (habitId: number) => leafCalls.push(habitId),
  });
  press();
  assert.deepEqual(
    leafCalls,
    [41],
    "the retained row must delegate its own habit identity",
  );
  assert.match(source, /onPress=\{handlePress\}/);
  assert.match(source, /onOpenHabit=\{handleOpenHabit\}/);

  for (const status of ["dispatched", "blocked", "failed"] as const) {
    const pushes: string[] = [];
    let requests = 0;
    const callback = loadSourceCallableForAudit<(habitId: number) => void>(
      source,
      "handleOpenHabit",
      {
        runNavigationIntent: (intent: {
          target: string;
          dispatch: () => void;
        }) => {
          requests += 1;
          assert.equal(
            intent.target,
            "/habit/41",
            "the navigation gate must receive the selected habit target",
          );
          if (status === "dispatched") {
            intent.dispatch();
          }
          return {
            status,
            active: { generation: 1, target: "/habit/41" },
            error: new Error("Dispatch failed"),
          };
        },
        router: { push: (target: string) => pushes.push(target) },
        console: { error: () => undefined },
      },
    );
    callback(41);
    assert.equal(
      requests,
      1,
      "one row activation must request exactly one navigation intent",
    );
    assert.deepEqual(
      pushes,
      status === "dispatched" ? ["/habit/41"] : [],
      "only an accepted intent may dispatch the selected habit route",
    );
  }
}

auditBreakdownNavigation(habitBreakdownSource);
for (const [search, replacement] of [
  ["() => onOpenHabit(habitId)", "() => onOpenHabit(42)"],
  ["const target = `/habit/${habitId}`;", "const target = '/habit/42';"],
  ["router.push(`/habit/${habitId}`)", "router.push('/habit/42')"],
  [
    "router.push(`/habit/${habitId}`);",
    "router.push(`/habit/${habitId}`); router.push(`/habit/${habitId}`);",
  ],
] as const) {
  assert.equal(
    habitBreakdownSource.split(search).length,
    2,
    "each navigation mutation must identify exactly one executable target",
  );
  assert.throws(
    () =>
      auditBreakdownNavigation(
        habitBreakdownSource.replace(search, replacement),
      ),
    { name: "AssertionError" },
    "navigation mutations must violate an observable contract",
  );
}

console.log("Live snapshot and navigation intent coordinator audit passed.");
