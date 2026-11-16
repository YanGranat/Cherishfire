/** @jsxImportSource nativewind */
import React, { useRef, useState } from "react";
import { TextInput } from "react-native";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/Dialog";
import { useVisualEffectiveMode } from "@/components/ScreenPreferencesBoundary";
import { useRetainedModalSession } from "@/hooks/useRetainedModalSession";
type FailureReasonStatus = "failure" | "skipped";
interface FailureReasonDialogProps {
  visible: boolean;
  status: FailureReasonStatus;
  initialReason?: string;
  onCancel: () => void;
  onSave: (reason: string) => boolean | Promise<boolean>;
  onDismiss?: () => void;
}
interface FailureReasonDialogSessionProps extends FailureReasonDialogProps {
  onDismiss: () => void;
}
type FailureReasonDialogSessionSnapshot = Pick<
  FailureReasonDialogProps,
  "status" | "initialReason"
>;
function FailureReasonDialogSession({
  visible,
  status,
  initialReason = "",
  onCancel,
  onSave,
  onDismiss,
}: FailureReasonDialogSessionProps) {
  const [reason, setReason] = useState(initialReason);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  const { t } = useTranslation();
  const effectiveMode = useVisualEffectiveMode();
  const isDarkTheme = effectiveMode === "dark";
  const submit = async (action: () => boolean | Promise<boolean>) => {
    if (isSubmittingRef.current) {
      return;
    }
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    let keepStateUntilDismiss = false;
    try {
      const succeeded = await action();
      keepStateUntilDismiss = succeeded;
    } catch (submitError) {
      console.error("Failed to save failure reason", submitError);
    } finally {
      if (!keepStateUntilDismiss) {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
      }
    }
  };
  const handleCancel = () => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    onCancel();
  };
  const handleSave = () => {
    return submit(() => onSave(reason.trim()));
  };
  const handleReasonChange = (value: string) => {
    setReason(value);
  };
  return (
    <Dialog
      visible={visible}
      onDismiss={onDismiss}
      title={
        status === "skipped"
          ? t("failureDialog.skipTitle")
          : t("failureDialog.title")
      }
      contentStyle={{
        paddingTop: 19,
        paddingBottom: 11,
      }}
      titleStyle={{ marginTop: -6, marginBottom: 8 }}
      actionsContainerStyle={{ marginTop: 8.5 }}
      actionButtonStyle={{ minHeight: 35, paddingVertical: 1.25 }}
      actions={[
        {
          label: t("common.cancel"),
          onPress: handleCancel,
          role: "cancel",
          disabled: isSubmitting,
        },
        {
          label: t("failureDialog.save"),
          onPress: handleSave,
          buttonStyle: { paddingRight: 0 },
          disabled: isSubmitting,
        },
      ]}
    >
      <TextInput
        value={reason}
        onChange={(event) => handleReasonChange(event.nativeEvent.text)}
        editable={!isSubmitting}
        placeholder={t("failureDialog.placeholder")}
        multiline
        scrollEnabled
        blurOnSubmit={false}
        className="text-primary text-base"
        style={{
          width: "100%",
          height: 80,
          lineHeight: 24,
          backgroundColor: isDarkTheme ? "#222222" : "#F5F5F5",
          borderWidth: 0,
          borderRadius: 12,
          paddingHorizontal: 12,
          paddingTop: 10,
          paddingBottom: 10,
        }}
        placeholderTextColor={isDarkTheme ? "#A6A6A6" : "#8E8E8E"}
        textAlignVertical="top"
      />
    </Dialog>
  );
}
function FailureReasonDialogComponent(props: FailureReasonDialogProps) {
  const { session, handleDismiss } =
    useRetainedModalSession<FailureReasonDialogSessionSnapshot>(
      props.visible,
      () => ({
        status: props.status,
        initialReason: props.initialReason,
      }),
    );
  if (session == null) return null;
  const snapshot = session.snapshot;
  const handleSessionDismiss = () => {
    handleDismiss();
    props.onDismiss?.();
  };
  return (
    <FailureReasonDialogSession
      key={session.key}
      visible={props.visible}
      status={snapshot.status}
      initialReason={snapshot.initialReason}
      onCancel={props.onCancel}
      onSave={props.onSave}
      onDismiss={handleSessionDismiss}
    />
  );
}
export const FailureReasonDialog = React.memo(FailureReasonDialogComponent);
