import React from "react";
import { useTranslation } from "react-i18next";
import { DropdownMenu } from "@/components/overlays/DropdownMenu";
import type { MenuItem } from "@/components/overlays/DropdownMenu";
import { useVisualLanguage } from "@/components/ScreenPreferencesBoundary";
const DETAIL_MENU_WIDTH_BY_LANGUAGE: Readonly<Record<string, number>> = {
  de: 236,
  fr: 220,
  it: 208,
  nl: 220,
};
interface DetailMenuProps {
  visible: boolean;
  onClose: () => void;
  descriptionVisible: boolean;
  onRename: () => void;
  onToggleDescription: () => void;
  onArchive: () => void;
  onDelete: () => void;
}
// Habit metadata, description visibility, archive, and deletion actions.
export function DetailMenu({
  visible,
  onClose,
  descriptionVisible,
  onRename,
  onToggleDescription,
  onArchive,
  onDelete,
}: DetailMenuProps) {
  const { t } = useTranslation();
  const language = useVisualLanguage();
  const baseLanguage = language.toLowerCase().split(/[-_]/, 1)[0];
  const items: MenuItem[] = [
    {
      label: t("detailMenu.rename"),
      icon: "edit",
      onPress: onRename,
      deferUntilClosed: true,
    },
    {
      label: descriptionVisible
        ? t("detailMenu.hideDescription")
        : t("detailMenu.showDescription"),
      icon: descriptionVisible ? "visibility-off" : "visibility",
      onPress: onToggleDescription,
    },
    {
      label: t("detailMenu.archive"),
      icon: "archive",
      onPress: onArchive,
      deferUntilClosed: true,
    },
    {
      label: t("detailMenu.delete"),
      icon: "trash-sharp",
      iconFamily: "ionicons",
      onPress: onDelete,
      destructive: true,
      deferUntilClosed: true,
    },
  ];
  return (
    <DropdownMenu
      visible={visible}
      onClose={onClose}
      items={items}
      menuWidth={DETAIL_MENU_WIDTH_BY_LANGUAGE[baseLanguage]}
    />
  );
}
