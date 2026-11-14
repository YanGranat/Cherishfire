import React from "react";
import { useTranslation } from "react-i18next";
import { ContextMenu } from "@/components/overlays/ContextMenu";
import type { MenuItem } from "@/components/overlays/DropdownMenu";
import { useSettingsStore } from "@/stores/settings-store";
interface HabitContextMenuProps {
  visible: boolean;
  onClose: () => void;
  x: number;
  y: number;
  onMinimum: () => void;
  onMaximum: () => void;
  onFailure: () => void;
  onSkip: () => void;
  onArchive: () => void;
}
// Habit status and archive actions.
export function HabitContextMenu({
  visible,
  onClose,
  x,
  y,
  onMinimum,
  onMaximum,
  onFailure,
  onSkip,
  onArchive,
}: HabitContextMenuProps) {
  const { t } = useTranslation();
  const askFailureReason = useSettingsStore((state) => state.askFailureReason);
  const askSkipReason = useSettingsStore((state) => state.askSkipReason);
  const items: MenuItem[] = [
    {
      label: t("contextMenu.minimum"),
      icon: "check",
      onPress: onMinimum,
    },
    {
      label: t("contextMenu.maximum"),
      icon: "local-fire-department",
      onPress: onMaximum,
    },
    {
      label: t("contextMenu.failure"),
      icon: "close",
      onPress: onFailure,
      destructive: true,
      deferUntilClosed: askFailureReason,
    },
    {
      label: t("contextMenu.skip"),
      icon: "navigate-next",
      onPress: onSkip,
      deferUntilClosed: askSkipReason,
    },
    {
      label: t("contextMenu.archive"),
      icon: "archive",
      onPress: onArchive,
    },
  ];
  return (
    <ContextMenu
      visible={visible}
      onClose={onClose}
      items={items}
      x={x}
      y={y}
    />
  );
}
