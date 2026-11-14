import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import {
  getNoteEditorContentHeight,
  getNoteEditorVisibilityDecision,
} from "../src/features/notes/utils/editor-visibility";
import {
  getNoteComposerBottomPadding,
  getNoteKeyboardLayoutMetrics,
  getReportedKeyboardOverlap,
  NOTE_COMPOSER_KEYBOARD_GAP,
} from "../src/features/notes/utils/keyboard-layout";
import { getNoteComposerContentHeight } from "../src/features/notes/utils/composer-height";
import {
  DARK_TOGGLE_OFF_THUMB_COLOR,
  getToggleThumbColor,
  LIGHT_TOGGLE_OFF_THUMB_COLOR,
  TOGGLE_ON_THUMB_COLOR,
  TOGGLE_THUMB_ANIMATION_DURATION_MS,
} from "../src/components/ui/toggle-thumb-color";
import { areRepeatSchedulesEqual } from "../src/types/habit";
import {
  clampDescriptionVisibleLines,
  DESCRIPTION_LINES_MAX,
  DESCRIPTION_LINES_MIN,
} from "../src/application/settings/habit-description-lines-setting";
import { loadSourceCallableForAudit } from "./fixtures/load-source-callable-for-audit";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const readBinary = (path: string) => readFileSync(resolve(root, path));

function assertSourceOrder(
  source: string,
  markers: readonly string[],
  message: string,
): void {
  let previousIndex = -1;
  for (const marker of markers) {
    const markerIndex = source.indexOf(marker, previousIndex + 1);
    assert.ok(
      markerIndex > previousIndex,
      `${message}: missing or out-of-order marker ${marker}`,
    );
    previousIndex = markerIndex;
  }
}

function listTypeScriptFiles(directory: string): string[] {
  const absoluteDirectory = resolve(root, directory);
  return readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap(
    (entry) => {
      const relativePath = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return listTypeScriptFiles(relativePath);
      return /\.tsx?$/.test(entry.name) ? [relativePath] : [];
    },
  );
}

const appConfig = JSON.parse(read("app.json")) as {
  expo: {
    android?: {
      allowBackup?: boolean;
      blockedPermissions?: string[];
    };
    splash?: { image?: string; backgroundColor?: string };
  };
};
assert.equal(
  appConfig.expo.android?.allowBackup,
  false,
  "a real Android uninstall must not silently restore the local-first database",
);
assert.deepEqual(
  new Set(appConfig.expo.android?.blockedPermissions ?? []),
  new Set([
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK",
    "android.permission.RECORD_AUDIO",
    "android.permission.READ_EXTERNAL_STORAGE",
    "android.permission.WRITE_EXTERNAL_STORAGE",
    "android.permission.SYSTEM_ALERT_WINDOW",
  ]),
  "the standalone APK must not request microphone, foreground media service, legacy storage, or overlay access that Cherishfire never uses",
);
assert.equal(appConfig.expo.splash?.image, "./assets/splash-icon.png");
assert.equal(appConfig.expo.splash?.backgroundColor, "#121212");
const sha256 = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
assert.notEqual(
  sha256(readBinary("assets/splash-icon.png")),
  sha256(readBinary("assets/icon.png")),
  "splash must use the dedicated transparent mark, not the square launcher tile",
);

