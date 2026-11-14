export const SUPPORTED_LANGUAGE_CODES = [
  "ru",
  "en",
  "uk",
  "es",
  "de",
  "fr",
  "it",
  "nl",
  "pl",
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGE_CODES)[number];

const SUPPORTED_LANGUAGE_SET = new Set<string>(SUPPORTED_LANGUAGE_CODES);

export function isSupportedLanguage(
  value: string,
): value is SupportedLanguage {
  return SUPPORTED_LANGUAGE_SET.has(value);
}

export function normalizeLanguageCode(value: unknown): SupportedLanguage {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return "en";

  const primary = raw.split("-")[0];
  if (primary === "ua") return "uk";
  if (isSupportedLanguage(primary)) return primary;

  return "en";
}
