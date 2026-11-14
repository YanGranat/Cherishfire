import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { DeleteDialog } from "./DeleteDialog";
import { DetailMenu } from "./DetailMenu";
import { RenameDialog } from "./RenameDialog";
export interface HabitDetailMenuControllerHandle {
  openMenu: () => void;
}
interface HabitDetailMenuControllerProps {
  habitName: string;
  descriptionVisible: boolean;
  isArchived: boolean;
  actionError: string | null;
  onClearActionError: () => void;
  onToggleDescription: () => void;
  onRename: (name: string) => void;
  onArchive: () => void;
  onDelete: () => void;
}
interface OverlaySession {
  visible: boolean;
  mounted: boolean;
}
const HIDDEN_SESSION: OverlaySession = {
  visible: false,
  mounted: false,
};
const MemoizedDetailMenu = React.memo(DetailMenu);
const MemoizedDeleteDialog = React.memo(DeleteDialog);
function HabitDetailMenuControllerComponent(
  {
    habitName,
    descriptionVisible,
    isArchived,
    actionError,
    onClearActionError,
    onToggleDescription,
    onRename,
    onArchive,
    onDelete,
  }: HabitDetailMenuControllerProps,
  ref: React.ForwardedRef<HabitDetailMenuControllerHandle>,
) {
  const [menu, setMenu] = useState<OverlaySession>(HIDDEN_SESSION);
  const [rename, setRename] = useState<OverlaySession>(HIDDEN_SESSION);
  const [deleteDialog, setDeleteDialog] =
    useState<OverlaySession>(HIDDEN_SESSION);
  const pendingDeleteConfirmRef = useRef(false);
  const onDeleteRef = useRef(onDelete);
  onDeleteRef.current = onDelete;
  const flushPendingDelete = useCallback(() => {
    if (!pendingDeleteConfirmRef.current) return;
    pendingDeleteConfirmRef.current = false;
    onDeleteRef.current();
  }, []);
  useImperativeHandle(
    ref,
    () => ({
      openMenu() {
        if (pendingDeleteConfirmRef.current) {
          // An accepted destructive command wins over a later reopen. AppModal
          // can legitimately suppress physical onDismiss when a close is
          // reversed, so retire the command here instead of stranding it.
          flushPendingDelete();
          return;
        }
        setMenu({ visible: true, mounted: true });
      },
    }),
    [flushPendingDelete],
  );
  useLayoutEffect(
    () => () => {
      flushPendingDelete();
    },
    [flushPendingDelete],
  );
  const closeMenu = useCallback(() => {
    setMenu((current) => ({ ...current, visible: false }));
  }, []);
  const openRename = useCallback(() => {
    if (isArchived) {
      return;
    }
    setMenu((current) => ({ ...current, visible: false }));
    onClearActionError();
    setRename({ visible: true, mounted: true });
  }, [isArchived, onClearActionError]);
  const toggleDescription = useCallback(() => {
    if (isArchived) {
      return;
    }
    setMenu((current) => ({ ...current, visible: false }));
    onToggleDescription();
  }, [isArchived, onToggleDescription]);
  const archive = useCallback(() => {
    setMenu((current) => ({ ...current, visible: false }));
    onArchive();
  }, [onArchive]);
  const openDelete = useCallback(() => {
    if (isArchived) {
      return;
    }
    setMenu((current) => ({ ...current, visible: false }));
    onClearActionError();
    setDeleteDialog({ visible: true, mounted: true });
  }, [isArchived, onClearActionError]);
  const cancelRename = useCallback(() => {
    setRename((current) => ({ ...current, visible: false }));
    onClearActionError();
  }, [onClearActionError]);
  const saveRename = useCallback(
    (name: string) => {
      if (isArchived) {
        return;
      }
      setRename((current) => ({ ...current, visible: false }));
      onRename(name);
    },
    [isArchived, onRename],
  );
  const cancelDelete = useCallback(() => {
    setDeleteDialog((current) => ({ ...current, visible: false }));
    onClearActionError();
  }, [onClearActionError]);
  const confirmDelete = useCallback(() => {
    if (pendingDeleteConfirmRef.current) {
      return;
    }
    pendingDeleteConfirmRef.current = true;
    setDeleteDialog((current) => ({ ...current, visible: false }));
  }, []);
  return (
    <>
      {menu.mounted ? (
        <MemoizedDetailMenu
          visible={menu.visible}
          onClose={closeMenu}
          descriptionVisible={descriptionVisible}
          onRename={openRename}
          onToggleDescription={toggleDescription}
          onArchive={archive}
          onDelete={openDelete}
        />
      ) : null}
      {rename.mounted ? (
        <RenameDialog
          visible={rename.visible}
          currentName={habitName}
          onCancel={cancelRename}
          onSave={saveRename}
          busy={false}
          errorMessage={rename.visible ? actionError : null}
        />
      ) : null}
      {deleteDialog.mounted ? (
        <MemoizedDeleteDialog
          visible={deleteDialog.visible}
          onCancel={cancelDelete}
          onDelete={confirmDelete}
          onDismiss={flushPendingDelete}
          busy={false}
          errorMessage={deleteDialog.visible ? actionError : null}
        />
      ) : null}
    </>
  );
}
export const HabitDetailMenuController = React.memo(
  forwardRef(HabitDetailMenuControllerComponent),
);
