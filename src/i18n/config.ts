import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import { getLocales } from "expo-localization";
import ru from "./locales/ru.json";
import en from "./locales/en.json";
import uk from "./locales/uk.json";
import es from "./locales/es.json";
import de from "./locales/de.json";
import fr from "./locales/fr.json";
import it from "./locales/it.json";
import nl from "./locales/nl.json";
import pl from "./locales/pl.json";
import { normalizeLanguageCode } from "./languages";

const deviceLocale = getLocales()[0]?.languageCode ?? "en";
const initialLanguage = normalizeLanguageCode(deviceLocale);
const i18n = createInstance();

i18n.use(initReactI18next).init({
  compatibilityJSON: "v4",
  // Keep application output free from i18next's optional
  // promotional console message. Missing-key warnings still use the normal
  // logger when they are relevant.
  showSupportNotice: false,
  // Every translation resource is bundled with the application. Publishing
  // them synchronously removes an avoidable initialization turn and prevents
  // the first screen from ever observing a not-yet-ready local i18n instance.
  initAsync: false,
  lng: initialLanguage,
  fallbackLng: "en",
  supportedLngs: ["ru", "en", "uk", "es", "de", "fr", "it", "nl", "pl"],
  resources: {
    ru: { translation: ru },
    en: { translation: en },
    uk: { translation: uk },
    es: { translation: es },
    de: { translation: de },
    fr: { translation: fr },
    it: { translation: it },
    nl: { translation: nl },
    pl: { translation: pl },
  },
  interpolation: {
    escapeValue: false,
  },
  react: {
    useSuspense: false,
    // Navigation keeps previous routes mounted. A global languageChanged
    // subscription in every useTranslation caller makes all hidden screens
    // render at once. ScreenPreferencesBoundary publishes one coherent
    // language revision only to the focused scene instead.
    bindI18n: "",
    bindI18nStore: "",
  },
});

export default i18n;
