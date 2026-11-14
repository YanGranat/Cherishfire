import type en from "./locales/en.json";

// English defines shared translation keys; plural forms vary by locale.
type TranslationSchema = typeof en;

// Augment i18next module for typed useTranslation
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: {
      translation: TranslationSchema;
    };
  }
}
