import type { SupportedLanguage } from "@/domain/settings/supported-language";

export {
  isSupportedLanguage,
  normalizeLanguageCode,
  type SupportedLanguage,
} from "@/domain/settings/supported-language";

export const LANGUAGE_OPTIONS = [
  { code: "de", nativeLabel: "Deutsch" },
  { code: "en", nativeLabel: "English" },
  { code: "es", nativeLabel: "Español" },
  { code: "fr", nativeLabel: "Français" },
  { code: "it", nativeLabel: "Italiano" },
  { code: "nl", nativeLabel: "Nederlands" },
  { code: "pl", nativeLabel: "Polski" },
  { code: "ru", nativeLabel: "Русский" },
  { code: "uk", nativeLabel: "Українська" },
] as const satisfies readonly {
  code: SupportedLanguage;
  nativeLabel: string;
}[];

export function getLanguageNativeLabel(code: string): string {
  return (
    LANGUAGE_OPTIONS.find((item) => item.code === code)?.nativeLabel ?? "English"
  );
}
