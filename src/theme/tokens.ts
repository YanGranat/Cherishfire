// Shared interface design tokens.

// Spacing scale (4dp base)
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 20,
  xl: 24,
  "2xl": 32,
  "3xl": 48,
} as const;

// Border radii
export const radii = {
  button: 8,
  sectionCard: 14,
  listCard: 10,
  dialog: 16,
  sheet: 16,
  menu: 12,
  input: 8,
  pill: 20,
  segment: 8,
  segmentInner: 6,
  heatmapYear: 2,
  full: 9999,
} as const;

// Component sizes
export const sizes = {
  headerHeight: 56,
  rowHeight: 68,
  checkboxOuter: 28,
  checkboxIcon: 18,
  fab: 56,
  headerIcon: 24,
  headerIconTouch: 44,
  menuItemIcon: 24,
  menuItemHeight: 48,
  menuWidthDropdown: 200,
  menuWidthContext: 220,
  menuWidthCalendarDay: 180,
  dialogWidth: 304,
  dialogPadding: 24,
  calendarDayCell: 32,
  calendarStripDayWidth: 40,
  calendarStripDayHeight: 56,
  heatmapCellYear: 10,
  heatmapCellMonth: 32,
  tabPillHeight: 32,
  tabPillPaddingH: 12,
  sheetDragHandleWidth: 32,
  sheetDragHandleHeight: 4,
  sendButton: 36,
  stepperButton: 40,
  intervalNumberHeight: 48,
  progressBarHeight: 4,
  toggleWidth: 48,
  toggleHeight: 28,
  colorPreviewCircle: 24,
  emptyStateIcon: 64,
  touchTargetMin: 44,
} as const;

// Line thicknesses
export const borders = {
  hairline: 0.5, // StyleSheet.hairlineWidth equivalent
  thin: 1,
  inputFocus: 2,
  checkboxBorder: 2,
  todayIndicator: 1.5,
  progressBar: 4,
  failureNoteBorder: 3,
} as const;

// Typography scale (system font)
export const typography = {
  title: { size: 20, weight: "600" as const, lineHeight: 1.2 },
  sectionTitle: { size: 14, weight: "600" as const, lineHeight: 1.3 },
  body: { size: 16, weight: "400" as const, lineHeight: 1.5 },
  bodySmall: { size: 14, weight: "400" as const, lineHeight: 1.5 },
  caption: { size: 12, weight: "400" as const, lineHeight: 1.3 },
  button: { size: 14, weight: "600" as const, lineHeight: 1.0 },
  buttonSmall: { size: 12, weight: "600" as const, lineHeight: 1.0 },
  stat: { size: 28, weight: "700" as const, lineHeight: 1.1 },
  statLabel: { size: 12, weight: "400" as const, lineHeight: 1.3 },
  streak: { size: 13, weight: "400" as const, lineHeight: 1.3 },
  input: { size: 16, weight: "400" as const, lineHeight: 1.5 },
  inputLabel: { size: 14, weight: "500" as const, lineHeight: 1.3 },
  intervalNumber: { size: 28, weight: "700" as const, lineHeight: 1.1 },
  calendarDay: { size: 14, weight: "500" as const, lineHeight: 1.0 },
  calendarWeekday: { size: 12, weight: "400" as const, lineHeight: 1.0 },
  monthLabel: { size: 16, weight: "600" as const, lineHeight: 1.2 },
  barLabel: { size: 11, weight: "400" as const, lineHeight: 1.0 },
} as const;

// Shadow definitions
export const shadows = {
  menu: {
    light: { offset: { width: 0, height: 4 }, radius: 12, opacity: 0.15 },
    dark: { offset: { width: 0, height: 4 }, radius: 12, opacity: 0.4 },
  },
  dialog: {
    light: { offset: { width: 0, height: 8 }, radius: 24, opacity: 0.2 },
    dark: { offset: { width: 0, height: 8 }, radius: 24, opacity: 0.5 },
  },
  fab: {
    light: { offset: { width: 0, height: 4 }, radius: 8, opacity: 0.2 },
    dark: { offset: { width: 0, height: 4 }, radius: 8, opacity: 0.4 },
  },
  card: {
    light: { offset: { width: 0, height: 1 }, radius: 3, opacity: 0.08 },
    dark: null, // use surfaceElevated bg instead
  },
  dragActive: {
    light: { offset: { width: 0, height: 8 }, radius: 16, opacity: 0.15 },
    dark: { offset: { width: 0, height: 8 }, radius: 16, opacity: 0.4 },
  },
} as const;

// Animation durations (ms)
export const durations = {
  checkboxChange: 200,
  sectionExpand: 250,
  sectionCollapse: 200,
  toggleSwitch: 200,
  buttonPress: 100,
  buttonRelease: 150,
  tabSwitch: 200,
  toastAppear: 200,
  toastDismiss: 150,
  toastVisibleDuration: 2000,
  menuAppear: 30,
  menuDismiss: 100,
  sheetAppear: 300,
  sheetDismiss: 250,
  dialogAppear: 200,
  dialogDismiss: 150,
  scrimFadeIn: 200,
  scrimFadeOut: 150,
  screenPush: 300,
  screenPop: 300,
  dragLift: 200,
  dragDrop: 200,
  calendarSelect: 150,
  calendarDeselect: 100,
  pressIn: 100,
  pressOut: 150,
} as const;

// Z-index scale
export const zIndex = {
  base: 0,
  fab: 10,
  stickyHeader: 20,
  sheet: 30,
  scrim: 40,
  menu: 50,
  dialog: 50,
  toast: 60,
} as const;
