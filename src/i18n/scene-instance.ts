import i18n from "@/i18n/config";

const sceneI18nByLanguage = new Map<string, typeof i18n>();

/**
 * Each retained native-stack scene needs an immutable language owner. Clones
 * share resources, so creating them once removes first-selection work without
 * duplicating translation JSON.
 */
export function getSceneI18n(language: string): typeof i18n {
  const cached = sceneI18nByLanguage.get(language);
  if (cached) return cached;

  const sceneI18n = i18n.cloneInstance({
    lng: language,
    initAsync: false,
  });
  sceneI18nByLanguage.set(language, sceneI18n);
  return sceneI18n;
}

export function prewarmSceneI18nLanguage(language: string): void {
  getSceneI18n(language);
}
