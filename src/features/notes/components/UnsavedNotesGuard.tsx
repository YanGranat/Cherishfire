import React, { useState, useSyncExternalStore } from "react";
import { useNavigation, usePreventRemove, type NavigationAction } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/Dialog";
import type { NoteEditorSession } from "@/features/notes/utils/note-editor-session";

export const UnsavedNotesGuard = React.memo(function UnsavedNotesGuard({
  editorSession,
  hasComposerDraft,
  enabled,
}: {
  editorSession: NoteEditorSession;
  hasComposerDraft: boolean;
  enabled: boolean;
}) {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const hasEditorDraft = useSyncExternalStore(
    editorSession.subscribe,
    editorSession.hasUnsavedChanges,
    editorSession.hasUnsavedChanges,
  );
  const [leaveAction, setLeaveAction] = useState<NavigationAction | null>(null);
  usePreventRemove(enabled && (hasComposerDraft || hasEditorDraft), ({ data }) => {
    setLeaveAction((current) => current ?? data.action);
  });
  return (
    <Dialog
      visible={leaveAction != null}
      title={t("notes.discardTitle")}
      message={t("notes.discardMessage")}
      actions={[
        {
          label: t("common.cancel"),
          role: "cancel",
          onPress: () => setLeaveAction(null),
        },
        {
          label: t("notes.discard"),
          variant: "destructive",
          onPress: () => {
            const action = leaveAction;
            setLeaveAction(null);
            if (action) navigation.dispatch(action);
          },
        },
      ]}
    />
  );
});
