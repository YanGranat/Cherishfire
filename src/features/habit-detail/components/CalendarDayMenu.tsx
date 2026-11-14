import React from "react";
import { useTranslation } from "react-i18next";
import { ContextMenu } from "@/components/overlays/ContextMenu";
import type { MenuItem } from "@/components/overlays/DropdownMenu";
import { useSettingsStore } from "@/stores/settings-store";
interface CalendarDayMenuProps {
  visible: boolean;
  onClose: () => void;
  x: number;
  y: number;
  onDone: () => void;
  onMinimum: () => void;
  onMaximum: () => void;
  onSkip: () => void;
  onFailure: () => void;
}
// Day statuses only; archive belongs to the habit-level menu.
export function CalendarDayMenu({
  visible,
  onClose,
  x,
  y,
  onDone,
  onMinimum,
  onMaximum,
  onSkip,
  onFailure,
}: CalendarDayMenuProps) {
  const { t } = useTranslation();
  const askFailureReason = useSettingsStore((state) => state.askFailureReason);
  const askSkipReason = useSettingsStore((state) => state.askSkipReason);
  const items: MenuItem[] = [
    {
      label: t("calendarDayMenu.done"),
      icon: "check",
      onPress: onDone,
    },
    {
      label: t("calendarDayMenu.minimum"),
      icon: "check",
      onPress: onMinimum,
    },
    {
      label: t("calendarDayMenu.maximum"),
      icon: "local-fire-department",
      onPress: onMaximum,
    },
    {
      label: t("calendarDayMenu.skip"),
      icon: "navigate-next",
      onPress: onSkip,
      deferUntilClosed: askSkipReason,
    },
    {
      label: t("calendarDayMenu.failure"),
      icon: "close",
      onPress: onFailure,
      destructive: true,
      deferUntilClosed: askFailureReason,
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
