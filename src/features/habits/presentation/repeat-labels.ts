import type { TFunction } from "i18next";
import type { RepeatSchedule } from "@/types/habit";

type TranslationFunction =
  | TFunction
  | ((key: string, options?: Record<string, unknown>) => string);

function translate(
  t: TranslationFunction,
  key: string,
  options?: Record<string, unknown>
): string {
  return (t as (key: string, options?: Record<string, unknown>) => string)(
    key,
    options
  );
}

export function getRepeatLabel(
  schedule: RepeatSchedule,
  t: TranslationFunction,
  weekdayShortKeys: string[],
  language: string
): string {
  switch (schedule.type) {
    case "daily":
      return translate(t, "repeat.daily");

    case "weekdays": {
      if (schedule.days.length === 7) return translate(t, "repeat.daily");
      const labels = [...schedule.days]
        .sort((a, b) => a - b)
        .map((day) =>
          translate(t, `weekdaysShort.${weekdayShortKeys[day - 1]}`)
        );
      return labels.join(", ");
    }

    case "monthly": {
      if (schedule.dates.length === 1) {
        const count = schedule.dates[0];
        if (language.toLowerCase().split(/[-_]/, 1)[0] === "en") {
          const lastTwoDigits = count % 100;
          const lastDigit = count % 10;
          const category =
            lastTwoDigits >= 11 && lastTwoDigits <= 13
              ? "other"
              : lastDigit === 1
                ? "one"
                : lastDigit === 2
                  ? "two"
                  : lastDigit === 3
                    ? "few"
                    : "other";
          return translate(t, `repeat.dayOfMonth_ordinal_${category}`, { count });
        }
        return translate(t, "repeat.dayOfMonth_one", {
          count,
        });
      }
      const dates = [...schedule.dates].sort((a, b) => a - b);
      const labels: string[] = [];
      for (let start = 0; start < dates.length; ) {
        let end = start;
        while (end + 1 < dates.length && dates[end + 1] === dates[end] + 1) {
          end += 1;
        }
        if (end - start >= 2) {
          labels.push(`${dates[start]}–${dates[end]}`);
        } else {
          for (let index = start; index <= end; index += 1) {
            labels.push(String(dates[index]));
          }
        }
        start = end + 1;
      }
      return labels.join(", ");
    }

    case "interval":
      return getEveryNDaysLabel(schedule.every, t, language);

    default:
      return "";
  }
}

export function getEveryNDaysLabel(
  count: number,
  t: TranslationFunction,
  language: string
): string {
  const numericCount = Number(count);
  const integerCount = Math.abs(Math.trunc(numericCount));
  const baseLanguage = language.toLowerCase().split(/[-_]/, 1)[0];
  let category: "one" | "few" | "many" | "other";

  if (baseLanguage === "ru" || baseLanguage === "uk") {
    const mod10 = integerCount % 10;
    const mod100 = integerCount % 100;
    category =
      mod10 === 1 && mod100 !== 11
        ? "one"
        : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
          ? "few"
          : "many";
  } else if (baseLanguage === "pl") {
    const mod10 = integerCount % 10;
    const mod100 = integerCount % 100;
    category =
      integerCount === 1
        ? "one"
        : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
          ? "few"
          : "many";
  } else if (baseLanguage === "fr") {
    category = integerCount === 0 || integerCount === 1 ? "one" : "other";
  } else {
    category = integerCount === 1 ? "one" : "other";
  }

  // Keep plural selection deterministic when Intl.PluralRules is unavailable.
  return translate(t, `repeat.everyNDays_${category}`, {
    count: numericCount,
  });
}

export const WEEKDAY_SHORT_KEYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;
