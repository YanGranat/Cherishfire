import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInstance } from "i18next";
import { LANGUAGE_OPTIONS, normalizeLanguageCode } from "../src/i18n/languages";
import { getRepeatLabel } from "../src/features/habits/presentation/repeat-labels";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenKeys(input: JsonRecord, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (isRecord(value)) {
      keys.push(...flattenKeys(value, nextKey));
    } else {
      keys.push(nextKey);
    }
  }
  return keys;
}

function flattenValues(
  input: JsonRecord,
  prefix = "",
  output = new Map<string, unknown>()
): Map<string, unknown> {
  for (const [key, value] of Object.entries(input)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (isRecord(value)) {
      flattenValues(value, nextKey, output);
    } else {
      output.set(nextKey, value);
    }
  }
  return output;
}

function placeholderSignature(value: unknown): string {
  if (typeof value !== "string") return "";
  return [...value.matchAll(/{{\s*([^}]+?)\s*}}/g)]
    .map((match) => match[1])
    .sort()
    .join("|");
}

function readJsonFile(path: string): JsonRecord {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Invalid JSON object in ${path}`);
  }
  return parsed;
}

function difference(a: Set<string>, b: Set<string>): string[] {
  const diff: string[] = [];
  for (const key of a) {
    if (!b.has(key)) diff.push(key);
  }
  return diff.sort();
}

function run(): void {
  const localesDir = join(process.cwd(), "src", "i18n", "locales");
  const files = readdirSync(localesDir).filter((file) => file.endsWith(".json"));

  if (!files.includes("en.json")) {
    throw new Error("Base locale src/i18n/locales/en.json not found");
  }

  const baseLocale = readJsonFile(join(localesDir, "en.json"));
  const baseKeys = new Set(flattenKeys(baseLocale));
  const baseValues = flattenValues(baseLocale);
  const monthlyKeyPrefix = "repeat.dayOfMonth_";
  const ordinalDays = [
    "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th",
    "11th", "12th", "13th", "14th", "15th", "16th", "17th", "18th", "19th", "20th",
    "21st", "22nd", "23rd", "24th", "25th", "26th", "27th", "28th", "29th", "30th", "31st",
  ];
  const neutralStatisticsEmptyTitles: Readonly<Record<string, string>> = {
    de: "Keine Daten",
    en: "No data",
    es: "Sin datos",
    fr: "Aucune donnée",
    it: "Nessun dato",
    nl: "Geen gegevens",
    pl: "Brak danych",
    ru: "Нет данных",
    uk: "Немає даних",
  };

  assert.equal(normalizeLanguageCode("ru-RU"), "ru");
  assert.equal(normalizeLanguageCode("en-US"), "en");
  assert.equal(normalizeLanguageCode(123), "en");
  assert.equal(normalizeLanguageCode({ language: "ru" }), "en");
  assert.equal(normalizeLanguageCode("ja-JP"), "en");
  assert.equal(normalizeLanguageCode(null), "en");
  assert.deepEqual(LANGUAGE_OPTIONS.map((option) => option.code),
    ["de", "en", "es", "fr", "it", "nl", "pl", "ru", "uk"],
    "the language list follows native names without a pinned language");
  assert.equal(
    baseKeys.has("notes.deleteMessage"),
    false,
    "the note delete dialog must not retain a redundant explanatory message"
  );

  const i18nConfig = readFileSync(
    join(process.cwd(), "src", "i18n", "config.ts"),
    "utf8"
  );
  const settingsTypes = readFileSync(
    join(process.cwd(), "src", "types", "settings.ts"),
    "utf8"
  );
  assert.match(i18nConfig, /getLocales\(\)\[0\]\?\.languageCode \?\? "en"/);
  assert.match(
    i18nConfig,
    /initAsync: false/,
    "bundled locale resources must be available in the initial render turn",
  );
  assert.match(
    i18nConfig,
    /showSupportNotice:\s*false/,
    "release startup must not emit i18next's optional promotional console notice",
  );
  assert.match(i18nConfig, /fallbackLng: "en"/);
  assert.match(settingsTypes, /language: "en"/);

  let hasMismatch = false;

  for (const file of files) {
    const currentLocale = readJsonFile(join(localesDir, file));
    const currentValues = flattenValues(currentLocale);
    const localeCode = file.replace(/\.json$/, "");
    const dateKeys = [...currentValues.keys()].filter((key) => key.startsWith(monthlyKeyPrefix)).sort();
    assert.deepEqual(dateKeys, (localeCode === "en"
      ? ["ordinal_one", "ordinal_two", "ordinal_few", "ordinal_other"]
      : ["one", "other"]).map((suffix) => monthlyKeyPrefix + suffix).sort(),
    `${file} must provide its exact monthly-date translation family`);
    for (const key of dateKeys) assert.equal(placeholderSignature(currentValues.get(key)), "count");
    const originalPluralRules = Intl.PluralRules;
    for (const rulesAvailable of [true, false]) {
      if (!rulesAvailable) Reflect.set(Intl, "PluralRules", undefined);
      try {
        const instance = createInstance();
        instance.init({
          initAsync: false,
          showSupportNotice: false,
          lng: localeCode,
          fallbackLng: false,
          resources: { [localeCode]: { translation: currentLocale } },
        });
        for (let day = 1; day <= 31; day += 1) {
          const expected = localeCode === "en" ? ordinalDays[day - 1]
            : String(currentValues.get(monthlyKeyPrefix + "one")).replace("{{count}}", String(day));
          assert.equal(getRepeatLabel({ type: "monthly", dates: [day] }, instance.getFixedT(localeCode), [], localeCode), expected,
            `${file} must render a correct monthly date without depending on Intl.PluralRules`);
        }
        for (const [dates, expected] of [
          [Array.from({ length: 31 }, (_, index) => index + 1), "1–31"],
          [[4, 5, 6, 12, 22, 23, 24, 25], "4–6, 12, 22–25"],
          [[5, 6, 18], "5, 6, 18"],
          [[4, 8, 12, 18], "4, 8, 12, 18"],
          [[30, 29, 28, 13, 8, 7], "7, 8, 13, 28–30"],
        ] as const) {
          const draft = [...dates];
          assert.equal(
            getRepeatLabel({ type: "monthly", dates: draft }, instance.getFixedT(localeCode), [], localeCode),
            expected,
            `${file} must compact date runs without hiding gaps or pairs`,
          );
          assert.deepEqual(draft, dates, "formatting must not mutate the selected dates");
        }
      } finally {
        Reflect.set(Intl, "PluralRules", originalPluralRules);
      }
    }
    assert.equal(
      currentValues.get("statistics.emptyTitle"),
      neutralStatisticsEmptyTitles[localeCode],
      `${file} must use a neutral no-data title for past periods`
    );
    if (file === "en.json") continue;
    const currentKeys = new Set(flattenKeys(currentLocale).filter((key) => !key.startsWith(monthlyKeyPrefix)));
    const comparableBaseKeys = new Set([...baseKeys].filter((key) => !key.startsWith(monthlyKeyPrefix)));

    const missing = difference(comparableBaseKeys, currentKeys);
    const extra = difference(currentKeys, comparableBaseKeys);
    const placeholderMismatches = [...comparableBaseKeys].filter(
      (key) =>
        currentValues.has(key) &&
        placeholderSignature(baseValues.get(key)) !==
          placeholderSignature(currentValues.get(key))
    );

    if (
      missing.length === 0 &&
      extra.length === 0 &&
      placeholderMismatches.length === 0
    ) {
      continue;
    }

    hasMismatch = true;
    console.error(`Locale mismatch in ${file}`);
    if (missing.length > 0) {
      console.error(`  Missing (${missing.length}): ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      console.error(`  Extra (${extra.length}): ${extra.join(", ")}`);
    }
    if (placeholderMismatches.length > 0) {
      console.error(
        `  Placeholder mismatch (${placeholderMismatches.length}): ${placeholderMismatches.join(", ")}`
      );
    }
  }

  if (hasMismatch) {
    process.exitCode = 1;
    return;
  }

  console.log("i18n locale audit passed");
}

run();
