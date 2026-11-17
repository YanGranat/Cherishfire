import { UTCDateMini } from "@date-fns/utc";
import { format } from "date-fns/format";
import { parseISO } from "date-fns/parseISO";
import type { Locale } from "date-fns";
import { de } from "date-fns/locale/de";
import { enUS } from "date-fns/locale/en-US";
import { es } from "date-fns/locale/es";
import { fr } from "date-fns/locale/fr";
import { it } from "date-fns/locale/it";
import { nl } from "date-fns/locale/nl";
import { pl } from "date-fns/locale/pl";
import { ru } from "date-fns/locale/ru";
import { uk } from "date-fns/locale/uk";
import {
  normalizeLanguageCode,
  type SupportedLanguage,
} from "@/i18n/languages";
import { isCivilDateKey } from "@/domain/dates/civil-date";
import type { StatisticsPeriodRange } from "@/domain/statistics/statistics-period";
type Period = "week" | "month" | "year";
const DATE_FNS_LOCALE_MAP: Record<SupportedLanguage, Locale> = {
  ru,
  en: enUS,
  uk,
  es,
  de,
  fr,
  it,
  nl,
  pl,
};
const WEEKDAY_LABELS: Record<SupportedLanguage, string[]> = {
  ru: ["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"],
  en: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"],
  uk: ["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "НД"],
  es: ["LU", "MA", "MI", "JU", "VI", "SÁ", "DO"],
  de: ["MO", "DI", "MI", "DO", "FR", "SA", "SO"],
  fr: ["LU", "MA", "ME", "JE", "VE", "SA", "DI"],
  it: ["LU", "MA", "ME", "GI", "VE", "SA", "DO"],
  nl: ["MA", "DI", "WO", "DO", "VR", "ZA", "ZO"],
  pl: ["PN", "WT", "ŚR", "CZ", "PT", "SO", "ND"],
};
const MONTH_LABELS: Record<SupportedLanguage, string[]> = {
  ru: ["Я", "Ф", "М", "А", "М", "И", "И", "А", "С", "О", "Н", "Д"],
  en: ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"],
  uk: ["С", "Л", "Б", "К", "Т", "Ч", "Л", "С", "В", "Ж", "Л", "Г"],
  es: ["E", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"],
  de: ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"],
  fr: ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"],
  it: ["G", "F", "M", "A", "M", "G", "L", "A", "S", "O", "N", "D"],
  nl: ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"],
  pl: ["S", "L", "M", "K", "M", "C", "L", "S", "W", "P", "L", "G"],
};
const WEEK_PREFIX: Record<SupportedLanguage, string> = {
  ru: "Н",
  en: "W",
  uk: "Т",
  es: "S",
  de: "W",
  fr: "S",
  it: "S",
  nl: "W",
  pl: "T",
};
export function getDateFnsLocale(language: string): Locale {
  return DATE_FNS_LOCALE_MAP[normalizeLanguageCode(language)];
}
export function getWeekdayLabels(language: string): string[] {
  return WEEKDAY_LABELS[normalizeLanguageCode(language)];
}
export function getMonthLabels(language: string): string[] {
  return MONTH_LABELS[normalizeLanguageCode(language)];
}
/** Parse a canonical civil date without applying the device time zone. */
export function toCivilDate(
  dateString: string,
): InstanceType<typeof UTCDateMini> {
  if (!isCivilDateKey(dateString)) return new UTCDateMini(NaN);
  return parseISO(dateString, { in: (value) => new UTCDateMini(value) });
}
export function formatCivilDate(
  dateString: string,
  pattern: string,
  language: string,
): string {
  const parsed = toCivilDate(dateString);
  if (Number.isNaN(parsed.getTime())) return dateString;
  return format(parsed, pattern, { locale: getDateFnsLocale(language) });
}
export function formatLocalizedDate(
  date: Date | string,
  language: string,
): string {
  const parsed =
    typeof date === "string"
      ? /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? toCivilDate(date)
        : parseISO(date)
      : date;
  if (Number.isNaN(parsed.getTime()))
    return typeof date === "string" ? date : "";
  return format(parsed, "P", { locale: getDateFnsLocale(language) });
}
export function formatLocalizedDateTime(date: Date, language: string): string {
  if (Number.isNaN(date.getTime())) return "";
  return format(date, "Pp", { locale: getDateFnsLocale(language) });
}
// Week labels for bar chart month view: W1, W2 ... or locale-specific prefix.
export function getWeekLabels(language: string): string[] {
  const prefix = WEEK_PREFIX[normalizeLanguageCode(language)];
  return [1, 2, 3, 4, 5].map((n) => `${prefix}${n}`);
}
// Period label:
// Week: "3 Feb – 9 Feb"
// Month: "January 2026"
// Year: "2026"
export function getPeriodLabel(
  period: Period,
  language: string,
  range: StatisticsPeriodRange,
): string {
  const start = toCivilDate(range.startDate);
  const end = toCivilDate(range.endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new RangeError(
      "Statistics label range is outside the supported range",
    );
  }
  const locale = getDateFnsLocale(language);
  switch (period) {
    case "week":
      return `${format(start, "d MMM", { locale })} – ${format(end, "d MMM", {
        locale,
      })}`;
    case "month":
      return format(start, "LLLL yyyy", { locale });
    case "year":
      return format(start, "yyyy");
  }
}
