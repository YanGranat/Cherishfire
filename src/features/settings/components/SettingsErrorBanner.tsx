import React from "react";
import { useTranslation } from "react-i18next";
import { InlineErrorBanner } from "@/components/ui/InlineErrorBanner";
import { useSettingsStore } from "@/stores/settings-store";
export function SettingsErrorBanner() {
  const { t } = useTranslation();
  const error = useSettingsStore((state) => state.error);
  const clearError = useSettingsStore((state) => state.clearError);
  if (!error) return null;
  return (
    <InlineErrorBanner
      message={t("common.dataErrorMessage")}
      onDismiss={clearError}
      dismissAccessibilityLabel={t("common.ok")}
      containerStyle={{ marginBottom: 10 }}
    />
  );
}
