import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { OneShotActionGate } from "@/application/interaction/one-shot-action-gate";
import { useSettingsStore } from "@/stores/settings-store";
import type { DayStatus } from "@/types/habit";
import { FailureReasonDialog } from "@/features/habits/components/FailureReasonDialog";
import { CalendarDayMenu } from "./CalendarDayMenu";
export interface HabitDetailDayStatusCommand {
  date: string;
  status: DayStatus;
  reason?: string;
  afterReasonDismiss: boolean;
}
export interface HabitDetailStatusOverlayControllerHandle {
  openDayMenu: (params: { date: string; x: number; y: number }) => void;
  flushPendingCommandBeforeOwnerUnmount: () => void;
}
interface HabitDetailStatusOverlayControllerProps {
  onApplyStatus: (command: HabitDetailDayStatusCommand) => void;
}
interface DayMenuSession {
  visible: boolean;
  date: string;
  x: number;
  y: number;
}
interface FailureDialogSession {
  visible: boolean;
  date: string;
  status: "failure" | "skipped";
}
interface PendingFailureSubmission {
  date: string;
  status: "failure" | "skipped";
  reason?: string;
}
const MemoizedCalendarDayMenu = React.memo(CalendarDayMenu);
function HabitDetailStatusOverlayControllerComponent(
  { onApplyStatus }: HabitDetailStatusOverlayControllerProps,
  ref: React.ForwardedRef<HabitDetailStatusOverlayControllerHandle>,
) {
  // A null session is intentional: neither portal is mounted until the user
  // first asks for it. After first use, the component stays mounted so its
  // existing close animation and retained native-modal lifecycle are intact.
  const [dayMenu, setDayMenu] = useState<DayMenuSession | null>(null);
  const [failureDialog, setFailureDialog] =
    useState<FailureDialogSession | null>(null);
  const dayMenuRef = useRef<DayMenuSession | null>(null);
  const failureDialogRef = useRef<FailureDialogSession | null>(null);
  const pendingFailureSubmissionRef = useRef<PendingFailureSubmission | null>(
    null,
  );
  const dayMenuIntentGateRef = useRef<OneShotActionGate | null>(null);
  const failureIntentGateRef = useRef<OneShotActionGate | null>(null);
  const onApplyStatusRef = useRef(onApplyStatus);
  onApplyStatusRef.current = onApplyStatus;
  const publishDayMenu = useCallback((session: DayMenuSession) => {
    dayMenuRef.current = session;
    setDayMenu(session);
  }, []);
  const publishFailureDialog = useCallback((session: FailureDialogSession) => {
    failureDialogRef.current = session;
    setFailureDialog(session);
  }, []);
  const flushPendingFailureSubmission = useCallback(() => {
    const pending = pendingFailureSubmissionRef.current;
    if (!pending) return;
    pendingFailureSubmissionRef.current = null;
    onApplyStatusRef.current({
      ...pending,
      afterReasonDismiss: true,
    });
  }, []);
  const openDayMenu = useCallback(
    ({
      date,
      x,
      y,
    }: Parameters<
      HabitDetailStatusOverlayControllerHandle["openDayMenu"]
    >[0]) => {
      // A submitted reason is a captured product command. Never let a newer
      // overlay intent replace it before the post-dismiss handoff runs.
      flushPendingFailureSubmission();
      const activeFailureDialog = failureDialogRef.current;
      if (activeFailureDialog?.visible) {
        return;
      }
      const activeDayMenu = dayMenuRef.current;
      if (activeDayMenu?.visible) {
        return;
      }
      dayMenuIntentGateRef.current = new OneShotActionGate();
      publishDayMenu({ visible: true, date, x, y });
    },
    [flushPendingFailureSubmission, publishDayMenu],
  );
  useImperativeHandle(
    ref,
    () => ({
      openDayMenu,
      flushPendingCommandBeforeOwnerUnmount: flushPendingFailureSubmission,
    }),
    [flushPendingFailureSubmission, openDayMenu],
  );
  useLayoutEffect(
    () => () => {
      flushPendingFailureSubmission();
      dayMenuRef.current = null;
      failureDialogRef.current = null;
      dayMenuIntentGateRef.current = null;
      failureIntentGateRef.current = null;
    },
    [flushPendingFailureSubmission],
  );
  const closeDayMenu = useCallback(() => {
    const current = dayMenuRef.current;
    if (!current?.visible) return;
    publishDayMenu({ ...current, visible: false });
  }, [publishDayMenu]);
  const applyDayMenuStatus = useCallback(
    (status: DayStatus) => {
      const current = dayMenuRef.current;
      const gate = dayMenuIntentGateRef.current;
      if (!current?.visible || !gate?.claim()) {
        return;
      }
      // Close first. Product mutation is allowed only after the overlay owner
      // has synchronously published the hidden intent.
      publishDayMenu({ ...current, visible: false });
      const { askFailureReason, askSkipReason } = useSettingsStore.getState();
      const shouldAskReason =
        (status === "failure" && askFailureReason) ||
        (status === "skipped" && askSkipReason);
      if (shouldAskReason && (status === "failure" || status === "skipped")) {
        failureIntentGateRef.current = new OneShotActionGate();
        publishFailureDialog({
          visible: true,
          date: current.date,
          status,
        });
        return;
      }
      onApplyStatusRef.current({
        date: current.date,
        status,
        afterReasonDismiss: false,
      });
    },
    [publishDayMenu, publishFailureDialog],
  );
  const submitFailureReason = useCallback(
    (reason: string) => {
      const current = failureDialogRef.current;
      const gate = failureIntentGateRef.current;
      if (!current?.visible || !gate?.claim()) {
        return false;
      }
      pendingFailureSubmissionRef.current = {
        date: current.date,
        status: current.status,
        reason,
      };
      publishFailureDialog({ ...current, visible: false });
      return true;
    },
    [publishFailureDialog],
  );
  const cancelFailureReason = useCallback(() => {
    const current = failureDialogRef.current;
    const gate = failureIntentGateRef.current;
    if (!current?.visible || !gate?.claim()) return;
    publishFailureDialog({ ...current, visible: false });
  }, [publishFailureDialog]);
  return (
    <>
      {dayMenu ? (
        <MemoizedCalendarDayMenu
          visible={dayMenu.visible}
          onClose={closeDayMenu}
          x={dayMenu.x}
          y={dayMenu.y}
          onDone={() => applyDayMenuStatus("done")}
          onMinimum={() => applyDayMenuStatus("minimum")}
          onMaximum={() => applyDayMenuStatus("maximum")}
          onSkip={() => applyDayMenuStatus("skipped")}
          onFailure={() => applyDayMenuStatus("failure")}
        />
      ) : null}

      {failureDialog ? (
        <FailureReasonDialog
          visible={failureDialog.visible}
          status={failureDialog.status}
          onCancel={cancelFailureReason}
          onSave={(reason) => submitFailureReason(reason)}
          onDismiss={flushPendingFailureSubmission}
        />
      ) : null}
    </>
  );
}
export const HabitDetailStatusOverlayController = React.memo(
  forwardRef(HabitDetailStatusOverlayControllerComponent),
);