const dataTransferCodecSource = read(
  "src/application/data-transfer/data-transfer-codec.ts",
);
const dataTransferServiceSource = read(
  "src/application/data-transfer/data-transfer-service.ts",
);
const dataTransferCoordinatorSource = read(
  "src/application/data-transfer/data-transfer-coordinator.ts",
);
const dataTransferCompositionSource = read("src/composition/data-transfer.ts");
const dataTransferRepositorySource = read(
  "src/data/sqlite/data-transfer-repository.ts",
);
const dataTransferImportFileSource = read(
  "src/platform/data-transfer/select-import-file.ts",
);
const dataTransferLimitsSource = read(
  "src/application/data-transfer/data-transfer-limits.ts",
);
const dataTransferHomeSource = read(
  "src/features/habits/components/HomeDataTransferOverlayController.tsx",
);
for (const compositionFile of listTypeScriptFiles("src/composition")) {
  assert.doesNotMatch(
    read(compositionFile),
    /from\s+["']@\/(?:app|features|components|hooks|stores|theme)(?:\/|["'])/,
    `${compositionFile} must not depend upward on presentation or UI state`,
  );
}
assert.match(dataTransferCodecSource, /export const EXPORT_SCHEMA_VERSION = 5/);
assert.match(
  dataTransferCodecSource,
  /export const MIN_SUPPORTED_EXPORT_SCHEMA_VERSION = 5/,
);
assert.match(dataTransferCodecSource, /validateRepeatConfig/);
assert.match(dataTransferCodecSource, /validateReminderValue/);
assert.match(dataTransferCodecSource, /validateNormalizedImportRows/);
assert.match(dataTransferCodecSource, /validateSettingsSemantics/);
assert.match(dataTransferCodecSource, /validateArchiveSemantics/);
assert.match(dataTransferCodecSource, /scheduleHistory order/);
assert.doesNotMatch(
  dataTransferCodecSource,
  /createPreImportBackup|readPreImportBackup|removeLegacyPreImportBackup/,
);
assert.match(
  dataTransferCompositionSource,
  /capturePendingHabitWriteFence[\s\S]*capturePendingNotesWriteFence[\s\S]*capturePendingSettingsWriteFence/,
  "the composite transfer fence must include each registered durable owner",
);
assert.match(dataTransferCompositionSource, /new DataTransferCoordinator/);
assert.match(
  dataTransferCompositionSource,
  /new DataTransferService<PreparedExportFile>/,
  "composition must wire exactly one data-transfer application service",
);
assert.match(
  dataTransferCompositionSource,
  /return dataTransferService\.exportAllData\(\)/,
  "the public export facade must delegate to the single application owner",
);
assert.match(
  dataTransferCompositionSource,
  /if \(importFileSelectionInFlight\) return importFileSelectionInFlight/,
  "the public import-file facade must coalesce rapid duplicate confirmations before opening a native picker",
);
assert.match(
  dataTransferCompositionSource,
  /from "@\/platform\/data-transfer\/select-import-file"/,
  "the native import-file adapter must be exposed only through composition",
);
assert.doesNotMatch(
  dataTransferHomeSource,
  /from ["']expo-(?:document-picker|file-system\/legacy)["']/,
  "Home presentation must not own native data-transfer file APIs",
);
assert.match(dataTransferHomeSource, /await selectDataTransferImportFile\(\)/);
assert.match(
  dataTransferImportFileSource,
  /type: "\*\/\*"[\s\S]{0,100}copyToCacheDirectory: true[\s\S]{0,100}multiple: false/,
  "the native picker must expose provider-mislabelled JSON while preserving a local single-file copy",
);
assertSourceOrder(
  dataTransferImportFileSource,
  [
    "pickerRequest = DocumentPicker.getDocumentAsync({",
    "const result = await pickerRequest;",
    "const asset = result.assets[0];",
    "const file = new File(asset.uri);",
    "readBoundedDataTransferImportText({",
    "const fileInfo = file.info();",
    "readText: () => file.text(),",
  ],
  "the native picker and bounded local-file reader must preserve their causal order",
);
assertSourceOrder(
  dataTransferLimitsSource,
  [
    "const declaredByteLength = source.getByteLength();",
    "if (declaredByteLength == null)",
    "assertDataTransferImportByteLength(declaredByteLength);",
    "const text = await source.readText();",
    "byteLength: assertDataTransferImportTextSize(text)",
  ],
  "unknown and oversized import files must fail before JS reads text, followed by a decoded UTF-8 verification",
);
assert.match(
  dataTransferServiceSource,
  /const snapshotRequest = this\.dependencies\.readConsistentSnapshot\(\);[\s\S]{0,300}this\.completeExport/,
  "export must capture its exact snapshot cutoff synchronously before any await or platform import",
);
assert.match(
  dataTransferServiceSource,
  /if \(this\.exportInFlight\) return this\.exportInFlight/,
  "rapid duplicate export confirmations must share one file and native share flow",
);
assert.doesNotMatch(
  dataTransferCodecSource,
  /@\/(?:composition|data|platform|features|components|stores|theme)\/|react(?:-native)?|expo-/,
  "the frozen schema codec must stay pure and independently testable",
);
assert.doesNotMatch(
  dataTransferCodecSource,
  /new Date\(\)/,
  "the pure data-transfer codec must receive its export timestamp explicitly",
);
assert.match(
  dataTransferCompositionSource,
  /dataTransferCoordinator\.readExportSnapshot/,
);
assert.match(
  dataTransferCompositionSource,
  /dataTransferCoordinator\.replaceImportedData/,
);
assertSourceOrder(
  dataTransferCoordinatorSource,
  [
    "await dependencies.durableMutations.waitThrough(fence)",
    "await dependencies.waitForApplicationEffects()",
    "await dependencies.enterPlatformReplacementBoundary()",
    "await dependencies.replaceAtomically()",
    "await dependencies.publishCommittedSnapshot(result)",
  ],
  "import must settle durable/application work, freeze platform effects, then replace and publish sequentially",
);
assert.match(
  dataTransferRepositorySource,
  /runtimeDb\.transaction\(async \(tx\) =>/,
  "SQLite replacement and verification must share one serialized transaction",
);
assert.match(dataTransferServiceSource, /importNormalizedData/);
assert.match(
  dataTransferServiceSource,
  /if \(this\.importInFlight\)[\s\S]{0,180}this\.importInFlight\.data === data[\s\S]{0,120}this\.importInFlight\.promise/,
  "rapid duplicate import confirmations must share one replacement flow",
);
assert.match(dataTransferCodecSource, /previewNormalizedImportData/);
assert.match(
  dataTransferRepositorySource,
  /readConsistentSnapshot: \(\) => runtimeDb\.transaction\(readRows\)/,
  "export must read one consistent serialized database snapshot",
);

const rootLayout = read("app/_layout.tsx");
const uiScheduling = read("src/utils/ui-scheduling.ts");
const uiStore = read("src/stores/ui-store.ts");
assert.match(
  uiScheduling,
  /firstFrame = requestAnimationFrame[\s\S]{0,120}secondFrame = requestAnimationFrame/,
);
assert.doesNotMatch(
  uiScheduling,
  /waitForNextUiFrame/,
  "interactive persistence must not regain the obsolete one-frame delay helper",
);
assert.match(
  uiScheduling,
  /export function waitForUiPaint\(\): Promise<void> \{[\s\S]{0,120}runAfterUiPaint\(resolve\)/,
  "post-paint persistence must reuse the canonical two-frame native paint boundary",
);
const speculativeIdleScheduling = uiScheduling.slice(
  uiScheduling.indexOf("export function runWhenUiIsIdle"),
);
assert.match(
  uiScheduling,
  /MIN_SPECULATIVE_IDLE_BUDGET_MS = 8/,
  "optional non-preemptible work must reserve one complete 120 Hz frame budget",
);
assert.match(
  speculativeIdleScheduling,
  /deadline[\s\S]{0,180}timeRemaining\(\)[\s\S]{0,220}remainingMs < MIN_SPECULATIVE_IDLE_BUDGET_MS[\s\S]{0,100}requestIdleSlot\(\)/,
  "speculative work must yield instead of consuming the final sliver of an idle callback",
);
assert.doesNotMatch(
  speculativeIdleScheduling,
  /timeout\s*:/,
  "optional warmups must not be forced into a later user interaction by an idle timeout",
);
assert.doesNotMatch(
  rootLayout,
  /backfillArchiveHistory|removeLegacyPreImportBackup/,
);
assert.match(rootLayout, /import \{ StatusBar \} from "expo-status-bar"/);
assert.match(
  rootLayout,
  /<StatusBar style=\{isDarkTheme \? "light" : "dark"\} \/>/,
);
assert.match(rootLayout, /const isSystemDark = systemColorScheme === "dark"/);
assert.match(
  rootLayout,
  /<StatusBar style=\{isSystemDark \? "light" : "dark"\} \/>/,
);
assert.match(rootLayout, /loaded = await loadSettings\(\)/);
assert.match(rootLayout, /setSettingsLoadFailed\(!loaded\)/);
assert.match(
  rootLayout,
  /setBootstrapReady\(true\);[\s\S]{0,320}runWhenUiIsIdle\([\s\S]{0,100}warmupHabitReminders\(\)/,
  "optional notification-module warmup must not hold the first application screen or interrupt a later interaction",
);
assert.doesNotMatch(rootLayout, /<StatusBar[^>]*backgroundColor=/);
assert.match(
  uiStore,
  /selectDate\(date\) \{[\s\S]{0,120}selectedDate === date\) return;[\s\S]{0,80}set\(\{ selectedDate: date \}\)/,
  "persisting the already-selected day must not wake every UI-store subscriber",
);
assert.match(
  rootLayout,
  /import \{ Stack, useNavigationContainerRef, useRouter \} from "expo-router"[\s\S]*?<Stack[\s\S]*?contentStyle: \{ backgroundColor: stackBackgroundColor \}/,
  "the root must use the native stack and an opaque live-theme surface",
);
assert.match(
  rootLayout,
  /<Stack\.Screen name="index" options=\{\{ freezeOnBlur: false \}\} \/>/,
  "covered Home must be able to commit live visible facts before Back reveals it",
);

const colorSchemePerformanceSource = read("app/settings/color-scheme.tsx");
assert.match(colorSchemePerformanceSource, /const ColorRow = React\.memo/);
assert.match(colorSchemePerformanceSource, /const selectColor = useCallback/);
assert.match(colorSchemePerformanceSource, /const rightActions = useMemo/);
assert.match(
  colorSchemePerformanceSource,
  /const selected = useSettingsStore\([\s\S]{0,100}\(state\) => state\.colorScheme === color,?[\s\S]{0,40}\);/,
  "each color row must subscribe only to whether that row is selected",
);
assert.doesNotMatch(
  colorSchemePerformanceSource,
  /\bextraData=/,
  "accent selection must not invalidate the whole FlatList through extraData",
);
assert.doesNotMatch(
  colorSchemePerformanceSource,
  /const (?:selectedColorScheme|colorScheme) = useSettingsStore/,
  "the color-list parent must not subscribe to the selected accent",
);
assert.match(
  colorSchemePerformanceSource,
  /<FlatList[\s\S]{0,500}initialNumToRender=\{initialRowsToRender\}[\s\S]{0,200}removeClippedSubviews=\{false\}/,
  "the long color list must mount only a viewport-derived first batch without clipping Android rows",
);
assert.match(
  colorSchemePerformanceSource,
  /windowHeight - insets\.top - sizes\.headerHeight[\s\S]{0,180}Math\.ceil\(availableListHeight \/ SETTINGS_ROW_HEIGHT\) \+ 1/,
  "the first color batch must derive from the list viewport below the safe-area header instead of over-rendering the full window",
);
assert.doesNotMatch(
  colorSchemePerformanceSource,
  /getItemLayout=/,
  "color rows use minHeight and must remain correct with large system fonts",
);
assert.doesNotMatch(
  colorSchemePerformanceSource,
  /onSelect=\{\(\) =>/,
  "stable row callbacks must preserve ColorRow memoization",
);

const mainScreen = read("app/index.tsx");
const homeDataTransferOverlay = read(
  "src/features/habits/components/HomeDataTransferOverlayController.tsx",
);
const homeSnapshotController = read(
  "src/features/habits/presentation/home-snapshot.ts",
);
const handleSelectDateSource = mainScreen.slice(
  mainScreen.indexOf("const handleSelectDate = useCallback"),
  mainScreen.indexOf("const handleSelectDateRef = useRef"),
);
assert.ok(
  handleSelectDateSource.length > 0,
  "Home date-selection callback must remain auditable",
);
assert.match(mainScreen, /const HabitListScreenContent = React\.memo/);
assert.match(
  mainScreen,
  /function useLiveHabitStoreSnapshot\([\s\S]{0,120}publishVisibleFacts[\s\S]{0,400}createHomeSnapshotController[\s\S]{0,2800}React\.useSyncExternalStore\(/,
  "Home must keep one focus-aware snapshot so covered data stays current without invisible native commits",
);
const liveHabitSnapshotSource = mainScreen.slice(
  mainScreen.indexOf("function useLiveHabitStoreSnapshot"),
  mainScreen.indexOf("interface HomeMainMenuHandle"),
);
assert.match(
  liveHabitSnapshotSource,
  /useHabitStore\.subscribe\(publishRelevantSnapshot\)[\s\S]{0,700}controller\.reconcile\([\s\S]{0,120}publishVisibleFacts/,
  "Home must close the render-to-subscribe race under the same focus publication policy",
);
assert.doesNotMatch(
  liveHabitSnapshotSource,
  /snapshotRef\.current|navigation\.isFocused\(\)|navigation\.addListener/,
  "the snapshot owner must not use an imperative navigation read or mutate React snapshot refs",
);
assert.match(
  homeSnapshotController,
  /latestDayRecordsByDate = current\.dayRecordsByDate[\s\S]{0,700}getDayRecordsWitness/,
  "Home must retain neighbour cache availability without publishing the full map",
);
assert.match(
  mainScreen,
  /selectedDateCachedRecords = getDayRecordsWitness\(selectedDate\)[\s\S]{0,180}getDayRecordsWitness\([\s\S]{0,80}interactiveDateForLists/,
  "an explicit date intent must read the authoritative live cache witness",
);
assert.doesNotMatch(
  mainScreen.slice(
    mainScreen.indexOf("const selectedDateCachedRecords"),
    mainScreen.indexOf("const dateWindowPrefetchTimerRef"),
  ),
  /habitState\.dayRecordsByDate/,
  "a stale published map must not override authoritative cache eviction or prewarm state",
);
assert.match(
  mainScreen.slice(
    mainScreen.indexOf("export default function HabitListScreen"),
  ),
  /useIsFocused\(\)/,
  "one focus render must publish the latest covered Home facts before reveal",
);
assert.doesNotMatch(
  mainScreen.slice(
    mainScreen.indexOf("const HabitListScreenContent = React.memo"),
    mainScreen.indexOf("const HabitListScreenContent = React.memo") + 900,
  ),
  /homeIsFocused/,
  "focus changes must not become a prop that rebuilds the large Home tree",
);
assert.doesNotMatch(
  mainScreen,
  /useHabitStore\(\(s\)/,
  "Home must consume one filtered live store snapshot rather than independent subscriptions",
);
const homeMainMenuControllerSource = mainScreen.slice(
  mainScreen.indexOf("const HomeMainMenuController"),
  mainScreen.indexOf("const HomeAboutDialogController"),
);
assert.match(
  homeMainMenuControllerSource,
  /const HomeMainMenuController = React\.memo\([\s\S]*React\.forwardRef/,
  "the main dropdown must remain an isolated memoized controller",
);
assert.match(
  homeMainMenuControllerSource,
  /const \[menu, setMenu\] = useState<\{\s*visible: boolean;\s*\}>\(\{ visible: false \}\)/,
  "the main dropdown controller must own visibility independently of the list",
);
assert.match(
  homeMainMenuControllerSource,
  /<MainDropdownMenu\s+visible=\{menu\.visible\}/,
  "the main dropdown must receive visibility from its isolated controller",
);
assert.match(
  mainScreen,
  /const handleOpenMainMenu = useCallback\(\(\) => \{[\s\S]{0,120}mainMenuRef\.current\?\.open\(\)/,
  "the stable main-menu control must open the isolated overlay owner",
);
assert.match(
  mainScreen,
  /onPress: handleOpenMainMenu/,
  "the main-menu header action must consume the stable isolated callback",
);
assert.doesNotMatch(
  mainScreen,
  /const \[menuVisible, setMenuVisible\] = useState/,
  "opening or closing the main dropdown must not re-render the entire home screen",
);
assert.match(
  mainScreen,
  /const HomeAboutDialogController = React\.memo\([\s\S]{0,160}React\.forwardRef[\s\S]{0,520}const \[dialog, setDialog\] = useState<[\s\S]{0,620}<AboutDialog/,
  "the About portal must own its visibility outside the animated Home lists",
);
assert.match(
  mainScreen,
  /const aboutDialogRef = useRef<HomeAboutDialogHandle>\(null\)/,
  "Home must retain one imperative About portal handle",
);
assert.match(
  mainScreen,
  /aboutDialogRef\.current\?\.open\(\)/,
  "Home must open About through its isolated portal owner",
);
assert.match(
  mainScreen,
  /<HomeAboutDialogController ref=\{aboutDialogRef\} \/>/,
  "Home must mount the isolated About portal controller",
);
assert.doesNotMatch(
  mainScreen,
  /const \[aboutDialogVisible, setAboutDialogVisible\] = useState/,
  "opening or closing About must not rebuild the complete Home screen",
);
assert.match(
  mainScreen,
  /const HomeHabitMenuController = React\.memo\([\s\S]{0,120}React\.forwardRef[\s\S]{0,1800}<HabitContextMenu/,
  "the per-habit context menu must own its target and visibility outside the heavy Home list",
);
assert.match(mainScreen, /habitMenuRef\.current\?\.open\(\{/);
assert.doesNotMatch(
  mainScreen,
  /const \[contextMenu, setContextMenu\] = useState/,
  "opening a per-habit menu must not update state owned by the entire Home screen",
);
const homeFailureReasonControllerSource = mainScreen.slice(
  mainScreen.indexOf("const HomeFailureReasonController = React.memo"),
  mainScreen.indexOf("interface HomeFocusCoordinatorProps"),
);
assert.ok(
  homeFailureReasonControllerSource.length > 0,
  "the isolated failure-reason controller must remain auditable",
);
assert.match(
  homeFailureReasonControllerSource,
  /React\.forwardRef[\s\S]*const \[session, setSession\] = useState\([\s\S]*<FailureReasonDialog/,
  "the failure-reason overlay must own its session outside the heavy Home list",
);
assert.match(
  mainScreen,
  /failureReasonRef\.current\?\.open\(\{\s*habitId,\s*date: interactiveDateForLists,\s*status/,
  "opening a failure-reason dialog must update only its isolated overlay owner",
);
assert.doesNotMatch(
  mainScreen,
  /const \[failureDialog, setFailureDialog\] = useState/,
  "opening or closing a failure-reason dialog must not rebuild the entire Home screen",
);
assertSourceOrder(
  homeFailureReasonControllerSource,
  [
    "const pendingSubmitRef = useRef",
    "const flushPendingSubmit = useCallback",
    "useLayoutEffect(() => () => { flushPendingSubmit(false); }",
    "onDismiss={flushPendingSubmit}",
  ],
  "Home must wait for the physical dialog dismissal before starting the expensive status command and must not lose that command on owner unmount",
);
assertSourceOrder(
  homeFailureReasonControllerSource,
  [
    "pendingSubmitRef.current = {",
    "setSession((current) => ({",
    "visible: false,",
  ],
  "Home reason submission must capture one command before committing the hidden dialog state",
);
assert.match(mainScreen, /const isFocused = useIsFocused\(\)/);
assert.match(
  mainScreen,
  /function HabitListScreenVisualContent[\s\S]{0,420}const currentTheme = useVisualTheme\(\);[\s\S]{0,120}const currentColorScheme = useVisualColorScheme\(\);[\s\S]{0,420}visualTheme=\{currentTheme\}[\s\S]{0,100}visualColorScheme=\{currentColorScheme\}/,
  "Home content must consume one coherent revision from its focus-deferred visual boundary",
);
assert.doesNotMatch(
  mainScreen,
  /react-freeze|<Freeze\b|infiniteThenable/,
  "a root route must not suspend on an infinite thenable during navigation",
);
assert.match(
  mainScreen,
  /useRef<HomeDataTransferOverlayHandle>\(null\)[\s\S]*<HomeDataTransferOverlayController[\s\S]{0,140}ref=\{dataTransferOverlayRef\}[\s\S]{0,100}selectedDate=\{selectedDate\}/,
  "Home must delegate import, export, and status portals to one isolated owner",
);
assert.doesNotMatch(
  mainScreen,
  /setPendingImportError|setExportDialog|setImportDialog/,
  "opening data-transfer overlays must not update the heavy Home screen owner",
);
assert.match(homeDataTransferOverlay, /setPendingImportError/);
assert.match(
  homeDataTransferOverlay,
  /const data = normalizeImportData\(json\);/,
);
assert.match(
  homeDataTransferOverlay,
  /importNormalizedData\(\s*data,\s*publishImportedSnapshot,?\s*\)/,
);
assert.match(
  homeDataTransferOverlay,
  /habitStore\.loadHabits\(\{ mode: "committed-import" \}\)/,
  "committed import publication must use its explicit write-barrier mode",
);
assert.match(
  homeDataTransferOverlay,
  /pendingImportPublicationRecoveryRef[\s\S]*imported\.retryPublication/,
  "a committed import with failed publication must retry publication rather than replacing SQLite again",
);
assert.doesNotMatch(homeDataTransferOverlay, /pendingImport\.json/);
assert.doesNotMatch(
  homeDataTransferOverlay,
  /finally[\s\S]{0,160}setPendingImport\(null\)/,
);
assert.doesNotMatch(homeDataTransferOverlay, /restoreBackup|successWithBackup/);
assert.match(mainScreen, /maxSelectableDateStr/);
assert.match(mainScreen, /date > maxSelectableDateStr/);
assert.match(
  mainScreen,
  /const listIsFuture = interactiveDateForLists > todayDateStr/,
);
assert.doesNotMatch(mainScreen, /if \(date > todayDateStr\) return/);
assert.match(
  mainScreen,
  /void archiveHabit\(habitId\)\.catch\(\(archiveError\)/,
);
assert.equal(
  (mainScreen.match(/checkboxDisabled=\{listIsFuture\}/g) ?? []).length,
  2,
  "future-day checkbox disabling must reach active and completed lists",
);

const dropdownMenu = read("src/components/overlays/DropdownMenu.tsx");
const contextMenu = read("src/components/overlays/ContextMenu.tsx");
const detailMenu = read("src/features/habit-detail/components/DetailMenu.tsx");
const habitContextMenu = read(
  "src/features/habits/components/HabitContextMenu.tsx",
);
const calendarDayMenu = read(
  "src/features/habit-detail/components/CalendarDayMenu.tsx",
);
assert.match(dropdownMenu, /const LAST_ITEM_BOTTOM_INSET = 2/);
assert.match(contextMenu, /const LAST_ITEM_BOTTOM_INSET = 2/);
assert.match(dropdownMenu, /height: sizes\.menuItemHeight/);
assert.match(
  dropdownMenu,
  /paddingBottom: isLast \? LAST_ITEM_BOTTOM_INSET : 0/,
);
assert.match(
  contextMenu,
  /paddingBottom: isLast \? LAST_ITEM_BOTTOM_INSET : 0/,
);
for (const menuSource of [dropdownMenu, contextMenu]) {
  assert.match(
    menuSource,
    /const menuDividerColor = isDarkTheme \? "#3A3A3A" : "#E0E0E0"/,
  );
}
assert.match(contextMenu, /item\.icon === "navigate-next"/);
assert.match(
  contextMenu,
  /thinChevron:[\s\S]{0,100}width: 10,[\s\S]{0,80}height: 10,[\s\S]{0,120}borderRightWidth: 1\.75,[\s\S]{0,80}borderBottomWidth: 1\.75/,
);
assert.match(dropdownMenu, /menuWidth = sizes\.menuWidthDropdown/);
assert.match(
  mainScreen,
  /runAfterUiPaint\(\(\) => setAndroidHostPreloaded\(true\)\)[\s\S]{0,1800}preloadOnAndroid=\{androidHostPreloaded\}/,
  "the Home menu portal may pre-attach only after the first correct Home paint",
);
assert.match(
  dropdownMenu,
  /const retainHiddenAndroidHost =[\s\S]{0,100}Platform\.OS === "android" && preloadOnAndroid;[\s\S]{0,120}const shouldRender = shouldMount \|\| retainHiddenAndroidHost;/,
  "menu preloading must remain Android-only and must not change product visibility",
);
assert.match(
  dropdownMenu,
  /visible=\{shouldMount && !nativeDismissPending\}[\s\S]{0,100}keepMountedOnAndroid=\{retainHiddenAndroidHost\}/,
  "a retained menu host must stay invisible and non-interactive until product visibility opens it",
);
assert.match(detailMenu, /const DETAIL_MENU_WIDTH_BY_LANGUAGE/);
assert.match(detailMenu, /de: 236/);
assert.match(detailMenu, /fr: 220/);
assert.match(detailMenu, /it: 208/);
assert.match(detailMenu, /nl: 220/);
assert.match(
  detailMenu,
  /menuWidth=\{DETAIL_MENU_WIDTH_BY_LANGUAGE\[baseLanguage\]\}/,
);
assert.match(
  detailMenu,
  /icon: "trash-sharp",[\s\S]{0,80}iconFamily: "ionicons"/,
);
assert.match(
  detailMenu,
  /onPress: onArchive,[\s\S]{0,100}deferUntilClosed: true/,
  "archive navigation must start only after the detail menu has fully disappeared",
);
assert.match(habitContextMenu, /deferUntilClosed: askFailureReason/);
assert.match(habitContextMenu, /deferUntilClosed: askSkipReason/);
assert.match(calendarDayMenu, /deferUntilClosed: askFailureReason/);
assert.match(calendarDayMenu, /deferUntilClosed: askSkipReason/);
assert.match(dropdownMenu, /disabled\?: boolean/);
assert.match(
  dropdownMenu,
  /onPress=\{[\s\S]{0,120}item\.disabled[\s\S]{0,1800}if \(!beginClose\(\)\) return;[\s\S]{0,700}if \(item\.deferUntilClosed\)[\s\S]{0,500}return;[\s\S]{0,100}onClose\(\);[\s\S]{0,100}item\.onPress\(\);/,
);
assert.match(dropdownMenu, /const MENU_CLOSE_MS = 85;/);
assert.match(dropdownMenu, /const SCRIM_CLOSE_MS = 65;/);
assert.match(dropdownMenu, /const beginClose = React\.useCallback\(/);
assert.match(
  dropdownMenu,
  /if \(closeStartedRef\.current\) \{\s*return false;\s*\}/,
);
assert.match(contextMenu, /const beginClose = React\.useCallback\(/);
assert.match(
  contextMenu,
  /if \(closeStartedRef\.current\) \{\s*return false;\s*\}/,
);
for (const menuSource of [dropdownMenu, contextMenu]) {
  assert.match(
    menuSource,
    /const processedProductVisibilityRef = React\.useRef<boolean \| null>\(null\)/,
    "a menu must retain the last product visibility independently of callback identity",
  );
  assert.match(
    menuSource,
    /if \(processedProductVisibilityRef\.current === visible\) return;\s*processedProductVisibilityRef\.current = visible;/,
    "a parent rerender must not restart a menu transition whose product visibility did not change",
  );
  const finalizeCloseStart = menuSource.indexOf(
    "const finalizeClose = React.useCallback",
  );
  const finishCloseStart = menuSource.indexOf(
    "const finishClose = React.useCallback",
    finalizeCloseStart,
  );
  const finishCloseEnd = menuSource.indexOf(
    "const finishNativeDismiss",
    finishCloseStart,
  );
  const finalizeCloseSource = menuSource.slice(
    finalizeCloseStart,
    finishCloseStart,
  );
  const finishCloseSource = menuSource.slice(finishCloseStart, finishCloseEnd);
  assertSourceOrder(
    finalizeCloseSource,
    ["pendingActivation.onPress();", "finally {", "onCloseRef.current();"],
    "a deferred command must run exactly once and always retire parent visibility",
  );
  assertSourceOrder(
    finishCloseSource,
    [
      "if (transitionGenerationRef.current !== generation) return;",
      "if (usesIOSNativeHost) {",
      "setNativeDismissPending(true);",
      "finalizeClose(generation);",
    ],
    "only the current completed close may enter either native dismissal or the Android handoff",
  );
  assert.match(
    menuSource,
    /useLayoutEffect\(\(\) => \{[\s\S]{0,220}processedProductVisibilityRef[\s\S]{0,6200}if \(visible\)[\s\S]{0,4200}menuProgress\.value = withTiming/,
    "menu opening must be scheduled before paint without changing its tuned timing",
  );
  assertSourceOrder(
    menuSource,
    [
      "const isReversingNativeDismiss = nativeDismissPendingRef.current;",
      "const isReversingClose =",
      "if (!isReversingClose) {",
      "menuProgress.value = 0;",
      "scrimProgress.value = 0;",
      "menuProgress.value = withTiming(",
    ],
    "a close-to-open reversal must preserve the currently visible menu frame",
  );
}
assert.match(
  contextMenu,
  /if \(!beginClose\(\)\) return;[\s\S]{0,700}if \(item\.deferUntilClosed\)[\s\S]{0,500}return;[\s\S]{0,100}item\.onPress\(\);[\s\S]{0,100}onClose\(\);/,
  "context-menu item presses must start their close animation synchronously before product work",
);
assert.match(
  dropdownMenu,
  /accessibilityState=\{\{ disabled: item\.disabled \}\}/,
);
for (const menuSource of [dropdownMenu, contextMenu]) {
  assert.match(menuSource, /useSafeAreaInsets\(\)/);
  assert.match(menuSource, /numberOfLines=\{1\}/);
  assert.match(menuSource, /ellipsizeMode="tail"/);
  assert.match(menuSource, /minWidth: 0/);
}
assert.match(dropdownMenu, /insets\.top \+ SCREEN_MARGIN/);
assert.match(dropdownMenu, /windowHeight - insets\.bottom/);
assert.match(contextMenu, /const minX = insets\.left \+ screenMargin/);
assert.match(contextMenu, /const minY = insets\.top \+ screenMargin/);

const mainCalendar = read("src/features/habits/components/CalendarStrip.tsx");
assert.match(mainCalendar, /offset <= MAIN_CALENDAR_FUTURE_DAYS/);
assert.match(mainCalendar, /addDays\(today, offset\)/);

const habitTransfer = read("src/features/habits/hooks/useHabitTransfer.ts");
assert.match(habitTransfer, /if \(isFuture\) \{\s*return false;\s*\}/);
assert.match(habitTransfer, /if \(isFuture \|\| isBusy \|\| getIsTransferBusy\(\)\) \{\s*return false;\s*\}/);

const checkboxCircle = read(
  "src/features/habits/components/CheckboxCircle.tsx",
);
const habitItem = read("src/features/habits/components/HabitItem.tsx");
assert.equal(
  (checkboxCircle.match(/disabled=\{disabled\}/g) ?? []).length,
  2,
  "only truly unavailable checkbox controls may be natively disabled",
);
assert.equal(
  (checkboxCircle.match(/if \(disabled \|\| readOnly\) \{/g) ?? []).length,
  4,
  "read-only future guards must cover press and long-press in both variants",
);
assert.match(
  habitItem,
  /disabled=\{isPendingPersistence\}[\s\S]{0,80}readOnly=\{checkboxDisabled\}/,
);
assert.match(checkboxCircle, /readOnly\?: boolean/);
assert.match(
  checkboxCircle,
  /if \(!onPress\(\)\) return;\s*runAfterUiPaint\(\(\) => \{[\s\S]{0,220}playHabitExecutionSound\(\)/,
  "the visual mutation must run first and sound may start only after that frame",
);
assert.equal(
  (checkboxCircle.match(/runAfterUiPaint\(\(\) => \{/g) ?? []).length,
  2,
  "both checkbox variants must defer sound and haptics until after visual publication",
);
assert.doesNotMatch(
  checkboxCircle,
  /runAfterNextUiFrame|playCompletionSoundAfterVisualCommit/,
  "completion feedback must not add any extra scheduler beyond the single post-paint handoff",
);
assert.match(checkboxCircle, /event\.stopPropagation\(\)/);
assert.match(checkboxCircle, /const \[readOnlyPressed, setReadOnlyPressed\]/);
assert.match(checkboxCircle, /disabled: disabled \|\| readOnly/);

const activeHabitsList = read(
  "src/features/habits/components/ActiveHabitsList.tsx",
);
const completedHabitsSection = read(
  "src/features/habits/components/CompletedHabitsSection.tsx",
);
const completedToggle = read(
  "src/features/habits/components/CompletedSectionToggleVisual.tsx",
);
const activeHabitRowSource = activeHabitsList.slice(
  activeHabitsList.indexOf("const ActiveHabitRow"),
  activeHabitsList.indexOf(
    "const styles = StyleSheet.create",
    activeHabitsList.indexOf("const ActiveHabitRow"),
  ),
);
const activeHabitDragGestureSource = activeHabitRowSource.slice(
  activeHabitRowSource.indexOf("const dragGesture = useMemo"),
  activeHabitRowSource.indexOf("const animatedRowStyle"),
);
const completedHabitRowSource = completedHabitsSection.slice(
  completedHabitsSection.indexOf("const CompletedHabitRow"),
  completedHabitsSection.indexOf(
    "const styles = StyleSheet.create",
    completedHabitsSection.indexOf("const CompletedHabitRow"),
  ),
);
const flightOverlay = read(
  "src/features/habits/components/SectionFlightOverlay.tsx",
);
const habitAnimationConstants = read(
  "src/features/habits/animation/constants.ts",
);
assert.match(activeHabitsList, /checkboxDisabled=\{checkboxDisabled\}/);
assert.match(
  activeHabitsList,
  /Gesture\.Pan\(\)[\s\S]{0,80}\.enabled\(item\.habit\.id > 0\)/,
  "an optimistic habit without a persisted id must not start the tuned drag/drop pipeline",
);
assert.match(completedHabitsSection, /checkboxDisabled=\{checkboxDisabled\}/);
assert.match(
  completedHabitsSection,
  /const \[rowsMounted, setRowsMounted\] = useState\(isExpanded\)[\s\S]{0,420}const mountCompletedRows = isExpanded \|\| rowsMounted/,
  "collapsed completed habits must not retain every expensive native row after the tuned curtain finishes",
);
assert.match(
  completedHabitsSection,
  /finished &&[\s\S]{0,160}!latestExpandedRef\.current[\s\S]{0,120}!latestBusyRef\.current[\s\S]{0,100}setRowsMounted\(false\)/,
  "completed rows may unmount only after a successful collapse and outside an active cross-section transfer",
);
assert.match(
  completedHabitsSection,
  /\{mountCompletedRows\s*\? renderRows\.map\(/,
  "collapsed completed row instances must be absent from the native tree",
);
assert.match(
  activeHabitsList,
  /key=\{row\.key\}[\s\S]{0,1400}checkboxVisualEpoch=\{layoutEpoch\}/,
  "active row/drag identity must stay stable within one committed date owner",
);
assert.match(
  activeHabitRowSource,
  /const dragAdmissionCode = useSharedValue\(0\)[\s\S]{0,220}const dragGestureIndex = useSharedValue\(dragSessionIndex\)[\s\S]{0,120}const dragGestureCount = useSharedValue\(totalCount\)/,
  "a native home recognizer must read changing same-owner admission and geometry through UI-thread state",
);
assert.match(
  activeHabitRowSource,
  /useLayoutEffect\(\(\) => \{[\s\S]{0,220}dragAdmissionCode\.value =[\s\S]{0,260}dragGestureIndex\.value = dragSessionIndex[\s\S]{0,120}dragGestureCount\.value = totalCount/,
  "home drag admission must update in the commit turn, without waiting for GestureDetector's passive config refresh",
);
assert.match(
  activeHabitDragGestureSource,
  /const admissionCode = dragAdmissionCode\.value[\s\S]{0,500}const sessionIndex = dragGestureIndex\.value[\s\S]{0,700}const count = dragGestureCount\.value/,
  "the UI-thread gesture must consume the current date epoch rather than a captured React render",
);
assert.doesNotMatch(
  `${activeHabitsList}\n${completedHabitsSection}`,
  /useFlowLayout/,
  "each committed date owner must use one absolute native row model instead of a temporary relative-flow tree",
);
assert.doesNotMatch(
  activeHabitDragGestureSource,
  /\n\s{6}(?:useFlowLayout|suppressLayoutAnimations|suppressReflowAnimation|isBusy|dragSessionIndex|totalCount),/,
  "transient date/transfer props must not recreate or permanently stale the native home recognizer",
);
assert.match(
  completedHabitsSection,
  /key=\{row\.key\}[\s\S]{0,1400}checkboxVisualEpoch=\{layoutEpoch\}/,
  "completed row geometry must stay stable within one committed date owner",
);
assert.match(
  activeHabitsList,
  /const item = row\.item;[\s\S]{0,180}<ActiveHabitRow[\s\S]{0,100}item=\{item\}/,
  "active rows must receive the store-stabilized item instead of a recreated wrapper",
);
assert.match(
  completedHabitsSection,
  /item=\{row\.kind === "item" \? row\.item : null\}/,
  "completed rows must receive the store-stabilized item instead of a recreated render-row wrapper",
);
assert.doesNotMatch(
  completedHabitRowSource,
  /\brow\.kind\b|\brow\.item\b/,
  "a recreated completed render-row wrapper must not invalidate every memoized completed row",
);
assert.match(
  activeHabitsList,
  /function areActiveHabitRowPropsEqual[\s\S]{0,1800}previous\.item\.habit\.name === next\.item\.habit\.name[\s\S]{0,400}previous\.item\.currentStreak === next\.item\.currentStreak/,
  "unchanged active habit rows must not rebuild their native gesture and animated view tree",
);
assert.match(activeHabitsList, /\}, areActiveHabitRowPropsEqual\);/);
assert.match(
  completedHabitsSection,
  /function areCompletedHabitRowPropsEqual[\s\S]{0,1800}previous\.item\.currentStreak === next\.item\.currentStreak/,
  "unchanged completed habit rows must not rebuild their native animated view tree",
);
assert.match(completedHabitsSection, /\}, areCompletedHabitRowPropsEqual\);/);
assert.match(
  habitItem,
  /React\.memo\(HabitItemComponent, areHabitItemPropsEqual\)/,
  "an unchanged habit body must survive geometry-only parent renders",
);
assert.match(
  habitItem,
  /committedCheckboxVisual\.presentationEpoch !== visualEpoch[\s\S]{0,80}committedCheckboxVisual\.state !== checkboxState[\s\S]{0,80}\? visualEpoch[\s\S]{0,80}: committedCheckboxVisual\.key/,
  "a date switch must remount a checkbox only when its visible tone changes",
);
assert.match(
  habitItem,
  /useLayoutEffect\(\(\) => \{[\s\S]{0,180}presentationEpoch: visualEpoch[\s\S]{0,120}key: checkboxVisualKey/,
  "checkbox presentation identity must advance only after the selected date commits",
);
assert.match(
  habitItem,
  /<CheckboxCircle[\s\S]{0,80}key=\{checkboxVisualKey\}/,
  "a changed date tone must not retain press or Reanimated state from the previous date",
);
assert.doesNotMatch(
  activeHabitsList,
  /if \(useFlowLayout\) \{\s*return \(\s*<View/,
  "active rows must keep one React host identity while date-switch layout mode changes",
);
assert.doesNotMatch(
  completedHabitsSection,
  /if \(useFlowLayout\) \{\s*return \(\s*<View/,
  "completed rows must keep one React host identity while date-switch layout mode changes",
);
assert.ok(
  activeHabitRowSource.indexOf("if (useStaticRowPosition) {") >= 0 &&
    activeHabitRowSource.lastIndexOf("animatedRowStyle,") >
      activeHabitRowSource.lastIndexOf("<Animated.View"),
  "active rows must keep their animated mapper attached so its static branch eventually neutralizes drag values",
);
assert.ok(
  completedHabitRowSource.indexOf("if (useStaticRowPosition) {") >= 0 &&
    completedHabitRowSource.lastIndexOf("animatedRowStyle,") >
      completedHabitRowSource.lastIndexOf("<Animated.View"),
  "completed rows must keep their animated mapper attached for eventual target-position convergence",
);
assert.match(
  activeHabitRowSource,
  /if \(useStaticRowPosition\) \{[\s\S]{0,400}top: myIndex \* SLOT_HEIGHT[\s\S]{0,220}backgroundColor: surfaceBackgroundColor[\s\S]{0,120}transform: \[\{ scale: 1 \}\]/,
  "active static rows must explicitly neutralize stale drag color, scale, and position",
);
assert.doesNotMatch(
  activeHabitRowSource,
  /useStaticRowPosition \? staticRowStyle : animatedRowStyle/,
);
assert.doesNotMatch(
  completedHabitRowSource,
  /useStaticRowPosition \? staticRowStyle : animatedRowStyle/,
);
assert.match(
  activeHabitsList,
  /useLayoutEffect\(\(\) => \{\s*pendingDropOrderRef\.current = null;[\s\S]{0,300}resetDragState\(\);[\s\S]{0,100}\[layoutEpoch,/,
  "a retained-owner epoch change must clear stale drag values before native paint",
);
assert.match(
  mainScreen,
  /committedLayoutEpochRef\.current !== layoutEpoch[\s\S]{0,160}useLayoutEffect\(\(\) => \{[\s\S]{0,100}committedLayoutEpochRef\.current = layoutEpoch/,
  "date-switch snap detection must be based on the last committed epoch, not a ref mutated during render",
);
assert.match(
  mainScreen,
  /const suppressInitialLayoutAnimations = !isInteractiveDayLoaded/,
  "a private cold date request must not change the layout mode of the still-visible day",
);
assert.match(
  activeHabitsList,
  /const heightStyle = useAnimatedStyle\([\s\S]{0,300}height: suppressLayoutAnimations \? targetListHeight : listHeight\.value/,
  "the active-list mapper must converge to the target height while date suppression remains active",
);
assert.doesNotMatch(
  activeHabitsList,
  /listHeightOverride/,
  "a static height override cannot beat a retained Reanimated height",
);
assert.match(
  completedHabitsSection,
  /const curtainStyle = useAnimatedStyle\([\s\S]{0,300}height: forceCurtainSnap \? targetCurtainHeight : curtainHeight\.value/,
  "the completed-curtain mapper must converge to the target height while date suppression remains active",
);
assert.match(
  completedHabitsSection,
  /const visibleCurtainHeight = forceCurtainSnap[\s\S]{0,100}\? targetCurtainHeight[\s\S]{0,100}: curtainHeight\.value[\s\S]{0,240}visibleCurtainHeight > 0/,
  "the completed-toggle separator must share the curtain's snapped height owner",
);
assert.doesNotMatch(
  completedHabitsSection,
  /curtainHeightOverride/,
  "a static curtain override cannot beat a retained Reanimated height",
);
assert.doesNotMatch(
  mainScreen,
  /const suppressInitialLayoutAnimations =\s*!isSelectedDayLoaded/,
  "requested-date readiness must not leak into the visible Home presentation",
);
assert.match(
  handleSelectDateSource,
  /if \(transferBusyRef\.current\) \{[\s\S]{0,500}deferredDateSwitchRef\.current = \{ date \};\s*return;/,
  "date selection must not publish a new day under an active habit flight",
);
assert.match(
  mainScreen,
  /const cancelPrivateDateRequest = useCallback\([\s\S]{0,300}setRequestedDateForList\(resolvedDateForList\)[\s\S]{0,300}pendingDateRequestRef\.current = null/,
  "cancelling a private cold request must restore the visible date and clear its presentation state",
);
assert.match(
  handleSelectDateSource,
  /if \(transferBusyRef\.current\) \{\s*if \(date === resolvedDateForList\) \{\s*deferredDateSwitchRef\.current = null;\s*if \(hasPrivateDateRequest\) cancelPrivateDateRequest\(\);\s*return;/,
  "returning to the visible day during a flight must also cancel an older private cold request",
);
assert.match(
  handleSelectDateSource,
  /if \(date === resolvedDateForList\) \{\s*if \(hasPrivateDateRequest\) cancelPrivateDateRequest\(\);\s*return;/,
  "returning to the still-visible day must cancel a private cold request without publishing an A-to-A scene",
);
assert.match(
  activeHabitRowSource,
  /useStaticRowPosition \|\|\s*dragVisualsDisabled/,
  "separator geometry must not inherit stale drag state during a date snap",
);
assert.match(
  mainScreen,
  /if \(transfer\.isBusy\) return;\s*const deferred = deferredDateSwitchRef\.current;\s*if \(!deferred\) return;\s*deferredDateSwitchRef\.current = null;\s*handleSelectDateRef\.current\(deferred\.date\);/,
  "the latest deferred date request must resume after the habit flight settles",
);
assert.ok(
  mainScreen.indexOf("handleSelectDateRef.current(deferred.date);") <
    mainScreen.indexOf("const currentPending = pendingDateRequestRef.current;"),
  "deferred intent release must retain its source order before cold-date publication setup",
);
assert.match(
  mainScreen,
  /if \(transfer\.isBusy\) return;\s*const currentPending = pendingDateRequestRef\.current;/,
  "a loaded cold date must remain private while the visible day owns a checkbox flight",
);
assert.match(
  mainScreen,
  /useLayoutEffect\(\(\) => \{\s*const pending = pendingDateRequestRef\.current;[\s\S]{0,260}pending\.toDate !== selectedDate[\s\S]{0,1800}setResolvedDateForList\(/,
  "a ready complete Home date must publish before paint instead of waiting for a passive-effect frame",
);
assert.match(
  mainScreen,
  /currentPending\?\.id !== pending\.id[\s\S]{0,160}currentPending\.toDate !== selectedDate[\s\S]{0,60}\)\s*return;/,
  "a superseded cold date request must not publish its target",
);
assert.match(
  habitAnimationConstants,
  /SEPARATOR_RENDER_HEIGHT = 3 \/ PixelRatio\.get\(\)/,
);
assert.match(
  activeHabitsList,
  /isFirstRow && showTopSeparator \? 0 : -SEPARATOR_RENDER_HEIGHT/,
);
assert.match(
  activeHabitsList,
  /isFirstVisible && showTopSeparator \? 0 : -SEPARATOR_RENDER_HEIGHT/,
);
assert.match(
  activeHabitsList,
  /const rowContent = \([\s\S]{0,220}styles\.rowTopSeparator,[\s\S]{0,220}<HabitItem[\s\S]{0,1000}styles\.rowBottomSeparator/,
  "each active habit row must own its top separator, habit body, and bottom separator in order",
);
assert.doesNotMatch(activeHabitsList, /opacity: showTop \? 1 : 0/);
assert.match(activeHabitsList, /rowBottomSeparator:\s*\{\s*opacity: 1,/);
assert.doesNotMatch(
  activeHabitsList,
  /bottomSeparatorStyle\s*=\s*useAnimatedStyle/,
);
assert.doesNotMatch(activeHabitsList, /isLastRow/);
assert.match(activeHabitsList, /height: SEPARATOR_RENDER_HEIGHT/);
assert.match(
  completedHabitsSection,
  /showTopSeparator=\{!hasPrecedingSeparator && index === 0\}/,
);
assert.match(
  completedHabitsSection,
  /top:[\s\S]{0,120}hasPrecedingSeparator \|\| visibleCurtainHeight > 0[\s\S]{0,100}-SEPARATOR_RENDER_HEIGHT/,
);
assert.doesNotMatch(
  completedHabitsSection,
  /opacity: hasPrecedingSeparator \|\| visibleCurtainHeight > 0 \? 0 : 1/,
);
assert.doesNotMatch(completedHabitsSection, /isLastRow/);
assert.match(completedHabitsSection, /height: SEPARATOR_RENDER_HEIGHT/);
assert.match(completedToggle, /height: SEPARATOR_RENDER_HEIGHT/);
assert.match(completedToggle, /topSeparatorStyle/);
assert.match(
  completedToggle,
  /topSeparatorLine:[\s\S]{0,120}position: "absolute"/,
);
assert.match(completedToggle, /paddingTop: 15 \+ SEPARATOR_RENDER_HEIGHT/);
assert.match(completedToggle, /bottomSeparatorLine/);
assert.equal(
  (flightOverlay.match(/height: SEPARATOR_RENDER_HEIGHT/g) ?? []).length,
  2,
  "the flying row must use the same physical-pixel separator height at both edges",
);
assert.match(flightOverlay, /sourceIndex > 0 \? -SEPARATOR_RENDER_HEIGHT : 0/);
assert.doesNotMatch(flightOverlay, /SLOT_HEIGHT - 1|height: 1/);
assert.match(mainScreen, /height: SEPARATOR_RENDER_HEIGHT/);
assert.match(mainScreen, /showTopSeparator=\{!isCalendarVisible\}/);
assert.match(mainScreen, /hasPrecedingSeparator=\{/);
assert.match(mainScreen, /activeIncomingPlaceholderIndex != null/);
assert.match(
  mainScreen,
  /const statisticsIconColor = isDarkTheme \? darkTheme\.icon : "#808080"/,
);
assert.match(mainScreen, /color=\{statisticsIconColor\}/);

const themeColors = read("src/theme/colors.ts");
assert.match(
  themeColors,
  /export const lightTheme = \{[\s\S]{0,400}icon: "#505050"/,
);

const reminderService = read("src/application/reminders/reminder-service.ts");
const reminderNotificationAdapter = read(
  "src/platform/notifications/expo-reminder-notification-adapter.ts",
);
const reminderRepository = read(
  "src/data/sqlite/reminder-day-record-repository.ts",
);
const deferredReminderWorkCoordinator = read(
  "src/application/reminders/deferred-reminder-work-coordinator.ts",
);
assert.doesNotMatch(reminderNotificationAdapter, /isExpoGoRuntime/);
assert.doesNotMatch(
  reminderNotificationAdapter,
  /await import\("expo-notifications"\)/,
);
assert.match(reminderNotificationAdapter, /importLocalNotificationsModule/);
assert.match(
  reminderNotificationAdapter,
  /expo-notifications\/build\/scheduleNotificationAsync/,
);
assert.match(reminderService, /refreshReminderNotificationTimezone/);
assert.match(reminderService, /subscribeToReminderNotificationResponses/);
assert.match(reminderService, /private enqueueReminderSync/);
assert.match(reminderService, /syncHabitRemindersAfterRecordChanges/);
assert.match(
  reminderService,
  /loadReminderRecordsByHabit\(\s*changedHabits,?\s*\)/,
);
assert.match(
  deferredReminderWorkCoordinator,
  /if \(this\.recordRunActive \|\| this\.recordTask\) return;/,
);
assert.match(
  deferredReminderWorkCoordinator,
  /recordStartRequested[\s\S]{0,700}schedulePendingRecordSync\(\)/,
);
assert.match(
  reminderRepository,
  /const placeholders = chunk\.map\(\(\) => "\?"\)[\s\S]{0,300}WHERE habit_id IN \(\$\{placeholders\}\)/,
);

const calendar = read("src/features/habit-detail/components/MonthCalendar.tsx");
assert.match(calendar, /createHabitScheduleMatcher/);
assert.match(calendar, /const isScheduledForDate = useMemo/);
assert.match(calendar, /isNextMonthDisabled/);

const repeatSheet = read("src/features/habit-form/components/RepeatSheet.tsx");
const repeatDaysTab = read(
  "src/features/habit-form/components/RepeatDaysTab.tsx",
);
const repeatMonthlyTab = read(
  "src/features/habit-form/components/RepeatMonthlyTab.tsx",
);
const monthlyDateDraftStore = read(
  "src/features/habit-form/utils/monthly-date-draft.ts",
);
const repeatIntervalTab = read(
  "src/features/habit-form/components/RepeatIntervalTab.tsx",
);
const createScreen = read("app/create.tsx");
const createHabitHook = read("src/features/habit-form/hooks/useCreateHabit.ts");
const habitDetailScreen = read("app/habit/[id].tsx");
const habitDetailFormOverlayController = read(
  "src/features/habit-detail/components/HabitDetailFormOverlayController.tsx",
);
const habitDetailStatusOverlayController = read(
  "src/features/habit-detail/components/HabitDetailStatusOverlayController.tsx",
);
const habitFormKeyboardDismiss = read(
  "src/features/habit-form/utils/dismiss-keyboard-for-overlay.ts",
);
const inlineErrorBanner = read("src/components/ui/InlineErrorBanner.tsx");
const settingsErrorBanner = read(
  "src/features/settings/components/SettingsErrorBanner.tsx",
);
const archiveScreen = read("app/archive.tsx");
assert.doesNotMatch(
  repeatSheet,
  /wasVisibleRef|resetFromInitialSchedule|use(?:Layout)?Effect\([\s\S]{0,600}createRepeatDraft/,
);
assert.match(repeatSheet, /function RepeatSheetContent\(/);
assert.match(
  repeatSheet,
  /const \[initialDraft\] = useState\(\(\) => createRepeatDraft\(initialSchedule\)\)/,
);
assert.match(repeatSheet, /\{visible \? \([\s\S]{0,80}<RepeatSheetContent/);
assert.doesNotMatch(repeatSheet, /datesRef|setDates|setDraftDates/);
assert.match(repeatSheet, /createMonthlyDateDraftStore\(initialDraft\.dates\)/);
assert.match(
  repeatSheet,
  /dates: monthlyDateDraft\.getDates\(\)\.sort\(\(a, b\) => a - b\)/,
);
assert.match(repeatSheet, /switch \(activeTabRef\.current\)/);
assert.match(repeatSheet, /intervalInputRef/);
assert.match(repeatSheet, /const toggleDay = useCallback\(/);
assert.doesNotMatch(repeatSheet, /const toggleDate = useCallback\(/);
assert.match(
  repeatSheet,
  /const previous = daysRef\.current;[\s\S]{0,180}if \(wasSelected && previous\.length <= 1\) return true;[\s\S]{0,220}setDraftDays\(nextDays\);/,
  "rapid weekday taps must derive from the latest draft and keep one day selected",
);
assert.match(
  monthlyDateDraftStore,
  /if \(wasSelected && selectedDates\.size === 1\)[\s\S]{0,500}selectedDates\.delete\(date\)[\s\S]{0,500}selectedDates\.add\(date\)/,
  "the monthly draft store must derive every tap from its latest state and keep one date selected",
);
assert.match(repeatDaysTab, /const RepeatDayRow = React\.memo\(/);
assert.match(repeatDaysTab, /export const RepeatDaysTab = React\.memo\(/);
assert.match(repeatDaysTab, /selectedDays\.length > 1/);
assert.match(
  repeatDaysTab,
  /const handlePress = useCallback\(\(\) => \{\s*if \(!canToggle\) return;\s*onToggleDay\(day\);/,
  "each admitted weekday tap must delegate to the synchronous draft owner",
);
assert.match(repeatMonthlyTab, /const DATE_ROWS = Array\.from\(/);
assert.match(repeatMonthlyTab, /const RepeatMonthDateCell = React\.memo\(/);
assert.match(repeatMonthlyTab, /export const RepeatMonthlyTab = React\.memo\(/);
assert.match(repeatMonthlyTab, /React\.useSyncExternalStore\(/);
assert.match(repeatMonthlyTab, /dateDraft\.subscribeDate\(date, listener\)/);
assert.match(
  repeatMonthlyTab,
  /const handlePress = useCallback\(\(\) => \{\s*dateDraft\.toggleDate\(date\);/,
  "a second monthly-date tap before React commits must read the first tap's synchronous draft state",
);
assert.doesNotMatch(
  repeatSheet,
  /style=\{\(\{ pressed \}\)/,
  "repeat-sheet controls must preserve their NativeWind padding on Android",
);
assert.match(
  repeatSheet,
  /behavior=\{Platform\.OS === "ios" \? "padding" : "height"\}/,
);
assert.match(
  repeatIntervalTab,
  /dividerColor = isDarkTheme \? darkTheme\.divider : lightTheme\.divider/,
);
assert.match(
  repeatSheet,
  /repeatDividerColor = isDarkTheme[\s\S]{0,80}darkTheme\.divider[\s\S]{0,80}lightTheme\.divider/,
);
assert.match(
  repeatIntervalTab,
  /disabledIconColor = isDarkTheme[\s\S]{0,80}darkTheme\.disabled[\s\S]{0,80}lightTheme\.disabled/,
);
assert.match(
  repeatIntervalTab,
  /color=\{canDecrement \? accent : disabledIconColor\}/,
);
assert.match(
  repeatIntervalTab,
  /color=\{canIncrement \? accent : disabledIconColor\}/,
);
assert.match(
  repeatIntervalTab,
  /const normalizedValueRef = React\.useRef\(normalizedValue\);[\s\S]{0,1800}const currentValue = normalizedValueRef\.current;[\s\S]{0,700}normalizedValueRef\.current = expectedValue;[\s\S]{0,700}const currentValue = normalizedValueRef\.current;[\s\S]{0,700}normalizedValueRef\.current = expectedValue;/,
  "rapid interval stepper taps must accumulate from synchronous intent state",
);
assert.doesNotMatch(repeatIntervalTab, /borderColor: "#3A3A3A"/);
const createOverlayControllerSource = createScreen.slice(
  createScreen.indexOf("const CreateHabitOverlayController = React.memo("),
  createScreen.indexOf("const CreateHabitScheduleController = React.memo("),
);
const createScheduleControllerSource = createScreen.slice(
  createScreen.indexOf("const CreateHabitScheduleController = React.memo("),
  createScreen.indexOf("export default function CreateHabitScreen()"),
);
const createScreenOwnerSource = createScreen.slice(
  createScreen.indexOf("export default function CreateHabitScreen()"),
);
assert.match(
  createScheduleControllerSource,
  /const applyRepeatSchedule = useCallback\([\s\S]{0,500}scheduleSnapshotRef\.current[\s\S]{0,300}areRepeatSchedulesEqual\([\s\S]{0,800}publishSchedule\([\s\S]{0,180}repeatSchedule: nextRepeatSchedule/,
  "repeat changes must derive from the latest synchronous schedule snapshot",
);
assert.match(
  createScheduleControllerSource,
  /const confirmStartDate = useCallback\([\s\S]{0,240}scheduleSnapshotRef\.current[\s\S]{0,700}publishSchedule\(\{ \.\.\.current, startDate: date \}\)/,
  "start-date changes must derive from the latest synchronous schedule snapshot",
);
assert.match(
  createScheduleControllerSource,
  /const saveReminder = useCallback\([\s\S]{0,300}scheduleSnapshotRef\.current[\s\S]{0,1000}publishSchedule\([\s\S]{0,220}reminderEnabled: nextEnabled,[\s\S]{0,100}reminderTime: nextTime/,
  "reminder changes must derive from the latest synchronous schedule snapshot",
);
assert.match(
  createScheduleControllerSource,
  /React\.useImperativeHandle\([\s\S]{0,260}getSnapshot: \(\) => scheduleSnapshotRef\.current/,
  "the schedule controller must expose one current snapshot to Save",
);
assert.match(
  createScheduleControllerSource,
  /scheduleSnapshotRef\.current = next;[\s\S]{0,100}setSchedule\(next\);/,
  "schedule intent must become synchronously readable before its visual commit",
);
assert.match(
  createScreenOwnerSource,
  /scheduleControllerRef\.current\?\.getSnapshot\(\)[\s\S]{0,650}repeatSchedule: schedule\.repeatSchedule[\s\S]{0,300}startDate: schedule\.startDate[\s\S]{0,300}reminderEnabled: schedule\.reminderEnabled/,
  "habit creation must save the controller snapshot without mirroring schedule state in the screen",
);
assert.match(
  createOverlayControllerSource,
  /\{session\?\.kind === "repeat" \? \([\s\S]{0,260}<MemoizedRepeatSheet/,
  "the repeat portal must exist only for its single active overlay session",
);
assert.match(
  createOverlayControllerSource,
  /const \[session, setSession\] = useState<CreateFormOverlaySession \| null>\(\s*null,?\s*\);[\s\S]{0,140}const sessionRef = useRef<CreateFormOverlaySession \| null>\(null\);[\s\S]{0,100}const generationRef = useRef\(0\);/,
  "all create form overlays must share one generation-guarded owner",
);
assert.doesNotMatch(
  createOverlayControllerSource,
  /const \[(?:repeatSession|dateSession|reminderSession),/,
  "create form overlays must not regain independent session state",
);
assert.match(
  createOverlayControllerSource,
  /const shouldPreloadDatePicker =\s*Platform\.OS === "android" && isFocused && datePickerHostWarmed;/,
  "the hidden date host may prewarm only on a focused Android route",
);
assert.match(
  createOverlayControllerSource,
  /\{shouldPreloadDatePicker \|\| session\?\.kind === "start-date" \? \([\s\S]{0,160}<MemoizedDatePickerModal/,
  "Create must mount the date host only for the focused prewarm or active date session",
);
assert.match(
  createOverlayControllerSource,
  /\{session\?\.kind === "reminder" \? \([\s\S]{0,260}<ReminderScreen/,
  "the closed reminder portal must not add its editor tree to the first Create frame",
);
const createReminderSaveOwnerSource = createOverlayControllerSource.slice(
  createOverlayControllerSource.indexOf("const saveReminders"),
  createOverlayControllerSource.indexOf(
    "return (",
    createOverlayControllerSource.indexOf("const saveReminders"),
  ),
);
assertSourceOrder(
  createReminderSaveOwnerSource,
  [
    'if (!closeOverlay("reminder", generation)) return;',
    "onReminderSave(enabled, time);",
  ],
  "Create reminder save must publish overlay dismissal before applying its value",
);
assert.match(
  createOverlayControllerSource,
  /<ReminderScreen[\s\S]{0,360}onSave=\{\(enabled, time\) =>[\s\S]{0,180}saveReminders\([\s\S]{0,180}session\.generation[\s\S]{0,320}onBack=\{\(\) =>[\s\S]{0,100}closeOverlay\("reminder", session\.generation\)/,
  "Create must route save and cancel through distinct parent-owned commands",
);
assert.doesNotMatch(
  createOverlayControllerSource,
  /<ReminderScreen[\s\S]{0,360}onSave=\{onReminderSave\}/,
  "Create must not bypass the overlay owner when saving reminders",
);
assert.doesNotMatch(
  createScreenOwnerSource,
  /setRepeatSheetVisible|setDatePickerVisible|setReminderScreenVisible|setRepeatSchedule|setStartDate|setReminderEnabled|setReminderTime/,
  "the full create screen must not own schedule or overlay mutation state",
);
assert.match(
  createScheduleControllerSource,
  /overlayControllerRef\.current\?\.openRepeat\(\)[\s\S]{0,1200}overlayControllerRef\.current\?\.openStartDate\(\)[\s\S]{0,1200}overlayControllerRef\.current\?\.openReminders\(\)/,
  "the isolated schedule owner must delegate all three modal openings to the overlay controller",
);
assert.match(
  createScreenOwnerSource,
  /<CreateHabitScheduleController[\s\S]{0,180}ref=\{scheduleControllerRef\}[\s\S]{0,180}initialSnapshot=\{initialScheduleSnapshot\}/,
  "the stable form must mount one isolated schedule subtree",
);
assert.match(
  createScreenOwnerSource,
  /nameRef\.current = value;\s*const nextHasName = value\.trim\(\)\.length > 0;\s*if \(nextHasName !== hasNameRef\.current\) \{\s*hasNameRef\.current = nextHasName;\s*setHasName\(nextHasName\);/,
  "name changes must update synchronous Save intent before requesting its visual commit",
);
assert.match(
  createScreenOwnerSource,
  /const canSave = hasName;[\s\S]{0,5000}disabled=\{!canSave\}/,
  "the Create Save control must use the committed name availability",
);
assert.match(
  createScreen,
  /const MemoizedRepeatSheet = React\.memo\(RepeatSheet\);[\s\S]{0,100}const MemoizedDatePickerModal = React\.memo\(DatePickerModal\);/,
  "an unrelated schedule field must not re-render hidden repeat/date portals",
);
assert.match(
  createOverlayControllerSource,
  /const isFocused = useIsFocused\(\);[\s\S]{0,220}const \[datePickerHostWarmed, setDatePickerHostWarmed\] = useState\(false\);/,
  "Create must own one reusable Android date-host warm state",
);
assert.match(
  createOverlayControllerSource,
  /Platform\.OS !== "android"[\s\S]{0,160}!isFocused[\s\S]{0,240}hasVisibleOverlay[\s\S]{0,240}runAfterUiPaint[\s\S]{0,220}isFocusedRef\.current && !sessionRef\.current\?\.visible/,
  "Create date prewarm must be guaranteed after the first correct focused Android frame",
);
assert.doesNotMatch(
  createOverlayControllerSource,
  /setDatePickerHostWarmed\(false\)/,
);
assert.match(
  createOverlayControllerSource,
  /const onStartDateConfirmRef = useRef\(onStartDateConfirm\);[\s\S]{0,520}onStartDateConfirmRef\.current = onStartDateConfirm;/,
  "the warmed DatePicker host must receive stable callbacks that validate the current overlay session through refs",
);
assert.match(
  createOverlayControllerSource,
  /const confirmCurrentStartDate = useCallback\([\s\S]{0,900}sessionRef\.current[\s\S]{0,900}onStartDateConfirmRef\.current\(date\)/,
  "the stable confirm callback must resolve the latest overlay generation and owner callback",
);
assert.match(
  createOverlayControllerSource,
  /onConfirm=\{confirmCurrentStartDate\}\s*onCancel=\{cancelCurrentStartDate\}/,
  "the warmed DatePicker host must not receive render-local callback closures",
);
assert.doesNotMatch(createScreen, /requestAnimationFrame/);
assert.equal(
  (createScreen.match(/dismissKeyboardForHabitFormOverlay\(\);/g) ?? []).length,
  3,
  "repeat, start-date, and reminder overlays must share the keyboard-dismiss helper",
);
assert.equal(
  (
    habitDetailFormOverlayController.match(
      /dismissKeyboardForHabitFormOverlay\(\);/g,
    ) ?? []
  ).length,
  1,
  "the existing-habit overlay owner must dismiss the keyboard only after accepting a new session",
);
assert.doesNotMatch(
  habitDetailScreen,
  /dismissKeyboardForHabitFormOverlay/,
  "the detail route must not dismiss the keyboard before overlay admission",
);
assert.equal(
  (habitFormKeyboardDismiss.match(/Keyboard\.dismiss\(\);/g) ?? []).length,
  1,
  "the shared keyboard-dismiss helper must own the single native request",
);
assert.doesNotMatch(createScreen, /useState\("09:00"\)/);
const habitDetailRepeatApply = habitDetailScreen.slice(
  habitDetailScreen.indexOf("const handleRepeatApply"),
  habitDetailScreen.indexOf("const handleStartDateConfirm"),
);
const repeatNoopIndex = habitDetailRepeatApply.indexOf(
  "areRepeatSchedulesEqual(currentHabit.repeatSchedule, schedule)",
);
const repeatPatchIndex = habitDetailRepeatApply.indexOf(
  "previewSchedule({ repeatSchedule: schedule });",
  repeatNoopIndex,
);
const repeatPersistenceIndex = habitDetailRepeatApply.indexOf(
  'runDetailAction("repeat"',
  repeatPatchIndex,
);
assert.ok(
  repeatNoopIndex >= 0 &&
    repeatNoopIndex < repeatPatchIndex &&
    repeatPatchIndex < repeatPersistenceIndex,
  "habit repeat apply must skip no-op work, publish one atomic schedule snapshot, then persist",
);
assertSourceOrder(
  habitDetailFormOverlayController.slice(
    habitDetailFormOverlayController.indexOf("const applyRepeat"),
    habitDetailFormOverlayController.indexOf("const confirmStartDate"),
  ),
  [
    'if (!closeOverlay("repeat", generation)) return;',
    "onRepeatApply(schedule);",
  ],
  "habit repeat apply must begin overlay dismissal before waking the detail data tree",
);
assert.equal(
  areRepeatSchedulesEqual(
    { type: "monthly", dates: [20, 2, 7] },
    { type: "monthly", dates: [7, 20, 2] },
  ),
  true,
  "repeat no-op detection must ignore selection order",
);
assert.equal(
  areRepeatSchedulesEqual(
    { type: "interval", every: 2 },
    { type: "interval", every: 2, fromCompletion: true },
  ),
  false,
  "interval completion mode is a meaningful schedule change",
);
assert.match(
  repeatSheet,
  /function RepeatSheetContent\([\s\S]{0,16000}<KeyboardAvoidingView/,
);
const habitDetailLoadingBranch = habitDetailScreen.slice(
  habitDetailScreen.indexOf('if (presentationState === "loading")'),
  habitDetailScreen.indexOf('if (presentationState === "error")'),
);
assert.match(habitDetailLoadingBranch, /<Header/);
assert.match(
  habitDetailLoadingBranch,
  /title=\{habit\?\.name \?\? t\("detail\.title"\)\}/,
);
assert.doesNotMatch(habitDetailLoadingBranch, /centerTitle/);

assert.match(inlineErrorBanner, /marginHorizontal: 14/);
assert.match(inlineErrorBanner, /marginTop: 10/);
assert.match(inlineErrorBanner, /minHeight: 44/);
assert.match(inlineErrorBanner, /borderRadius: radii\.listCard/);
assert.match(inlineErrorBanner, /alignItems: "center"/);
assert.match(inlineErrorBanner, /color=\{palette\.muted\}/);
assert.match(settingsErrorBanner, /<InlineErrorBanner/);
assert.match(settingsErrorBanner, /containerStyle=\{\{ marginBottom: 10 \}\}/);
for (const source of [createScreen, habitDetailScreen, archiveScreen]) {
  assert.match(source, /<InlineErrorBanner/);
}
for (const source of [createScreen, habitDetailScreen, archiveScreen]) {
  assert.doesNotMatch(
    source,
    /mx-base mb-sm min-h-\[44px\]|mx-\[14px\] mt-\[10px\][^\n]*rounded-\[10px\][^\n]*border-divider/,
  );
}

const dialog = read("src/components/ui/Dialog.tsx");
const datePicker = read(
  "src/features/habit-form/components/DatePickerModal.tsx",
);
const datePickerMonthModel = read(
  "src/features/habit-form/utils/date-picker-month-model.ts",
);
assert.match(datePicker, /function DatePickerContent\(/);
assert.match(
  datePicker,
  /const DatePickerCalendarPane = React\.memo\([\s\S]{0,700}const \[currentMonth, setCurrentMonth\] = useState\(\s*\(\) =>[\s\S]{0,80}selectedDate\.slice\(0, 7\)/,
);
assert.match(
  datePicker,
  /function useDatePickerSelectionDraft\([\s\S]{0,500}React\.useRef\(selectedDate\)/,
);
assert.doesNotMatch(
  datePicker,
  /wasVisibleRef|const \[picked, setPicked\]|use(?:Layout)?Effect\([\s\S]{0,500}setPicked\(selectedDate/,
);
assert.match(datePicker, /const DatePickerDayCell = React\.memo\(/);
assert.doesNotMatch(
  datePicker,
  /<DatePickerDayCell[\s\S]{0,120}\{\.\.\.dayModel\}/,
  "calendar model keys must not be spread into React component props",
);
assert.match(
  datePicker,
  /const DatePickerCalendarPane = React\.memo\([\s\S]{0,1000}const monthModelLookup = useMemo\([\s\S]{0,120}getDatePickerMonthModel\(currentMonth, language\)/,
);
assert.match(datePicker, /const monthModel = monthModelLookup\.model/);
assert.doesNotMatch(
  datePicker,
  /useSyncExternalStore|listenersRef|selection\.subscribe/,
  "date selection must not create one external-store subscription per calendar cell",
);
assert.match(
  datePicker,
  /interface DatePickerDayCellProps[\s\S]{0,250}isSelected: boolean[\s\S]{0,300}const DatePickerDayCell = React\.memo/,
  "the single date-selection owner must feed granular booleans to memoized cells",
);
assert.match(
  datePicker,
  /monthModel\.gridSlots\.map\(\(slot\) => \([\s\S]{0,180}key=\{slot\.key\}/,
  "month navigation must reuse position-keyed native cells",
);
assert.doesNotMatch(
  datePicker,
  /display:\s*["']none["']|DATE_PICKER_GRID_SLOT_COUNT|length:\s*37/,
  "date-picker performance must not add hidden rows or change modal geometry",
);
assert.match(
  datePicker,
  /runWhenUiIsIdle\([\s\S]{0,180}prewarmAdjacentDatePickerMonthModels\(currentMonth, language\)/,
);
assert.match(datePickerMonthModel, /DATE_PICKER_MONTH_CACHE_LIMIT = 18/);
assert.match(
  datePickerMonthModel,
  /key: `\$\{normalizedLanguage\}:\$\{year\}-\$\{month\}`/,
);
assert.match(datePicker, /\{visible \? \([\s\S]{0,80}<DatePickerContent/);
const header = read("src/components/layout/Header.tsx");
const aboutDialog = read("src/features/settings/components/AboutDialog.tsx");
const failureReasonDialog = read(
  "src/features/habits/components/FailureReasonDialog.tsx",
);
const retainedModalSession = read("src/hooks/useRetainedModalSession.ts");
assert.match(
  retainedModalSession,
  /if \(visible !== state\.observedVisible\)[\s\S]{0,360}session: \{ key: nextKey, snapshot: createSnapshot\(\) \}/,
);
assert.match(
  retainedModalSession,
  /setState\(\{ \.\.\.state, observedVisible: false \}\)/,
  "closing a fading modal must retain its current payload",
);
assert.match(
  retainedModalSession,
  /const handleDismiss = useCallback[\s\S]{0,220}current\.observedVisible[\s\S]{0,120}session: null/,
  "a retained modal payload may be released only after native dismissal",
);
assert.doesNotMatch(failureReasonDialog, /wasVisibleRef/);
assert.match(failureReasonDialog, /function FailureReasonDialogSession\(/);
assert.match(failureReasonDialog, /useRetainedModalSession/);
assert.match(
  failureReasonDialog,
  /type FailureReasonDialogSessionSnapshot = Pick<[\s\S]{0,100}"status"/,
  "only the opening status may be frozen; reason actions must remain live",
);
assert.match(
  failureReasonDialog,
  /status=\{snapshot\.status\}[\s\S]{0,120}onSkip=\{props\.onSkip\}[\s\S]{0,80}onSave=\{props\.onSave\}/,
  "failure reason callbacks must remain current while its session is open",
);
assert.match(dialog, /onDismiss\?: \(\) => void/);
assert.match(dialog, /onDismiss=\{onDismiss\}/);
assert.match(dialog, /animationType="fade"/);
assert.match(
  dialog,
  /width: Math\.min\(sizes\.dialogWidth, windowWidth - 32\)/,
  "the shared dialog must retain its standard card width",
);
assert.doesNotMatch(
  dialog,
  /androidFadeRendering|AppModalFadeLayer/,
  "the shared dialog must delegate its fade to one AppModal owner",
);
assert.doesNotMatch(
  dialog,
  /androidDismissPending|usesAndroidCustomFade|synchronizePortalMountOnAndroid|useSharedValue|withTiming|cancelAnimation/,
  "Dialog must delegate one physical lifecycle to AppModal instead of layering a second state machine over it",
);
assert.match(failureReasonDialog, /onDismiss=\{onDismiss\}/);
assert.match(
  failureReasonDialog,
  /key=\{session\.key\}[\s\S]{0,120}visible=\{props\.visible\}/,
);
assert.match(
  failureReasonDialog,
  /keepStateUntilDismiss = succeeded[\s\S]{0,1000}if \(!keepStateUntilDismiss\)/,
  "a successful reason action must preserve the fading dialog contents until the overlay is gone",
);
assert.doesNotMatch(
  mainScreen,
  /setFailureDialog\(\{ visible: false, habitId: 0, status: "failure" \}\)/,
  "closing the skip dialog must not replace its title and payload during fade-out",
);
assert.doesNotMatch(
  habitDetailScreen,
  /setFailureDialog\(\{ visible: false, date: "", status: "failure" \}\)/,
  "habit detail must preserve the visible reason payload until fade-out completes",
);
assert.match(dialog, /onRequestClose/);
assert.match(
  datePicker,
  /onRequestClose=\{\(\) => \{\s*onCancel\(\);\s*return true;/,
  "date-picker hardware dismissal must invoke its current cancel owner",
);
assert.match(
  repeatSheet,
  /onRequestClose=\{\(\) => \{\s*onCancel\(\);\s*return true;/,
  "repeat-sheet hardware dismissal must invoke its current cancel owner",
);
const dialogRequestCloseBody = dialog.match(
  /onRequestClose=\{\(\) => \{([\s\S]*?)\n\s*\}\}\s*\n\s*>/,
)?.[1];
assert.ok(
  dialogRequestCloseBody,
  "dialog must expose an explicit hardware-dismissal callback",
);
assert.match(
  dialogRequestCloseBody,
  /if \(!cancelAction \|\| cancelAction\.disabled\) return false;/,
  "dialog hardware dismissal must reject absent or disabled cancel actions",
);
assert.match(
  dialogRequestCloseBody,
  /cancelAction\.onPress\(\);/,
  "dialog hardware dismissal must invoke the enabled cancel action",
);
assert.match(
  dialogRequestCloseBody,
  /return true;/,
  "dialog hardware dismissal must report a handled cancel action",
);
assert.doesNotMatch(datePicker, /t\("datePicker\.title"\)/);
assert.match(datePicker, /paddingVertical: 14/);
assert.match(header, /paddingLeft: centerTitle \? 8 : 16/);
assert.match(header, /paddingRight: 8/);
assert.doesNotMatch(
  header,
  /style=\{\(\{ pressed \}\)/,
  "Header Pressables must preserve static layout styles and action widths on Android",
);
assert.match(dialog, /variant\?: "standard" \| "about"/);
assert.match(dialog, /variant = "standard"/);
assert.match(
  dialog,
  /paddingBottom: isAboutVariant \? sizes\.dialogPadding : 12/,
);
assert.match(dialog, /fontSize: 19, lineHeight: 25, marginBottom: 12/);
assert.match(dialog, /isAboutVariant \? null : \{ marginTop: 22 \}/);
assert.match(dialog, /min-h-\[46px\] px-\[14px\]/);
assert.match(dialog, /interface DialogTitleAction/);
assert.match(dialog, /onContentLayout\?: \(event: LayoutChangeEvent\) => void/);
assert.match(dialog, /onLayout=\{onContentLayout\}/);
assert.match(
  dialog,
  /position: "absolute",[\s\S]{0,80}top: -10,[\s\S]{0,80}right: -10,[\s\S]{0,120}width: sizes\.touchTargetMin,[\s\S]{0,80}height: sizes\.touchTargetMin/,
);
assert.match(
  dialog,
  /fontSize: 14\.5,[\s\S]{0,80}lineHeight: 20,[\s\S]{0,80}fontWeight: "500"/,
);
assert.doesNotMatch(
  dialog,
  /style=\{\(\{ pressed \}\)/,
  "Dialog controls must preserve their static NativeWind geometry on Android",
);
assert.doesNotMatch(
  datePicker,
  /style=\{\(\{ pressed \}\)/,
  "Date-picker controls must preserve their NativeWind padding and touch geometry on Android",
);
assert.match(dialog, /isAboutVariant[\s\S]{0,80}\? \{ fontWeight: "600" \}/);
assert.match(aboutDialog, /variant="about"/);
assert.match(
  aboutDialog,
  /fontSize: 20,[\s\S]{0,80}lineHeight: 26,[\s\S]{0,80}fontWeight: "400",[\s\S]{0,80}marginBottom: 16/,
);
assert.doesNotMatch(
  aboutDialog,
  /GitHub|github|Linking\.openURL|REPOSITORY_URL/,
  "About must not initiate external navigation",
);
assert.match(failureReasonDialog, /status === "skipped"/);
assert.match(failureReasonDialog, /const \[isSubmitting, setIsSubmitting\]/);
assert.match(failureReasonDialog, /const isSubmittingRef = useRef\(false\)/);
assert.match(
  failureReasonDialog,
  /if \(isSubmittingRef\.current\) \{\s*return;\s*\}/,
  "repeated reason submission must not dispatch a second command",
);
assert.match(failureReasonDialog, /const succeeded = await action\(\)/);
assert.equal(
  (failureReasonDialog.match(/disabled: isSubmitting/g) ?? []).length,
  2,
  "both reason actions must block repeated submission",
);
assert.match(failureReasonDialog, /editable=\{!isSubmitting\}/);
assert.match(
  failureReasonDialog,
  /titleStyle=\{\{ marginTop: -6, marginBottom: 8 \}\}/,
);
assert.match(
  failureReasonDialog,
  /actionsContainerStyle=\{\{ marginTop: 8\.5 \}\}/,
);
assert.match(failureReasonDialog, /buttonStyle: \{ paddingRight: 0 \}/);
assert.match(
  failureReasonDialog,
  /width: "100%",[\s\S]{0,80}height: 80,[\s\S]{0,80}lineHeight: 24/,
);
assert.match(
  failureReasonDialog,
  /paddingHorizontal: 12,[\s\S]{0,80}paddingTop: 10,[\s\S]{0,80}paddingBottom: 10/,
);
assert.doesNotMatch(failureReasonDialog, /marginHorizontal: -6/);
assert.doesNotMatch(failureReasonDialog, /paddingVertical: 10/);
assert.doesNotMatch(failureReasonDialog, /minHeight: 80/);

const settingsScreen = read("app/settings/index.tsx");
const settingsStore = read("src/stores/settings-store.ts");
const settingsMutationCoordinator = read(
  "src/application/settings/settings-mutation-coordinator.ts",
);
const settingsRepositoryPort = read(
  "src/application/settings/settings-repository-port.ts",
);
const settingsRepository = read("src/data/sqlite/settings-repository.ts");
const settingsComposition = read("src/composition/settings.ts");
const themeSettingsScreen = read("app/settings/theme.tsx");
const languageSettingsScreen = read("app/settings/language.tsx");
const colorSchemeSettingsScreen = read("app/settings/color-scheme.tsx");
const settingsScreenShell = read(
  "src/features/settings/components/SettingsScreenShell.tsx",
);
assert.match(
  settingsScreen,
  /standardRow: \{[\s\S]{0,80}minHeight: SETTINGS_ROW_HEIGHT/,
);
assert.doesNotMatch(
  settingsScreen,
  /standardRow: \{[\s\S]{0,160}paddingVertical/,
);
assert.match(
  settingsScreen,
  /function FailureReasonSettingsRow[\s\S]{0,420}settings\.askFailureReason[\s\S]{0,220}name="close"/,
);
assert.match(
  settingsScreen,
  /skipReasonIconSlot[\s\S]{0,120}width: 20[\s\S]{0,320}skipReasonChevron[\s\S]{0,220}borderRightWidth: 1\.75[\s\S]{0,120}borderBottomWidth: 1\.75/,
);
assert.match(settingsScreen, /name="close" size=\{21\}/);
assert.match(
  settingsScreen,
  /function SkipReasonChevron[\s\S]{0,420}styles\.skipReasonChevron[\s\S]{0,100}borderColor: palette\.icon/,
);
const skipReasonRowIndex = settingsScreen.lastIndexOf(
  'label={t("settings.askSkipReason")}',
);
const archiveStatsRowIndex = settingsScreen.lastIndexOf(
  'label={t("settings.showArchivedHabitsInStatistics")}',
);
assert.ok(skipReasonRowIndex >= 0);
assert.ok(
  archiveStatsRowIndex > skipReasonRowIndex,
  "archive statistics row must follow the skip-reason row",
);
assert.doesNotMatch(settingsScreen, /<Feather/);
assert.match(
  settingsScreen,
  /function SettingsToggleRow[\s\S]{0,1200}accessibilityLabel=\{label\}/,
);
for (const rowComponent of [
  "SoundSettingsRow",
  "ReminderSettingsRow",
  "FailureReasonSettingsRow",
  "SkipReasonSettingsRow",
  "ArchiveStatisticsSettingsRow",
]) {
  assert.match(settingsScreen, new RegExp(`function ${rowComponent}\\(`));
  assert.match(settingsScreen, new RegExp(`<${rowComponent} \\/>`));
}
assert.doesNotMatch(
  settingsScreen,
  /const soundEnabled =|const askFailureReason =|const askSkipReason =/,
  "one toggle must not subscribe and re-render the whole settings screen",
);
assert.match(settingsScreen, /<SettingsErrorBanner \/>/);
assert.match(
  settingsScreenShell,
  /<ScreenWrapper padBottom=\{false\} backgroundColor=\{backgroundColor\}>[\s\S]{0,200}<Header[\s\S]{0,800}<ScreenWrapper scrollable backgroundColor=\{backgroundColor\}>/,
);
for (const source of [
  settingsScreen,
  themeSettingsScreen,
  languageSettingsScreen,
  colorSchemeSettingsScreen,
]) {
  assert.match(source, /<SettingsScreenShell/);
  assert.doesNotMatch(source, /<ScreenWrapper scrollable>/);
}
assert.match(settingsScreen, /style=\{styles\.standardRow\}/);
assert.match(
  settingsScreen,
  /const runNavigationIntent = useNavigationIntentGate\(\)/,
  "settings navigation must use the shared generation-safe intent gate",
);
assert.match(
  settingsScreen,
  /runNavigationIntent\(\{[\s\S]{0,180}target: row\.route,[\s\S]{0,180}dispatch: \(\) => \{\s*router\.push\(row\.route\);[\s\S]{0,180}result\.status === "blocked"\) \{\s*return;/,
  "rapid settings navigation taps must not push a second destination while one is pending",
);
assert.match(
  settingsScreen,
  /result\.status === "failed"[\s\S]{0,220}console\.error\([^;]*result\.error\)/,
  "a synchronous settings navigation failure must reach the error boundary",
);
assert.doesNotMatch(
  settingsScreen,
  /navigationPendingRef/,
  "settings must not keep a second ad-hoc navigation lock beside the shared gate",
);
assert.doesNotMatch(
  settingsScreen,
  /style=\{\(\{ pressed \}\)/,
  "settings navigation rows must keep their static 56dp style on Android",
);
assert.match(settingsScreen, /numberOfLines=\{1\}/);
assert.match(settingsScreen, /ellipsizeMode="tail"/);
assert.doesNotMatch(settingsScreen, /Clipboard\.setStringAsync|expo-clipboard/);
assert.match(themeSettingsScreen, /active:bg-press-highlight/);
assert.match(languageSettingsScreen, /active:bg-press-highlight/);
assert.match(colorSchemeSettingsScreen, /active:bg-press-highlight/);
assert.match(
  colorSchemeSettingsScreen,
  /style=\{\{ minHeight: SETTINGS_ROW_HEIGHT \}\}/,
);
assert.doesNotMatch(
  colorSchemeSettingsScreen,
  /style=\{\{ height: SETTINGS_ROW_HEIGHT \}\}/,
);
assert.match(
  settingsStore,
  /loadSettings\([^)]*\): Promise<boolean>/,
  "settings state must expose one typed asynchronous load boundary, including the committed-import mode",
);
assert.match(settingsStore, /set\(\{ isLoading: true, error: null \}\)/);
assert.match(settingsStore, /function normalizeThemeMode\(value: unknown\)/);
assert.match(settingsStore, /function normalizeBooleanSetting\(value: unknown/);
assert.match(
  settingsStore,
  /values\.has\(SETTINGS_KEYS\.THEME\) && theme !== themeRaw/,
);
assert.match(
  settingsStore,
  /values\.has\(key\) && rawValue !== normalizedValue/,
);
assert.match(
  settingsStore,
  /async setTheme\(theme\)[\s\S]{0,160}if \(theme === get\(\)\.theme\) return true;/,
);
assert.match(
  settingsStore,
  /async setTheme\(theme\)[\s\S]{0,320}settingsMutationCoordinator\.submit\([\s\S]{0,220}set\(\{ theme, error: null \}\);[\s\S]{0,260}await submission\.completion/,
  "theme selection must publish its optimistic state in the same turn before awaiting durability",
);
assert.match(
  settingsMutationCoordinator,
  /submit<Scope[\s\S]{0,520}const ownedCommand = cloneMutationCommand\(command\)/,
  "each setting intent must become the latest owner and enter tracked per-scope persistence",
);
assert.match(
  settingsMutationCoordinator,
  /latestRevisionByScope\.set\(ownedCommand\.scope, revision\)/,
);
assert.match(
  settingsMutationCoordinator,
  /const completion = this\.trackDurable\([\s\S]{0,120}durableSequence,[\s\S]{0,120}this\.enqueueScope\(ownedCommand\.scope/,
);
assert.match(
  settingsMutationCoordinator,
  /private async executeCommand<Scope extends SettingMutationScope>[\s\S]{0,300}await this\.waitForDurableGate\(durableSequence\);/,
  "settings commands must honor an active exact-snapshot gate before SQLite dispatch",
);
assert.match(
  settingsMutationCoordinator,
  /!this\.isCurrent\(command\.scope, revision\) &&\s*!this\.isDurableSequencePinned\(durableSequence\)/,
  "pre-cutoff work must remain pinned even if a post-cutoff intent supersedes it",
);
assert.match(
  settingsMutationCoordinator,
  /const persistence = persistenceOperationForCommand\(\s*command,\s*confirmedColor,\s*command\.scope === "color" && this\.hasDirtyColorStructure\(\),\s*\)/,
  "the repository operation must be derived once from the owned command and current durable baseline",
);
assert.match(
  settingsMutationCoordinator,
  /if \(persistence\.kind === "write"\) \{\s*await \(\(\) => this\.dependencies\.write\(persistence\.entries\)\)\(\);\s*\} else \{\s*await \(\(\) => this\.dependencies\.delete\(persistence\.keys\)\)\(\);/,
  "a current setting command must commit its typed upsert/delete through the repository",
);
assert.match(
  settingsMutationCoordinator,
  /this\.confirmCommittedValue\(\s*command\.scope,\s*revision,\s*command\.value as SettingMutationValue<Scope>,\s*\);/,
  "a started SQLite commit must advance the durable baseline even if a newer intent arrived while it was in flight",
);
assert.match(
  settingsComposition,
  /export async function waitForAllPendingSettingsEffects[\s\S]{0,140}settingsMutationCoordinator\.whenEffectsIdle\(\)/,
  "import/reset must be able to drain old global i18n and reminder reconciliation separately",
);
assert.match(
  settingsMutationCoordinator,
  /async whenIdle\(\)[\s\S]{0,120}while \(true\)[\s\S]{0,140}for \(const repair of this\.pendingRepairs\) repair\.run\(\)[\s\S]{0,160}Promise\.allSettled\(\[\.\.\.this\.pending\]\)/,
  "the settings barrier must drain writes added during an earlier drain pass",
);
assert.match(
  settingsStore,
  /await settingsMutationCoordinator\.captureSettledLoadToken\(\)[\s\S]{0,120}readPersistedSettings\(\)/,
  "a settings SELECT must not overtake a mutation registered before load started",
);
assert.doesNotMatch(
  settingsMutationCoordinator,
  /requestAnimationFrame|runAfterUiPaint|setTimeout/,
  "settings durability must not depend on a timer or RAF that can pause in background",
);
assert.doesNotMatch(
  settingsStore,
  /persistLatestSettingAfterUiPaint|persistSettingAfterUiPaint|pendingSettingsPersistence|INSERT INTO settings|runtimeDb\.|@\/data\/|@\/db\/|@\/i18n\/config|@\/utils\/reminder-notifications|new SettingsMutationCoordinator/,
  "the Zustand store must not retain persistence/platform composition ownership or direct SQL",
);
assert.match(
  settingsRepository,
  /const valuesSql = entries\.map\(\(\) => "\(\?, \?\)"\)\.join\(", "\);[\s\S]*?INSERT INTO settings \(key, value\) VALUES \$\{valuesSql\}[\s\S]{0,120}ON CONFLICT\(key\) DO UPDATE SET value = excluded\.value/,
  "setting bundles must use one atomic multi-row UPSERT instead of serial bridge calls",
);
const settingsRepositoryWriteStart = settingsRepository.indexOf(
  "async function write(",
);
const settingsRepositoryDeleteStart = settingsRepository.indexOf(
  "async function deleteKeys(",
);
assert.ok(
  settingsRepositoryWriteStart >= 0 &&
    settingsRepositoryDeleteStart > settingsRepositoryWriteStart,
  "the settings repository must keep distinct write and delete operations",
);
assert.doesNotMatch(
  settingsRepository.slice(
    settingsRepositoryWriteStart,
    settingsRepositoryDeleteStart,
  ),
  /runtimeDb\.transaction/,
  "one SQLite UPSERT statement is already atomic and must not pay transaction setup",
);
assert.match(
  settingsRepository.slice(settingsRepositoryDeleteStart),
  /if \(keys\.length <= SQLITE_DELETE_BIND_CHUNK_SIZE\) \{[\s\S]{0,100}await deleteFrom\(runtimeDb\);[\s\S]{0,100}\} else \{[\s\S]{0,100}await runtimeDb\.transaction\(deleteFrom\);/,
  "settings deletion may open a transaction only when the bind limit requires multiple statements",
);
assert.match(
  settingsRepositoryPort,
  /export interface SettingsRepositoryPort[\s\S]{0,180}readAll\(\)[\s\S]{0,120}write\(entries/,
  "settings persistence must have one inward application port",
);
assert.match(
  settingsRepository,
  /from "@\/application\/settings\/settings-repository-port"/,
  "the SQLite settings adapter must depend on the application-owned port",
);
assert.match(
  settingsRepository,
  /settingsRepository: SettingsRepositoryPort = \{[\s\S]{0,120}\breadAll,\s*\bwrite,\s*\bdelete: deleteKeys,?\s*\}/,
  "the SQLite settings adapter must implement the application-owned port",
);
assert.doesNotMatch(
  settingsRepository,
  /export (?:type SettingsWriteEntry|interface SettingsRepository\b)/,
  "the SQLite adapter must not define a duplicate persistence contract",
);
const settingsRepairStart = settingsStore.indexOf(
  'if (mode === "settled" && repairs.length > 0) {',
);
const settingsRepairEnd = settingsStore.indexOf(
  "      return true;",
  settingsRepairStart,
);
assert.ok(
  settingsRepairStart >= 0 && settingsRepairEnd > settingsRepairStart,
  "ordinary startup loads must own a bounded normalization-repair section",
);
const settingsRepairSection = settingsStore.slice(
  settingsRepairStart,
  settingsRepairEnd,
);
assert.match(
  settingsRepairSection,
  /settingsMutationCoordinator\s*\.scheduleRepair\(/,
  "ordinary startup repairs must enter the tracked coordinator",
);
assert.match(
  settingsRepairSection,
  /repairs\.map\([\s\S]*scopes: getRepairMutationScopes\(entry\[0\]\)/,
  "each repair must declare the setting scopes it can overwrite",
);
assert.match(
  settingsMutationCoordinator,
  /scheduleRepair\([\s\S]{0,800}const generation = this\.generation;[\s\S]{0,160}const baselines = new Map\(this\.latestRevisionByScope\)/,
  "startup repairs must not overwrite a setting changed after their snapshot",
);
assert.match(
  settingsMutationCoordinator,
  /const performRepair = async \(\) => \{[\s\S]{0,180}await this\.waitForDurableGate\(durableSequence\)/,
  "a startup repair must cross the same durable snapshot gate as an explicit command",
);
assert.match(
  settingsMutationCoordinator,
  /if \(generation !== this\.generation\)[\s\S]{0,520}this\.latestRevisionByScope\.get\(scope\) === baselines\.get\(scope\)/,
  "a repair must recheck both snapshot generation and owned scope revisions immediately before writing",
);
assert.doesNotMatch(
  themeSettingsScreen,
  /await\s+setTheme|setTimeout|requestAnimationFrame|InteractionManager/,
  "theme rows must not delay the synchronous optimistic store update",
);
assert.match(
  settingsStore,
  /async setColorScheme\(scheme\)[\s\S]{0,280}if \(normalized === current\.colorScheme\) return true;/,
);
const setLanguageStart = settingsStore.indexOf("async setLanguage(language)");
const setLanguageEnd = settingsStore.indexOf(
  "\n  async setAskFailureReason",
  setLanguageStart,
);
assert.ok(setLanguageStart >= 0 && setLanguageEnd > setLanguageStart);
const setLanguageSource = settingsStore.slice(setLanguageStart, setLanguageEnd);
assert.match(
  setLanguageSource,
  /if \(normalizedLanguage === get\(\)\.language\) return true;/,
);
assert.match(
  setLanguageSource,
  /settingsMutationCoordinator\.submit\(\{[\s\S]{0,100}scope,[\s\S]{0,100}value: normalizedLanguage[\s\S]{0,180}set\(\{ language: normalizedLanguage, error: null \}\);[\s\S]{0,320}await submission\.completion/,
  "the focused language must publish in the current turn while durable/global work stays typed and coordinated",
);
assert.match(
  settingsMutationCoordinator,
  /case "language":[\s\S]{0,100}SETTINGS_KEYS\.LANGUAGE, command\.value/,
  "the coordinator must derive both durable language data and its global side effect from one typed value",
);
assert.match(
  settingsMutationCoordinator,
  /scope === "language"[\s\S]{0,180}kind: "language", language: value as string/,
);
assert.match(
  settingsComposition,
  /function changeI18nLanguageInCurrentTurn\([\s\S]{0,120}const change = i18n\.changeLanguage\(language\);/,
  "language application must invoke i18next synchronously in the accepted settings effect",
);
assert.doesNotMatch(
  settingsMutationCoordinator,
  /await this\.dependencies\.changeLanguage[\s\S]{0,300}dependencies\.write/,
  "global i18n reconciliation must not hold the durable settings write",
);
for (const source of [
  settingsScreen,
  themeSettingsScreen,
  languageSettingsScreen,
  colorSchemeSettingsScreen,
]) {
  assert.doesNotMatch(
    source,
    /useSettingsStore\(\)/,
    "settings screens must subscribe only to the fields they render",
  );
}
assert.match(
  settingsMutationCoordinator,
  /confirmedByScope = new Map/,
  "all settings scopes need one coordinator-owned confirmed baseline registry",
);
assert.match(
  settingsMutationCoordinator,
  /replaceConfirmedSnapshot\([\s\S]{0,1800}confirmedByScope\.set/,
);
assert.match(
  settingsMutationCoordinator,
  /confirmCommittedValue<Scope[\s\S]{0,260}revision < current\.revision/,
  "out-of-order completions must not move a confirmed baseline backwards",
);
assert.match(
  settingsMutationCoordinator,
  /case "color":[\s\S]{0,700}COLOR_SCHEME_OPTIONS[\s\S]{0,180}BUILTIN_COLOR_OVERRIDES[\s\S]{0,180}CUSTOM_COLORS[\s\S]{0,180}COLOR_SCHEME/,
  "structural color mutations must have one coherent option/override/selection bundle writer",
);
assert.match(
  settingsStore,
  /async setTheme\(theme\)[\s\S]{0,900}settingsMutationCoordinator\.isLatest\(submission\)[\s\S]{0,180}theme: result\.confirmedValue/,
  "a failed latest theme mutation must roll back to the last confirmed theme",
);
assert.match(
  setLanguageSource,
  /settingsMutationCoordinator\.isLatest\(submission\)[\s\S]{0,120}set\(\{[\s\S]{0,120}language: result\.confirmedValue/,
  "a failed latest language mutation must restore the visible scene from the coordinator baseline",
);
assert.match(
  settingsMutationCoordinator,
  /const confirmedValue = this\.getConfirmedValue\(command\.scope\)[\s\S]{0,320}sideEffectForValue\(command\.scope, confirmedValue\)[\s\S]{0,220}"rollback"/,
  "a failed latest language mutation must request global i18n rollback from that same baseline",
);
assert.doesNotMatch(
  setLanguageSource,
  /whenEffectsIdle|scheduleReminderNotificationLocalizationRefresh/,
  "the setter must not register reminder work after the settings-effects barrier has already settled",
);
assert.match(
  settingsComposition,
  /function changeI18nLanguageInCurrentTurn[\s\S]{0,700}Promise\.resolve\(change\)\.then\(\s*\(\) => \{[\s\S]{0,500}scheduleReminderNotificationLocalizationRefresh\(\)/,
  "language apply and rollback must register global reminder work before their settings effect settles",
);
const loadedSettingsPublishIndex = settingsStore.indexOf("...loadedSettings,");
const loadedSettingsEffectsIndex = settingsStore.indexOf(
  "registerLoadedSettingsPlatformEffects();",
  loadedSettingsPublishIndex,
);
assert.ok(
  loadedSettingsPublishIndex >= 0 &&
    loadedSettingsEffectsIndex > loadedSettingsPublishIndex &&
    loadedSettingsEffectsIndex - loadedSettingsPublishIndex < 500,
  "settings reload/import must synchronously register platform reconciliation after publishing the loaded snapshot",
);
assert.match(
  settingsComposition,
  /registerLoadedSettingsPlatformEffects[\s\S]{0,220}scheduleReminderNotificationLocalizationRefresh\(\);[\s\S]{0,180}reconcileConfirmedSideEffect\([\s\S]{0,80}"reminderNotifications"/,
  "load-time reminder master reconciliation must be visible to the settings effect barrier",
);
assert.match(
  reminderService,
  /async flushAndFreezePendingReminderWork[\s\S]{0,420}this\.replacementGate\.enter\(\)/,
  "import must freeze newly accepted native reminder work through publication",
);
const setColorSchemeStart = settingsStore.indexOf("async setColorScheme(");
const setColorSchemeEnd = settingsStore.indexOf(
  "\n  async addColorScheme",
  setColorSchemeStart,
);
assert.ok(
  setColorSchemeStart >= 0 && setColorSchemeEnd > setColorSchemeStart,
  "setColorScheme must remain independently auditable",
);
const setColorSchemeSource = settingsStore.slice(
  setColorSchemeStart,
  setColorSchemeEnd,
);
assert.match(
  setColorSchemeSource,
  /settingsMutationCoordinator\.submit\(\{[\s\S]{0,120}value: nextColorSettings,[\s\S]{0,80}operation: "select"/,
  "the store must express color selection intent without duplicating persistence rules",
);
assert.match(
  settingsMutationCoordinator,
  /command\.operation === "select"[\s\S]{0,160}haveEqualColorStructure\(command\.value, confirmedColor\)[\s\S]{0,120}SETTINGS_KEYS\.COLOR_SCHEME, command\.value\.colorScheme/,
  "a rapid selection must carry the complete unconfirmed color structure",
);
assert.match(
  settingsMutationCoordinator,
  /haveEqualColorStructure\(command\.value, confirmedColor\)[\s\S]{0,120}\[\[SETTINGS_KEYS\.COLOR_SCHEME, command\.value\.colorScheme\]\][\s\S]{0,520}SETTINGS_KEYS\.CUSTOM_COLORS/,
  "an ordinary selection must retain the one-key persistence fast path",
);
assert.match(
  settingsMutationCoordinator,
  /function haveEqualColorStructure\([\s\S]{0,700}colorSchemeOptions[\s\S]{0,500}builtinColorOverrides[\s\S]{0,500}customColors/,
  "color persistence coalescing must compare every separately persisted structural field",
);
assert.match(
  setColorSchemeSource,
  /settingsMutationCoordinator\.submit\([\s\S]{0,160}value: nextColorSettings/,
);
assert.match(
  setColorSchemeSource,
  /settingsMutationCoordinator\.isLatest\(submission\)[\s\S]{0,160}cloneColorSettingsBundle\(result\.confirmedValue\)/,
);
for (const colorMutationName of [
  "addColorScheme",
  "updateColorScheme",
  "removeColorScheme",
]) {
  const mutationStart = settingsStore.indexOf(`async ${colorMutationName}(`);
  const mutationEnd = settingsStore.indexOf("\n  async ", mutationStart + 8);
  const mutationSource = settingsStore.slice(
    mutationStart,
    mutationEnd < 0 ? settingsStore.length : mutationEnd,
  );
  assert.ok(mutationStart >= 0, `${colorMutationName} must exist`);
  assert.match(
    mutationSource,
    /settingsMutationCoordinator\.submit\([\s\S]{0,120}scope,[\s\S]{0,120}value: nextColorSettings,[\s\S]{0,120}operation: "replace-bundle"/,
    `${colorMutationName} must submit one coherent color-bundle command`,
  );
  assert.match(mutationSource, /await submission\.completion/);
  assert.match(
    mutationSource,
    /settingsMutationCoordinator\.isLatest\(submission\)[\s\S]{0,160}cloneColorSettingsBundle\(result\.confirmedValue\)/,
  );
}
for (const [actionName, fieldName] of [
  ["setAskFailureReason", "askFailureReason"],
  ["setAskSkipReason", "askSkipReason"],
  ["setSoundEnabled", "soundEnabled"],
  ["setShowArchivedHabitsInStatistics", "showArchivedHabitsInStatistics"],
] as const) {
  const mutationStart = settingsStore.indexOf(`async ${actionName}(`);
  const mutationEnd = settingsStore.indexOf("\n  async ", mutationStart + 8);
  const mutationSource = settingsStore.slice(
    mutationStart,
    mutationEnd < 0 ? settingsStore.length : mutationEnd,
  );
  assert.ok(mutationStart >= 0, `${actionName} must exist`);
  assert.match(
    mutationSource,
    /settingsMutationCoordinator\.submit\([\s\S]{0,320}set\(/,
  );
  assert.match(
    mutationSource,
    /await submission\.completion/,
    `${actionName} must await the tracked coordinator result`,
  );
  assert.match(
    mutationSource,
    new RegExp(
      `settingsMutationCoordinator\\.isLatest\\(submission\\)[\\s\\S]{0,240}${fieldName}:[\\s\\S]{0,80}result\\.confirmedValue`,
    ),
  );
}
const reminderToggleMutationSource = settingsStore.match(
  /async setReminderNotificationsEnabled[\s\S]*?async setStatisticsBlockOrder/,
)?.[0];
assert.ok(
  reminderToggleMutationSource,
  "the reminder notification mutation boundary must remain auditable",
);
assert.match(
  reminderToggleMutationSource,
  /settingsMutationCoordinator\.submit\(\{[\s\S]{0,100}scope,[\s\S]{0,100}value: enabled/,
  "a reminder toggle must use the typed durable/native command",
);
assert.match(
  reminderToggleMutationSource,
  /settingsMutationCoordinator\.isLatest\(submission\)[\s\S]{0,180}reminderNotificationsEnabled: result\.confirmedValue/,
  "a failed latest reminder toggle must restore its confirmed UI value",
);
const settingsCommandExecution = settingsMutationCoordinator.match(
  /  private async executeCommand<Scope extends SettingMutationScope>\([\s\S]*?\n  private requestSideEffect\(/,
)?.[0];
assert.ok(
  settingsCommandExecution,
  "the settings command execution boundary must remain auditable",
);
const settingsPersistenceIndex = settingsCommandExecution.indexOf(
  'if (persistence.kind === "write")',
);
assert.match(
  settingsCommandExecution,
  /if \(persistence\.kind === "write"\) \{\s*await \(\(\) => this\.dependencies\.write\(persistence\.entries\)\)\(\);\s*\} else \{\s*await \(\(\) => this\.dependencies\.delete\(persistence\.keys\)\)\(\);/,
  "settings commands must persist through the typed write/delete adapter boundary",
);
const settingsConfirmationIndex = settingsCommandExecution.indexOf(
  "this.confirmCommittedValue(",
);
const settingsEffectRequestIndex = settingsCommandExecution.indexOf(
  'this.requestSideEffect(effect.scope, revision, effect.effect, "apply");',
);
assert.ok(
  settingsPersistenceIndex >= 0 &&
    settingsConfirmationIndex > settingsPersistenceIndex &&
    settingsEffectRequestIndex > settingsConfirmationIndex,
  "durable confirmation must precede reminder or language native reconciliation",
);
assert.match(
  settingsMutationCoordinator,
  /scope === "reminderNotifications"[\s\S]{0,180}kind: "reminder-master", enabled: value as boolean/,
  "a failed latest reminder toggle must reconcile the native notification owner",
);
assert.match(
  settingsMutationCoordinator,
  /sideEffectForValue\(command\.scope, confirmedValue\)[\s\S]{0,220}"rollback"/,
);
assert.match(
  settingsStore,
  /async setStatisticsBlockOrder[\s\S]{0,700}const scope = `statisticsOrder:\$\{period\}`[\s\S]{0,500}settingsMutationCoordinator\.submit\([\s\S]{0,500}settingsMutationCoordinator\.isLatest\(submission\)[\s\S]{0,300}result\.confirmedValue/,
  "statistics order failures must restore the last confirmed order for that period",
);
assert.match(settingsStore, /const colorScheme = next/);
assert.match(settingsMutationCoordinator, /persistenceOperationForCommand/);
assert.match(
  settingsStore,
  /readSettingFromMap<unknown>\([\s\S]{0,80}SETTINGS_KEYS\.COLOR_SCHEME_OPTIONS,[\s\S]{0,30}null/,
);
assert.match(
  settingsStore,
  /readSettingFromMap<unknown>\([\s\S]{0,80}SETTINGS_KEYS\.BUILTIN_COLOR_OVERRIDES,[\s\S]{0,30}null/,
);
assert.match(
  settingsStore,
  /normalizeColorSchemeOptions\([\s\S]{0,100}legacyCustomColors/,
);
assert.match(
  settingsStore,
  /if \(!normalized \|\| current\.colorSchemeOptions\.length <= 1\) return false;/,
);
assert.match(
  settingsStore,
  /getSelectionAfterColorRemoval\([\s\S]{0,120}current\.colorScheme/,
);
assert.match(
  settingsMutationCoordinator,
  /SETTINGS_KEYS\.COLOR_SCHEME_OPTIONS,\s*command\.value\.colorSchemeOptions[\s\S]{0,180}SETTINGS_KEYS\.BUILTIN_COLOR_OVERRIDES,\s*command\.value\.builtinColorOverrides[\s\S]{0,180}SETTINGS_KEYS\.CUSTOM_COLORS,\s*command\.value\.customColors[\s\S]{0,180}SETTINGS_KEYS\.COLOR_SCHEME,\s*command\.value\.colorScheme/,
);
assert.match(
  settingsStore,
  /isBuiltinColorScheme\(previous\)[\s\S]{0,240}findOverriddenBuiltinColor[\s\S]{0,240}builtinColorOverrides\[overriddenBuiltin\] = next/,
);
assert.match(
  settingsStore,
  /findOverriddenBuiltinColor\([\s\S]{0,140}normalized[\s\S]{0,120}delete builtinColorOverrides\[removedOverride\]/,
);
assert.match(
  settingsMutationCoordinator,
  /function persistenceOperationForCommand[\s\S]{0,1800}SETTINGS_KEYS\.BUILTIN_COLOR_OVERRIDES/,
  "add, edit, and delete must preserve builtin override identity in their structural bundle",
);

const customColorDialog = read(
  "src/features/settings/components/CustomColorDialog.tsx",
);
assert.match(
  customColorDialog,
  /<Dialog[\s\S]{0,1200}contentStyle=\{\[[\s\S]{0,120}width: dialogWidth/,
  "the established 320dp custom-color card width must override the shared dialog's default card width",
);
assert.match(
  customColorDialog,
  /const dialogWidth = Math\.min\(320, windowWidth - 32\)/,
  "the custom-color dialog must keep its wider geometry on narrow and regular screens",
);
assert.match(
  customColorDialog,
  /saturationValueDragStart\.current\.x \+ gestureState\.dx/,
);
assert.match(
  customColorDialog,
  /saturationValueDragStart\.current\.y \+ gestureState\.dy/,
);
assert.match(customColorDialog, /hueDragStartX\.current \+ gestureState\.dx/);
assert.match(customColorDialog, /clamp\([\s\S]{0,120}0,[\s\S]{0,40}width/);
assert.match(
  customColorDialog,
  /onSubmit: \(color: CustomColorScheme\) => Promise<boolean> \| boolean/,
  "custom-color submission must return its durable success to the dialog owner",
);
assert.match(
  customColorDialog,
  /onDelete\?: \(\) => Promise<boolean> \| boolean/,
  "custom-color deletion must return its durable success to the dialog owner",
);
assert.doesNotMatch(
  customColorDialog,
  /use(?:Layout)?Effect\(\(\) => \{[\s\S]{0,500}(?:setHsv\(initialHsv\)|setHexInput\(initial\))/,
  "an already-open color draft must not be reseeded by an effect",
);
assert.match(customColorDialog, /function CustomColorDialogSession\(/);
assert.match(
  customColorDialog,
  /type CustomColorDialogSessionSnapshot = Pick<[\s\S]{0,100}"initialColor"/,
  "only a custom color dialog's opening color may seed its draft",
);
assert.match(
  customColorDialog,
  /initialColor=\{snapshot\.initialColor\}[\s\S]{0,180}onCancel=\{props\.onCancel\}[\s\S]{0,80}onSubmit=\{props\.onSubmit\}/,
  "custom color validation and actions must remain current while open",
);
assert.match(
  customColorDialog,
  /type CustomColorDialogSessionSnapshot = Pick<[\s\S]{0,180}"canDelete" \| "onDelete"/,
  "the retained edit-color session must preserve its delete affordance through the closing fade",
);
assert.match(
  customColorDialog,
  /canDelete=\{snapshot\.canDelete\}[\s\S]{0,80}onDelete=\{snapshot\.onDelete\}/,
  "closing an edit-color dialog must not drop its menu before native dismissal",
);
const customColorSessionStart = customColorDialog.indexOf(
  "function CustomColorDialogSession(",
);
const customColorOwnerStart = customColorDialog.indexOf(
  "function CustomColorDialogComponent(",
);
assert.ok(
  customColorSessionStart >= 0 &&
    customColorOwnerStart > customColorSessionStart &&
    customColorDialog
      .slice(customColorSessionStart, customColorOwnerStart)
      .includes("onDismiss={onDismiss}") &&
    customColorDialog
      .slice(customColorOwnerStart)
      .includes("useRetainedModalSession"),
  "custom color dialog must retain its opening snapshot until native dismissal",
);
assert.match(
  customColorDialog,
  /key=\{session\.key\}[\s\S]{0,120}visible=\{props\.visible\}/,
);
assert.match(
  customColorDialog,
  /submittedColorRef\.current = normalizedColor;[\s\S]{0,80}setIsSubmitting\(true\)/,
);
assert.match(
  customColorDialog,
  /isDuplicate && !isSubmittedColorUpdate[\s\S]{0,100}\? "colorSchemeScreen\.duplicateColor"/,
);
assert.match(
  customColorDialog,
  /disabled: !normalizedColor \|\| isDuplicate \|\| isSubmitting/,
);
assert.match(
  customColorDialog,
  /icon: "trash-sharp",[\s\S]{0,80}iconFamily: "ionicons"/,
);
assert.doesNotMatch(customColorDialog, /icon: "delete"|delete-outline/);
assert.equal(
  (
    customColorDialog.match(/pointerEvents=\{disabled \? "none" : "auto"\}/g) ??
    []
  ).length,
  2,
);
assert.doesNotMatch(
  customColorDialog,
  /setDialogHeight|setSaturationValueLayout|setHueLayoutWidth/,
  "initial native picker measurements must not rebuild the complete dialog owner",
);
assert.match(customColorDialog, /const dialogHeightRef = useRef\(0\)/);
assert.match(
  customColorDialog,
  /setKeyboardTop\(event\.endCoordinates\.screenY\)/,
);
assert.match(
  customColorDialog,
  /const centeredDialogBottom = \(screenHeight \+ dialogHeight\) \/ 2/,
);
assert.match(
  customColorDialog,
  /const overlap = centeredDialogBottom - keyboardTop/,
);
assert.match(
  customColorDialog,
  /const requiredShift = Math\.max\(0, overlap \+ 16\)/,
);
assert.match(
  customColorDialog,
  /return -Math\.min\(requiredShift, highestSafeShift\)/,
);
assert.match(customColorDialog, /return -112/);
assert.match(customColorDialog, /paddingTop: 17/);
assert.match(customColorDialog, /titleStyle=\{\{ marginBottom: 13 \}\}/);
assert.match(
  customColorDialog,
  /actionsContainerStyle=\{\{ marginTop: 18 \}\}/,
);
assert.doesNotMatch(customColorDialog, /colorSchemeScreen\.pickerHint/);
assert.match(
  customColorDialog,
  /const DEFAULT_COLOR: CustomColorScheme = "#3B82F6"/,
);
assert.match(customColorDialog, /locations=\{\[0, 0\.98\]\}/);
assert.match(
  customColorDialog,
  /saturationValueGradient: \{[\s\S]{0,180}top: -1,[\s\S]{0,80}right: -1,[\s\S]{0,80}bottom: -1,[\s\S]{0,80}left: -1/,
);
assert.doesNotMatch(
  customColorDialog,
  /saturationValueGradient: \{[\s\S]{0,120}borderRadius/,
  "the palette must use one rounded clipping mask, not independently antialiased gradient corners",
);
assert.match(customColorDialog, /errorKey \? t\(errorKey\) : " "/);
assert.doesNotMatch(
  customColorDialog,
  /errorKey \? t\(errorKey\) : t\("colorSchemeScreen\.hexLabel"\)/,
);
assert.match(
  customColorDialog,
  /transform: \[\{ translateY: keyboardTranslateY \}\]/,
);
assert.match(customColorDialog, /function CustomColorDialogSession\(/);
assert.match(
  customColorDialog,
  /onFocus=\{\(\) => \{[\s\S]{0,240}setIsHexInputFocused\(true\);[\s\S]{0,80}\}\}/,
);
const hexBlurHandlerSource = customColorDialog.slice(
  customColorDialog.indexOf("onBlur={() => {"),
  customColorDialog.indexOf('autoCapitalize="characters"'),
);
assert.ok(hexBlurHandlerSource.length > 0);
assert.match(
  hexBlurHandlerSource,
  /onBlur=\{\(\) => \{\s*setIsHexInputFocused\(false\);/,
  "HEX blur must release the focused-state keyboard offset",
);
assert.match(
  customColorDialog,
  /Platform\.OS === "ios" \? "keyboardWillShow" : "keyboardDidShow"[\s\S]{0,320}setIsHexInputFocused\(true\)/,
);
assert.match(
  customColorDialog,
  /Platform\.OS === "ios" \? "keyboardWillHide" : "keyboardDidHide"[\s\S]{0,650}setIsHexInputFocused\(false\)/,
);
assert.match(
  customColorDialog,
  /icon: "more-vert"[\s\S]{0,160}colorSchemeScreen\.colorOptions/,
);
assert.match(
  customColorDialog,
  /label: t\("colorSchemeScreen\.deleteColor"\)[\s\S]{0,160}disabled: !canDelete \|\| isSubmitting/,
);
assert.match(
  customColorDialog,
  /accessibilityHint: !canDelete[\s\S]{0,100}colorSchemeScreen\.lastColorCannotDelete/,
);
const colorSchemeScreen = read("app/settings/color-scheme.tsx");
const colorPickerControllerSource = colorSchemeScreen.slice(
  colorSchemeScreen.indexOf("const ColorPickerController = React.memo("),
  colorSchemeScreen.indexOf("export default function ColorSchemeScreen()"),
);
assert.ok(colorPickerControllerSource.length > 0);
assert.match(
  colorSchemeScreen,
  /const persistence = editingScheme[\s\S]{0,400}setPickerVisible\(false\);[\s\S]{0,900}setPickerInitialColor\(color\);[\s\S]{0,80}setPickerVisible\(true\);/,
  "color submit must close against optimistic state and restore the exact draft after a latest persistence failure",
);
assert.match(
  colorSchemeScreen,
  /const persistence = removeColorScheme\(editingScheme\);[\s\S]{0,80}setPickerVisible\(false\);[\s\S]{0,900}setPickerInitialColor\(originalColor\);[\s\S]{0,80}setPickerVisible\(true\);/,
  "color delete must close against optimistic state and restore the exact color after a latest persistence failure",
);
assert.match(colorSchemeScreen, /onSubmit=\{handleSubmit\}/);
assert.doesNotMatch(
  colorSchemeScreen,
  /onSubmit=\{\(color\) => void handleSubmit\(color\)\}/,
);
assert.match(
  colorPickerControllerSource,
  /const openEdit = useCallback\(\(scheme: ColorScheme\) => \{\s*pickerOperationRef\.current \+= 1;\s*setEditingScheme\(scheme\);[\s\S]{0,240}setPickerInitialColor\([\s\S]{0,160}setPickerVisible\(true\);/,
  "opening color editing must invalidate stale persistence recovery and seed the requested draft",
);
assert.doesNotMatch(
  colorPickerControllerSource,
  /const openEdit = useCallback\([\s\S]{0,360}setColorScheme/,
);
assert.match(
  colorSchemeScreen,
  /const pickerControllerRef = useRef<ColorPickerControllerHandle>\(null\)[\s\S]{0,500}pickerControllerRef\.current\?\.openEdit\(scheme\)/,
  "the color list must delegate editing without owning the dialog state",
);
assert.match(
  colorSchemeScreen,
  /const selectColor = useCallback\([\s\S]{0,500}void setColorScheme\(scheme\);/,
);
assert.match(colorSchemeScreen, /onSelect=\{selectColor\}/);
assert.match(colorSchemeScreen, /onEdit=\{openEdit\}/);
assert.match(
  colorSchemeScreen,
  /const editHint = t\("colorSchemeScreen\.editHint"\);[\s\S]{0,1400}editHint=\{editHint\}/,
);
assert.match(
  colorSchemeScreen,
  /onLongPress=[\s\S]{0,160}longPressTriggeredRef\.current = true[\s\S]{0,520}delayLongPress=\{180\}/,
);
assert.match(
  colorSchemeScreen,
  /event\.stopPropagation\(\);\s*onEdit\(color\);/,
  "the color preview edit control must not also select its parent row",
);
assert.match(
  colorSchemeScreen,
  /getAccentScheme\(editingScheme\)\.base\.toUpperCase\(\) === color[\s\S]{0,60}closePicker\(\);\s*return true;/,
  "an unchanged color submit must close without creating another durable mutation",
);
assert.match(
  colorSchemeScreen,
  /const persistence = removeColorScheme\(editingScheme\);[\s\S]{0,80}setPickerVisible\(false\);/,
);
assert.match(colorSchemeScreen, /canDelete=\{colorSchemeOptions\.length > 1\}/);
assert.doesNotMatch(
  colorSchemeScreen,
  /name="close"|deleteCustom|removeCustomColor|BUILTIN_COLOR_SCHEMES\.map/,
);

const notesScreen = read("app/habit/[id]/notes.tsx");
const noteRepository = read("src/data/sqlite/note-repository.ts");
const notesApplication = read("src/application/notes/notes-application.ts");
const notesSession = read("src/application/notes/notes-session.ts");
const notesComposition = read("src/composition/notes.ts");
assert.match(
  notesScreen,
  /<KeyboardAvoidingView[\s\S]{0,160}behavior=\{Platform\.OS === "ios" \? "padding" : undefined\}/,
  "Android notes must let the adjustResize window own keyboard layout while iOS uses padding",
);
assert.doesNotMatch(
  notesScreen,
  /react-native-keyboard-controller|ControlledKeyboardAvoidingView|KeyboardEvents/,
  "notes must not combine adjustResize with a second Android keyboard layout owner",
);
assert.match(
  notesScreen,
  /const screenHeight = Dimensions\.get\("screen"\)\.height/,
);
assert.match(
  notesScreen,
  /getReportedKeyboardOverlap\(\{[\s\S]{0,400}preferEventHeight:[\s\S]{0,120}Platform\.OS === "android" && nativeKeyboardLayoutOwner[\s\S]{0,900}setKeyboardOverlap\(selectedOverlap\)/,
);
assert.match(
  notesScreen,
  /maximumRootLayoutHeightRef\.current = Math\.max\([\s\S]{0,110}maximumRootLayoutHeightRef\.current,[\s\S]{0,40}rootLayoutHeight/,
);
assert.match(
  notesScreen,
  /getNoteKeyboardLayoutMetrics\(\{[\s\S]{0,180}maximumLayoutHeight: maximumRootLayoutHeightRef\.current,[\s\S]{0,100}currentLayoutHeight: rootLayoutHeight,[\s\S]{0,100}keyboardOverlap,[\s\S]{0,120}nativeLayoutOwner: nativeKeyboardLayoutOwner/,
);
assert.match(notesScreen, /onLayout=\{handleRootLayout\}/);
assert.match(
  notesScreen,
  /const nextHeight = event\.nativeEvent\.layout\.height;[\s\S]{0,900}setRootLayoutHeight/,
);
assert.doesNotMatch(
  notesScreen,
  /useWindowDimensions|reactiveWindow/,
  "Notes must use one reactive keyboard-layout source",
);
assert.match(
  notesScreen,
  /Constants\.executionEnvironment === ExecutionEnvironment\.StoreClient/,
  "Expo Go must use native root resize as its keyboard-layout owner",
);
assert.doesNotMatch(
  notesScreen,
  /baselineWindowHeightRef|usesSystemResize|fallbackKeyboardInset/,
  "a resized keyboard viewport must never replace the maximum unoccluded baseline",
);
assert.match(
  notesScreen,
  /const editorKeyboardLift =[\s\S]{0,120}editingNoteIds\.size > 0[\s\S]{0,80}viewportKeyboardLift/,
);
function assertNotesKeyboardViewport(source: string): void {
  const tree = ts.createSourceFile(
    "notes.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const viewports: ts.JsxOpeningElement[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxOpeningElement(node) &&
      node.tagName.getText(tree) === "KeyboardAvoidingView"
    ) {
      viewports.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(
    viewports.length,
    1,
    "the note list must retain one keyboard viewport owner",
  );
  const properties = viewports[0].attributes.properties;
  assert.ok(
    properties.every((property) => ts.isJsxAttribute(property)),
    "viewport props must not hide a later style override in a spread",
  );
  const attribute = (name: string): ts.JsxAttribute => {
    const matches = properties.filter(
      (property): property is ts.JsxAttribute =>
        ts.isJsxAttribute(property) && property.name.getText(tree) === name,
    );
    assert.equal(
      matches.length,
      1,
      `the viewport must own exactly one ${name} prop`,
    );
    return matches[0];
  };
  const interop = attribute("cssInterop").initializer;
  assert.ok(
    interop &&
      ts.isJsxExpression(interop) &&
      interop.expression?.kind === ts.SyntaxKind.FalseKeyword,
    "the composite keyboard viewport must receive primitive native styles",
  );
  assert.ok(
    !properties.some(
      (property) =>
        ts.isJsxAttribute(property) &&
        property.name.getText(tree) === "className",
    ),
    "the bypassed keyboard viewport must not depend on a remapped className",
  );
  const style = attribute("style").initializer;
  assert.ok(
    style &&
      ts.isJsxExpression(style) &&
      style.expression &&
      ts.isObjectLiteralExpression(style.expression),
    "the keyboard viewport must own an explicit native style object",
  );
  const fields = style.expression.properties;
  assert.equal(
    fields.length,
    3,
    "the viewport style must preserve its three primitive fields",
  );
  const field = (name: string): ts.Expression => {
    const matches = fields.filter(
      (
        property,
      ): property is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
        (ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property)) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === name,
    );
    assert.equal(
      matches.length,
      1,
      `the viewport style must own exactly one ${name} field`,
    );
    const property = matches[0];
    if (ts.isShorthandPropertyAssignment(property)) return property.name;
    assert.ok(
      ts.isPropertyAssignment(property),
      "viewport style fields must not be spread or computed",
    );
    return property.initializer;
  };
  const flex = field("flex");
  assert.ok(
    ts.isNumericLiteral(flex) && Number(flex.text) === 1,
    "the keyboard viewport must retain flex-one geometry",
  );
  const padding = field("paddingBottom");
  assert.ok(
    ts.isIdentifier(padding) && padding.text === "editorKeyboardLift",
    "the note list viewport must end above an overlay keyboard while a card is edited",
  );
  const background = field("backgroundColor");
  assert.ok(
    ts.isIdentifier(background) && background.text === "backgroundColor",
    "the primitive viewport background must use its visual preference color",
  );
}
assertNotesKeyboardViewport(notesScreen);
for (const [before, after] of [
  ["cssInterop={false}", "cssInterop={true}"],
  ["flex: 1, backgroundColor", "flex: 0, backgroundColor"],
  ["paddingBottom: editorKeyboardLift", "paddingBottom: 0"],
  ["paddingBottom: editorKeyboardLift", "paddingBottom: composerKeyboardLift"],
]) {
  assert.equal(
    notesScreen.split(before).length - 1,
    1,
    "viewport mutation must identify one source site",
  );
  assert.throws(
    () => assertNotesKeyboardViewport(notesScreen.replace(before, after)),
    (error: unknown) => error instanceof assert.AssertionError,
    "viewport mutations must fail the actual JSX prop or geometry contract",
  );
}
assert.doesNotMatch(
  notesScreen,
  /listKeyboardInset/,
  "keyboard reveal coordinates must not introduce a second list inset owner",
);

assert.deepEqual(
  getNoteKeyboardLayoutMetrics({
    maximumLayoutHeight: 800,
    currentLayoutHeight: 440,
    keyboardOverlap: 0,
    bottomInset: 24,
    nativeLayoutOwner: false,
  }),
  {
    keyboardVisible: false,
    systemResizeInset: 0,
    composerKeyboardLift: 0,
    viewportKeyboardLift: 0,
  },
  "resize before keyboardDidShow must not pre-emptively move the composer",
);
assert.deepEqual(
  getNoteKeyboardLayoutMetrics({
    maximumLayoutHeight: 800,
    currentLayoutHeight: 440,
    keyboardOverlap: 360,
    bottomInset: 24,
    nativeLayoutOwner: false,
  }),
  {
    keyboardVisible: true,
    systemResizeInset: 360,
    composerKeyboardLift: 0,
    viewportKeyboardLift: 0,
  },
  "a full Expo Go adjustResize must never receive a second keyboard inset",
);
assert.deepEqual(
  getNoteKeyboardLayoutMetrics({
    maximumLayoutHeight: 800,
    currentLayoutHeight: 464,
    keyboardOverlap: 360,
    bottomInset: 24,
    nativeLayoutOwner: false,
  }),
  {
    keyboardVisible: true,
    systemResizeInset: 336,
    composerKeyboardLift: 0,
    viewportKeyboardLift: 24,
  },
  "composer safe-area padding and editor viewport coverage are different contracts",
);
assert.deepEqual(
  getNoteKeyboardLayoutMetrics({
    maximumLayoutHeight: 800,
    currentLayoutHeight: 800,
    keyboardOverlap: 360,
    bottomInset: 24,
    nativeLayoutOwner: false,
  }),
  {
    keyboardVisible: true,
    systemResizeInset: 0,
    composerKeyboardLift: 336,
    viewportKeyboardLift: 360,
  },
  "an overlay keyboard must be covered manually without double-counting the safe area",
);
assert.deepEqual(
  getNoteKeyboardLayoutMetrics({
    maximumLayoutHeight: 800,
    currentLayoutHeight: 600,
    keyboardOverlap: 360,
    bottomInset: 24,
    nativeLayoutOwner: false,
  }),
  {
    keyboardVisible: true,
    systemResizeInset: 200,
    composerKeyboardLift: 136,
    viewportKeyboardLift: 160,
  },
  "partial native resize must add only the genuinely uncovered keyboard area",
);
assert.deepEqual(
  getNoteKeyboardLayoutMetrics({
    maximumLayoutHeight: 791.3,
    currentLayoutHeight: 791.3,
    keyboardOverlap: 284,
    bottomInset: 0,
    nativeLayoutOwner: true,
  }),
  {
    keyboardVisible: true,
    systemResizeInset: 284,
    composerKeyboardLift: 0,
    viewportKeyboardLift: 0,
  },
  "a native root resize remains the sole layout owner when window dimensions are stale",
);
assert.equal(
  getReportedKeyboardOverlap({
    eventHeight: 284,
    overlapFromScreenY: 331.3,
    preferEventHeight: true,
  }),
  284,
  "Android keyboard height must exclude the system navigation region",
);
assert.equal(
  getReportedKeyboardOverlap({
    eventHeight: 284,
    overlapFromScreenY: 331.3,
    preferEventHeight: false,
  }),
  331.3,
  "a standalone edge-to-edge root must use the physical keyboard top, including the system navigation region",
);
const standaloneComposerMetrics = getNoteKeyboardLayoutMetrics({
  maximumLayoutHeight: 872.7,
  currentLayoutHeight: 872.7,
  keyboardOverlap: 331.3,
  bottomInset: 47.3,
  nativeLayoutOwner: false,
});
assert.deepEqual(
  standaloneComposerMetrics,
  {
    keyboardVisible: true,
    systemResizeInset: 0,
    composerKeyboardLift: 284,
    viewportKeyboardLift: 331.3,
  },
  "standalone Notes must lift both the composer and editor viewport to the physical keyboard top",
);
assert.equal(
  getNoteComposerBottomPadding({
    bottomInset: 47.3,
    extraKeyboardLift: standaloneComposerMetrics.composerKeyboardLift,
    keyboardVisible: true,
  }),
  337.3,
  "an edge-to-edge composer must preserve a six dp gap above the physical keyboard top",
);
assert.equal(
  getReportedKeyboardOverlap({
    eventHeight: 0,
    overlapFromScreenY: 331.3,
    preferEventHeight: true,
  }),
  331.3,
  "screen coordinates remain a fallback when Android omits keyboard height",
);
assert.equal(NOTE_COMPOSER_KEYBOARD_GAP, 6);
assert.equal(
  getNoteComposerBottomPadding({
    bottomInset: 0,
    extraKeyboardLift: 0,
    keyboardVisible: false,
  }),
  12,
  "the composer must preserve its tuned idle bottom padding",
);
assert.equal(
  getNoteComposerBottomPadding({
    bottomInset: 0,
    extraKeyboardLift: 0,
    keyboardVisible: true,
  }),
  6,
  "an Expo Go native resize must leave only the requested 6dp keyboard gap",
);
assert.equal(
  getNoteComposerBottomPadding({
    bottomInset: 24,
    extraKeyboardLift: 260,
    keyboardVisible: true,
  }),
  290,
  "the standalone fallback must still cover a 284dp keyboard plus the 6dp gap",
);
assert.equal(
  (notesScreen.match(/<InlineErrorBanner/g) ?? []).length,
  2,
  "note load and mutation failures must share the common inline banner",
);
assert.doesNotMatch(
  notesScreen,
  /mx-base mb-sm min-h-\[44px\][^\n]*rounded-\[10px\]/,
);
assert.doesNotMatch(notesScreen, /habitName|setHabitName/);
assert.match(
  notesScreen,
  /import \{[\s\S]{0,100}notesApplication[\s\S]{0,100}\} from "@\/composition\/notes"/,
  "the Notes route must depend on the configured application-facing API",
);
assert.doesNotMatch(
  notesScreen,
  /runtimeDb|@\/db\/runtime|@\/data\/sqlite|@\/application\/notes\/notes-cache|\b(?:SELECT|INSERT|UPDATE|DELETE)\b/,
  "the Notes route must remain free of SQLite and cache implementation details",
);
assert.doesNotMatch(
  notesApplication,
  /@\/data\/|@\/db\/|runtimeDb|NOTE_COLUMNS|\b(?:SELECT|INSERT|UPDATE|DELETE)\b/,
  "the Notes application service must depend inward on a repository port",
);
assert.match(
  notesComposition,
  /createNotesApplication\(sqliteNoteRepository, \{[\s\S]*waitForCommitOpportunity[\s\S]*now:/,
  "the Notes composition root must wire SQLite and external runtime ports without owning behavior",
);
assert.match(
  noteRepository,
  /ORDER BY date ASC, created_at ASC/,
  "the Notes repository must preserve the established oldest-to-newest order",
);
assert.match(noteRepository, /async function createNote/);
assert.match(noteRepository, /async function updateNoteText/);
assert.match(
  noteRepository,
  /export const sqliteNoteRepository: NoteRepository/,
);
assert.match(noteRepository, /async function deleteNote/);
assert.match(notesScreen, /shouldScrollToNewNoteRef\.current = true/);
assert.match(notesScreen, /onContentSizeChange/);
assert.match(notesScreen, /scrollToEnd\(\{ animated: true \}\)/);
assert.doesNotMatch(notesScreen, /notes\.deleteMessage/);
assert.match(notesScreen, /const TOP_SCROLL_SETTLE_THRESHOLD_DP = 16/);
assert.match(notesScreen, /scrollToOffset\(\{ offset: 0, animated: false \}\)/);
assert.match(notesScreen, /overScrollMode="always"/);
assert.match(notesScreen, /onScrollBeginDrag=\{handleNotesScrollBeginDrag\}/);
assert.match(notesScreen, /onScrollEndDrag=\{handleNotesScrollEndDrag\}/);
assert.match(
  notesScreen,
  /onMomentumScrollBegin=\{handleNotesMomentumScrollBegin\}/,
);
assert.match(
  notesScreen,
  /onMomentumScrollEnd=\{handleNotesMomentumScrollEnd\}/,
);
assert.match(notesScreen, /habitExists === null \? \(/);
assert.match(
  notesScreen,
  /habitExists === true \? \([\s\S]{0,160}<NoteInput[\s\S]{0,100}hidden=\{hideComposer\}[\s\S]{0,120}keyboardVisible=\{keyboardVisible\}[\s\S]{0,80}extraKeyboardLift=\{composerKeyboardLift\}/,
);
assert.match(
  notesScreen,
  /const hideComposer = editingNoteIds\.size > 0 \|\| composerReleasePending/,
  "the composer must remain hidden while an editor-owned keyboard is still closing",
);
assert.match(
  notesScreen,
  /setComposerReleasePending\(false\);[\s\S]{0,240}setKeyboardOverlap\(0\)/,
  "keyboardDidHide must release the composer in the same state update",
);
assert.match(
  notesScreen,
  /!editorHandoffInProgressRef\.current &&[\s\S]{0,100}keyboardVisibleRef\.current[\s\S]{0,360}setComposerReleasePending\(true\);[\s\S]{0,80}Keyboard\.dismiss\(\)/,
  "finishing one editor should dismiss the keyboard without breaking editor-to-editor focus handoff",
);
assert.match(notesScreen, /onEditingChange=\{handleNoteEditingChange\}/);
assert.match(notesScreen, /onEditorReady=\{handleNoteEditorReady\}/);
assert.match(
  notesScreen,
  /if \(!target \|\| activeEditorSaveRef\.current\?\.noteId !== noteId\) return;/,
  "late layout events from the previous card must not retake editor ownership",
);
assert.match(
  notesScreen,
  /previousEditor && previousEditor\.noteId !== noteId[\s\S]{0,180}editorHandoffInProgressRef\.current = true[\s\S]{0,180}if \(!previousEditor\.saveDraft\(\)\) return false[\s\S]{0,180}editorHandoffInProgressRef\.current = false/,
  "opening another editor must synchronously save the current draft or block the handoff",
);
assert.match(
  notesScreen,
  /activeEditorSaveRef\.current = \{ noteId, saveDraft \}/,
);
assert.match(
  notesScreen,
  /if \(editing\) return new Set\(\[noteId\]\);/,
  "only one note card may own editing at a time",
);
assert.ok(
  (notesScreen.match(/\.measure\(/g) ?? []).length >= 3,
  "editor reveal must measure the list viewport, editor, and action row",
);
assert.match(notesScreen, /onEditorGeometry=\{handleNoteEditorGeometry\}/);
assert.match(notesScreen, /onLayout=\{handleNoteListLayout\}/);
assert.match(
  notesScreen,
  /if \(phase === "layout"\) \{[\s\S]{0,120}clearEditorRevealFrame\(\);[\s\S]{0,80}revealActiveEditor\(\);/,
  "a growing note editor must enter the bounded visibility convergence owner",
);
assert.doesNotMatch(
  notesScreen,
  /onContentSizeChange=\{\(\) => \{[\s\S]{0,280}scheduleEditorReveal\(\)/,
  "FlatList content-size changes must not add a second delayed editor jump",
);
const noteMutationSource = notesScreen.slice(
  notesScreen.indexOf("const handleSend"),
  notesScreen.indexOf("const handleNoteEditingChange"),
);
assert.doesNotMatch(
  noteMutationSource,
  /setNoteList|confirmedNoteStatesRef|noteWriteTokensRef|notePersistenceIdsRef|persistenceCommitScheduler|notesApplication\.(?:create|update|delete|trackPendingWrite|waitForPersistenceTurn)/,
  "the screen must retain editor UX only, never a second Notes data/concurrency owner",
);
assert.match(noteMutationSource, /notesSession\.create\(text\)/);
assert.match(noteMutationSource, /notesSession\.update\(noteId, text\)/);
assert.match(
  noteMutationSource,
  /setDeleteTarget\(null\);\s*const submission = notesSession\.delete\(\s*targetId,?\s*\);/,
);
assert.match(
  notesScreen,
  /const noteKeyExtractor = \(item: NotesSessionNote\) => item\.clientMutationId/,
  "persisting a new note must not replace its stable React key and unmount a focused editor",
);
assert.match(
  notesScreen,
  /useSyncExternalStore\([\s\S]{0,180}notesSession\.subscribe[\s\S]{0,180}notesSession\.getSnapshot/,
  "the route must render the immutable application-owned projection",
);
assert.match(
  notesSession,
  /persistedIdReady[\s\S]*confirmed: Note \| null[\s\S]*latestRevision[\s\S]*latestIntent/,
  "immediate edit/delete and conditional rollback must be owned by NotesSession",
);
assert.doesNotMatch(noteMutationSource, /setNoteList\(previousList\)/);
assert.match(
  notesSession,
  /handleUpdateFailure\([\s\S]*entity\.latestRevision !== revision[\s\S]*entity\.confirmed/,
  "a failed latest note save must roll back to confirmed SQLite state",
);
assert.doesNotMatch(
  notesSession,
  /handleUpdateFailure\([\s\S]{0,1200}\{ \.\.\.previousNote/,
  "a failed latest note save must never restore an earlier optimistic snapshot",
);
assert.match(
  notesScreen,
  /const EDITOR_VISIBILITY_MAX_FRAMES = 12;/,
  "editor visibility convergence must have a hard frame bound",
);
assert.match(
  notesScreen,
  /const EDITOR_VISIBILITY_MAX_DURATION_MS = 250;/,
  "editor visibility convergence must have a hard duration bound",
);
assert.match(
  notesScreen,
  /getNoteEditorVisibilityDecision\(\{[\s\S]{0,220}viewportHeight,[\s\S]{0,220}actionsPageY,[\s\S]{0,80}keyboardTop/,
  "the production convergence loop must delegate exact editor/actions geometry to its tested pure owner",
);
assert.match(
  notesScreen,
  /active\.targets\.requestId === entry\.targets\.requestId[\s\S]{0,120}entry\.targets\.getRequestId\(\) === entry\.targets\.requestId/,
  "stale geometry work must be cancelled by the active product request",
);
assert.match(
  notesScreen,
  /editorGeometryEnvironmentEpochRef\.current === environmentEpoch/,
  "keyboard or viewport changes must invalidate an otherwise completed editor measurement",
);
assert.match(
  notesScreen,
  /const revalidateActiveEditorGeometry = useCallback\(\(\) => \{[\s\S]{0,100}editorGeometryEnvironmentEpochRef\.current \+= 1;[\s\S]{0,100}completedEditorGeometryKeyRef\.current = null;[\s\S]{0,140}scheduleEditorGeometry\(entry\)/,
  "the active editor must be revalidated in every keyboard/viewport geometry epoch",
);
assert.match(
  notesScreen,
  /const handleNoteListLayout = useCallback\(\(\) => \{[\s\S]{0,80}revalidateActiveEditorGeometry\(\)/,
  "a committed FlatList viewport layout must begin a fresh editor visibility epoch",
);
const editorVisibilityScrollBlock = notesScreen.match(
  /const nextOffset = Math\.max\(([\s\S]*?)scheduleRetry\(\);/,
)?.[0];
assert.ok(
  editorVisibilityScrollBlock,
  "a hidden editor must expose a bounded scroll-and-remeasure block",
);
assert.match(
  editorVisibilityScrollBlock,
  /currentOffset \+ decision\.scrollDelta/,
  "a hidden editor must apply only the measured visibility delta",
);
assert.match(
  editorVisibilityScrollBlock,
  /list\.scrollToOffset\(\{[\s\S]*?offset: nextOffset,[\s\S]*?animated: false,[\s\S]*?\}\);/,
  "editor visibility correction must be immediate and target the measured offset",
);
assert.match(
  editorVisibilityScrollBlock,
  /const pendingCorrection =[\s\S]{0,160}pendingEditorCorrectionRef\.current;[\s\S]{0,160}if \(pendingCorrection == null\) \{[\s\S]{0,260}pendingEditorCorrectionRef\.current = \{[\s\S]{0,260}requestedOffset: nextOffset/,
  "only one native editor scroll correction may be in flight at a time",
);
assert.doesNotMatch(
  editorVisibilityScrollBlock,
  /scrollOffsetRef\.current\s*=\s*nextOffset/,
  "only the native onScroll callback may own the observed list offset",
);
assert.match(
  notesScreen,
  /function getEditorGeometryKey\([\s\S]{0,420}entry\.targets\.noteId[\s\S]{0,160}entry\.metrics\.lineCount[\s\S]{0,160}entry\.metrics\.heightBucket[\s\S]{0,120}environmentEpoch/,
  "duplicate layout requests for the same text geometry must share one correction key",
);
assert.match(
  notesScreen,
  /const handleNotesScroll = useCallback\([\s\S]{0,320}scrollOffsetRef\.current = y;[\s\S]{0,900}movedTowardTarget[\s\S]{0,320}reachedTarget[\s\S]{0,240}pendingEditorCorrectionRef\.current = null/,
  "native onScroll must acknowledge a correction before any residual correction can be issued",
);
assert.match(
  notesScreen,
  /const handleNoteListContentSizeChange = useCallback\([\s\S]{0,600}requestAnimationFrame\(\(\) => \{[\s\S]{0,220}requestAnimationFrame\(\(\) => \{[\s\S]{0,500}pendingEditorCorrectionRef\.current !== pendingCorrection[\s\S]{0,300}pendingEditorCorrectionRef\.current = null;[\s\S]{0,160}revalidateActiveEditorGeometry\(\)/,
  "content growth must re-arm a clamped correction only after native onScroll had two frames to acknowledge the first request",
);
assert.match(
  editorVisibilityScrollBlock,
  /scheduleRetry\(\);$/,
  "editor visibility correction must be verified after native scrolling",
);
assert.match(
  notesScreen,
  /const scheduleRetry = \(\) => \{[\s\S]{0,320}requestAnimationFrame\([\s\S]{0,120}attempt\(\)/,
  "only a retry may wait for the next animation frame",
);
assert.match(
  notesScreen,
  /run\.deadline = setTimeout\([\s\S]{0,500}attempt\(\);/,
  "the first post-layout editor measurement must start immediately",
);

assert.equal(
  getNoteEditorContentHeight({
    nativeHeight: 40,
    currentHeight: 60,
    minimumHeight: 20,
    mayShrink: false,
  }),
  60,
  "a stale smaller native size must not collapse a newer editor layout",
);
assert.equal(
  getNoteEditorContentHeight({
    nativeHeight: 40,
    currentHeight: 60,
    minimumHeight: 20,
    mayShrink: true,
  }),
  40,
  "a real deletion must still be able to shrink the editor",
);
assert.equal(
  getNoteEditorContentHeight({
    nativeHeight: 80,
    currentHeight: 60,
    minimumHeight: 20,
    mayShrink: false,
  }),
  80,
  "editor growth must never be blocked by the stale-shrink guard",
);
assert.equal(
  getNoteEditorContentHeight({
    nativeHeight: Number.NaN,
    currentHeight: 60,
    minimumHeight: 20,
    mayShrink: false,
  }),
  null,
  "invalid native content geometry must fail closed",
);

const visibleEditorDecision = getNoteEditorVisibilityDecision({
  viewportHeight: 400,
  viewportPageY: 100,
  editorHeight: 100,
  editorPageY: 200,
  actionsHeight: 40,
  actionsPageY: 310,
  keyboardTop: 450,
});
assert.equal(visibleEditorDecision.valid, true);
assert.equal(
  visibleEditorDecision.valid && visibleEditorDecision.visible,
  true,
  "an already visible editor/actions union must not move the list",
);
assert.equal(
  visibleEditorDecision.valid && visibleEditorDecision.scrollDelta,
  0,
);
const coveredEditorDecision = getNoteEditorVisibilityDecision({
  viewportHeight: 400,
  viewportPageY: 100,
  editorHeight: 50,
  editorPageY: 380,
  actionsHeight: 40,
  actionsPageY: 440,
  keyboardTop: 450,
});
assert.equal(
  coveredEditorDecision.valid && coveredEditorDecision.scrollDelta,
  42,
  "a keyboard-covered action row must move by the overlap plus the visual safety gap",
);
const oversizedEditorDecision = getNoteEditorVisibilityDecision({
  viewportHeight: 400,
  viewportPageY: 100,
  editorHeight: 400,
  editorPageY: -10,
  actionsHeight: 40,
  actionsPageY: 398,
  keyboardTop: 450,
});
assert.equal(
  oversizedEditorDecision.valid &&
    oversizedEditorDecision.visible &&
    oversizedEditorDecision.visibilityMode,
  "actions-and-editor-viewport",
  "an editor taller than the viewport is usable only when its actions and text viewport are visible",
);
const coveredOversizedEditorDecision = getNoteEditorVisibilityDecision({
  viewportHeight: 400,
  viewportPageY: 100,
  editorHeight: 400,
  editorPageY: 90,
  actionsHeight: 40,
  actionsPageY: 398,
  keyboardTop: 450,
});
assert.equal(
  coveredOversizedEditorDecision.valid &&
    coveredOversizedEditorDecision.visible,
  false,
  "an oversized editor is not usable while its typed tail remains below the keyboard boundary",
);
assert.deepEqual(
  getNoteEditorVisibilityDecision({
    viewportHeight: 0,
    viewportPageY: 100,
    editorHeight: 50,
    editorPageY: 200,
    actionsHeight: 40,
    actionsPageY: 260,
    keyboardTop: 450,
  }),
  { valid: false },
  "invalid native geometry must fail closed and be remeasured",
);
const noteCard = read("src/features/notes/components/NoteCard.tsx");
assert.match(
  noteCard,
  /const onEditingChangeRef = useRef\(onEditingChange\);\s*onEditingChangeRef\.current = onEditingChange;/,
  "the note editor must keep the current parent callback in a ref",
);
assert.match(
  noteCard,
  /useEffect\(\(\) => \{\s*return \(\) => \{[\s\S]{0,180}if \(editingRef\.current\) onEditingChangeRef\.current\?\.\(note\.id, false\);[\s\S]{0,80}\};\s*\}, \[note\.id\]\);/,
  "changing a parent callback identity must never deactivate a note editor",
);
assert.equal(
  (
    noteCard.match(
      /min-h-\[32px\] min-w-\[48px\] items-center justify-center/g,
    ) ?? []
  ).length,
  2,
);
assert.equal((noteCard.match(/style=\{ACTION_LABEL_STYLE\}/g) ?? []).length, 2);
assert.match(
  noteCard,
  /const ACTION_LABEL_STYLE = \{[\s\S]{0,80}fontSize: 13,[\s\S]{0,80}lineHeight: 18,[\s\S]{0,80}fontWeight: "400"/,
);
assert.match(noteCard, /defaultValue=\{draftTextRef\.current\}/);
assert.match(
  noteCard,
  /if \(editingRef\.current\) return;[\s\S]{0,220}draftTextRef\.current = note\.text/,
  "an external optimistic rollback must never replace the text visible in an active native editor",
);
assert.match(
  noteCard,
  /const saveForEditorHandoff[\s\S]{0,420}trimmed !== renderedNoteTextRef\.current/,
  "editor handoff must compare the visible draft with the latest rendered note instead of a stale closure",
);
assert.match(
  noteCard,
  /const enterEditing[\s\S]{0,900}draftTextRef\.current = initialDraft;[\s\S]{0,100}draftBaseTextRef\.current = initialDraft;[\s\S]{0,500}editingRef\.current = true/,
  "the uncontrolled editor must synchronously snapshot one draft before it mounts",
);
assert.match(noteCard, /ref=\{cardRef\}[\s\S]{0,80}collapsable=\{false\}/);
assert.match(noteCard, /const CARD_BOTTOM_GAP = 11\.5/);
assert.match(noteCard, /const NOTE_LINE_HEIGHT = 20/);
assert.match(
  noteCard,
  /const NOTE_TEXT_STYLE = \{[\s\S]{0,120}fontSize: 14,[\s\S]{0,80}lineHeight: NOTE_LINE_HEIGHT,[\s\S]{0,80}fontWeight: "400"/,
);
assert.equal(
  (noteCard.match(/NOTE_TEXT_STYLE/g) ?? []).length,
  3,
  "read text and editor must share identical typography",
);
assert.match(noteCard, /paddingHorizontal: 0,[\s\S]{0,60}paddingVertical: 0/);
assert.match(
  noteCard,
  /const \[editorViewportHeight, setEditorViewportHeight\][\s\S]{0,120}NOTE_LINE_HEIGHT/,
);
assert.match(
  noteCard,
  /onLayout=\{handleReadTextLayout\}/,
  "the edit viewport must start at the rendered note text height",
);
assert.match(
  noteCard,
  /height: editorViewportHeight, overflow: "hidden"[\s\S]{0,700}height: editorViewportHeight \+ NOTE_LINE_HEIGHT/,
  "Android must keep one clipped spare line inside the native editor to avoid the multiline Enter jump",
);
assert.match(noteCard, /scrollEnabled=\{false\}/);
assert.match(
  noteCard,
  /onFocus=\{handleEditorFocus\}/,
  "a focused note must re-run viewport reveal",
);
const noteEditorLayoutEffectStart = noteCard.indexOf(
  "useLayoutEffect(() => {",
  noteCard.indexOf("const handleEditorFocus"),
);
const noteEditorSaveStart = noteCard.indexOf(
  "const handleSave",
  noteEditorLayoutEffectStart,
);
assert.ok(
  noteEditorLayoutEffectStart >= 0 &&
    noteEditorSaveStart > noteEditorLayoutEffectStart &&
    noteCard
      .slice(noteEditorLayoutEffectStart, noteEditorSaveStart)
      .includes('onEditorReady?.(note.id, cardRef.current, "layout")'),
  "editor growth must report its new layout before paint",
);
assert.match(noteCard, /onContentSizeChange=\{handleEditorContentSizeChange\}/);
assert.match(
  noteCard,
  /onEditorGeometry\?: \(\s*requestId: number,\s*targets: NoteEditorGeometryTargets,\s*metrics: NoteEditorGeometryMetrics,?\s*\) => void/,
  "editor geometry must pass the product request identity and current measured targets",
);
assert.match(
  noteCard,
  /requestId: allocateNoteEditorGeometryRequestId\(\)|const requestId = allocateNoteEditorGeometryRequestId\(\)/,
  "each product reveal must receive its own monotonic request id",
);
assert.doesNotMatch(
  noteCard,
  /editorTextRevisionRef/,
  "ordinary native text callbacks must not invalidate product geometry unless layout actually changes",
);
assert.match(
  noteCard,
  /const handleEditorContentSizeChange[\s\S]{0,1100}queueEditorGeometry\(nextHeight\)/,
  "native content-size changes must queue product visibility work",
);
assert.match(
  noteCard,
  /const handleEditorLayout = \(\) => \{[\s\S]{0,220}queueEditorGeometry\(editorViewportHeightRef\.current\)[\s\S]{0,100}publishEditorGeometry\(\)/,
  "committed editor/action layouts must initiate product visibility work",
);
assert.equal(
  (noteCard.match(/onLayout=\{handleEditorLayout\}/g) ?? []).length,
  2,
  "both the text viewport and action row must publish their committed geometry",
);
assert.match(
  noteCard,
  /getNoteEditorContentHeight\(\{[\s\S]{0,180}currentHeight,[\s\S]{0,100}mayShrink: lastEditMayShrinkRef\.current/,
  "a stale Android content-size callback must not shrink the editor after insertion",
);
assert.doesNotMatch(
  noteCard,
  /scrollEnabled=\{Platform\.OS === "android"\}|setEditorHeight|readTextHeightRef/,
  "a note editor must grow with its text instead of using a fixed internally scrolling edit session",
);
assert.match(noteCard, /draftTextRef\.current = value/);
assert.doesNotMatch(
  noteCard,
  /isSaving|setIsSaving|await onSave|<ActivityIndicator/,
  "optimistically accepted note edits must close in the same event batch instead of rendering a redundant saving frame",
);
assert.match(
  noteCard,
  /if \(nextHasDraftText === hasDraftTextRef\.current\) return;/,
);
assert.match(noteCard, /underlineColorAndroid="transparent"/);
assert.doesNotMatch(noteCard, /value=\{text\}/);
assert.doesNotMatch(noteCard, /const \[text, setText\]/);
const noteEditRequestIndex = noteCard.indexOf(
  "const accepted = onEditingChange?.(",
);
const noteEditAcceptedIndex = noteCard.indexOf("if (accepted === false) {");
const noteEditorMountIndex = noteCard.indexOf("setEditing(true);");
assert.ok(
  noteEditRequestIndex >= 0 &&
    noteCard.indexOf("saveForEditorHandoff", noteEditRequestIndex) >= 0 &&
    noteEditRequestIndex < noteEditAcceptedIndex &&
    noteEditAcceptedIndex < noteEditorMountIndex,
  "the previous draft must be accepted before the new native editor mounts",
);
assert.match(
  noteCard,
  /onEditingChange\?\.\(note\.id, false\);[\s\S]{0,80}setEditing\(false\);/,
);
assert.match(noteCard, /requestAnimationFrame\(\(\) =>/);
assert.doesNotMatch(noteCard, /setTimeout\([^\n]*focus/);
const noteEditorHandoffStart = noteCard.indexOf(
  "const saveForEditorHandoff = React.useCallback(",
);
const noteEditorHandoffEnd = noteCard.indexOf(
  "const enterEditing = React.useCallback(",
  noteEditorHandoffStart,
);
assert.ok(
  noteEditorHandoffStart >= 0 && noteEditorHandoffEnd > noteEditorHandoffStart,
  "the editor handoff must remain an independently bounded callback",
);
const noteEditorHandoffSource = noteCard.slice(
  noteEditorHandoffStart,
  noteEditorHandoffEnd,
);
assert.match(
  noteEditorHandoffSource,
  /const saveForEditorHandoff = React\.useCallback\(\(\) => \{[\s\S]{0,240}if \(!trimmed\)/,
);
assertSourceOrder(
  noteEditorHandoffSource,
  [
    "if (!trimmed) {",
    "return false;",
    "if (trimmed !== renderedNoteTextRef.current) {",
    "if (!onSave(note.id, trimmed)) {",
    "inputRef.current?.focus();",
    "return false;",
    "leaveEditing();",
    "return true;",
  ],
  "a non-empty draft must be committed before ownership moves to another card",
);
assert.doesNotMatch(
  noteCard,
  /useEffect\(\(\) => \{[\s\S]{0,120}onEditingChange\?\.\(note\.id, editing\)/,
);
assert.doesNotMatch(
  noteCard,
  /style=\{\(\{ pressed \}\)/,
  "note action buttons must preserve their NativeWind minimum sizes on Android",
);

const noteInput = read("src/features/notes/components/NoteInput.tsx");
const notesCache = read("src/application/notes/notes-cache.ts");
const notesLoadApplicationSource = notesApplication.slice(
  notesApplication.indexOf("const load = async"),
  notesApplication.indexOf("const prewarm = async"),
);
assert.match(notesCache, /const MAX_CACHED_HABITS = 48/);
assert.match(notesCache, /export function invalidateCachedNotes/);
assert.match(
  notesCache,
  /captureNotesCacheReadToken[\s\S]*isNotesCacheReadTokenCurrent[\s\S]*token\.generation ===[\s\S]*setCachedNotesIfCurrent/,
  "an invalidated in-flight notes read must not republish a stale cache snapshot",
);
assert.match(
  notesCache,
  /trackPendingNotesWrite[\s\S]*capturePendingNotesWriteFence[\s\S]*waitForPendingNotesWritesThrough[\s\S]*waitForPendingNotesWrites/,
  "notes must support per-habit reads and exact-cutoff transfer fences",
);
assert.match(
  dataTransferCoordinatorSource,
  /publication-blocked[\s\S]*retryPublication[\s\S]*publishCommittedSnapshot/,
  "a committed import must remain blocked and retry only in-memory publication",
);
assertSourceOrder(
  notesLoadApplicationSource,
  [
    "for (;;)",
    "await waitForPendingNotesWrites(habitId);",
    "const cacheReadToken = captureNotesCacheReadToken(habitId);",
    "if (!readIsCurrent)",
    "continue;",
    "loadTokens.set(result, cacheReadToken);",
    "return result;",
  ],
  "an invalidated notes read must retry instead of exposing an empty or stale screen",
);
assert.match(
  notesSession,
  /for \(;;\) \{[\s\S]{0,500}gateway\.load[\s\S]{0,350}!this\.gateway\.isLoadResultCurrent\(loaded\)[\s\S]{0,100}continue/,
  "a write registered after the application result but before session publication must force one more read",
);
assert.match(
  notesApplication,
  /habitExists[\s\S]*\? setCachedNotesIfCurrent[\s\S]*: isNotesCacheReadTokenCurrent/,
  "a missing habit must never be cached as an existing habit with an empty notes list",
);
assert.match(
  notesSession,
  /const cached = gateway\.getCachedSnapshot\(habitId\)[\s\S]{0,180}replaceAuthoritativeEntities\(cached\)[\s\S]{0,220}status: cached \? "ready" : "idle"/,
  "a repeated notes route must paint its authoritative in-process snapshot without waiting for SQLite",
);
assert.match(
  notesScreen,
  /if \(notesSnapshot\.status === "idle"\) \{[\s\S]{0,100}notesSession\.ensureLoaded\(getKnownHabitExists\)/,
  "only a cache miss may start the blocking notes read",
);
assert.match(
  read("src/stores/habit-store.ts"),
  /resetInMemoryCaches\(\)[\s\S]{0,700}invalidateAllNotesProjections\(\)/,
  "import/reset must invalidate every cached notes snapshot",
);
assert.match(noteInput, /hidden\?: boolean/);
assert.match(noteInput, /keyboardVisible: boolean/);
assert.match(noteInput, /extraKeyboardLift: number/);
assert.match(noteInput, /height: 0, opacity: 0, overflow: "hidden"/);
assert.match(noteInput, /pointerEvents=\{hidden \? "none" : "auto"\}/);
assert.match(
  noteInput,
  /getNoteComposerBottomPadding\(\{[\s\S]{0,120}bottomInset: insets\.bottom,[\s\S]{0,80}extraKeyboardLift,[\s\S]{0,80}keyboardVisible/,
);
assert.match(noteInput, /paddingTop: keyboardVisible \? 4 : 6,/);
assert.match(noteInput, /paddingBottom: bottomPadding \+ 2,/);
assert.match(noteInput, /paddingRight: 6,/);
assert.match(noteInput, /borderWidth: 1\.2,/);
assert.match(
  noteInput,
  /const composerBorderColor = isDark \? "#505050" : "#C7C7C7"/,
);
assert.match(noteInput, /FontAwesome6[\s\S]{0,80}name="arrow-up"/);
assert.match(noteInput, /textValueRef\.current = "";/);
assert.match(noteInput, /measuredInputHeightRef\.current = baseInputHeight;/);
assert.match(noteInput, /setInputHeight\(baseInputHeight\);/);
assert.match(noteInput, /onSend: \(text: string\) => boolean/);
assert.doesNotMatch(
  noteInput,
  /isSending|setIsSending|await onSend|<ActivityIndicator/,
  "optimistically accepted notes must clear the composer in the same event batch",
);
assert.match(noteInput, /getNoteComposerContentHeight\(\{/);
assert.equal(
  getNoteComposerContentHeight({
    textLength: 0,
    contentHeight: 126,
    currentHeight: 126,
    baseHeight: 38,
    maximumHeight: 170,
  }),
  38,
  "a stale Android content-size event must not re-expand a cleared composer",
);
assert.equal(
  getNoteComposerContentHeight({
    textLength: 40,
    contentHeight: 82,
    currentHeight: 38,
    baseHeight: 38,
    maximumHeight: 170,
  }),
  82,
  "a non-empty composer must still grow with its content",
);
assert.equal(
  getNoteComposerContentHeight({
    textLength: 40,
    contentHeight: 60,
    currentHeight: 82,
    baseHeight: 38,
    maximumHeight: 170,
  }),
  82,
  "transient native content-size shrinkage must not make typed text jump",
);
assert.doesNotMatch(
  noteInput,
  /Keyboard\.addListener|useWindowDimensions|keyboardOverlap/,
  "the screen must own one keyboard geometry source for both the composer and edited cards",
);
assert.doesNotMatch(noteInput, /setKeyboardVisible|Keyboard\.isVisible/);
assert.doesNotMatch(noteInput, /onPressIn=\{\(\) =>/);
assert.match(noteCard, /onEditingChangeRef\.current = onEditingChange/);

const archiveCard = read("src/features/archive/components/ArchiveCard.tsx");
assert.match(archiveCard, /const CARD_BOTTOM_GAP = 11\.5/);
assert.doesNotMatch(archiveCard, /pressed \? 0\.6 : 1/);

const toggle = read("src/components/ui/Toggle.tsx");
assert.match(toggle, /offTrackColor = isDarkTheme \? "#616161" : "#9E9E9E"/);
assert.equal(TOGGLE_THUMB_ANIMATION_DURATION_MS, 250);
assert.equal(
  getToggleThumbColor(DARK_TOGGLE_OFF_THUMB_COLOR, 0),
  DARK_TOGGLE_OFF_THUMB_COLOR,
);
assert.equal(getToggleThumbColor(DARK_TOGGLE_OFF_THUMB_COLOR, 0.5), "#E7E7E7");
assert.equal(
  getToggleThumbColor(LIGHT_TOGGLE_OFF_THUMB_COLOR, 0),
  LIGHT_TOGGLE_OFF_THUMB_COLOR,
);
assert.equal(
  getToggleThumbColor(LIGHT_TOGGLE_OFF_THUMB_COLOR, 1),
  TOGGLE_ON_THUMB_COLOR,
);
assert.doesNotMatch(
  toggle,
  /Animated\.createAnimatedComponent\(Switch\)|<AnimatedSwitch/,
  "React Native's public Switch color mapping must not be bypassed by animated native props",
);
assert.match(toggle, /new Animated\.Value\(value \? 1 : 0\)/);
assert.match(
  toggle,
  /const \[displayedThumbProgress, setDisplayedThumbProgress\] = React\.useState\([\s\S]{0,80}value \? 1 : 0/,
  "the public Switch must receive a real color string for every visible animation step",
);
assert.match(
  toggle,
  /const thumbColor = getToggleThumbColor\([\s\S]{0,80}offThumbColor,[\s\S]{0,40}displayedThumbProgress/,
  "the thumb must interpolate continuously between neutral theme colors, never the accent",
);
assert.match(
  toggle,
  /thumbProgress\.addListener\(\(\{ value: progress \}\) => \{[\s\S]{0,80}thumbProgressRef\.current = progress;[\s\S]{0,80}setDisplayedThumbProgress\(progress\)/,
  "every animation step must update the plain Switch's public string prop",
);
assert.match(toggle, /duration: TOGGLE_THUMB_ANIMATION_DURATION_MS/);
assert.match(toggle, /easing: Easing\.inOut\(Easing\.ease\)/);
assert.match(toggle, /useNativeDriver: false/);
const switchRenderStart = toggle.indexOf("<Switch");
const switchRenderEnd = toggle.indexOf("/>", switchRenderStart);
assert.ok(
  switchRenderStart >= 0 && switchRenderEnd > switchRenderStart,
  "Toggle must render its controlled plain Switch",
);
const switchRender = toggle.slice(switchRenderStart, switchRenderEnd + 2);
assert.match(
  switchRender,
  /trackColor=\{\{ false: offTrackColor, true: accent \}\}/,
  "only the enabled switch track may use the selected accent",
);
assert.match(
  switchRender,
  /ios_backgroundColor=\{offTrackColor\}/,
  "the collapsed iOS track must use the same neutral theme color",
);
assert.match(switchRender, /thumbColor=\{thumbColor\}/);
assert.doesNotMatch(switchRender, /as unknown as string/);
assert.doesNotMatch(
  toggle,
  /thumbColor=\{isDarkTheme && !value/,
  "thumb tint must follow the motion progress instead of jumping at the final boolean state",
);

const editRows = read("src/features/habit-detail/components/EditRows.tsx");
assert.match(
  editRows,
  /style=\{\{ minWidth: 0 \}\}[\s\S]{0,220}ellipsizeMode="tail"[\s\S]{0,160}flexShrink: 1, minWidth: 0, textAlign: "right"/,
);

const heatmap = read("src/features/statistics/components/Heatmap.tsx");
assert.match(
  heatmap,
  /const legendColors = React\.useMemo\([\s\S]{0,100}levels\["-4"\][\s\S]{0,260}levels\[4\]/,
);
assert.doesNotMatch(heatmap, /scoreToColor\(-2|scoreToColor\(-1\.2/);

const appModal = read("src/components/ui/AppModal.tsx");
const screenPreferencesBoundary = read(
  "src/components/ScreenPreferencesBoundary.tsx",
);
const visualSnapshotProviderSource = screenPreferencesBoundary.slice(
  screenPreferencesBoundary.indexOf(
    "export function VisualPreferencesSnapshotProvider",
  ),
  screenPreferencesBoundary.indexOf("interface ScreenVisualTreeProps"),
);
const themeProvider = read("src/theme/provider.tsx");
const systemAppearance = read("src/theme/system-appearance.ts");
const appRootLayout = read("app/_layout.tsx");
const systemNavigationBar = read("src/utils/system-navigation-bar.ts");
assert.match(appModal, /Platform\.OS === "android"/);
assert.match(appModal, /<Portal>/);
assert.match(appModal, /BackHandler\.addEventListener/);
const androidPortalMountedDeclarationIndex = appModal.indexOf(
  "const androidPortalMounted = visible || portalMounted;",
);
const androidPortalRenderBranchIndex = appModal.indexOf(
  "if (usesAndroidPortal)",
  androidPortalMountedDeclarationIndex,
);
const androidPortalMountedGuardIndex = appModal.indexOf(
  "if (!androidPortalMounted) return null;",
  androidPortalRenderBranchIndex,
);
assert.ok(
  androidPortalMountedDeclarationIndex >= 0 &&
    androidPortalRenderBranchIndex > androidPortalMountedDeclarationIndex &&
    androidPortalMountedGuardIndex > androidPortalRenderBranchIndex,
  "an Android overlay must enter the portal in the same render that makes it visible",
);
assert.match(
  appModal,
  /const portalOpacityStyle = React\.useMemo\([\s\S]{0,320}opacity: shouldFade\s*\?\s*opacity\s*:\s*shouldRetainAndroidPortal && !visible\s*\?\s*0\s*:\s*1/,
  "AppModal must keep one grouped-opacity owner for the complete Android overlay",
);
assert.match(
  appModal,
  /const portalContent =[\s\S]{0,180}<VisualPreferencesSnapshotProvider[\s\S]{0,260}<ThemeVariablesProvider/,
  "Android portal content must explicitly regain scene preferences and NativeWind variables",
);
assert.match(
  appModal,
  /const currentVisualPreferences = React\.useMemo<VisualPreferencesSnapshot>[\s\S]{0,520}const shouldFade/,
  "the modal bridge must capture one coherent source-scene snapshot rather than default settings",
);
assert.ok(
  (appModal.match(/\.\.\.modalPresentation\.visualPreferences/g) ?? [])
    .length >= 2,
  "both detached modal hosts must consume the same retained visual snapshot",
);
assert.match(
  appModal,
  /<ThemeVariablesProvider\s+effectiveMode=\{modalPresentation\.visualPreferences\.effectiveMode\}\s*>/,
  "the Android portal's NativeWind variables must belong to the retained modal snapshot",
);
assert.match(
  screenPreferencesBoundary,
  /export function VisualPreferencesSnapshotProvider\([\s\S]{0,900}<VisualLanguageContext\.Provider value=\{language\}>[\s\S]{0,180}<VisualEffectiveModeContext\.Provider value=\{effectiveMode\}>[\s\S]{0,180}<VisualThemeContext\.Provider value=\{theme\}>[\s\S]{0,180}<VisualColorSchemeContext\.Provider value=\{colorScheme\}>/,
  "the detached subtree bridge must restore one coherent language, effective mode, selected theme and accent snapshot without navigation hooks",
);
assert.doesNotMatch(
  visualSnapshotProviderSource,
  /useIsFocused|useSettingsStore/,
  "the detached portal snapshot provider must not require navigation context or subscribe to the global settings store",
);
assert.match(
  screenPreferencesBoundary,
  /function useLiveVisualPreferences\(\)[\s\S]{0,260}useSettingsStore\(\(state\) => state\.theme\)[\s\S]{0,260}useSystemColorMode\(\)/,
  "one application visual revision must update covered screens before Back reveals them",
);
const sceneI18nSource = read("src/i18n/scene-instance.ts");
assert.match(
  sceneI18nSource,
  /i18n\.cloneInstance\(\{[\s\S]{0,120}lng: language,[\s\S]{0,80}initAsync: false/,
  "each mounted scene language must use a cheap resource-sharing i18n clone rather than the mutable global language",
);
assert.match(screenPreferencesBoundary, /getSceneI18n\(language\)/);
assert.match(
  screenPreferencesBoundary,
  /<I18nextProvider i18n=\{sceneI18n\} defaultNS="translation">/,
  "a blurred scene must keep the translator that belongs to its coherent snapshot",
);
assert.doesNotMatch(
  visualSnapshotProviderSource,
  /translationNamespaceRevision|i18n=\{i18n\}/,
  "provider identity tricks must not expose blurred scenes to the shared mutable i18n language",
);
const settingsStackLayout = read("app/settings/_layout.tsx");
assert.match(
  screenPreferencesBoundary,
  /VisualEffectiveModeContext[\s\S]{0,240}effectiveMode/,
  "every scene snapshot must carry the already resolved light/dark mode",
);
assert.match(
  screenPreferencesBoundary,
  /function ScreenVisualTree\([\s\S]{0,650}<ThemeProvider\s+effectiveMode=\{snapshot\.effectiveMode\}\s*>/,
  "the React theme and NativeWind variables must come from one coherent application snapshot",
);
assert.match(
  screenPreferencesBoundary,
  /return <ScreenVisualTree snapshot=\{visible\}>\{children\}<\/ScreenVisualTree>;/,
  "the live visual revision must wrap the entire route tree atomically",
);
assert.match(
  screenPreferencesBoundary,
  /export function FocusDeferredScreenPreferencesBoundary[\s\S]{0,700}const deferred = React\.useDeferredValue\(live\)[\s\S]{0,160}const presented = focused \? live : deferred[\s\S]{0,160}<ScreenVisualTree snapshot=\{presented\}>/,
  "covered Home must catch up through interruptible work while focus always publishes the live coherent visual revision",
);
assert.doesNotMatch(
  screenPreferencesBoundary,
  /FocusDeferredScreenPreferencesBoundary[\s\S]{0,900}retainedRef/,
  "the Home boundary must not retain a stale visual snapshot until focus",
);
assert.doesNotMatch(
  screenPreferencesBoundary,
  /freezeColorSchemeVariables|colorSchemeForVariables/,
  "a scene must never publish a new color identity while retaining NativeWind variables from the previous color",
);
assert.doesNotMatch(
  settingsStackLayout,
  /freezeColorSchemeVariables/,
  "the settings stack must not split visual color ownership between context and NativeWind variables",
);
const directSystemThemeSubscribers = [
  ...listTypeScriptFiles("app"),
  ...listTypeScriptFiles("src"),
].filter((path) => read(path).includes("useColorScheme"));
assert.deepEqual(
  directSystemThemeSubscribers,
  [],
  "only the process-wide system appearance store may observe Android/iOS theme changes; scenes and leaves must read their coherent effective mode",
);
assert.equal(
  systemAppearance.match(/= Appearance\.addChangeListener\(/g)?.length,
  1,
  "system appearance must have one process-wide native subscription owner",
);
assert.match(
  screenPreferencesBoundary,
  /export function useVisualEffectiveMode\(\)/,
  "leaf components must read the effective mode from their scene snapshot",
);
assert.doesNotMatch(
  settingsScreen,
  /router\.prefetch\("\/settings\/(?:theme|language|color-scheme)"\)/,
  "the custom Settings stack must not mount sibling option screens off-screen; a preloaded sibling can be painted above the requested route",
);
assert.match(themeSettingsScreen, /const ThemeRow = React\.memo/);
assert.match(languageSettingsScreen, /const LanguageRow = React\.memo/);
assert.match(themeSettingsScreen, /const selectTheme = React\.useCallback/);
assert.match(
  languageSettingsScreen,
  /const selectLanguage = React\.useCallback/,
);
assert.doesNotMatch(
  appModal,
  /if \(visible\)[\s\S]{0,500}opacity\.setValue\(0\)/,
  "an interrupted modal close must reopen from its current opacity without a transparent flash",
);
assert.match(
  themeProvider,
  /export function ThemeVariablesProvider\([\s\S]{0,500}const hostStyle = useMemo\([\s\S]{0,100}\[StyleSheet\.absoluteFillObject, themeStyle\],[\s\S]{0,80}\[themeStyle\],[\s\S]{0,100}style=\{hostStyle\}/,
  "portal theme variables must be restored without adding a flex sibling beside the navigator",
);
assert.doesNotMatch(
  themeProvider,
  /style=\{\[/,
  "theme hosts must preserve inline style identity between unchanged visual revisions",
);
assert.doesNotMatch(
  themeProvider,
  /function ThemeVariablesProvider[\s\S]{0,500}className="bg-background"/,
  "the portal bridge must not paint over transparent scrims",
);
assert.doesNotMatch(
  appModal,
  /navigationBarBackgroundColor|navigationBarScrimOpacity|setAndroidNavigationBar/,
);
assert.match(appRootLayout, /<PortalProvider>/);
assert.doesNotMatch(
  appRootLayout,
  /react-native-keyboard-controller|KeyboardProvider/,
  "the root must not force Android edge-to-edge keyboard ownership and defeat adjustResize",
);
assert.match(
  appRootLayout,
  /<GestureHandlerRootView style=\{\{ flex: 1 \}\}>[\s\S]{0,80}<SafeAreaProvider>/,
);
assert.match(appRootLayout, /setAndroidNavigationBarTheme\(isDarkTheme\)/);
assert.match(appRootLayout, /setAndroidNavigationBarTheme\(isSystemDark\)/);
const appChromeStart = appRootLayout.indexOf("function AppChromeBoundary");
const appNavigationStart = appRootLayout.indexOf("const AppNavigation");
const appContentStart = appRootLayout.indexOf("function AppContent");
const startupStateStart = appRootLayout.indexOf("function StartupState");
assert.ok(appChromeStart >= 0);
assert.ok(appNavigationStart > appChromeStart);
assert.ok(appContentStart > appNavigationStart);
assert.ok(startupStateStart > appContentStart);
const appChromeSource = appRootLayout.slice(appChromeStart, appNavigationStart);
const appContentSource = appRootLayout.slice(
  appContentStart,
  startupStateStart,
);
const startupStateEnd = appRootLayout.indexOf(
  "function MigratedApp",
  startupStateStart,
);
const startupStateSource = appRootLayout.slice(
  startupStateStart,
  startupStateEnd,
);
assert.doesNotMatch(
  appContentSource,
  /usePathname\(\)/,
  "route observation must not re-render the root app stack",
);
assert.doesNotMatch(
  appChromeSource,
  /screenListeners|transitionEnd|requestAnimationFrame/,
);
assert.match(
  appChromeSource,
  /useLayoutEffect\(\(\) => \{[\s\S]{0,100}setAndroidNavigationBarTheme\(isDarkTheme\)/,
  "the Android navigation button style must be dispatched in the same commit boundary as a theme repaint",
);
assert.match(
  startupStateSource,
  /useLayoutEffect\(\(\) => \{[\s\S]{0,100}setAndroidNavigationBarTheme\(isSystemDark\)/,
  "startup system-bar styling must not wait for a passive post-paint effect",
);
assert.doesNotMatch(appRootLayout, /usePathname/);
assert.doesNotMatch(
  appChromeSource,
  /state\.colorScheme/,
  "accent changes must not re-render the root navigator",
);
assert.doesNotMatch(
  appContentSource,
  /useSettingsStore\(/,
  "unrelated setting changes must not re-render AppContent",
);
assert.match(
  appContentSource,
  /<AppChromeBoundary>[\s\S]*?<ScreenPreferencesBoundary>[\s\S]*?<AppNavigation \/>[\s\S]*?<\/ScreenPreferencesBoundary>[\s\S]*?<\/AppChromeBoundary>/,
  "all routes must share one live visual revision so covered screens are ready before reveal",
);
assert.equal(
  (appRootLayout.match(/<ScreenPreferencesBoundary\b/g) ?? []).length,
  1,
  "the root must own exactly one visual-preferences subscription boundary",
);
assert.match(
  mainScreen,
  /<FocusDeferredScreenPreferencesBoundary focused=\{homeIsFocused\}>[\s\S]{0,500}<HabitListScreenVisualContent/,
  "the retained Home route must shield its large row tree from urgent visual updates on a covering route",
);
assert.match(
  systemNavigationBar,
  /NavigationBar\.setStyle\(isDarkTheme \? "dark" : "light"\)/,
);
assert.match(systemNavigationBar, /if \(Platform\.OS !== "android"\) return;/);
assert.match(
  systemNavigationBar,
  /Constants\.executionEnvironment === ExecutionEnvironment\.StoreClient[\s\S]{0,100}setExpoGoNavigationBarTheme\(isDarkTheme\);[\s\S]{0,40}return;/,
  "Expo Go must receive an opaque host-bar background before the standalone edge-to-edge branch",
);
assert.match(
  systemNavigationBar,
  /expo-navigation-bar\/build\/ExpoNavigationBar\.android/,
);
assert.match(
  systemNavigationBar,
  /setBackgroundColorAsync!\(processedBackground\)/,
);
assert.match(
  systemNavigationBar,
  /setBorderColorAsync!\(processedBackground\)/,
);
assert.match(systemNavigationBar, /setButtonStyleAsync!\(buttonStyle\)/);
assert.doesNotMatch(
  systemNavigationBar,
  /screenStyle|overlayStyles|overlayOrder|applyQueue|usePathname/,
  "Expo Go fallback must not restore asynchronous route or overlay ownership",
);
assert.doesNotMatch(
  dialog,
  /navigationBarBackgroundColor|navigationBarScrimOpacity/,
);
assert.doesNotMatch(
  dropdownMenu,
  /navigationBarBackgroundColor|navigationBarScrimOpacity/,
);
assert.doesNotMatch(mainScreen, /navigationBarBackgroundColor/);
assert.doesNotMatch(detailMenu, /navigationBarBackgroundColor/);
const navigationBarPlugin = read("plugins/with-transparent-navigation-bar.js");
assert.match(navigationBarPlugin, /android:enforceNavigationBarContrast/);
assert.match(navigationBarPlugin, /value: "false"/);
assert.doesNotMatch(
  navigationBarPlugin,
  /name:\s*"enforceNavigationBarContrast"/,
  "the unqualified style attribute does not exist and breaks Android resource linking",
);
assert.match(read("app.json"), /\.\/plugins\/with-transparent-navigation-bar/);
assert.match(
  detailMenu,
  /icon: "trash-sharp",[\s\S]{0,80}iconFamily: "ionicons"/,
);
assert.doesNotMatch(detailMenu, /icon: "delete"|delete-outline/);
assert.match(
  archiveScreen,
  /icon: "trash-sharp" as const,[\s\S]{0,80}iconFamily: "ionicons" as const/,
);
assert.doesNotMatch(archiveScreen, /icon: "delete" as const|delete-outline/);
assert.doesNotMatch(
  mainScreen,
  /router\.prefetch\("\/settings"\)/,
  "Expo Router 6 must not create an off-screen duplicate of the custom nested Settings stack",
);
const focusedRouteModuleWarmup = read(
  "src/components/FocusedRouteModuleWarmup.tsx",
);
const routeModuleWarmup = read("src/utils/route-module-warmup.ts");
assert.match(focusedRouteModuleWarmup, /const isFocused = useIsFocused\(\)/);
assert.match(
  focusedRouteModuleWarmup,
  /if \(!isFocused\) return;[\s\S]{0,180}return \(\) => task\.cancel\(\)/,
  "retained native-stack scenes must stop scheduling module warmup as soon as they blur",
);
assert.match(
  routeModuleWarmup,
  /runWhenUiIsIdle\([\s\S]{0,1200}entry\.load\(\)/,
);
assert.doesNotMatch(
  routeModuleWarmup,
  /runAfterUiSettles|timeoutMs|5_000/,
  "optional cold imports must never be forced into a busy user interaction by a timeout",
);
assert.doesNotMatch(
  routeModuleWarmup,
  /router\.|prefetch\(/,
  "module warmup may evaluate code while idle but must never create a hidden navigation scene",
);

const dialogSource = read("src/components/ui/Dialog.tsx");
const reminderScreen = read(
  "src/features/habit-form/components/ReminderScreen.tsx",
);
const reminderSaveHandlerSource = reminderScreen.slice(
  reminderScreen.indexOf("const handleSave"),
  reminderScreen.indexOf("const handleAddReminder"),
);
assert.match(dialogSource, /titleAccessory\?: React\.ReactNode/);
assert.match(reminderScreen, /titleAccessory=\{/);
assert.match(
  reminderScreen,
  /contentStyle=\{\[[\s\S]{0,260}Platform\.OS === "ios"[\s\S]{0,160}width: iosDialogWidth/,
  "the established wider iOS reminder card must override only Dialog content geometry",
);
assert.doesNotMatch(reminderScreen, /titleStyle=\{\{ display: "none" \}\}/);
assert.match(
  reminderScreen,
  /const removeButtonIconColor = isDark \? "#B0B0B0" : "#666666"/,
);
assert.match(
  reminderSaveHandlerSource,
  /const currentEnabled = enabledRef\.current;[\s\S]{0,1800}onSave\(Boolean\(encoded\) && currentEnabled, encoded\);/,
  "saving reminders must pass the current draft to its single parent command owner",
);
assert.doesNotMatch(
  reminderSaveHandlerSource,
  /onBack\(|pendingSaveActionRef/,
  "the reminder draft must not close the overlay separately or invent a generic fallback commit",
);
assert.doesNotMatch(reminderScreen, /09:00|findNextReminderTime/);
assert.match(
  reminderScreen,
  /const \[times, setTimes\] = useState<string\[\]>\(\(\) =>[\s\S]{0,80}parseReminderTimes\(initialTime\)/,
);
assert.doesNotMatch(
  reminderScreen,
  /setTimes\(parseReminderTimes\(initialTime\)\)/,
  "an already-open reminder editor must not reset its draft from changing props",
);
assert.doesNotMatch(
  reminderScreen,
  /setEnabled\(initialEnabled/,
  "an already-open reminder editor must not reset its toggle from changing props",
);
assert.match(reminderScreen, /function ReminderScreenSession\(/);
assert.match(
  reminderScreen,
  /type ReminderScreenSessionSnapshot = Pick<[\s\S]{0,120}"enabled" \| "time"/,
  "only reminder values from the opening frame may seed its draft",
);
assert.match(
  reminderScreen,
  /time=\{snapshot\.time\}[\s\S]{0,100}onSave=\{props\.onSave\}[\s\S]{0,80}onBack=\{props\.onBack\}/,
  "reminder actions must remain current while the editor is open",
);
assert.match(reminderScreen, /useRetainedModalSession/);
assert.match(
  reminderScreen,
  /const handleDismiss = \(\) => \{\s*invalidateAndroidPickerSession\(\);\s*invalidateIOSPickerSession\(\);\s*onDismiss\(\);\s*\};[\s\S]{0,500}onDismiss=\{handleDismiss\}/,
  "dismissing the retained reminder dialog must invalidate its native picker generation before releasing the session",
);
assert.match(
  reminderScreen,
  /interface AndroidReminderPickerSession\s*\{\s*generation: number;\s*ownerSessionKey: number;/,
  "Android time-picker callbacks must belong to one explicit editor generation",
);
assert.match(
  reminderScreen,
  /const consumeCurrentPickerSession =[\s\S]{0,1200}mountedRef\.current[\s\S]{0,160}visibleRef\.current[\s\S]{0,300}currentSession\?\.generation === pickerSession\.generation[\s\S]{0,300}committedSessionKeyRef\.current === pickerSession\.ownerSessionKey/,
  "Android picker callbacks must fail closed after unmount, hide, replacement, or session change",
);
assert.match(
  reminderScreen,
  /const handleOpenError = \(\) => \{\s*if \(!consumeCurrentPickerSession\(\)\) \{\s*return;[\s\S]{0,900}onError: handleOpenError,\s*onChange: \(event, selectedDate\) => \{\s*if \(!consumeCurrentPickerSession\(\)\) \{\s*return;/,
  "both asynchronous native open failures and returned values must use the generation guard",
);
assert.match(
  reminderScreen,
  /mountedRef\.current = false;\s*invalidateAndroidPickerSession\(\);[\s\S]{0,300}visibleRef\.current = visible;\s*if \(!visible\) \{\s*invalidateAndroidPickerSession\(\);/,
  "closing or unmounting the reminder editor must dismiss its Android time picker",
);
assert.doesNotMatch(
  reminderScreen,
  /<ReminderScreenSession\s+key=\{session\.key\}/,
  "a new reminder draft must not remount the Dialog/AppModal physical host",
);
assert.match(
  reminderScreen,
  /sessionKey=\{session\.key\}[\s\S]{0,120}visible=\{props\.visible\}/,
  "the stable reminder host must receive the new draft generation explicitly",
);
assert.match(
  reminderScreen,
  /if \(observedSessionKey !== sessionKey\)[\s\S]{0,900}setPickerValue\(nextPickerValue\)/,
  "a new reminder session must reset its complete draft before committing a visible frame",
);
assert.match(
  reminderScreen,
  /const canSave =[\s\S]{0,120}effectiveTimes\.length > 0/,
);
const addReminderSource = reminderScreen.slice(
  reminderScreen.indexOf("const handleAddReminder"),
  reminderScreen.indexOf("const handleRemoveReminder"),
);
assert.match(addReminderSource, /updateIsAddingTime\(true\)/);
assert.match(addReminderSource, /DateTimePickerAndroid|openAndroidTimePicker/);
const androidReminderPickerIndex = addReminderSource.indexOf(
  "openAndroidTimePicker(",
);
const appendReminderTimeIndex = addReminderSource.indexOf(
  "updateTimes(nextTimes);",
);
const enableReminderAfterTimeIndex = addReminderSource.indexOf(
  "updateEnabled(true);",
  appendReminderTimeIndex,
);
assert.ok(
  androidReminderPickerIndex >= 0 &&
    appendReminderTimeIndex > androidReminderPickerIndex &&
    enableReminderAfterTimeIndex > appendReminderTimeIndex,
  "a confirmed first reminder must append its selected time without rebuilding the editor",
);
const toggleReminderSource = reminderScreen.slice(
  reminderScreen.indexOf("const handleToggle"),
  reminderScreen.indexOf("const handleRemoveReminder"),
);
assert.match(toggleReminderSource, /if \(timesRef\.current\.length === 0\)/);
assert.match(
  toggleReminderSource,
  /updateEnabled\(true\);[\s\S]{0,180}handleAddReminder\([\s\S]{0,120}Platform\.OS === "android"/,
);
assert.match(
  addReminderSource,
  /rollbackEnabledOnCancel\s*\? \{\s*onDismiss: \(\) => \{\s*updateEnabled\(false\);\s*\},\s*onOpenError: \(\) => \{\s*updateEnabled\(false\);/,
  "cancelling the first Android time picker must roll back the optimistic toggle",
);
assert.match(
  reminderScreen,
  /DateTimePickerAndroid\.open\(\{[\s\S]{0,160}positiveButton:[\s\S]{0,100}textColor: accent,[\s\S]{0,160}negativeButton:[\s\S]{0,100}textColor: removeButtonIconColor/,
);
assert.match(
  reminderScreen,
  /<DateTimePicker[\s\S]{0,220}accentColor=\{accent\}[\s\S]{0,120}themeVariant=\{isDark \? "dark" : "light"\}/,
  "the inline iOS time picker must follow the app's explicit accent and theme instead of the phone theme",
);
assert.match(
  reminderScreen,
  /const iosTimePickerWidth = 290;[\s\S]{0,240}const iosDialogHorizontalPadding = Math\.max\([\s\S]{0,120}iosDialogWidth - iosTimePickerWidth/,
  "the Expo 54 iOS wheel picker must receive its measured native width inside the reminder dialog",
);
assert.match(
  reminderScreen,
  /contentStyle=\{\[[\s\S]{0,180}Platform\.OS === "ios"[\s\S]{0,100}width: iosDialogWidth,[\s\S]{0,100}paddingHorizontal: iosDialogHorizontalPadding/,
  "only iOS may widen the reminder dialog for the native wheel picker",
);
assert.match(
  reminderScreen,
  /<DateTimePicker[\s\S]{0,300}style=\{\{ width: iosTimePickerWidth \}\}/,
  "the iOS wheel picker must retain its explicit native width",
);
const reminderToggleAccessorySource = reminderScreen.slice(
  reminderScreen.indexOf("titleAccessory={"),
  reminderScreen.indexOf(
    "actions={[",
    reminderScreen.indexOf("titleAccessory={"),
  ),
);
assert.match(reminderToggleAccessorySource, /<Pressable/);
assert.match(reminderToggleAccessorySource, /pointerEvents="none"/);
assert.match(reminderToggleAccessorySource, /<Toggle\s+value=\{enabled\}/);
assert.doesNotMatch(
  reminderScreen,
  /androidPickerVisible|setAndroidPickerVisible/,
);

const habitBreakdown = read(
  "src/features/statistics/components/HabitBreakdown.tsx",
);
assert.match(habitBreakdown, /active:bg-press-highlight/);
assert.match(
  habitBreakdown,
  /<View style=\{\{ marginLeft: 4 \}\}>[\s\S]{0,100}<Icon name="chevron-right"/,
);
const completedToggleVisual = read(
  "src/features/habits/components/CompletedSectionToggleVisual.tsx",
);
assert.match(
  completedToggleVisual,
  /toggleRow:[\s\S]{0,220}paddingLeft: 20/,
  "completed-section arrow must share the habit checkbox center line",
);
const themeTokens = read("src/theme/tokens.ts");
const tailwindConfig = read("tailwind.config.js");
assert.match(themeTokens, /sectionCard: 14/);
assert.match(themeTokens, /listCard: 10/);
assert.doesNotMatch(themeTokens, /\n\s*card: 12/);
assert.match(tailwindConfig, /"section-card": "14px"/);
assert.match(tailwindConfig, /"list-card": "10px"/);
for (const source of [
  read("app/create.tsx"),
  read("app/statistics.tsx"),
  read("src/features/statistics/components/BarChart.tsx"),
  habitBreakdown,
  read("src/features/statistics/components/Heatmap.tsx"),
  read("src/features/statistics/components/PeriodSelector.tsx"),
  read("src/features/statistics/components/SummaryCards.tsx"),
  read("src/features/habit-detail/components/EditRows.tsx"),
  read("src/features/habit-detail/components/InlineDescription.tsx"),
  read("src/features/habit-detail/components/MonthCalendar.tsx"),
  read("src/features/habit-detail/components/ProgressStats.tsx"),
]) {
  assert.doesNotMatch(source, /rounded-\[14px\]/);
}

const inlineDescription = read(
  "src/features/habit-detail/components/InlineDescription.tsx",
);
const habitDescriptionLinesSetting = read(
  "src/application/settings/habit-description-lines-setting.ts",
);
const habitStore = read("src/stores/habit-store.ts");
const habitPersistenceTracker = read(
  "src/application/habits/habit-write-fence.ts",
);
const habitPersistenceApplication = read(
  "src/application/habits/habit-persistence.ts",
);
const habitPersistenceRepository = read("src/data/sqlite/habit-repository.ts");
const chunkedDelete = read("src/data/sqlite/chunked-delete.ts");
const habitDetailHook = read(
  "src/features/habit-detail/hooks/useHabitDetail.ts",
);
const monthCalendar = read(
  "src/features/habit-detail/components/MonthCalendar.tsx",
);
const progressStats = read(
  "src/features/habit-detail/components/ProgressStats.tsx",
);
const renameDialog = read(
  "src/features/habit-detail/components/RenameDialog.tsx",
);
const habitActionSlice = (start: string, end: string): string => {
  const startIndex = habitStore.indexOf(start);
  const endIndex = habitStore.indexOf(end, startIndex + start.length);
  assert.ok(
    startIndex >= 0 && endIndex > startIndex,
    `missing ${start} action`,
  );
  return habitStore.slice(startIndex, endIndex);
};
const assertDeferredPersistence = (
  source: string,
  optimisticMarker: string,
  persistenceMarker: string,
  action: string,
) => {
  const optimisticIndex = source.indexOf(optimisticMarker);
  const opportunityIndex = source.indexOf(
    "await persistenceCommitScheduler.waitForCommitOpportunity();",
    optimisticIndex,
  );
  const persistenceIndex = source.indexOf(persistenceMarker, opportunityIndex);
  assert.ok(optimisticIndex >= 0, `${action} must publish optimistic state`);
  assert.ok(
    opportunityIndex > optimisticIndex,
    `${action} must wait for foreground paint or a background durability fallback`,
  );
  assert.ok(
    persistenceIndex > opportunityIndex,
    `${action} must persist only after the durable scheduling boundary`,
  );
};
assert.match(
  habitPersistenceTracker,
  /capturePendingHabitWriteFence[\s\S]*waitForPendingHabitWritesThrough[\s\S]*waitForHabitPersistenceTurn[\s\S]*releasePendingHabitWriteFence/,
  "export/import must own an exact-cutoff habit write fence",
);
assert.match(
  habitStore,
  /createHabit: withPendingHabitWriteTracking[\s\S]*updateHabit: withPendingHabitWriteTracking[\s\S]*renameHabit: withPendingHabitWriteTracking[\s\S]*reorderHabits: withPendingHabitWriteTracking[\s\S]*archiveHabit: withPendingHabitWriteTracking[\s\S]*restoreHabits: withPendingHabitWriteTracking[\s\S]*deleteHabits: withPendingHabitWriteTracking[\s\S]*markDay: withPendingHabitWriteTracking[\s\S]*unmarkDay: withPendingHabitWriteTracking/,
  "all optimistic habit mutations must remain visible to the export/import drain barrier",
);
assertDeferredPersistence(
  habitActionSlice("  async createHabit", "  async updateHabit"),
  "habits: [...state.habits, optimisticHabit]",
  "habitPersistence.createHabit({",
  "habit create",
);
const postPaintUpdateHabitSource = habitActionSlice(
  "  async updateHabit",
  "  async renameHabit",
);
assertDeferredPersistence(
  postPaintUpdateHabitSource,
  "allHabits: state.allHabits.map(updateModel)",
  "habitPersistence.patchHabit(id",
  "habit metadata update",
);
assertDeferredPersistence(
  postPaintUpdateHabitSource,
  "// Habit detail has already published the complete schedule preview.",
  "habitPersistence.persistScheduleEdit({",
  "habit schedule update",
);
assertDeferredPersistence(
  habitActionSlice("  async renameHabit", "  async reorderHabits"),
  "allHabits: state.allHabits.map(updateName)",
  "habitPersistence.patchHabit(id",
  "habit rename",
);
assertDeferredPersistence(
  habitActionSlice("  async reorderHabits", "  async archiveHabit"),
  "return { habits: nextHabits, allHabits: nextAllHabits }",
  "habitPersistence.persistReorder(orderedIds)",
  "habit reorder persistence",
);
assertDeferredPersistence(
  habitActionSlice("  async archiveHabit", "  async restoreHabit"),
  "allHabits: state.allHabits.map",
  "habitPersistence.archiveHabit(",
  "habit archive",
);
assertDeferredPersistence(
  habitActionSlice("  async restoreHabits", "  async deleteHabit"),
  "set({ habits: nextActiveHabits, allHabits: nextAllHabits })",
  "habitPersistence.restoreHabits(",
  "habit restore",
);
assertDeferredPersistence(
  habitActionSlice("  async deleteHabits", "  async markDay"),
  "allDayRecords: nextAllDayRecords",
  "habitPersistence.deleteHabits(deletedIdList)",
  "habit deletion",
);
assertDeferredPersistence(
  habitActionSlice("  async markDay", "  async unmarkDay"),
  "allDayRecordsByDateCache[date] = optimisticList;",
  "habitPersistence.markDay({",
  "day mark",
);
assertDeferredPersistence(
  habitActionSlice("  async unmarkDay", "  resetInMemoryCaches"),
  "allDayRecordsByDateCache[date] = optimisticList;",
  "habitPersistence.unmarkDay(habitId, date)",
  "day unmark",
);
assert.match(
  inlineDescription,
  /controlBackgroundColor = isDark \? "#383838" : lightTheme\.pressHighlight/,
);
assert.match(inlineDescription, /onFocus=\{handleInputFocus\}/);
assert.match(inlineDescription, /scrollEnabled=\{editing\}/);
assert.doesNotMatch(inlineDescription, /focusTimerRef|setTimeout\(/);
assert.doesNotMatch(inlineDescription, /<Pressable/);
const descriptionKeyboardDismissIndex = inlineDescription.indexOf(
  "Keyboard.dismiss();",
);
const descriptionOptimisticCloseIndex = inlineDescription.indexOf(
  "setEditing(false);",
  descriptionKeyboardDismissIndex,
);
const descriptionPersistenceIndex = inlineDescription.indexOf(
  "const saved = onSave(text);",
  descriptionOptimisticCloseIndex,
);
assert.ok(
  descriptionKeyboardDismissIndex >= 0 &&
    descriptionOptimisticCloseIndex > descriptionKeyboardDismissIndex &&
    descriptionPersistenceIndex > descriptionOptimisticCloseIndex,
  "description must dismiss the keyboard and close optimistically before synchronous optimistic dispatch",
);
assert.doesNotMatch(
  inlineDescription,
  /setIsSaving|await onSave\(text\)/,
  "description save must not add a redundant saving render or await persistence before closing",
);
assert.match(
  inlineDescription,
  /if \(saved === false\)[\s\S]{0,100}setEditing\(true\)/,
);

function assertDescriptionResizeLifecycle(source: string): void {
  const tree = ts.createSourceFile(
    "InlineDescription.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const readGeometryConstant = (name: string, expected: number): number => {
    const values: number[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(tree) === name &&
        node.initializer &&
        ts.isNumericLiteral(node.initializer)
      ) {
        values.push(Number(node.initializer.text));
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    assert.deepEqual(
      values,
      [expected],
      `description ${name} must keep its tuned geometry`,
    );
    return values[0];
  };
  const geometry: Record<string, unknown> = {
    INPUT_LINE_HEIGHT: readGeometryConstant("INPUT_LINE_HEIGHT", 22),
    INPUT_VERTICAL_PADDING: readGeometryConstant("INPUT_VERTICAL_PADDING", 10),
    INPUT_MIN_HEIGHT: readGeometryConstant("INPUT_MIN_HEIGHT", 44),
    MIN_VISIBLE_LINES: DESCRIPTION_LINES_MIN,
    MAX_VISIBLE_LINES: DESCRIPTION_LINES_MAX,
    clampVisibleLines: clampDescriptionVisibleLines,
  };
  geometry.linesToHeight = loadSourceCallableForAudit<
    (lines: number) => number
  >(source, "linesToHeight", geometry);
  geometry.clampHeight = loadSourceCallableForAudit<(height: number) => number>(
    source,
    "clampHeight",
    geometry,
  );
  geometry.heightToLines = loadSourceCallableForAudit<
    (height: number) => number
  >(source, "heightToLines", geometry);
  const cleanupFactories: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === "useEffect"
    ) {
      const factory = node.arguments[0];
      if (
        factory &&
        factory.getText(tree).includes("resizeGestureActiveRef.current = false")
      ) {
        cleanupFactories.push(factory.getText(tree));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(
    cleanupFactories.length,
    1,
    "the description resize gesture must have one lifetime cleanup owner",
  );

  type PersistResult = {
    status: string;
    isLatest: boolean;
    confirmedValue: number;
  };
  type Handlers = {
    onStartShouldSetPanResponder(): boolean;
    onMoveShouldSetPanResponder(event: unknown, state: { dy: number }): boolean;
    onPanResponderGrant(): void;
    onPanResponderMove(event: unknown, state: { dy: number }): void;
    onPanResponderRelease(): void;
    onPanResponderTerminate(): void;
  };
  const createFixture = (editable = true) => {
    const active = { current: false };
    const inputHeight = { current: 64 };
    const dragStart = { current: 64 };
    let renderedHeight = 64;
    let visibleLines = 2;
    const writes: {
      habitId: number;
      lines: number;
      complete?: (result: PersistResult) => void;
    }[] = [];
    const environment = {
      ...geometry,
      editable,
      habitId: 17,
      resizeGestureActiveRef: active,
      inputHeightRef: inputHeight,
      dragStartHeightRef: dragStart,
      setVisibleLines: (lines: number) => {
        visibleLines = lines;
      },
      setInputHeight: (value: number | ((previous: number) => number)) => {
        renderedHeight =
          typeof value === "function" ? value(renderedHeight) : value;
      },
      persistDescriptionVisibleLines: (habitId: number, lines: number) => {
        const write: (typeof writes)[number] = { habitId, lines };
        writes.push(write);
        return {
          then: (complete: (result: PersistResult) => void) => {
            write.complete = complete;
          },
        };
      },
      console: { error: () => {} },
      recoveryFocusFrameRef: { current: null },
      cancelAnimationFrame: () => {},
    };
    const applyDraggedHeight = loadSourceCallableForAudit<(dy: number) => void>(
      source,
      "applyDraggedHeight",
      environment,
    );
    const finishDraggedHeight = loadSourceCallableForAudit<() => void>(
      source,
      "finishDraggedHeight",
      environment,
    );
    const handlers = loadSourceCallableForAudit<() => Handlers>(
      source,
      "panResponder",
      {
        ...environment,
        applyDraggedHeight,
        finishDraggedHeight,
        PanResponder: { create: (value: Handlers) => value },
      },
    )();
    const cleanup = loadSourceCallableForAudit<() => () => void>(
      `const cleanupFactory = ${cleanupFactories[0]};`,
      "cleanupFactory",
      environment,
    )();
    return {
      handlers,
      writes,
      cleanup,
      active,
      inputHeight,
      dragStart,
      commitHeight: () => {
        inputHeight.current = renderedHeight;
      },
      getHeight: () => renderedHeight,
      getLines: () => visibleLines,
    };
  };
  const fixture = createFixture();
  fixture.handlers.onPanResponderRelease();
  fixture.handlers.onPanResponderTerminate();
  assert.equal(
    fixture.writes.length,
    0,
    "ungranted resize callbacks must not persist",
  );
  assert.equal(fixture.handlers.onStartShouldSetPanResponder(), true);
  assert.equal(
    fixture.handlers.onMoveShouldSetPanResponder(null, { dy: 1 }),
    false,
  );
  assert.equal(
    fixture.handlers.onMoveShouldSetPanResponder(null, { dy: 2 }),
    true,
  );
  fixture.handlers.onPanResponderGrant();
  fixture.handlers.onPanResponderMove(null, { dy: 57 });
  fixture.commitHeight();
  fixture.handlers.onPanResponderRelease();
  fixture.handlers.onPanResponderRelease();
  fixture.handlers.onPanResponderTerminate();
  assert.equal(
    fixture.writes.length,
    1,
    "release and terminate must share one consumed resize command",
  );
  assert.deepEqual(
    [fixture.writes[0].habitId, fixture.writes[0].lines],
    [17, 5],
  );
  assert.equal(
    fixture.getHeight(),
    130,
    "release must snap the continuous height to complete lines",
  );
  assert.equal(fixture.getLines(), 5);
  assert.equal(fixture.inputHeight.current, 130);
  assert.equal(fixture.dragStart.current, 130);
  fixture.writes[0].complete?.({
    status: "committed",
    isLatest: true,
    confirmedValue: 1,
  });
  assert.equal(
    fixture.getHeight(),
    130,
    "successful persistence must retain the snapped height",
  );
  fixture.writes[0].complete?.({
    status: "failed",
    isLatest: false,
    confirmedValue: 1,
  });
  assert.equal(
    fixture.getHeight(),
    130,
    "an older failed resize must not replace the current height",
  );
  fixture.writes[0].complete?.({
    status: "failed",
    isLatest: true,
    confirmedValue: 3,
  });
  assert.equal(
    fixture.getHeight(),
    86,
    "the latest failed resize must restore its durable height",
  );
  assert.equal(fixture.getLines(), 3);
  assert.equal(fixture.inputHeight.current, 86);
  assert.equal(fixture.dragStart.current, 86);
  fixture.handlers.onPanResponderGrant();
  fixture.handlers.onPanResponderMove(null, { dy: 100_000 });
  fixture.commitHeight();
  fixture.handlers.onPanResponderTerminate();
  assert.equal(
    fixture.writes.length,
    2,
    "a later gesture must acquire a fresh resize admission",
  );
  assert.equal(fixture.writes[1].lines, DESCRIPTION_LINES_MAX);
  assert.equal(fixture.getHeight(), 900);
  fixture.handlers.onPanResponderGrant();
  fixture.handlers.onPanResponderMove(null, { dy: -100_000 });
  fixture.commitHeight();
  fixture.handlers.onPanResponderRelease();
  assert.equal(fixture.writes[2].lines, DESCRIPTION_LINES_MIN);
  assert.equal(fixture.getHeight(), 44);
  fixture.handlers.onPanResponderGrant();
  fixture.cleanup();
  fixture.handlers.onPanResponderRelease();
  assert.equal(
    fixture.writes.length,
    3,
    "unmount must revoke an unaccepted resize command",
  );
  const acceptedBeforeUnmount = createFixture();
  acceptedBeforeUnmount.handlers.onPanResponderGrant();
  acceptedBeforeUnmount.handlers.onPanResponderRelease();
  acceptedBeforeUnmount.cleanup();
  acceptedBeforeUnmount.handlers.onPanResponderTerminate();
  assert.equal(
    acceptedBeforeUnmount.writes.length,
    1,
    "unmount must not cancel or duplicate a resize command already accepted by persistence",
  );
  assert.equal(
    typeof acceptedBeforeUnmount.writes[0].complete,
    "function",
    "an accepted resize must retain its persistence completion after unmount",
  );
  const readOnly = createFixture(false);
  assert.equal(readOnly.handlers.onStartShouldSetPanResponder(), false);
  assert.equal(
    readOnly.handlers.onMoveShouldSetPanResponder(null, { dy: 50 }),
    false,
  );
  readOnly.handlers.onPanResponderGrant();
  readOnly.handlers.onPanResponderMove(null, { dy: 50 });
  readOnly.commitHeight();
  readOnly.handlers.onPanResponderRelease();
  assert.equal(
    readOnly.writes.length,
    0,
    "a read-only description must not acquire resize admission",
  );
  assert.equal(readOnly.getHeight(), 64);
}
assertDescriptionResizeLifecycle(inlineDescription);
for (const [before, after] of [
  ["if (!resizeGestureActiveRef.current) return;", ""],
  [
    "resizeGestureActiveRef.current = true;",
    "resizeGestureActiveRef.current = false;",
  ],
  [
    "resizeGestureActiveRef.current = false;\n    const snappedLines",
    "const snappedLines",
  ],
  [
    "resizeGestureActiveRef.current = false;\n      if (recoveryFocusFrameRef",
    "if (recoveryFocusFrameRef",
  ],
  [
    'result.status !== "failed" || !result.isLatest',
    'result.status !== "failed"',
  ],
  [
    "const snappedHeight = linesToHeight(snappedLines);",
    "const snappedHeight = inputHeightRef.current;",
  ],
] as const) {
  assert.equal(
    inlineDescription.split(before).length - 1,
    1,
    "resize mutation must identify one exact source contract",
  );
  assert.throws(
    () =>
      assertDescriptionResizeLifecycle(
        inlineDescription.replace(before, after),
      ),
    (error: unknown) => error instanceof assert.AssertionError,
    "resize lifecycle tests must reject a broken admission, completion, rollback, or snap contract",
  );
}
assert.match(
  habitDescriptionLinesSetting,
  /parsePersistedDescriptionLines[\s\S]{0,600}isValidDescriptionLinesValue\(parsed\)[\s\S]{0,120}values\.set\(habitId, clampDescriptionVisibleLines\(parsed\)\)/,
  "description height bootstrap must remain a pure parser until its load token is accepted",
);
assert.match(
  settingsMutationCoordinator,
  /this\.currentByScope\.set\([\s\S]{0,120}ownedCommand\.scope[\s\S]{0,650}this\.trackDurable/,
  "description expansion state must update synchronously before tracked persistence",
);
assert.match(
  settingsMutationCoordinator,
  /getHabitDescriptionLinesScopeHabitId\(ownedCommand\.scope\)[\s\S]{0,180}!this\.confirmedByScope\.has\(ownedCommand\.scope\)[\s\S]{0,220}DESCRIPTION_LINES_DEFAULT/,
  "a first-ever dynamic description command must register a rollback baseline before enqueue",
);
assert.match(
  settingsMutationCoordinator,
  /if \(this\.isCurrent\(command\.scope, revision\)\)[\s\S]{0,220}this\.currentByScope\.set\([\s\S]{0,180}cloneMutationValue\(command\.scope, confirmedValue\)/,
  "a latest failed description write must roll back to the real confirmed value",
);
assert.match(
  settingsStore,
  /const habitDescriptionLines = parsePersistedDescriptionLines\(rows\);[\s\S]{0,8000}createSettingsMutationSnapshot\([\s\S]{0,140}habitDescriptionLines/,
  "only an accepted settings snapshot may hydrate description height state",
);
assert.match(
  setLanguageSource,
  /settingsMutationCoordinator\.submit\(\{[\s\S]{0,100}scope,[\s\S]{0,100}value: normalizedLanguage[\s\S]{0,220}set\(\{ language: normalizedLanguage, error: null \}\)/,
  "rapid language changes must publish immediately through typed coordinator intents",
);
assert.match(
  settingsMutationCoordinator,
  /requestedEffects\.set\(effect\.kind[\s\S]{0,2600}if \(!this\.isCurrent\(requested\.scope, requested\.revision\)\) continue/,
  "only the latest durable language/reminder intent may reach its global side-effect owner",
);

const visibleDateOwnerIndex = mainScreen.indexOf(
  "const [resolvedDateForList, setResolvedDateForList]",
);
const requestedDateOwnerIndex = mainScreen.indexOf(
  "const [requestedDateForList, setRequestedDateForList]",
);
const visibleDateAliasIndex = mainScreen.indexOf(
  "const interactiveDateForLists = resolvedDateForList;",
);
assert.ok(
  visibleDateOwnerIndex >= 0 &&
    requestedDateOwnerIndex > visibleDateOwnerIndex &&
    visibleDateAliasIndex > requestedDateOwnerIndex,
  "the home header, calendar and both habit sections must share one visible date",
);
assert.doesNotMatch(
  mainScreen,
  /setInteractiveDateForLists/,
  "home date switching must not publish the list date in a later React update",
);
assert.match(
  mainScreen,
  /const isDateSwitchPending = selectedDate !== resolvedDateForList;/,
  "cold date loading must keep the complete previous day visible until the requested day is ready",
);
const homeDatePrepareIndex = handleSelectDateSource.indexOf(
  "getDayListSnapshotForState(",
);
const homeDateReadyIndex = handleSelectDateSource.indexOf(
  "const listSnapshotReady = hasDayListSnapshotForState(",
);
const homeDateSnapLockIndex = handleSelectDateSource.indexOf(
  "setIsDateEpochSnapLock(true);",
);
const homeDatePublishIndex = handleSelectDateSource.indexOf(
  "setResolvedDateForList(",
  homeDateSnapLockIndex,
);
assert.ok(
  homeDatePrepareIndex >= 0 &&
    homeDateReadyIndex > homeDatePrepareIndex &&
    homeDateSnapLockIndex > homeDateReadyIndex &&
    homeDatePublishIndex > homeDateSnapLockIndex,
  "a warm Home date must derive its complete list and arm the snap lock before publishing the visible epoch",
);
const selectDateHandlerStart = mainScreen.indexOf(
  "const handleSelectDate = useCallback",
);
const selectDateHandlerEnd = mainScreen.indexOf(
  "const handleSelectDateRef",
  selectDateHandlerStart,
);
assert.ok(
  selectDateHandlerStart >= 0 && selectDateHandlerEnd > selectDateHandlerStart,
);
const selectDateHandlerSource = mainScreen.slice(
  selectDateHandlerStart,
  selectDateHandlerEnd,
);
assert.match(
  selectDateHandlerSource,
  /if \(date === selectedDate\) return;/,
  "reselecting an already-requested date must reuse the pending presentation",
);
assert.match(selectDateHandlerSource, /setRequestedDateForList/);
assert.match(
  selectDateHandlerSource,
  /if \(listSnapshotReady\)[\s\S]*?setResolvedDateForList/,
  "a warm day must publish one complete visible date while a repeated tap can cancel an older cold request",
);
assert.match(
  settingsStore,
  /if \(nextOrders === currentOrders\) return true;[\s\S]{0,180}settingsMutationCoordinator\.submit\(/,
  "a no-op statistics reorder must not invalidate a pending real persistence",
);
assert.doesNotMatch(
  inlineDescription,
  /@\/data\/|@\/db\/|runtimeDb|getFirstSync|runSync|execSync/,
  "description presentation must not own persistence or synchronous SQLite",
);
assert.match(
  inlineDescription,
  /initialVisibleLinesRef\.current == null[\s\S]{0,140}readPersistedDescriptionVisibleLines\(habitId\)/,
);
assert.match(
  inlineDescription,
  /persistDescriptionVisibleLines\(habitId, snappedLines\)\.then/,
);
assert.match(inlineDescription, /from "@\/composition\/settings"/);
assert.match(inlineDescription, /display: visible \? "flex" : "none"/);
assert.doesNotMatch(inlineDescription, /if \(!visible\) return null/);
assert.match(inlineDescription, /React\.memo\(function InlineDescription/);
assert.match(settingsStackLayout, /const OPEN_DURATION_MS = 98/);
assert.match(settingsStackLayout, /const CLOSE_DURATION_MS = 80/);
assert.match(settingsStackLayout, /const OPEN_EASING = Easing\.linear/);
assert.match(settingsStackLayout, /const CLOSE_EASING = Easing\.linear/);
assert.match(settingsStackLayout, /const INCOMING_SHIFT_RATIO = 0\.2/);
assert.match(settingsStackLayout, /const OUTGOING_SHIFT_RATIO = 0\.2/);
assert.match(
  settingsStackLayout,
  /detachInactiveScreens/,
  "inactive Settings native views must detach while the global visual owner keeps their theme current",
);
assert.match(
  settingsStackLayout,
  /const effectiveMode = useVisualEffectiveMode\(\);[\s\S]{0,180}const stackBackgroundColor = settingsScreenBackgrounds\[effectiveMode\]/,
  "the retained stack background must come from the shared effective visual theme",
);
assert.match(
  settingsStackLayout,
  /cardStyle: \{ backgroundColor: stackBackgroundColor \}/,
  "Settings cards must be opaque so the native container cannot flash through",
);
assert.match(settingsStackLayout, /Animated\.add\(/);
assert.match(
  settingsStackLayout,
  /const cardStyleInterpolator = useMemo\([\s\S]{0,180}createIncomingOnlyInterpolator\(windowWidth\)[\s\S]{0,140}\[windowWidth\]/,
  "the tuned Settings interpolator must stay referentially stable until viewport width changes",
);
assert.match(
  settingsStackLayout,
  /const screenOptions = useMemo<StackNavigationOptions>\([\s\S]{0,900}cardStyleInterpolator,[\s\S]{0,180}\[cardStyleInterpolator, stackBackgroundColor\]/,
  "nested Settings descriptors must not churn their option identities on unrelated renders",
);
assert.match(
  settingsStackLayout,
  /screenOptions=\{screenOptions\}/,
  "the nested navigator must receive the stable options owner",
);
assert.doesNotMatch(
  settingsStackLayout,
  /screenListeners=\{\(\{ route \}\) =>/,
  "the nested navigator must not rebuild its listener factory inline",
);
assert.match(habitStore, /if \(!changesSchedule\)/);
assert.match(
  habitStore,
  /if \(!changesSchedule\)[\s\S]{0,3600}await habitPersistence\.patchHabit\(id, persistablePatch\)/,
  "simple habit edits must publish optimistic state before async persistence",
);
assert.match(
  habitStore,
  /return \{[\s\S]{0,80}habits: nextHabits,[\s\S]{0,120}allHabits: state\.allHabits\.map\(updateModel\)/,
);
const updateHabitSource = habitStore.slice(
  habitStore.indexOf("async updateHabit"),
  habitStore.indexOf("async renameHabit"),
);
const renameHabitSource = habitStore.slice(
  habitStore.indexOf("async renameHabit"),
  habitStore.indexOf("async reorderHabits"),
);
const reorderHabitsSource = habitStore.slice(
  habitStore.indexOf("async reorderHabits"),
  habitStore.indexOf("async archiveHabit"),
);
assert.match(
  reorderHabitsSource,
  /new Set\(orderedIds\)\.size !== orderedIds\.length/,
  "a reorder payload with duplicate ids must not drop a habit",
);
const archiveHabitSource = habitStore.slice(
  habitStore.indexOf("async archiveHabit"),
  habitStore.indexOf("async restoreHabit"),
);
const restoreHabitsSource = habitStore.slice(
  habitStore.indexOf("async restoreHabits"),
  habitStore.indexOf("async deleteHabit"),
);
const deleteHabitsSource = habitStore.slice(
  habitStore.indexOf("async deleteHabits"),
  habitStore.indexOf("async markDay"),
);
const createHabitSource = habitStore.slice(
  habitStore.indexOf("async createHabit"),
  habitStore.indexOf("async updateHabit"),
);
assert.match(
  createHabitSource,
  /habits: \[\.\.\.state\.habits, optimisticHabit\][\s\S]{0,2200}await habitPersistence\.createHabit\(\{/,
  "a newly created habit must publish before async SQLite insertion",
);
assert.match(
  habitStore,
  /const pendingOptimisticHabitIds = new Set<number>\(\)/,
  "optimistic habit creation must retain a registry independent of loading",
);
const loadHabitsSource = habitStore.slice(
  habitStore.indexOf("async loadHabits("),
  habitStore.indexOf("async loadDayRecords"),
);
assert.match(
  loadHabitsSource,
  /const pendingHabits = committedImport\s*\? \[\]\s*:\s*get\(\)\.habits\.filter[\s\S]{0,180}pendingOptimisticHabitIds\.has\(habit\.id\)/,
  "ordinary refresh must preserve pending creations while committed import excludes old commands",
);
const loadHabitsQueryIndex = loadHabitsSource.indexOf(
  "return await readAndPublishCurrentHabits(",
);
const loadHabitsDeletionFilterIndex = loadHabitsSource.indexOf(
  "const publishableHabits = committedImport",
);
assert.match(loadHabitsSource, /const publishableHabits = committedImport\s*\? allHabits\s*:\s*allHabits\.filter/);
const loadHabitsPendingDeletionIndex = loadHabitsSource.indexOf(
  "!pendingHabitDeletionIds.has(habit.id)",
  loadHabitsDeletionFilterIndex,
);
const loadHabitsTombstoneIndex = loadHabitsSource.indexOf(
  "!deletedHabitTombstones.has(habit.id)",
  loadHabitsDeletionFilterIndex,
);
const loadHabitsPublishIndex = loadHabitsSource.indexOf(
  "allHabits: [...publishableHabits, ...pendingHabits]",
);
assert.ok(
  loadHabitsQueryIndex >= 0 &&
    loadHabitsDeletionFilterIndex > loadHabitsQueryIndex &&
    loadHabitsPendingDeletionIndex > loadHabitsDeletionFilterIndex &&
    loadHabitsTombstoneIndex > loadHabitsPendingDeletionIndex &&
    loadHabitsPublishIndex > loadHabitsTombstoneIndex,
  "ordinary habit publication must filter live pending and tombstoned IDs before publishing",
);
const habitReadOwnerStart = habitStore.indexOf("async function readAndPublishCurrentHabits(");
const habitReadOwnerEnd = habitStore.indexOf("export const useHabitStore", habitReadOwnerStart);
assert.ok(habitReadOwnerStart >= 0 && habitReadOwnerEnd > habitReadOwnerStart);
const habitReadOwner = habitStore.slice(habitReadOwnerStart, habitReadOwnerEnd);
const habitBarrierCaptureIndex = habitReadOwner.indexOf("committedImport ? null : captureHabitReadBarrier()");
const habitBarrierWaitIndex = habitReadOwner.indexOf("await barrier.settled;");
const habitReadIndex = habitReadOwner.indexOf("habits = await queryAllHabitModels();");
const habitReadAdmissionIndex = habitReadOwner.lastIndexOf("if (barrier && !isHabitReadBarrierCurrent(barrier)) continue;");
const habitReadPublishIndex = habitReadOwner.indexOf("publish(habits);");
assert.ok(
  habitBarrierCaptureIndex >= 0 &&
    habitBarrierWaitIndex > habitBarrierCaptureIndex &&
    habitReadIndex > habitBarrierWaitIndex &&
    habitReadAdmissionIndex > habitReadIndex &&
    habitReadPublishIndex > habitReadAdmissionIndex,
  "ordinary habit reads must settle a captured write barrier and recheck admission before same-turn publication",
);
const loadAllDayRecordsSource = habitStore.slice(
  habitStore.indexOf("async loadAllDayRecords(options)"),
  habitStore.indexOf("async createHabit(input"),
);
assert.match(
  loadAllDayRecordsSource,
  /readAndPublishCurrentDayRecords\([\s\S]{0,150}queryAllDayRecordModels,\s*\(queried\) => \{[\s\S]{0,500}queried\.filter\([\s\S]{0,140}!pendingHabitDeletionIds\.has\(record\.habitId\)[\s\S]{0,100}!deletedHabitTombstones\.has\(record\.habitId\)/,
  "a full record reload must not resurrect records belonging to a pending deleted habit",
);
assert.match(
  createHabitSource,
  /const creationEpoch = dataCacheEpoch[\s\S]{0,9000}creationEpoch !== dataCacheEpoch[\s\S]{0,1400}replaceOrAppend/,
  "habit creation must neither disappear behind a concurrent load nor leak across an import reset",
);
assert.match(
  habitStore,
  /scheduleHabitRemindersSync\([\s\S]{0,120}loadedHabits\.filter\(\(habit\) => habit\.id > 0\)/,
  "temporary habit ids must never own native reminder notifications",
);
const markDaySource = habitStore.slice(
  habitStore.indexOf("async markDay"),
  habitStore.indexOf("async unmarkDay"),
);
const unmarkDaySource = habitStore.slice(habitStore.indexOf("async unmarkDay"));
assert.match(
  habitPersistenceApplication,
  /persistScheduleEdit\(input\)[\s\S]{0,120}return repository\.transaction\(async \(session\) =>/,
  "schedule edits must run through the application-owned atomic protocol",
);
assert.match(
  habitPersistenceApplication,
  /if \(reason != null\) \{[\s\S]{0,180}return repository\.transaction\(async \(session\) => \{[\s\S]{0,180}await persistRecord\(session\)[\s\S]{0,260}await session\.insertReasonNote/,
  "reason notes must persist atomically with their day record",
);
assert.match(
  habitPersistenceApplication,
  /One UPSERT is atomic[\s\S]{0,160}return persistRecord\(repository\)/,
  "ordinary completion marks must use one atomic UPSERT without a transaction wrapper",
);
assert.match(
  habitPersistenceApplication,
  /deleteHabits\(habitIds\)[\s\S]{0,180}repository\.transaction\(async \(session\) =>[\s\S]{0,220}session\.deleteSettingsByKeys\(settingKeys\)[\s\S]{0,160}session\.deleteHabitsByIds\(habitIds\)/,
  "habit deletion must atomically remove its description-size setting",
);
assert.match(habitPersistenceRepository, /INSERT INTO habits/);
assert.match(habitPersistenceRepository, /INSERT INTO notes/);
assert.match(
  habitPersistenceRepository,
  /deleteSettingsByKeys\(keys\)[\s\S]{0,260}deleteSqliteRowsByValues\([\s\S]{0,160}\{ table: "settings", column: "key" \}[\s\S]{0,80}keys/,
  "habit deletion must route settings cleanup through the bounded SQLite delete helper",
);
assert.match(
  habitPersistenceRepository,
  /deleteHabitsByIds\(habitIds\)[\s\S]{0,260}deleteSqliteRowsByValues\([\s\S]{0,160}\{ table: "habits", column: "id" \}[\s\S]{0,80}habitIds/,
  "habit deletion must route habit cleanup through the bounded SQLite delete helper",
);
assert.match(
  chunkedDelete,
  /offset \+= SQLITE_DELETE_BIND_CHUNK_SIZE[\s\S]{0,260}values\.slice\(offset, offset \+ SQLITE_DELETE_BIND_CHUNK_SIZE\)[\s\S]{0,220}executor\.run\([\s\S]{0,100}`DELETE FROM \$\{target\.table\} WHERE \$\{target\.column\} IN/,
  "the shared delete helper must preserve bounded bind chunks without owning a transaction",
);
assert.doesNotMatch(
  chunkedDelete,
  /\.transaction\(|BEGIN\b|COMMIT\b/,
  "chunked deletion must remain inside the caller-owned atomic transaction",
);
assert.match(
  habitStore,
  /resetInMemoryCaches\(\)[\s\S]{0,160}dataCacheEpoch \+= 1[\s\S]{0,500}allHabitsLoaded: false[\s\S]{0,300}allDayRecordsLoaded: false/,
  "import cache reset must invalidate old reads and both full-data snapshots",
);
assertSourceOrder(
  markDaySource,
  [
    "dayRecordOverlays.set(overlayKey, optimisticRecord);",
    "set((state) => {",
    "allDayRecords: nextAll,",
    "await persistenceCommitScheduler.waitForCommitOpportunity();",
    "await habitPersistence.markDay({",
  ],
  "the visible day mark must commit before async SQLite persistence",
);
assert.match(
  markDaySource,
  /isHabitTrackingActiveOnDate[\s\S]{0,500}isHabitScheduledForDate/,
  "marking a day must preserve the tracking-window and repeat-schedule guards",
);
assert.match(
  habitStore,
  /preloadDayRecordsWindow[\s\S]{0,9000}applyDayRecordOverlaysForDate/,
  "a late date-window preload must preserve optimistic day-record overlays",
);
assert.match(
  mainScreen,
  /preloadDayRecordsWindow\(centerDate, PRELOAD_DAY_RADIUS\)\.then\([\s\S]{0,700}runWhenUiIsIdle\(\(\) => \{[\s\S]{0,300}preloadDayListSnapshotsWindow\(centerDate, PRELOAD_DAY_RADIUS\)/,
  "neighbor list snapshots must be derived only after their records exist and in a second idle slot",
);
assert.match(
  habitStore,
  /export function hasDayListSnapshotForState[\s\S]{0,800}cached\.habitsRef === state\.habits[\s\S]{0,200}cached\.dayRecordsRef === dayRecordsForDate[\s\S]{0,200}cached\.allDayRecordsRef === state\.allDayRecords/,
  "Home list-snapshot cache hits must match the exact immutable inputs",
);
assert.match(
  markDaySource,
  /isLatestDayMutation\(overlayKey, mutationId\)[\s\S]{0,2400}dayRecordOverlays\.delete\(overlayKey\)/,
  "a persisted day mark must release its optimistic overlay",
);
assert.match(
  unmarkDaySource,
  /isLatestDayMutation\(overlayKey, mutationId\)[\s\S]{0,220}dayRecordOverlays\.delete\(overlayKey\)/,
  "a persisted day removal must release its optimistic overlay",
);
assert.match(
  habitStore,
  /async deleteHabits[\s\S]{0,1800}beginDayMutation[\s\S]{0,2600}clearDayRecordOverlaysForHabits/,
  "habit deletion must invalidate pending day writes and release their overlays",
);
assert.match(
  habitStore,
  /type HabitMutationScope =[\s\S]{0,80}"existence"[\s\S]{0,700}const ALL_HABIT_MUTATION_SCOPES/,
  "habit deletion must be able to supersede every pending field and lifecycle mutation",
);
assert.match(
  archiveHabitSource,
  /beginHabitMutation\(id, \[[\s\S]{0,100}"existence"[\s\S]{0,100}"lifecycle"[\s\S]{0,5000}queryHabitModelById\(id\)[\s\S]{0,300}const stillOwnsLifecycle/,
  "archive rollback must use authoritative lifecycle state and cannot resurrect a habit after a newer delete",
);
assert.match(
  habitStore,
  /function areHabitsSemanticallyEqual[\s\S]{0,2600}function upsertSortedHabit[\s\S]{0,500}if \(areHabitsSemanticallyEqual\(current, habit\)\) return collection;/,
  "authoritative habit acknowledgements must preserve collection references when they equal the optimistic state",
);
assert.match(
  archiveHabitSource,
  /collections\.habits === state\.habits[\s\S]{0,120}collections\.allHabits === state\.allHabits[\s\S]{0,100}return state;/,
  "an equal archive acknowledgement must not publish a second store update",
);
assert.match(
  restoreHabitsSource,
  /ownershipById[\s\S]{0,300}beginHabitMutation\(habit\.id,[\s\S]{0,120}"existence"[\s\S]{0,120}"lifecycle"[\s\S]{0,2600}habitPersistence\.restoreHabits\(/,
  "bulk restore must own each habit independently and derive lifecycle history from SQLite",
);
assert.match(
  habitPersistenceApplication,
  /restoreHabits\([\s\S]{0,180}repository\.transaction\(async \(session\) =>[\s\S]{0,220}await session\.readHabit\(habitId\)/,
  "bulk restore must derive each lifecycle transition from the authoritative persisted habit",
);
assert.doesNotMatch(
  restoreHabitsSource,
  /habits: stateBefore\.habits|allHabits: stateBefore\.allHabits/,
  "bulk restore failure must not replace whole collections with stale snapshots",
);
assert.match(
  deleteHabitsSource,
  /beginHabitMutation\(id, ALL_HABIT_MUTATION_SCOPES\)[\s\S]{0,180}pendingHabitDeletionIds\.add[\s\S]{0,7000}queryHabitModelById\(id\)[\s\S]{0,120}queryHabitDayRecordModels\(id\)[\s\S]{0,5000}upsertHabitInCollections/,
  "failed deletion must restore only still-owned authoritative habits and records",
);
assert.doesNotMatch(
  deleteHabitsSource,
  /dayRecordOverlays\.clear\(\)|habits: stateBefore\.habits|allHabits: stateBefore\.allHabits/,
  "failed deletion must not clobber unrelated overlays or whole habit collections",
);
assert.match(
  reorderHabitsSource,
  /queryAllHabitModels\(\)[\s\S]{0,500}if \(token !== reorderWriteToken\) return[\s\S]{0,700}authoritativeOrders[\s\S]{0,500}reconcileDisplayOrderRows/,
  "reorder failure must reconcile only authoritative order after checking lifecycle invalidation",
);
assert.doesNotMatch(
  reorderHabitsSource,
  /habits: currentHabits|await get\(\)\.loadHabits\(\)/,
  "reorder failure must not publish a stale whole-list snapshot",
);
assert.match(
  habitStore,
  /function finishDayMutation[\s\S]{0,180}latestDayMutationIds\.delete/,
  "completed day writes must not leak mutation bookkeeping",
);
assert.match(
  habitStore,
  /function finishHabitMutation[\s\S]{0,420}latestHabitMutationIds\.delete/,
  "completed habit writes must not leak mutation bookkeeping",
);
assert.match(
  habitStore,
  /type HabitMutationScope =[\s\S]{0,500}"description-visible"[\s\S]{0,260}"schedule"[\s\S]{0,260}"lifecycle"/,
  "unrelated habit fields must have independent optimistic-mutation ownership",
);
assert.match(
  updateHabitSource,
  /if \(!isLatestHabitMutation\(ownership, "schedule"\)\)[\s\S]{0,2800}finishHabitMutation\(ownership\);[\s\S]{0,420}return;/,
  "an older schedule transaction must never publish over a newer visible schedule intent",
);
assert.match(
  updateHabitSource,
  /await queryHabitModelById\(id\)[\s\S]{0,300}const stillOwnsAnyScope = ownership\.scopes\.some[\s\S]{0,900}if \(stillOwnsAnyScope && rollbackHabit\)[\s\S]{0,1800}else if \(stillOwnsAnyScope\)/,
  "a failed ordinary update A must neither roll back nor publish an error after a newer same-field update B owns its scopes",
);
assert.match(
  renameHabitSource,
  /await queryHabitModelById\(id\)[\s\S]{0,260}const stillOwnsName = isLatestHabitMutation\(ownership, "name"\)[\s\S]{0,180}if \(stillOwnsName && rollbackHabit\)[\s\S]{0,900}else if \(stillOwnsName\)/,
  "a failed rename A must neither roll back nor publish an error after a newer rename B owns the name",
);
assert.match(
  updateHabitSource,
  /catch \(error\) \{[\s\S]{0,500}isLatestHabitMutation\(ownership, "schedule"\)[\s\S]{0,500}queryHabitModelById\(id\)[\s\S]{0,120}queryHabitDayRecordModels\(id\)[\s\S]{0,240}isLatestHabitMutation\(ownership, "schedule"\)/,
  "a latest failed schedule mutation must recover the authoritative row and records without overriding a newer intent",
);
assert.match(
  habitPersistenceApplication,
  /assertScheduleMutationCurrent\(input\.isCurrent\);[\s\S]{0,120}session\.deleteDayRecordsByIds[\s\S]{0,900}assertScheduleMutationCurrent\(input\.isCurrent\);[\s\S]{0,120}session\.patchHabit[\s\S]{0,160}assertScheduleMutationCurrent\(input\.isCurrent\)/,
  "every superseded schedule transaction, including a mixed caller, must roll back before it can commit destructive record changes",
);
assert.match(
  updateHabitSource,
  /replaceAllHabitRecords\([\s\S]{0,500}replaceHabitRecordsForDate\(/,
  "schedule failure recovery must reconcile both full-history and date-scoped record caches",
);
assert.match(
  markDaySource,
  /if \(habitId <= 0 \|\| pendingHabitDeletionIds\.has\(habitId\)\) return false;[\s\S]*?if \(!habit\) return false;/,
  "temporary or unknown habits must never accept a day mark",
);
assert.match(
  unmarkDaySource,
  /if \(habitId <= 0 \|\| pendingHabitDeletionIds\.has\(habitId\)\) return false;[\s\S]*?if \(!habit \|\| !isHabitTrackingActiveOnDate/,
  "temporary or unavailable habits must never accept a day removal",
);
assert.match(
  habitStore,
  /const SCHEDULED_IDS_CACHE_MAX_DATES = 180[\s\S]{0,12000}while \(scheduledIdsCacheOrder\.length > SCHEDULED_IDS_CACHE_MAX_DATES\)[\s\S]{0,180}scheduledIdsByDateCache\.delete\(evicted\)/,
  "browsing dates must not make the main-screen schedule cache grow forever",
);
assert.match(
  habitStore,
  /resetInMemoryCaches\(\)[\s\S]{0,240}latestHabitMutationIds\.clear\(\)[\s\S]{0,100}latestDayMutationIds\.clear\(\)/,
  "import/reset must invalidate every pending optimistic mutation",
);
assert.match(
  habitPersistenceApplication,
  /const authoritativeHabit = await session\.readHabit\(input\.habitId\)/,
  "schedule edits must read their authoritative habit row through the repository",
);
assert.match(
  habitPersistenceRepository,
  /ON CONFLICT\(habit_id, date\) DO UPDATE SET/,
);
assert.doesNotMatch(habitDetailHook, /\[cachedHabit, habitId, load\]/);
assert.match(habitDetailHook, /const patchHabit = useCallback/);
assert.match(habitDetailHook, /const patchDayStatus = useCallback/);
assert.match(
  habitDetailHook,
  /const cachedHabitRecords = useHabitStore\(\(state\) =>[\s\S]{0,120}getHabitDayRecordsForState\(state, habitId\)/,
  "habit detail must read a stable per-habit record index instead of filtering global history on every store update",
);
assert.doesNotMatch(
  habitDetailHook,
  /allDayRecords\.filter\([\s\S]{0,100}record\.habitId === habitId/,
);
assert.match(
  habitDetailHook,
  /const storedRecords =[\s\S]{0,100}authoritativeRecords \?\?[\s\S]{0,100}allDayRecordsLoaded \? cachedHabitRecords : fallbackRecords/,
  "the loaded global cache must be the sole authoritative owner of detail records",
);
assert.match(
  habitDetailHook,
  /const records = schedulePreview\?\.records \?\? storedRecords/,
  "a schedule edit must publish its habit row and matching calendar records as one visible preview",
);
assert.match(
  habitDetailHook,
  /if \(forceDatabase\) setAuthoritativeRecords\(mappedRecords\)/,
  "an authoritative detail reload must not keep rendering stale global records",
);
assert.match(
  habitDetailHook,
  /if \(useHabitStore\.getState\(\)\.allDayRecordsLoaded\) return;[\s\S]{0,80}setFallbackRecords/,
  "local record patching must only serve the uncached direct-open fallback",
);
assert.doesNotMatch(habitDetailHook, /areDayRecordListsEqual/);
assert.match(
  habitDetailHook,
  /const reload = useCallback\([\s\S]{0,100}\(forceDatabase = false\) => load\(false, forceDatabase\)/,
  "habit detail reload must be able to bypass stale store caches after a failed schedule save",
);
assert.doesNotMatch(habitDetailHook, /\}, \[habit, records, todayDate\]\)/);
assert.match(monthCalendar, /React\.memo\(function MonthCalendar/);
assert.match(monthCalendar, /React\.memo\(function CalendarDayCell/);
assert.match(monthCalendar, /const handleCellPress = useCallback/);
assert.match(monthCalendar, /const \{ dataMap, scheduleRecords \} = useMemo/);
assert.doesNotMatch(monthCalendar, /dayData\.filter\(/);
assert.match(progressStats, /React\.memo\(function ProgressStats/);
assert.match(editRows, /React\.memo\(function EditRows/);
assert.doesNotMatch(
  habitDetailScreen,
  /actionInFlightRef|const \[pendingAction/,
  "habit detail must not restore a render-blocking serialized action state",
);
assertSourceOrder(
  habitDetailStatusOverlayController,
  [
    "const pendingFailureSubmissionRef =",
    "const flushPendingFailureSubmission = useCallback(() => {",
    "pendingFailureSubmissionRef.current = null;",
    "onApplyStatusRef.current({",
    "const openDayMenu = useCallback(",
    "flushPendingFailureSubmission();",
    "useLayoutEffect(",
    "onDismiss={flushPendingFailureSubmission}",
  ],
  "the isolated status owner must wait for the real dialog dismissal, survive a close-to-open reversal, and never lose the captured command",
);
assert.match(
  habitDetailStatusOverlayController,
  /useLayoutEffect\(\s*\(\) => \(\) => \{[\s\S]{0,320}flushPendingFailureSubmission\(\);/,
  "owner unmount must flush an already accepted failure command exactly once",
);
const habitDetailFailureDialogSource = habitDetailStatusOverlayController.slice(
  habitDetailStatusOverlayController.indexOf("const submitFailureReason"),
  habitDetailStatusOverlayController.indexOf(
    "return (",
    habitDetailStatusOverlayController.indexOf("const submitFailureReason"),
  ),
);
assertSourceOrder(
  habitDetailFailureDialogSource,
  [
    "pendingFailureSubmissionRef.current = {",
    "publishFailureDialog({ ...current, visible: false });",
  ],
  "habit-detail reason submission must capture the command before committing the hidden dialog state",
);
assert.doesNotMatch(
  habitDetailFailureDialogSource,
  /onApplyStatusRef\.current|patchDayStatus|persistDayStatus/,
  "habit-detail reason submission must not mutate the calendar in the same commit that hides the dialog",
);
assert.doesNotMatch(
  habitDetailScreen,
  /const \[(?:dayMenu|failureDialog),|<(?:CalendarDayMenu|FailureReasonDialog)\b/,
  "ephemeral calendar status overlays must not be owned by the full detail tree",
);
assert.match(
  habitDetailScreen,
  /useLayoutEffect\(\s*\(\) => \(\) => \{\s*statusOverlayControllerRef\.current\?\.flushPendingCommandBeforeOwnerUnmount\(\);/,
  "parent owner cleanup must flush an accepted child command before unmount",
);
assert.doesNotMatch(
  habitDetailScreen,
  /actionQueueRef/,
  "a component-level queue must not delay ownership of a newer detail action",
);
assert.match(
  habitDetailScreen,
  /action === "repeat" \|\| action === "start-date" \? "schedule" : action/,
  "repeat and start-date edits must share one last-write-wins action scope",
);
const repeatApplySource = habitDetailScreen.slice(
  habitDetailScreen.indexOf("const handleRepeatApply"),
  habitDetailScreen.indexOf("const handleStartDateConfirm"),
);
const startDateApplySource = habitDetailScreen.slice(
  habitDetailScreen.indexOf("const handleStartDateConfirm"),
  habitDetailScreen.indexOf("const handleReminderSave"),
);
assert.ok(
  repeatApplySource.indexOf('runDetailAction("repeat"') >= 0 &&
    repeatApplySource.indexOf("reload(true)") >
      repeatApplySource.indexOf('runDetailAction("repeat"') &&
    startDateApplySource.indexOf('runDetailAction("start-date"') >= 0 &&
    startDateApplySource.indexOf("reload(true)") >
      startDateApplySource.indexOf('runDetailAction("start-date"'),
  "failed repeat and start-date saves must request an authoritative detail reload",
);
assert.match(habitDetailScreen, /const actionVersionsRef = useRef/);
assert.match(habitDetailScreen, /disabled=\{isArchived\}/);
assert.match(habitDetailScreen, /reminderTime=\{habit\.reminderTime\}/);
assert.match(
  habitDetailScreen,
  /patchHabit\(\{ description: text \}\);[\s\S]{0,100}runDetailAction\("description"/,
);
assert.match(
  habitDetailScreen,
  /const descriptionVisible = !previousDescriptionVisible;[\s\S]{0,320}patchHabit\(\{ descriptionVisible \}\);[\s\S]{0,260}updateHabit\(habitId, \{ descriptionVisible \}\)/,
);
assert.match(
  habitDetailScreen,
  /updateHabit\(habitId, \{ descriptionVisible \}\)[\s\S]{0,260}descriptionVisible: previousDescriptionVisible/,
);
assert.match(habitDetailScreen, /const dayData = useMemo\(/);
assert.match(
  habitDetailScreen,
  /const expectedStatus = existing \? null : "done";[\s\S]{0,420}patchDayStatus\(date, expectedStatus\);[\s\S]{0,180}persistDayStatus\(date, "done"\)/,
);
assert.match(
  habitDetailScreen,
  /const persistDayStatus = useCallback\([\s\S]{0,180}markDay\(habitId, date, status, reason\)/,
);
assert.ok(
  startDateApplySource.indexOf("const nextStartDate = date;") >= 0 &&
    startDateApplySource.indexOf("nextStartDate === currentHabit.startDate") >
      startDateApplySource.indexOf("const nextStartDate = date;") &&
    startDateApplySource.indexOf(
      "previewSchedule({ startDate: nextStartDate })",
    ) >
      startDateApplySource.indexOf("nextStartDate === currentHabit.startDate"),
  "start-date UI must publish the validated value before persistence",
);
const reminderApplySource = habitDetailScreen.slice(
  habitDetailScreen.indexOf("const handleReminderSave"),
  habitDetailScreen.indexOf("// Day menu action"),
);
const reminderNextTimeIndex = reminderApplySource.indexOf(
  "const nextTime = nextEnabled ? time : null;",
);
const reminderPatchIndex = reminderApplySource.indexOf(
  "patchHabit({",
  reminderNextTimeIndex,
);
assert.ok(
  reminderNextTimeIndex >= 0 &&
    reminderPatchIndex > reminderNextTimeIndex &&
    reminderApplySource.indexOf(
      "reminderEnabled: nextEnabled",
      reminderPatchIndex,
    ) > reminderPatchIndex,
  "reminder UI must publish the validated value before persistence",
);
assertSourceOrder(
  habitDetailFormOverlayController.slice(
    habitDetailFormOverlayController.indexOf("const saveReminders"),
  ),
  [
    'if (!closeOverlay("reminder", generation)) return;',
    "onReminderSave(enabled, time);",
  ],
  "reminder save must begin overlay dismissal before waking the detail data tree",
);
assert.match(
  habitDetailScreen,
  /previewSchedule\(\{ repeatSchedule: schedule \}\);[\s\S]{0,700}updateHabit\(habitId, \{[\s\S]{0,100}repeatSchedule: schedule,[\s\S]{0,100}startDate: previousStartDate/,
  "repeat edits must publish immediately and persist the complete visible schedule pair",
);
assert.match(
  habitDetailScreen,
  /previewSchedule\(\{ startDate: nextStartDate \}\);[\s\S]{0,400}updateHabit\(habitId, \{[\s\S]{0,100}startDate: nextStartDate,[\s\S]{0,100}repeatSchedule: previousSchedule/,
  "start-date edits must publish immediately and persist the complete visible schedule pair",
);
assert.doesNotMatch(
  habitDetailScreen,
  /runAfter(?:NextUiFrame|UiPaint)/,
  "habit detail persistence must rely on async SQLite rather than synthetic frame delays",
);
assert.match(
  createHabitHook,
  /const persistence = createHabit\(input\);[\s\S]{0,240}router\.back\(\);[\s\S]{0,80}await persistence;/,
  "habit creation navigation must not wait for its SQLite round trip",
);
assert.match(createHabitHook, /const createInFlightRef = useRef\(false\)/);
assert.doesNotMatch(
  createHabitHook,
  /setIsCreating|setCreatingSafe/,
  "optimistic creation must not redraw the departing form only to expose busy state",
);
assert.doesNotMatch(createScreen, /busy: isCreating|!isCreating/);
assert.match(
  renameDialog,
  /inputBackgroundColor = isDarkTheme[\s\S]{0,80}"#262626"[\s\S]{0,80}lightTheme\.pressHighlight/,
);
assert.doesNotMatch(renameDialog, /useLayoutEffect/);
assert.match(renameDialog, /function RenameDialogSession\(/);
assert.match(renameDialog, /useRetainedModalSession/);
assert.match(renameDialog, /onDismiss=\{onDismiss\}/);
assert.match(
  renameDialog,
  /type RenameDialogSessionSnapshot = Pick<RenameDialogProps, "currentName">/,
  "only the opening name may seed a rename draft",
);
assert.match(
  renameDialog,
  /currentName=\{snapshot\.currentName\}[\s\S]{0,100}onCancel=\{props\.onCancel\}[\s\S]{0,80}onSave=\{props\.onSave\}[\s\S]{0,80}busy=\{props\.busy\}[\s\S]{0,100}errorMessage=\{props\.errorMessage\}/,
  "rename actions, busy state, and errors must stay live while open",
);
assert.match(
  renameDialog,
  /key=\{session\.key\}[\s\S]{0,120}visible=\{props\.visible\}/,
);

const homeTransferSource = read(
  "src/features/habits/hooks/useHabitTransfer.ts",
);
assert.match(
  mainScreen,
  /markDay: markDayForTransfer,\s*unmarkDay: unmarkDayForTransfer,/,
  "Home transfer commands must use the screen-owned record adapters",
);
function assertHomeTransferCommandChain(
  homeSource: string,
  transferSource: string,
): void {
  const numericConstants = Object.fromEntries(
    [...(transferSource + "\n" + read("src/features/habits/animation/constants.ts"))
      .matchAll(/^\s*(?:export )?const ([A-Z_]+) = ([\d.]+);/gm)]
      .map((match) => [match[1], Number(match[2])]),
  );
  for (const [kind, completed, hasRow, delivery, admission, reason] of [
    ["checkbox", false, true, "overlay", "open", null],
    ["checkbox", true, true, "overlay", "open", null],
    ["checkbox", true, true, "fallback", "open", null],
    ["checkbox", false, false, "overlay", "open", null],
    ["checkbox", true, false, "overlay", "open", null],
    ["context", false, true, "overlay", "open", null],
    ["context", true, true, "overlay", "open", null],
    ["context", false, false, "overlay", "open", null],
    ["context", false, true, "overlay", "open", "Sample reason"],
    ["context", true, true, "overlay", "open", "Sample reason"],
    ["context", false, false, "overlay", "open", "Sample reason"],
    ["checkbox", false, true, "overlay", "busy", null],
    ["checkbox", false, true, "overlay", "future", null],
    ["context", false, true, "overlay", "busy", null],
    ["context", false, true, "overlay", "future", null],
  ] as const) {
    const date = "2026-05-12";
    const commands: unknown[][] = [];
    const events: string[] = [];
    const timers: { callback: () => void; delay: number }[] = [];
    const pendingCommitRef: {
      current: { habitId: number; runCommit: () => void } | null;
    } = { current: null };
    const pendingCommitTimeoutRef = { current: null as number | null };
    const pendingStatusReasonRef = {
      current: null as {
        habitId: number;
        date: string;
        status: "failure" | "skipped";
        reason: string;
      } | null,
    };
    const recordCommand = (command: unknown[]) => {
      assert.equal(
        pendingCommitRef.current,
        null,
        "a transfer command must release its queue owner before reaching the store",
      );
      assert.equal(
        pendingCommitTimeoutRef.current,
        null,
        "a transfer command must clear its fallback before reaching the store",
      );
      commands.push(command);
      events.push("store");
      return Promise.resolve(true);
    };
    const markDay = loadSourceCallableForAudit<
      (id: number, date: string, status: string) => Promise<void>
    >(homeSource, "markDayForTransfer", {
      pendingStatusReasonRef,
      markDay: (...args: unknown[]) => recordCommand(["mark", ...args]),
    });
    const unmarkDay = loadSourceCallableForAudit<
      (id: number, date: string) => Promise<void>
    >(homeSource, "unmarkDayForTransfer", {
      unmarkDay: (...args: unknown[]) => recordCommand(["unmark", ...args]),
    });
    const item = {
      habit: { id: 41, name: "Sample habit" },
      checkboxState: completed ? "done" : "unmarked",
      currentStreak: 0,
      completedAt: 1,
    };
    const flushPendingCommitRef = { current: (_reason: string) => {} };
    const environment: Record<string, unknown> = {
      ...numericConstants,
      isFuture: admission === "future",
      isBusy: admission === "busy",
      isPast: false,
      selectedDate: date,
      activeItems: hasRow && !completed ? [item] : [],
      completedItems: hasRow && completed ? [item] : [],
      statusByHabitId: new Map(completed ? [[41, "done"]] : []),
      habitOrderIds: [41],
      allDayRecords: [],
      markDay,
      unmarkDay,
      pendingCommitRef,
      pendingCommitTimeoutRef,
      pendingFlightCompletionRef: { current: null },
      transferSyncRef: { current: null },
      flushPendingCommitRef,
      updateRowShiftDuration: () => {},
      setOverlayMountedHabitId: () => {},
      setFlyingState: () => {},
      setIsTransferSyncActive: () => {},
      projectStreakForTransfer: () => 1,
      resolveActiveTargetIndex: () => 0,
      resolveCompletedTargetIndex: () => 0,
      resolvePlannedFlightDurationMs: () => 180,
      resolveFlightGeometry: () => ({
        startY: 0,
        endY: 100,
        startX: 0,
        width: 300,
        clipBottomY: null,
        clipBottomYEnd: null,
      }),
      flight: { startFlight: () => events.push("flight") },
      beginFlight: () => events.push("overlay"),
      setTimeout: (callback: () => void, delay: number) => {
        timers.push({ callback, delay });
        return timers.length;
      },
      clearTimeout: () => events.push("clear-fallback"),
    };
    const load = <T>(name: string) =>
      loadSourceCallableForAudit<T>(transferSource, name, environment);
    environment.finalizeTransferSyncSession = load<() => void>("finalizeTransferSyncSession");
    environment.startTransferSyncSession = load<(args: unknown) => void>("startTransferSyncSession");
    const getIsTransferBusy = load<() => boolean>("getIsTransferBusy");
    environment.getIsTransferBusy = getIsTransferBusy;
    environment.clearPendingCommit = load<() => void>("clearPendingCommit");
    const flush = load<(reason: string) => void>("flushPendingCommit");
    environment.flushPendingCommit = flush;
    flushPendingCommitRef.current = flush;
    environment.queueCommitAfterOverlayReady = load<
      (id: number, commit: () => void) => void
    >("queueCommitAfterOverlayReady");
    environment.launchDownwardFlightImmediately = load<(id: number) => void>(
      "launchDownwardFlightImmediately",
    );
    const checkboxPress = load<(id: number) => boolean>("handleCheckboxPress");
    const contextPress = load<(id: number, status: string) => boolean>(
      "handleContextAction",
    );
    const transfer = { handleContextAction: contextPress, getIsTransferBusy };
    const transferBusyRef = { current: admission === "busy" };
    const homeCheckboxPress = loadSourceCallableForAudit<(id: number) => boolean>(
      homeSource,
      "handleTransferCheckboxPress",
      { transferHandleCheckboxPressRef: { current: checkboxPress } },
    );
    const overlayReady = load<(id: number, layer: string) => void>(
      "handleOverlayVisualReady",
    );
    const homeOverlayReady = loadSourceCallableForAudit<
      (id: number, layer: string) => void
    >(homeSource, "handleTransferOverlayVisualReady", {
      transferHandleOverlayVisualReadyRef: { current: overlayReady },
    });
    const invoke = () => {
      if (kind === "checkbox") {
        const accepted = homeCheckboxPress(41);
        assert.equal(accepted, admission === "open",
          "checkbox feedback must receive actual transfer admission");
        if (accepted && hasRow) {
          assert.equal(homeCheckboxPress(41), false,
            "same-turn duplicate input must not replace a synchronous transfer owner");
        }
      } else if (reason != null) {
        const submitReason = loadSourceCallableForAudit<
          (id: number, date: string, status: string, reason: string) => boolean
        >(homeSource, "handleFailureSubmit", {
          pendingStatusReasonRef,
          transferBusyRef,
          getIsTransferBusy,
          resolvedDateForListRef: { current: date },
          interactiveDateForLists: date,
          transfer,
        });
        assert.equal(submitReason(41, date, "failure", reason), true);
      } else {
        const homeContextPress = loadSourceCallableForAudit<
          (id: number, status: string) => void
        >(homeSource, "handleContextAction", {
          listIsFuture: admission === "future",
          transferBusyRef,
          getIsTransferBusy,
          useSettingsStore: {
            getState: () => ({ askFailureReason: false, askSkipReason: false }),
          },
          transfer,
        });
        homeContextPress(41, "failure");
      }
    };
    invoke();
    if (admission !== "open") {
      assert.deepEqual(
        commands,
        [],
        "blocked Home input must not mutate records",
      );
      assert.equal(pendingCommitRef.current, null);
      continue;
    }
    const waitsForOverlay = kind === "checkbox" && completed && hasRow;
    if (waitsForOverlay) {
      assert.deepEqual(
        commands,
        [],
        "upward transfer must keep its overlay barrier",
      );
      assert.equal(timers.length, 1);
      assert.equal(timers[0].delay, 1200);
      if (delivery === "fallback") timers[0].callback();
      else homeOverlayReady(41, "over");
    } else {
      assert.equal(
        commands.length,
        1,
        "accepted Home input must dispatch in its established phase",
      );
    }
    const expected =
      kind === "checkbox"
        ? completed
          ? ["unmark", 41, date]
          : ["mark", 41, date, "done"]
        : reason == null
          ? ["mark", 41, date, "failure"]
          : ["mark", 41, date, "failure", reason];
    assert.deepEqual(
      commands,
      [expected],
      "the full Home transfer chain must deliver the captured record command exactly once",
    );
    homeOverlayReady(41, completed ? "over" : "under");
    for (const timer of timers) timer.callback();
    flush("fallback");
    assert.deepEqual(
      commands,
      [expected],
      "duplicate overlay and captured fallback callbacks must not repeat an accepted command",
    );
    if (hasRow && (kind === "checkbox" || !completed)) {
      assert.ok(
        events.indexOf("flight") < events.indexOf("store"),
        "native flight setup must precede its durable transfer command",
      );
    }
    assert.equal(
      pendingStatusReasonRef.current,
      null,
      "a matching reason must be consumed by its record adapter",
    );
  }
}
assertHomeTransferCommandChain(mainScreen, homeTransferSource);
for (const [owner, search, replacement] of [
  [
    "transfer",
    "() => transferSyncRef.current != null",
    "() => false",
  ],
  ["transfer", "pending.runCommit();", "void pending.runCommit;"],
  [
    "transfer",
    "pending.runCommit();",
    "pending.runCommit(); pending.runCommit();",
  ],
  [
    "transfer",
    "pendingCommitRef.current = { habitId, runCommit };",
    "pendingCommitRef.current = { habitId, runCommit: () => {} };",
  ],
  [
    "transfer",
    'flushPendingCommit("fallback");\n      }, 1200);',
    "void flushPendingCommit;\n      }, 1200);",
  ],
  [
    "home",
    "await markDay(habitId, date, status, pending.reason);",
    "await markDay(habitId, date, status);",
  ],
  [
    "home",
    "await unmarkDay(habitId, date);",
    'await unmarkDay(habitId, "2026-05-13");',
  ],
  [
    "home",
    "transferHandleCheckboxPressRef.current(habitId);",
    "transferHandleCheckboxPressRef.current(42);",
  ],
] as const) {
  const source = owner === "home" ? mainScreen : homeTransferSource;
  assert.equal(
    source.split(search).length,
    2,
    "each Home command mutation must identify one actual source target",
  );
  const mutated = source.replace(search, replacement);
  assert.throws(
    () =>
      assertHomeTransferCommandChain(
        owner === "home" ? mutated : mainScreen,
        owner === "transfer" ? mutated : homeTransferSource,
      ),
    { name: "AssertionError" },
    "a lost, duplicated or misrouted Home command must violate the composed callback proof",
  );
}

const statisticsHook = read("src/features/statistics/hooks/useStatistics.ts");
const statisticsSession = read(
  "src/application/statistics/statistics-session.ts",
);
const statisticsDomain = read("src/domain/statistics/statistics-period.ts");
const statisticsPrewarm = read(
  "src/features/statistics/utils/statistics-prewarm.ts",
);
const homeScreen = read("app/index.tsx");
const statisticsScreen = read("app/statistics.tsx");
const statisticsReorderableBlocks = read(
  "src/features/statistics/components/ReorderableStatisticsBlocks.tsx",
);
const statisticsBarChart = read(
  "src/features/statistics/components/BarChart.tsx",
);
const statisticsPeriodSelector = read(
  "src/features/statistics/components/PeriodSelector.tsx",
);
const screenWrapper = read("src/components/layout/ScreenWrapper.tsx");
assert.doesNotMatch(
  statisticsHook,
  /@\/db\/client|@\/db\/schema/,
  "statistics must reuse the already-loaded application data",
);
assert.match(
  statisticsHook,
  /function readStatisticsStoreSnapshot\([\s\S]{0,420}allHabits: habitState\.allHabits[\s\S]{0,180}allRecords: habitState\.allDayRecords/,
  "statistics must read one coherent in-memory source snapshot instead of querying SQLite",
);
assert.match(
  statisticsHook,
  /function useLiveStatisticsStoreSnapshot\([\s\S]{0,2200}useHabitStore\.subscribe[\s\S]{0,1400}useSyncExternalStore/,
  "covered Statistics must publish visible source facts before it can be revealed again",
);
assert.match(
  statisticsHook,
  /useFocusEffect\([\s\S]{0,260}statisticsFocusedRef\.current = true[\s\S]{0,260}statisticsFocusedRef\.current = false[\s\S]{0,160}cancelStatisticsPreparation/,
  "expensive Statistics calculations and neighbour work must remain focus-owned",
);
assert.match(
  statisticsDomain,
  /const recordsByHabit = new Map[\s\S]{0,160}const statusByHabitDate = new Map/,
  "record indexes must have one domain owner",
);
assert.match(
  statisticsSession,
  /const build = \(\) => createStatisticsSourceIndex\(source\);\s*return \{\s*source,\s*index: build\(\),\s*periodCache: new Map\(\)/,
  "record indexes and the bounded period cache must share one source session",
);
const statisticsRenderSetupStart = statisticsHook.indexOf(
  "export function useStatistics()",
);
const statisticsRenderSetupEnd = statisticsHook.indexOf(
  "const publishRequestedTarget = useCallback",
  statisticsRenderSetupStart,
);
assert.ok(
  statisticsRenderSetupStart >= 0 &&
    statisticsRenderSetupEnd > statisticsRenderSetupStart,
  "statistics render setup must be isolated before callback-owned commands",
);
const statisticsRenderSetup = statisticsHook.slice(
  statisticsRenderSetupStart,
  statisticsRenderSetupEnd,
);
assert.doesNotMatch(
  statisticsRenderSetup,
  /getStatisticsPeriod\(/,
  "statistics render setup may only peek at prepared data; calculation belongs to callbacks/effects",
);
assert.match(statisticsDomain, /interface HabitPeriodEvaluation/);
assert.match(
  statisticsSession,
  /CURRENT_STATISTICS_PERIOD_TARGETS[\s\S]{0,180}period: "week"[\s\S]{0,100}period: "month"[\s\S]{0,100}period: "year"/,
);
assert.match(
  statisticsPrewarm,
  /const scheduleNextIdleSlot[\s\S]{0,220}runWhenUiIsIdle[\s\S]{0,500}getStatisticsPeriod[\s\S]{0,900}if \(!result\.cacheHit\) break[\s\S]{0,220}scheduleNextIdleSlot\(\)/,
  "statistics prewarming must yield between the week, month and year calculations",
);
assert.doesNotMatch(
  statisticsPrewarm,
  /runAfterUiSettles|timeoutMs|setTimeout/,
  "statistics prewarming must run only in genuine idle time",
);
assert.doesNotMatch(
  statisticsPrewarm,
  /\bset[A-Z]\w*\(/,
  "statistics prewarming must fill only the revision-scoped cache",
);
const statisticsDatePassStart = statisticsDomain.indexOf(
  "for (const { date: dateStr, scheduleFacts } of periodDates)",
);
const statisticsProgressAfterDatePass = statisticsDomain.indexOf(
  "calculatePeriodProgress(scheduledStatuses)",
  statisticsDatePassStart,
);
assert.ok(
  statisticsDatePassStart >= 0 &&
    statisticsProgressAfterDatePass > statisticsDatePassStart,
  "one date/habit pass must supply progress, charts, heatmap, and breakdown counters",
);
assert.equal(
  statisticsDomain.match(
    /for \(const \{ date: dateStr, scheduleFacts \} of periodDates\)/g,
  )?.length,
  1,
  "statistics must not rescan the complete date/habit matrix",
);
assert.match(
  statisticsDomain,
  /for \(let day = startDay; day <= endDay; day \+= 1\) \{\s*const scheduleFacts = createScheduleDateFactsFromDayNumber\(day\);\s*periodDates\.push\(\{ date: scheduleFacts\.date, scheduleFacts \}\);\s*\}[\s\S]{0,2300}evaluation\.isScheduled\(dateStr, scheduleFacts\)/,
  "statistics must parse calendar facts once per date rather than once per habit",
);
assert.doesNotMatch(
  statisticsDomain,
  /scheduledByHabitDate/,
  "statistics must not allocate per-habit date sets before repeating the same scan",
);
assert.doesNotMatch(
  homeScreen,
  /from "@\/application\/statistics\/statistics-session"/,
  "Statistics preparation must not pull the heavy statistics domain into initial Home evaluation",
);
assert.match(
  homeScreen,
  /runWhenUiIsIdle\(\(\) => \{[\s\S]{0,260}import\("@\/features\/statistics\/utils\/statistics-prewarm"\)[\s\S]{0,900}scheduleStatisticsPeriodsPrewarm\(source, \[\s*\{ period: "week", periodOffset: 0 \},\s*\]\)/,
  "Home may prepare only the common current-week deck in a genuine idle slot",
);
assert.doesNotMatch(
  homeScreen,
  /period: "month"|period: "year"|router\.prefetch/,
  "Home must not multiply speculative Statistics work or mount the route off-screen",
);
assert.match(
  homeScreen,
  /statisticsCurrentWeekPrewarmRevisionRef\.current \+= 1;[\s\S]{0,160}statisticsCurrentWeekPrewarmRef\.current\?\.cancel\(\)/,
  "stale Home statistics preparation must be cancellable",
);
const homeStatisticsPressSource = homeScreen.slice(
  homeScreen.indexOf("const handleOpenStatistics"),
  homeScreen.indexOf("const handleOpenMainMenu"),
);
assert.doesNotMatch(
  homeStatisticsPressSource,
  /await |import\(|getStatisticsPeriod\(|runWhenUiIsIdle|useEffect/,
  "opening Statistics must not wait for calculation, dynamic import, or idle work on the input turn",
);
assert.match(
  homeStatisticsPressSource,
  /runNavigationIntent\(\{\s*target: "\/statistics",\s*dispatch: \(\) => \{[\s\S]{0,300}router\.push\("\/statistics"\)/,
  "the navigation gate must dispatch the native push synchronously in the press turn",
);
assert.match(
  homeScreen,
  /const runNavigationIntent = useNavigationIntentGate\(\)/,
  "rapid Statistics taps must use the shared generation-safe navigation gate",
);
assert.match(
  homeStatisticsPressSource,
  /runNavigationIntent\(\{[\s\S]{0,180}target: "\/statistics"[\s\S]{0,1100}if \(result\.status === "blocked"\) \{\s*return;/,
  "an active Statistics navigation intent must reject duplicate taps",
);
assert.match(
  homeScreen,
  /accessibilityLabel: t\("accessibility\.openStatistics"\),\s*onPress: handleOpenStatistics/,
  "the Statistics header action must consume the stable isolated callback",
);
assert.match(
  homeStatisticsPressSource,
  /result\.status === "failed"[\s\S]{0,220}console\.error\("Failed to open statistics", result\.error\)/,
  "a synchronous navigation failure must remain observable through the normal error path",
);
assert.doesNotMatch(
  homeScreen,
  /statisticsNavigationActionIdRef|statisticsNavigationCommittedRef/,
  "Home must not retain a second ad-hoc owner for Statistics navigation locking",
);
assert.match(
  homeScreen,
  /const homeFocusedRef = useRef\(false\)[\s\S]{0,260}scheduleStatisticsCurrentWeekPrewarmRef/,
  "Home statistics prewarm needs a focus owner that does not wake the heavy list",
);
assert.match(
  homeScreen,
  /handleHomeFocusChange = useCallback\([\s\S]{0,140}homeFocusedRef\.current = focused;[\s\S]{0,1100}statisticsCurrentWeekPrewarmRef\.current\?\.cancel\(\)/,
  "leaving Home must synchronously cancel optional statistics prewarm",
);
assert.match(
  homeScreen,
  /handleHomeFocusChange = useCallback\([\s\S]{0,1300}audioWarmupIdleTaskRef\.current\?\.cancel\(\)/,
  "leaving Home must synchronously cancel optional audio warmup",
);
assert.match(
  homeScreen,
  /if \(!homeFocusedRef\.current\) \{[\s\S]{0,180}return;/,
  "prewarm must not start behind another route and must be reschedulable on focus",
);
const homeLayoutSuppressionStart = homeScreen.indexOf(
  "const suppressLayoutAnimations =",
);
const homeLayoutSuppressionEnd = homeScreen.indexOf(
  "const animateCheckboxTransitions =",
  homeLayoutSuppressionStart,
);
assert.ok(
  homeLayoutSuppressionStart >= 0 &&
    homeLayoutSuppressionEnd > homeLayoutSuppressionStart,
  "the Home layout-suppression expression must remain directly auditable",
);
const homeLayoutSuppressionSource = homeScreen.slice(
  homeLayoutSuppressionStart,
  homeLayoutSuppressionEnd,
);
assert.doesNotMatch(
  homeLayoutSuppressionSource,
  /Ref\.current/,
  "rendered Home gesture admission must not depend on an imperative ref that can change without a render",
);
assert.match(
  homeLayoutSuppressionSource,
  /suppressInitialLayoutAnimations[\s\S]*isLayoutEpochSwitchFrame[\s\S]*isDateEpochSnapLock/,
  "Home gesture suppression must retain every reactive geometry-epoch lock",
);
assert.match(
  homeScreen,
  /scheduleStatisticsCurrentWeekPrewarmRef\.current = scheduleCurrentWeek/,
  "the focus coordinator must retain one reschedulable current-period prewarm owner",
);
assert.match(habitStore, /function advanceStreakCacheForHabit/);
assert.match(habitStore, /function advanceScheduledIdsCacheForHabit/);
assert.match(
  habitStore,
  /scheduleHabitReminderAfterRecordChange\(get\(\)\.habits, habitId\)/,
  "native reminder repair must not compete with the visible mark/unmark frame",
);
assert.match(
  statisticsScreen,
  /<View style=\{styles\.presentationRoot\}>\s*\{currentPeriodSelector\}\s*<View style=\{styles\.presentationBody\}>\s*\{retainedScene != null \? \([\s\S]{0,650}<StatisticsPeriodScene\s*period=\{retainedScene\.period\}\s*todayStr=\{retainedScene\.todayStr\}\s*stats=\{retainedScene\.stats\}/,
  "the request selector and its single retained scene must share one presentation root",
);
assert.equal(statisticsScreen.match(/<StatisticsPeriodScene\b/g)?.length, 1);
assert.doesNotMatch(
  statisticsScreen,
  /<StatisticsPeriodScene\s+key=/,
  "a period presentation must not replace the retained scene's React identity",
);
assert.match(
  statisticsScreen,
  /pointerEvents=\{sceneActive \? "auto" : "none"\}\s*accessibilityElementsHidden=\{!sceneActive\}\s*importantForAccessibility=\{\s*sceneActive \? "auto" : "no-hide-descendants"\s*\}/,
  "a covered retained scene must be inert for touch and accessibility",
);
assert.match(
  statisticsScreen,
  /persistedBlockOrder=\{retainedSceneBlockOrder\}/,
);
assert.match(
  statisticsScreen,
  /statisticsBlockOrders\[retainedScene\.period\]/,
);
assert.equal(
  statisticsScreen.match(/style=\{styles\.presentationCover\}/g)?.length,
  2,
  "loading and error must cover the retained scene without removing it",
);
assert.match(
  statisticsScreen,
  /presentationCover:\s*\{\s*\.\.\.StyleSheet\.absoluteFillObject,\s*zIndex: 2,/,
);
assert.doesNotMatch(
  statisticsScreen,
  /hiddenDeckMountCount|readyDeckSceneKeys|StatisticsFallbackScene|deckEnabled|STATISTICS_PERIODS\.slice/,
  "Statistics must not mount invisible week, month, or year chart trees",
);
assert.match(
  statisticsScreen,
  /onNavigate=\{navigatePeriod\}/,
  "period arrows must use the same current selection shown above the body",
);
assert.match(
  statisticsHook,
  /const requestedTargetRef = useRef<StatisticsTarget>\([\s\S]{0,120}periodOffset: 0/,
  "statistics needs a synchronous owner for the latest requested target",
);
const resolveNavigationTargetSource = statisticsHook.slice(
  statisticsHook.indexOf("const resolveNavigationTarget = useCallback"),
  statisticsHook.indexOf("const navigatePeriod = useCallback"),
);
assert.match(
  resolveNavigationTargetSource,
  /const currentOwner = readCurrentStatisticsSource\(\);\s*const currentTarget = normalizeRequestedTargetForSource\(\s*currentOwner\.source,\s*\);\s*return getStatisticsNavigationTarget\(\s*currentTarget,\s*direction,\s*currentOwner\.source\.todayStr,\s*\);/,
  "navigation resolution must normalize the latest requested target against the authoritative civil date",
);
const navigatePeriodSource = statisticsHook.slice(
  statisticsHook.indexOf("const navigatePeriod = useCallback"),
  statisticsHook.indexOf("const changePeriod = useCallback"),
);
const currentOwnerIndex = navigatePeriodSource.indexOf(
  "const currentOwner = readCurrentStatisticsSource()",
);
const currentTargetIndex = navigatePeriodSource.indexOf(
  "const currentTarget = normalizeRequestedTargetForSource(",
);
const admittedTargetIndex = navigatePeriodSource.indexOf(
  "const admittedTarget = getStatisticsNavigationTarget(",
);
const admissionCheckIndex = navigatePeriodSource.indexOf(
  "!targetsEqual(nextTarget, admittedTarget)",
);
const publishTargetIndex = navigatePeriodSource.indexOf(
  "publishRequestedTarget(admittedTarget)",
);
assert.ok(
  currentOwnerIndex >= 0 &&
    currentTargetIndex > currentOwnerIndex &&
    admittedTargetIndex > currentTargetIndex &&
    admissionCheckIndex > admittedTargetIndex &&
    publishTargetIndex > admissionCheckIndex,
  "period navigation must revalidate the supplied target before synchronously publishing its admitted target",
);
assert.match(
  navigatePeriodSource,
  /const admittedTarget = getStatisticsNavigationTarget\(\s*currentTarget,\s*direction,\s*currentOwner\.source\.todayStr,\s*\);\s*if \(\s*targetsEqual\(admittedTarget, currentTarget\) \|\|\s*!targetsEqual\(nextTarget, admittedTarget\)/,
  "both boundary no-ops and stale supplied targets must be rejected before publication",
);
assert.match(
  statisticsHook,
  /const periodRange = getStatisticsPeriodRange\(\s*period,\s*periodOffset,\s*periodBaseCivilDate,\s*\);/,
  "the visible period must obtain its label and body bounds from the domain range resolver",
);
assert.match(
  statisticsHook,
  /const visibleTarget = \{ period, periodOffset \};\s*const canNavigatePrevious = canNavigateStatisticsBackward\(\s*visibleTarget,\s*periodBaseCivilDate,\s*\);\s*const canNavigateNext = canNavigateStatisticsForward\(\s*visibleTarget,\s*periodBaseCivilDate,\s*\);/,
  "both navigation directions must remain atomic with the visible selector, civil date and body",
);
assert.match(
  statisticsScreen,
  /<PeriodSelector\s*period=\{period\}\s*periodRange=\{periodRange\}\s*canNavigatePrevious=\{canNavigatePrevious\}\s*canNavigateNext=\{canNavigateNext\}/,
  "the selector must receive the visible bounded range and both navigation capabilities",
);
assert.match(
  statisticsPeriodSelector,
  /const isPreviousDisabled = !canNavigatePrevious;\s*const isNextDisabled = !canNavigateNext;/,
  "a cold historical request must remain reversible before its body is ready",
);
assert.match(statisticsPeriodSelector, /disabled=\{isPreviousDisabled\}/);
assert.match(statisticsPeriodSelector, /disabled=\{isNextDisabled\}/);
assert.match(
  statisticsPeriodSelector,
  /getPeriodLabel\(period, language, periodRange\)/,
  "the selector must format the same clipped period range as its data",
);
assert.doesNotMatch(
  statisticsScreen,
  /preparationHeader|preparationFallback|lastEmptyPresentationRef/,
  "statistics must not retain stale selector or empty-state snapshots while the requested target prepares",
);
const statisticsReorderSource = statisticsScreen.slice(
  statisticsScreen.indexOf("const handlePeriodReorder"),
  statisticsScreen.indexOf("const currentPeriodSelector"),
);
assert.match(
  statisticsScreen,
  /statisticsBlockOrders\[retainedScene\.period\]/,
  "the retained statistics scene must use its own period's block order",
);
assert.match(
  statisticsReorderSource,
  /setPersistedBlockOrder\(reorderedPeriod, nextFullOrder\)/,
  "week, month and year must read and save independent block orders",
);
assert.doesNotMatch(
  statisticsScreen,
  /PanResponder/,
);
assert.match(statisticsReorderableBlocks, /Gesture\.Pan\(\)/);
assert.match(
  statisticsReorderableBlocks,
  /React\.memo\(function ReorderableStatisticsRow/,
  "height collection must not rerender every heavy statistics row",
);
assert.match(
  statisticsReorderableBlocks,
  /const \[scenePresentation, setScenePresentation\] =\s*React\.useState[\s\S]*?effectiveNativeOrder\.map\(\(id\) => \([\s\S]*?<ReorderableStatisticsRow[\s\S]*?enabled=\{layoutReady && sceneInteractive\}[\s\S]*?controllerMounted=\{controllerShouldBeMounted\}/,
  "one stable keyed row tree must survive presentation handoff while unproven geometry cannot start a drag",
);
assert.doesNotMatch(
  statisticsReorderableBlocks,
  /layoutReady \? \([\s\S]{0,300}effectiveNativeOrder\.map[\s\S]{0,1800}\) : \([\s\S]{0,300}effectiveNativeOrder\.map/,
  "statistics content must not remount between measurement and absolute layout",
);
assert.match(
  statisticsReorderableBlocks,
  /activeCode >= 0[\s\S]{0,120}withTiming\(translateY[\s\S]{0,180}: translateY/,
  "idle period changes must not animate blocks from a stale order",
);
assert.match(
  statisticsReorderableBlocks,
  /activateAfterLongPress\(DRAG_ACTIVATE_MS\)/,
);
assert.match(statisticsReorderableBlocks, /useAnimatedScrollHandler\(/);
assert.match(
  statisticsReorderableBlocks,
  /removeClippedSubviews=\{false\}/,
  "all four rows must remain measurable while a hidden period restores a non-zero scroll offset",
);
assert.match(
  statisticsReorderableBlocks,
  /const TOP_SCROLL_SETTLE_THRESHOLD_DP = 16;/,
);
assert.match(
  statisticsReorderableBlocks,
  /const TOP_SCROLL_SETTLE_DELAY_MS = 30;/,
);
assert.match(
  statisticsReorderableBlocks,
  /onScroll: \(event\) => \{[\s\S]{0,100}if \(draggingCode\.value >= 0\) return;/,
);
assert.match(statisticsReorderableBlocks, /onBeginDrag: \(\) =>/);
assert.match(statisticsReorderableBlocks, /onEndDrag: \(event\) =>/);
assert.match(statisticsReorderableBlocks, /onMomentumBegin: \(\) =>/);
assert.match(statisticsReorderableBlocks, /onMomentumEnd: \(event\) =>/);
assert.match(
  statisticsReorderableBlocks,
  /shouldSettleStatisticsAtTop\([\s\S]{0,220}dragCode\.value,[\s\S]{0,100}scrollDragActive\.value,[\s\S]{0,100}scrollMomentumActive\.value/,
);
assert.match(statisticsReorderableBlocks, /scrollTo\(ref, 0, 0, false\)/);
assert.match(statisticsReorderableBlocks, /useFrameCallback\(/);
assert.match(
  statisticsReorderableBlocks,
  /if \(nextOffset === previousOffset\) return;/,
);
assert.doesNotMatch(
  statisticsReorderableBlocks,
  /Math\.abs\(nextOffset - previousOffset\) < 0\.1|nextOffset === previousOffset\)[\s\S]{0,80}autoScrollVelocity\.value = 0/,
);
assert.match(
  statisticsReorderableBlocks,
  /scrollTo\(scrollRef, 0, nextOffset, false\)/,
);
const statisticsReorderMath = read(
  "src/features/statistics/utils/ui-thread-reorder.ts",
);
assert.match(
  statisticsReorderMath,
  /edgeZone = 56,[\s\S]{0,40}maxVelocity = 0\.8/,
);
assert.match(
  statisticsReorderMath,
  /return -maxVelocity \* proximity;[\s\S]{0,240}return maxVelocity \* proximity;/,
);
const autoScrollOffsetWrite = statisticsReorderableBlocks.lastIndexOf(
  "scrollOffset.value = nextOffset;",
);
const autoScrollDragCompensation = statisticsReorderableBlocks.lastIndexOf(
  "updateActiveDragPosition(",
);
const autoScrollCommand = statisticsReorderableBlocks.lastIndexOf(
  "scrollTo(scrollRef, 0, nextOffset, false);",
);
assert.ok(autoScrollOffsetWrite >= 0);
assert.ok(autoScrollDragCompensation > autoScrollOffsetWrite);
assert.ok(
  autoScrollCommand > autoScrollDragCompensation,
  "drag compensation must reach the UI thread before the matching scrollTo",
);
assert.match(
  statisticsReorderableBlocks,
  /dragTop\.value = withTiming\([\s\S]{0,180}DROP_SETTLE_MS/,
);
assert.match(
  statisticsReorderableBlocks,
  /activeCode >= 0[\s\S]{0,120}withTiming\(translateY,[\s\S]{0,140}NEIGHBOR_SHIFT_MS[\s\S]{0,140}: translateY/,
);
assert.match(statisticsReorderableBlocks, /function StatisticsDragOverlay\(/);
assert.match(
  statisticsReorderableBlocks,
  /pointerEvents="none"[\s\S]{0,260}style=\{\[styles\.overlay, animatedStyle\]\}/,
);
assert.match(
  statisticsReorderableBlocks,
  /translateY: getStatisticsViewportDragTop\([\s\S]{0,100}dragTop\.value,[\s\S]{0,100}scrollOffset\.value/,
);
assert.match(
  statisticsReorderableBlocks,
  /const hiddenBehindOverlay = overlayReady\.value === 1;[\s\S]{0,100}opacity: hiddenBehindOverlay \? 0 : 1/,
);
assert.match(
  statisticsReorderableBlocks,
  /draggingCode\.value < 0 \|\|[\s\S]{0,80}overlayReady\.value !== 1 \|\|[\s\S]{0,80}autoScrollVelocity\.value === 0/,
);
assert.match(
  statisticsReorderableBlocks,
  /committedOrder\.value = nextOrder;[\s\S]{0,120}overlayReady\.value = 0;[\s\S]{0,120}draggingCode\.value = -1;/,
);
assert.match(
  statisticsReorderableBlocks,
  /<View style=\{\{ flex: 1, overflow: "hidden" \}\}>[\s\S]*<Animated\.ScrollView[\s\S]*<StatisticsDragOverlay/,
);
assert.doesNotMatch(
  statisticsReorderableBlocks,
  /nativeScrollOffset|getStatisticsRenderedDragTop|console\.log/,
);
assert.match(
  statisticsReorderableBlocks,
  /const presentationKey = React\.useMemo\([\s\S]{0,260}getStatisticsScenePresentationKey\([\s\S]{0,120}props\.visibleOrder[\s\S]{0,120}props\.geometryRevision/,
  "the statistics drag scene must survive pure reorder and receive an explicit content-geometry revision",
);
assert.match(
  statisticsScreen,
  /sceneKey=\{String\(retainedScene\.presentationRevision\)\}[\s\S]{0,120}onReorderPeriod=\{handlePeriodReorder\}/,
  "a new period/content presentation must reset stale drag geometry",
);
assert.match(
  statisticsScreen,
  /geometryRevision=\{`\$\{sceneKey\}:\$\{language\}`\}/,
  "every statistics scene must include content and language in its geometry revision",
);
assert.match(statisticsScreen, /active=\{sceneActive\}/);
assert.doesNotMatch(
  statisticsHook,
  /sceneDeckRevision|currentPeriodResults|setSceneDeckRevision/,
  "idle Statistics cache warming must stay non-observable and must not schedule a hidden render",
);
assert.match(
  statisticsHook,
  /scheduleStatisticsPeriodsPrewarm\(source, \[\s*\.\.\.adjacentTargets,\s*\.\.\.CURRENT_STATISTICS_PERIOD_TARGETS,\s*\]\);/,
  "Statistics may warm calculation caches after a commit without publishing another screen render",
);
assert.match(
  statisticsHook,
  /presentationRevisionRef\.current \+= 1;[\s\S]{0,100}revision: presentationRevisionRef\.current/,
  "published statistics content must carry a monotonic geometry revision",
);
const statisticsRowAnimatedStyleStart = statisticsReorderableBlocks.indexOf(
  "  const animatedStyle = useAnimatedStyle(() => {",
);
const statisticsRowAnimatedStyleEnd = statisticsReorderableBlocks.indexOf(
  "\n  return (\n    <Animated.View",
  statisticsRowAnimatedStyleStart,
);
assert.ok(statisticsRowAnimatedStyleStart >= 0);
assert.ok(statisticsRowAnimatedStyleEnd > statisticsRowAnimatedStyleStart);
const statisticsRowAnimatedStyle = statisticsReorderableBlocks.slice(
  statisticsRowAnimatedStyleStart,
  statisticsRowAnimatedStyleEnd,
);
assert.doesNotMatch(
  statisticsRowAnimatedStyle,
  /\b(?:enabled|positioned|idleTop|layoutRevision)\b/,
  "the UI-thread position mapper must not restart from period-dependent React props",
);
assert.match(
  statisticsRowAnimatedStyle,
  /geometryReady\.value !== 1[\s\S]{0,180}transform: undefined/,
  "the first correct Yoga-flow frame must be visible before Reanimated owns row transforms",
);
assert.match(
  statisticsRowAnimatedStyle,
  /activeCode >= 0[\s\S]{0,220}: committedOrder\.value[\s\S]{0,180}const targetTop = topForCode\(targetOrder, heights\.value, code\)/,
  "idle rows must derive their winning animated position only from stable UI-thread shared values",
);
const statisticsPresentationStableIndex = statisticsReorderableBlocks.indexOf(
  "resolveStatisticsPresentationHeights(",
);
const statisticsPresentationRebaseIndex = statisticsReorderableBlocks.indexOf(
  "nextBaseOrder.value = targetOrder;",
  statisticsPresentationStableIndex,
);
const statisticsPresentationGeometryReadyIndex =
  statisticsReorderableBlocks.indexOf(
    "ready.value = 1;",
    statisticsPresentationRebaseIndex,
  );
assert.ok(
  statisticsPresentationStableIndex >= 0 &&
    statisticsPresentationRebaseIndex > statisticsPresentationStableIndex &&
    statisticsPresentationGeometryReadyIndex >
      statisticsPresentationRebaseIndex,
  "revision-tagged layout proof must atomically rebase the stable UI-thread geometry before drag returns",
);
assert.match(
  statisticsReorderableBlocks.slice(
    statisticsPresentationRebaseIndex,
    statisticsPresentationGeometryReadyIndex + 32,
  ),
  /nextCommittedOrder\.value = targetOrder;[\s\S]*nextHeightsOwner\.value = targetHeights;[\s\S]*readyRevision\.value = targetRevision;[\s\S]*ready\.value = 1;/,
);
assert.doesNotMatch(
  statisticsReorderableBlocks,
  /const presentationFrame = useFrameCallback|measure\((?:summary|heatmap|bar|habit)(?:Row|Fallback)Ref\)/,
  "period handoff must never poll native refs that can detach during membership changes",
);
assert.equal(
  (statisticsReorderableBlocks.match(/useFrameCallback\(/g) ?? []).length,
  1,
  "the only frame callback belongs to active drag autoscroll",
);
assert.doesNotMatch(
  statisticsReorderableBlocks,
  /\b(?:setNativeProps|runOnUISync|callMicrotasks)\b/,
  "a React period transition must not race native paint through Reanimated escape hatches",
);
assert.match(
  statisticsReorderableBlocks,
  /\{props\.presentationHeader\}[\s\S]{0,240}<ReorderableStatisticsScene[\s\S]{0,160}visibleOrder=\{props\.visibleOrder\}[\s\S]{0,160}geometryRevision=\{presentationKey\}/,
  "the selector and the immediately visible body must always describe the same requested period",
);
assert.doesNotMatch(
  statisticsReorderableBlocks,
  /<ReorderableStatisticsScene[\s\S]{0,160}key=\{presentationKey\}/,
  "period changes must not remount the ScrollView and complete native block tree",
);
assert.match(
  statisticsReorderableBlocks,
  /key=\{`layout-proof:\$\{layoutRevision\}`\}[\s\S]{0,240}collapsable=\{false\}[\s\S]{0,240}onLayout=/,
  "a lightweight revision-keyed proof must report current row geometry without remounting heavy content",
);
assert.doesNotMatch(
  statisticsReorderableBlocks,
  /snapshotsRef|layersRef|requestStatisticsPresentation|promoteStatisticsPresentation|getVisibleStatisticsPresentationKey|StaticStatisticsScene|PreparedStatisticsPresentation/,
  "obsolete period snapshots must not delay the currently requested visible content",
);
assert.match(
  statisticsReorderableBlocks,
  /effectiveNativeOrder\.map\(\(id\) => \([\s\S]*?<ReorderableStatisticsRow[\s\S]*?key=\{id\}/,
  "one stable keyed native row tree must own normal flow, presentation rebase and reorder transforms",
);
assert.match(
  statisticsReorderableBlocks,
  /const fallbackVisible =[\s\S]{0,220}preparing-hidden[\s\S]{0,220}overlap[\s\S]*?<StatisticsPresentationFallback/,
  "a transformed scene must be covered by the exact target flow during rebase",
);
const statisticsLatestPresentationOwnerIndex =
  statisticsReorderableBlocks.indexOf(
    "latestPresentationRevisionRef.current = effectivePresentationRevision",
  );
const statisticsStalePresentationGuardIndex =
  statisticsReorderableBlocks.indexOf(
    "!isStatisticsSceneRevisionCurrent(",
    statisticsLatestPresentationOwnerIndex,
  );
assert.ok(
  statisticsLatestPresentationOwnerIndex >= 0 &&
    statisticsStalePresentationGuardIndex >
      statisticsLatestPresentationOwnerIndex,
  "rapid A → B → C may never let an obsolete native-geometry proof publish",
);
assert.match(
  statisticsReorderableBlocks,
  /geometryReady\.value !== 1 \|\|[\s\S]{0,120}geometryReadyRevision\.value !== expectedGeometryRevision/,
  "even an already-running stale worklet must be unable to apply obsolete transforms to current rows",
);
assert.match(
  statisticsReorderableBlocks,
  /\.onStart\(\(\) => \{[\s\S]{0,220}geometryReadyRevision\.value !== expectedGeometryRevision[\s\S]{0,120}return;/,
  "drag start must reject geometry from a previous Statistics presentation",
);
const statisticsFallbackOverlapIndex = statisticsReorderableBlocks.indexOf(
  'phase: usedFallback ? "overlap" : "ready"',
);
const statisticsFallbackRetireIndex = statisticsReorderableBlocks.indexOf(
  'scenePresentation.phase !== "overlap"',
  statisticsFallbackOverlapIndex,
);
const statisticsFallbackRetireFrameIndex = statisticsReorderableBlocks.indexOf(
  "requestAnimationFrame",
  statisticsFallbackRetireIndex,
);
assert.ok(
  statisticsFallbackOverlapIndex >= 0 &&
    statisticsFallbackRetireIndex > statisticsFallbackOverlapIndex &&
    statisticsFallbackRetireFrameIndex > statisticsFallbackRetireIndex,
  "the target fallback must overlap the proven drag scene for a physical frame before retirement",
);
assert.ok(
  (
    statisticsReorderableBlocks
      .slice(statisticsFallbackRetireIndex)
      .match(/requestAnimationFrame/g) ?? []
  ).length >= 2,
  "fallback retirement needs a double-frame barrier so at least one overlap frame can paint",
);
assert.doesNotMatch(
  statisticsReorderableBlocks,
  /console\.(?:info|warn)|PanResponder|animated: true/,
);
assert.match(screenWrapper, /onScroll=\{onScroll\}/);
assert.match(screenWrapper, /onContentSizeChange=\{onContentSizeChange\}/);
assert.match(statisticsDomain, /isToday: dateStr === source\.todayStr/);
assert.match(
  statisticsDomain,
  /\.filter\(\(evaluation\) => evaluation\.occurrenceCount > 0\)/,
);
assert.match(statisticsDomain, /isEmpty: scheduledStatuses\.length === 0/);
assert.match(statisticsScreen, /<BarChart[\s\S]{0,160}period=\{period\}/);
assert.match(
  statisticsBarChart,
  /const isCurrentDay = period === "week" && point\.isToday/,
);
assert.match(statisticsBarChart, /currentDayBorderColor = cardBorderColor/);
assert.match(
  statisticsBarChart,
  /borderWidth: isCurrentDay\s*\? 0\.5\s*: point\.isFuture\s*\? 0\.5\s*: 0/,
);
assert.match(
  statisticsBarChart,
  /borderColor: isCurrentDay[\s\S]{0,80}\? currentDayBorderColor/,
);
assert.match(
  statisticsBarChart,
  /labels\.map\(\(label, i\) => \{[\s\S]{0,160}period === "week" && chartData\[i\]\?\.isToday[\s\S]{0,240}isCurrentDay \? \{ color: accent \} : null/,
);
assert.match(statisticsPeriodSelector, /mx-\[14px\] mt-\[6px\]/);
assert.doesNotMatch(statisticsPeriodSelector, /mt-\[10px\]/);

console.log("UX safety audit passed.");
