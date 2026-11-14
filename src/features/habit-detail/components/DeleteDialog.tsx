import React from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/Dialog";
interface DeleteDialogProps {
  visible: boolean;
  onCancel: () => void;
  onDelete: () => void;
  onDismiss?: () => void;
  busy?: boolean;
  errorMessage?: string | null;
}
// Destructive confirmation; scrim presses do not dismiss it.
export function DeleteDialog({
  visible,
  onCancel,
  onDelete,
  onDismiss,
  busy = false,
  errorMessage,
}: DeleteDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog
      visible={visible}
      onDismiss={onDismiss}
      title={t("deleteDialog.title")}
      message={
        errorMessage
          ? `${t("deleteDialog.message")}\n\n${errorMessage}`
          : t("deleteDialog.message")
      }
      actions={[
        {
          label: t("deleteDialog.cancel"),
          onPress: onCancel,
          role: "cancel",
          disabled: busy,
        },
        {
          label: t("deleteDialog.delete"),
          onPress: onDelete,
          variant: "destructive",
          disabled: busy,
        },
      ]}
    />
  );
}
