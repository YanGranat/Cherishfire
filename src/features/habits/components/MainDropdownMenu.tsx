import React from "react";
import { useTranslation } from "react-i18next";
import { DropdownMenu } from "@/components/overlays/DropdownMenu";
import type { MenuItem } from "@/components/overlays/DropdownMenu";
interface MainDropdownMenuProps {
  visible: boolean;
  preloadOnAndroid?: boolean;
  onClose: () => void;
  onSettings: () => void;
  onExport: () => void;
  onImport: () => void;
  onAbout: () => void;
  onArchive: () => void;
}
// Main application destinations and data-transfer actions.
export function MainDropdownMenu({
  visible,
  preloadOnAndroid = false,
  onClose,
  onSettings,
  onExport,
  onImport,
  onAbout,
  onArchive,
}: MainDropdownMenuProps) {
  const { t } = useTranslation();
  const items: MenuItem[] = [
    {
      label: t("settings.title"),
      icon: "settings",
      onPress: onSettings,
      deferUntilClosed: true,
    },
    {
      label: t("export.title"),
      icon: "file-upload",
      onPress: onExport,
      deferUntilClosed: true,
    },
    {
      label: t("import.title"),
      icon: "file-download",
      onPress: onImport,
      deferUntilClosed: true,
    },
    {
      label: t("about.title"),
      icon: "info-outline",
      onPress: onAbout,
      deferUntilClosed: true,
    },
    {
      label: t("archive.title"),
      icon: "archive",
      onPress: onArchive,
      deferUntilClosed: true,
    },
  ];
  return (
    <DropdownMenu
      preloadOnAndroid={preloadOnAndroid}
      visible={visible}
      onClose={onClose}
      items={items}
    />
  );
}
