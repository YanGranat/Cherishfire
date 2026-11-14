import { addMonths } from "date-fns/addMonths";
import { eachDayOfInterval } from "date-fns/eachDayOfInterval";
import { endOfMonth } from "date-fns/endOfMonth";
import { format } from "date-fns/format";
import { getDay } from "date-fns/getDay";
import { startOfMonth } from "date-fns/startOfMonth";
import { subMonths } from "date-fns/subMonths";
import { normalizeLanguageCode } from "@/i18n/languages";
import {
  formatLocalizedDate,
  getDateFnsLocale,
  toCivilDate,
} from "@/utils/date";
export const DATE_PICKER_MONTH_CACHE_LIMIT = 18;
export interface DatePickerDayModel {
  readonly accessibilityLabel: string;
  readonly dateString: string;
  readonly dayNumber: number;
  readonly dayLabel: string;
}
export interface DatePickerMonthModel {
  readonly days: readonly DatePickerDayModel[];
  readonly gridSlots: readonly DatePickerGridSlotModel[];
  readonly label: string;
  readonly offset: number;
}
export interface DatePickerGridSlotModel {
  readonly day: DatePickerDayModel | null;
  readonly key: string;
}
export interface DatePickerMonthModelLookup {
  readonly cacheHit: boolean;
  readonly model: DatePickerMonthModel;
}
interface MonthDescriptor {
  end: Date;
  key: string;
  language: ReturnType<typeof normalizeLanguageCode>;
  start: Date;
}
function describeMonth(
  currentMonth: Date | string,
  language: string,
): MonthDescriptor {
  const civilDate = toCivilDate(
    typeof currentMonth === "string"
      ? currentMonth
      : format(currentMonth, "uuuu-MM-01"),
  );
  const start = startOfMonth(civilDate);
  const end = endOfMonth(civilDate);
  const normalizedLanguage = normalizeLanguageCode(language);
  const year = String(start.getFullYear()).padStart(4, "0");
  const month = String(start.getMonth() + 1).padStart(2, "0");
  return {
    end,
    key: `${normalizedLanguage}:${year}-${month}`,
    language: normalizedLanguage,
    start,
  };
}
function createMonthModel({
  end,
  language,
  start,
}: MonthDescriptor): DatePickerMonthModel {
  const firstDayOfWeek = getDay(start);
  const days = eachDayOfInterval({ start, end }).map((day) =>
    Object.freeze({
      accessibilityLabel: formatLocalizedDate(day, language),
      dateString: format(day, "yyyy-MM-dd"),
      dayNumber: day.getDate(),
      dayLabel: format(day, "d"),
    }),
  );
  // Monday = 0.
  const offset = firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1;
  // Slot keys describe the visual position, not the date. Switching a month
  // can therefore reuse the existing native cells instead of remounting the
  // whole grid. The length remains exactly offset + number of days, so the
  // number of rows and modal height follow the month's actual day count.
  const gridSlots = Array.from(
    { length: offset + days.length },
    (_, index): DatePickerGridSlotModel =>
      Object.freeze({
        day: index < offset ? null : days[index - offset],
        key: `slot-${index}`,
      }),
  );
  return Object.freeze({
    days: Object.freeze(days),
    gridSlots: Object.freeze(gridSlots),
    label: format(start, "LLLL yyyy", {
      locale: getDateFnsLocale(language),
    }),
    offset,
  });
}
/** Small true-LRU cache for immutable, locale-specific calendar month data. */
export class DatePickerMonthModelCache {
  private readonly entries = new Map<string, DatePickerMonthModel>();
  constructor(private readonly maxEntries = DATE_PICKER_MONTH_CACHE_LIMIT) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(
        "DatePicker month cache size must be a positive integer",
      );
    }
  }
  getWithStatus(
    currentMonth: Date | string,
    language: string,
  ): DatePickerMonthModelLookup {
    const descriptor = describeMonth(currentMonth, language);
    const cached = this.entries.get(descriptor.key);
    if (cached) {
      // Map preserves insertion order. Reinsertion makes a hit most-recently
      // used, so navigation around a familiar month does not evict it.
      this.entries.delete(descriptor.key);
      this.entries.set(descriptor.key, cached);
      return { cacheHit: true, model: cached };
    }
    const model = createMonthModel(descriptor);
    if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey != null) this.entries.delete(oldestKey);
    }
    this.entries.set(descriptor.key, model);
    return { cacheHit: false, model };
  }
  get(currentMonth: Date | string, language: string): DatePickerMonthModel {
    return this.getWithStatus(currentMonth, language).model;
  }
  get size(): number {
    return this.entries.size;
  }
}
const datePickerMonthModelCache = new DatePickerMonthModelCache();
export function getDatePickerMonthModel(
  currentMonth: Date | string,
  language: string,
): DatePickerMonthModelLookup {
  return datePickerMonthModelCache.getWithStatus(currentMonth, language);
}
export function prewarmAdjacentDatePickerMonthModels(
  currentMonth: Date | string,
  language: string,
  cache: DatePickerMonthModelCache = datePickerMonthModelCache,
): void {
  const civilMonth = describeMonth(currentMonth, language).start;
  // Keep two months in both directions ready. A user can tap the month arrow
  // faster than an idle callback runs; this bounded window prevents that
  // second tap from building a localized 28–31 day model in the response
  // frame while remaining well below the global LRU limit.
  for (let distance = 1; distance <= 2; distance += 1) {
    const previousMonth = subMonths(civilMonth, distance);
    const nextMonth = addMonths(civilMonth, distance);
    if (previousMonth.getUTCFullYear() >= 1) cache.get(previousMonth, language);
    if (nextMonth.getUTCFullYear() <= 9999) cache.get(nextMonth, language);
  }
}
export function prewarmDatePickerMonthModels(
  currentMonth: Date | string,
  language: string,
  cache: DatePickerMonthModelCache = datePickerMonthModelCache,
): void {
  cache.get(currentMonth, language);
  prewarmAdjacentDatePickerMonthModels(currentMonth, language, cache);
}
