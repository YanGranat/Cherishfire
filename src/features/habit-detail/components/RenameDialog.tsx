/** @jsxImportSource nativewind */
import React, { useState } from "react";
import { Text, TextInput } from "react-native";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/Dialog";
import { useVisualEffectiveMode } from "@/components/ScreenPreferencesBoundary";
import { darkTheme, lightTheme } from "@/theme/colors";
import { useRetainedModalSession } from "@/hooks/useRetainedModalSession";
interface RenameDialogProps {
  visible: boolean;
  currentName: string;
  onCancel: () => void;
  onSave: (name: string) => void;
  busy?: boolean;
  errorMessage?: string | null;
}
interface RenameDialogSessionProps extends RenameDialogProps {
  onDismiss: () => void;
}
type RenameDialogSessionSnapshot = Pick<RenameDialogProps, "currentName">;
// Rename starts from the current name and keeps one retained input draft.
function RenameDialogSession({
  visible,
  currentName,
  onCancel,
  onSave,
  busy = false,
  errorMessage,
  onDismiss,
}: RenameDialogSessionProps) {
  const [name, setName] = useState(() => currentName);
  const { t } = useTranslation();
  const effectiveMode = useVisualEffectiveMode();
  const isDarkTheme = effectiveMode === "dark";
  const palette = isDarkTheme ? darkTheme : lightTheme;
  const inputBackgroundColor = isDarkTheme
    ? "#262626"
    : lightTheme.pressHighlight;
  const handleSave = () => {
    const trimmed = name.trim();
    if (trimmed.length > 0) {
      onSave(trimmed);
      return;
    }
  };
  const handleNameChange = (value: string) => {
    setName(value);
  };
  return (
    <Dialog
      visible={visible}
      onDismiss={onDismiss}
      title={t("rename.title")}
      actions={[
        {
          label: t("rename.cancel"),
          onPress: onCancel,
          role: "cancel",
          disabled: busy,
        },
        {
          label: t("rename.save"),
          onPress: handleSave,
          disabled: busy,
        },
      ]}
    >
      <TextInput
        value={name}
        onChange={(event) => handleNameChange(event.nativeEvent.text)}
        autoFocus
        selectTextOnFocus
        className="text-primary text-base border border-border rounded-input p-md"
        style={{
          backgroundColor: inputBackgroundColor,
          borderColor: palette.border,
        }}
      />
      {errorMessage ? (
        <Text accessibilityRole="alert" className="mt-sm text-sm text-muted">
          {errorMessage}
        </Text>
      ) : null}
    </Dialog>
  );
}
function RenameDialogComponent(props: RenameDialogProps) {
  const { session, handleDismiss } =
    useRetainedModalSession<RenameDialogSessionSnapshot>(props.visible, () => ({
      currentName: props.currentName,
    }));
  if (session == null) return null;
  const snapshot = session.snapshot;
  return (
    <RenameDialogSession
      key={session.key}
      visible={props.visible}
      currentName={snapshot.currentName}
      onCancel={props.onCancel}
      onSave={props.onSave}
      busy={props.busy}
      errorMessage={props.errorMessage}
      onDismiss={handleDismiss}
    />
  );
}
export const RenameDialog = React.memo(RenameDialogComponent);
