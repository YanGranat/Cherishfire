import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createInstance } from "i18next";
import ts from "typescript";
import {
  LANGUAGE_OPTIONS,
  normalizeLanguageCode,
  type SupportedLanguage,
} from "../src/i18n/languages";
import { getRepeatLabel } from "../src/features/habits/presentation/repeat-labels";
import { getWeekdayLabels } from "../src/utils/date";
import { auditLocalizedFeedback } from "./fixtures/audit-localized-feedback";

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

const INTERVAL_SAMPLE_COUNTS = [
  1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111, 112, 114, 121, 122, 365,
] as const;
const PLURAL_INTERVAL_COUNTS = [
  2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111, 112, 114, 121, 122, 365,
] as const;
const SLAVIC_ONE_INTERVAL_COUNTS = [1, 21, 101, 121] as const;
const SLAVIC_FEW_INTERVAL_COUNTS = [2, 4, 22, 122] as const;
const SLAVIC_MANY_INTERVAL_COUNTS = [5, 11, 12, 14, 25, 111, 112, 114, 365] as const;
interface IntervalExpectation {
  counts: readonly number[];
  phrase: string;
}
const INTERVAL_EXPECTATIONS: Readonly<
  Record<SupportedLanguage, readonly IntervalExpectation[]>
> = {
  de: [
    { counts: [1], phrase: "Jeden Tag" },
    { counts: PLURAL_INTERVAL_COUNTS, phrase: "Alle {{count}} Tage" },
  ],
  en: [
    { counts: [1], phrase: "Every {{count}} day" },
    { counts: PLURAL_INTERVAL_COUNTS, phrase: "Every {{count}} days" },
  ],
  es: [
    { counts: [1], phrase: "Cada {{count}} día" },
    { counts: PLURAL_INTERVAL_COUNTS, phrase: "Cada {{count}} días" },
  ],
  fr: [
    { counts: [1], phrase: "Chaque jour" },
    { counts: PLURAL_INTERVAL_COUNTS, phrase: "Tous les {{count}} jours" },
  ],
  it: [
    { counts: [1], phrase: "Ogni {{count}} giorno" },
    { counts: PLURAL_INTERVAL_COUNTS, phrase: "Ogni {{count}} giorni" },
  ],
  nl: [
    { counts: [1], phrase: "Elke {{count}} dag" },
    { counts: PLURAL_INTERVAL_COUNTS, phrase: "Elke {{count}} dagen" },
  ],
  pl: [
    { counts: [1], phrase: "Co {{count}} dzień" },
    { counts: PLURAL_INTERVAL_COUNTS, phrase: "Co {{count}} dni" },
  ],
  ru: [
    { counts: SLAVIC_ONE_INTERVAL_COUNTS, phrase: "Каждый {{count}} день" },
    { counts: SLAVIC_FEW_INTERVAL_COUNTS, phrase: "Каждые {{count}} дня" },
    { counts: SLAVIC_MANY_INTERVAL_COUNTS, phrase: "Каждые {{count}} дней" },
  ],
  uk: [
    { counts: SLAVIC_ONE_INTERVAL_COUNTS, phrase: "Кожен {{count}} день" },
    { counts: SLAVIC_FEW_INTERVAL_COUNTS, phrase: "Кожні {{count}} дні" },
    { counts: SLAVIC_MANY_INTERVAL_COUNTS, phrase: "Кожні {{count}} днів" },
  ],
};
const IMPORT_PREVIEW_EXPECTATIONS: Readonly<Record<SupportedLanguage, string>> = {
  de: "Gewohnheiten: {{habits}} (davon archiviert: {{archived}}). Markierungen: {{records}}. Notizen: {{notes}}. Die aktuellen Daten werden ersetzt.",
  en: "Habits: {{habits}} (including {{archived}} archived); check-ins: {{records}}; notes: {{notes}}. Current data will be replaced.",
  es: "Total de hábitos: {{habits}} (en el archivo: {{archived}}). Registros: {{records}}. Notas: {{notes}}. Los datos actuales se reemplazarán.",
  fr: "Habitudes : {{habits}} (dont {{archived}} dans l’archive). Entrées de suivi : {{records}}. Notes : {{notes}}. Les données actuelles seront remplacées.",
  it: "Abitudini: {{habits}} (di cui {{archived}} in archivio). Registrazioni: {{records}}. Note: {{notes}}. I dati attuali verranno sostituiti.",
  nl: "Gewoonten: {{habits}} (waarvan gearchiveerd: {{archived}}). Registraties: {{records}}. Notities: {{notes}}. De huidige gegevens worden vervangen.",
  pl: "Nawyki: {{habits}} (w tym zarchiwizowane: {{archived}}). Wpisy: {{records}}. Notatki: {{notes}}. Obecne dane zostaną zastąpione.",
  ru: "В файле: привычек — {{habits}} (в том числе в архиве — {{archived}}), отметок — {{records}}, заметок — {{notes}}. Текущие данные будут заменены.",
  uk: "У файлі: звичок — {{habits}} (з них в архіві — {{archived}}), позначок — {{records}}, нотаток — {{notes}}. Поточні дані буде замінено.",
};
const IMPORT_PREVIEW_COUNTS = [
  { habits: 0, archived: 0, records: 0, notes: 0 },
  { habits: 1, archived: 0, records: 2, notes: 5 },
  { habits: 2, archived: 1, records: 5, notes: 0 },
  { habits: 5, archived: 2, records: 1, notes: 2 },
  { habits: 5, archived: 5, records: 2, notes: 1 },
] as const;
const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

function placeholdersMatch(
  localeCode: SupportedLanguage,
  key: string,
  referenceValue: unknown,
  translatedValue: unknown,
): boolean {
  const reference = placeholderSignature(referenceValue);
  const translated = placeholderSignature(translatedValue);
  if (key === "repeat.everyNDays_one" &&
    (localeCode === "de" || localeCode === "fr")) {
    return reference === "count" && translated === "";
  }
  return reference === translated;
}

function auditStartupLanguage(source: string, localesDir: string): void {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const cases = [
    ...LANGUAGE_OPTIONS.map(({ code }) => ({
      locales: [{ languageCode: code }], expected: code,
    })),
    { locales: [{ languageCode: "ja" }, { languageCode: "fr" }], expected: "en" },
    { locales: [{ languageCode: "de-AT" }], expected: "de" },
    { locales: [{ languageCode: null }], expected: "en" },
    { locales: [], expected: "en" },
  ];
  for (const { locales, expected } of cases) {
    const exports: { default?: ReturnType<typeof createInstance> } = {};
    runInNewContext(compiled, {
      exports,
      require(name: string) {
        if (name === "i18next") return { createInstance };
        if (name === "react-i18next") {
          return { initReactI18next: { type: "3rdParty", init() {} } };
        }
        if (name === "expo-localization") return { getLocales: () => locales };
        if (name === "./languages") return { normalizeLanguageCode };
        const match = /^\.\/locales\/([a-z]{2})\.json$/.exec(name);
        assert.ok(match, `unexpected localization dependency: ${name}`);
        return readJsonFile(join(localesDir, `${match[1]}.json`));
      },
    });
    const instance = exports.default;
    assert.ok(instance?.isInitialized, "bundled translations must initialize synchronously");
    assert.equal(instance.language, expected, "startup must honor the primary device locale or English fallback");
    const expectedLocale = readJsonFile(join(localesDir, `${expected}.json`));
    assert.equal(instance.t("settings.title"), (expectedLocale.settings as JsonRecord).title);
  }
}

async function run(): Promise<void> {
  const localesDir = join(process.cwd(), "src", "i18n", "locales");
  const files = readdirSync(localesDir).filter((file) => file.endsWith(".json"));

  if (!files.includes("en.json")) {
    throw new Error("Base locale src/i18n/locales/en.json not found");
  }
  assert.deepEqual(
    files.slice().sort(),
    LANGUAGE_OPTIONS.map((option) => `${option.code}.json`).sort(),
    "the locale files must match the supported language registry",
  );

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
  auditStartupLanguage(i18nConfig, localesDir);

  let hasMismatch = false;

  for (const file of files) {
    const currentLocale = readJsonFile(join(localesDir, file));
    const currentValues = flattenValues(currentLocale);
    const localeCode = file.replace(/\.json$/, "") as SupportedLanguage;
    for (const [key, value] of currentValues) {
      assert.equal(typeof value, "string", `${file}:${key} must be a string`);
    }
    assert.deepEqual(
      getWeekdayLabels(localeCode),
      WEEKDAY_KEYS.map((key) => currentValues.get(`weekdaysShort.${key}`)),
      `${file} weekday labels must match the date formatting table`,
    );
    if (localeCode === "es") {
      assert.equal(currentValues.get("weekdaysShort.sat"), "SÁ");
    }
    const actionErrorMessage = currentValues.get("import.actionErrorMessage");
    assert.ok(
      typeof actionErrorMessage === "string" && actionErrorMessage.trim().length > 0,
      `${file} must provide an import operation failure message`,
    );
    assert.notEqual(
      actionErrorMessage,
      currentValues.get("import.errorMessage"),
      `${file} must distinguish an import operation failure from an invalid file`,
    );
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
        const intervalCases = INTERVAL_EXPECTATIONS[localeCode].flatMap(
          ({ counts, phrase }) => counts.map((count) => ({
            count,
            expected: phrase.replaceAll("{{count}}", String(count)),
          })),
        );
        assert.deepEqual(
          intervalCases.map(({ count }) => count).sort((a, b) => a - b),
          INTERVAL_SAMPLE_COUNTS,
          `${file} must cover every interval grammar boundary without duplicate cases`,
        );
        for (const { count, expected } of intervalCases) {
          assert.equal(
            getRepeatLabel(
              { type: "interval", every: count, fromCompletion: false },
              instance.getFixedT(localeCode),
              [],
              localeCode,
            ),
            expected,
            `${file} must render the interval ${count} with the correct language form`,
          );
        }
        for (const counts of IMPORT_PREVIEW_COUNTS) {
          const expected = IMPORT_PREVIEW_EXPECTATIONS[localeCode].replace(
            /{{(habits|archived|records|notes)}}/g,
            (_placeholder, key: keyof typeof counts) => String(counts[key]),
          );
          assert.equal(
            instance.t("import.previewMessage", counts),
            expected,
            `${file} import counts must retain their identity and archived subset meaning`,
          );
        }
        assert.equal(instance.t("import.actionErrorMessage"), actionErrorMessage);
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
        !placeholdersMatch(localeCode, key, baseValues.get(key), currentValues.get(key))
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

  await auditLocalizedFeedback();
  console.log("i18n locale audit passed");
}

const auditDeadline = setTimeout(() => {
  console.error("i18n locale audit did not settle within 15 seconds");
  process.exitCode = 1;
}, 15_000);
void run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(auditDeadline));
