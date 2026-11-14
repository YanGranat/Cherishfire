import React, {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  normalizeImportData,
  previewNormalizedImportData,
  type ImportPreview,
  type NormalizedImportData,
} from "@/application/data-transfer/data-transfer-codec";
import { useVisualEffectiveMode } from "@/components/ScreenPreferencesBoundary";
import { Dialog } from "@/components/ui/Dialog";
import {
  exportAllData,
  getDataTransferImportFileFailure,
  importNormalizedData,
  selectDataTransferImportFile,
} from "@/composition/data-transfer";
import {
  closeDataTransferOverlay,
  createEmptyDataTransferOverlaySlot,
  createSynchronousActionFence,
  enqueueDataTransferOverlay,
  settleDataTransferOverlayDismissal,
  type DataTransferOverlaySlot,
} from "@/features/habits/utils/data-transfer-overlay-slot";
import i18n from "@/i18n/config";
import { useHabitStore } from "@/stores/habit-store";
import {
  loadSettingsFromCommittedImport,
  useSettingsStore,
} from "@/stores/settings-store";
import { darkTheme, lightTheme } from "@/theme/colors";
const IMPORT_PRELOAD_DAY_RADIUS = 1;
export interface HomeStatusDialogInput {
  title: string;
  message: string;
  onRetry?: () => Promise<boolean>;
}
export interface HomeDataTransferOverlayHandle {
  openExport(): void;
  openImport(): void;
  showStatus(status: HomeStatusDialogInput): void;
}
interface HomeDataTransferOverlayControllerProps {
  selectedDate: string;
}
interface ExportOverlayRequest {
  readonly kind: "export";
}
interface ImportFileOverlayRequest {
  readonly kind: "import-file";
}
interface ImportPreviewOverlayRequest {
  readonly kind: "import-preview";
  readonly data: NormalizedImportData;
  readonly preview: ImportPreview;
}
interface StatusOverlayRequest extends HomeStatusDialogInput {
  readonly kind: "status";
  readonly importRequestToken?: number;
  readonly dismissLabel: string;
  readonly retryLabel: string;
}
type HomeDataTransferOverlayRequest =
  | ExportOverlayRequest
  | ImportFileOverlayRequest
  | ImportPreviewOverlayRequest
  | StatusOverlayRequest;
type OverlayKind = HomeDataTransferOverlayRequest["kind"];
function currentTransferTranslator() {
  return i18n.getFixedT(useSettingsStore.getState().language);
}
function createStatusRequest(
  status: HomeStatusDialogInput,
  translate = currentTransferTranslator(),
  importRequestToken?: number,
): StatusOverlayRequest {
  return {
    ...status,
    kind: "status",
    importRequestToken,
    dismissLabel: translate("common.ok"),
    retryLabel: translate("common.retry"),
  };
}
function isVisibleOverlay(
  slot: DataTransferOverlaySlot<HomeDataTransferOverlayRequest>,
  kind: OverlayKind,
): boolean {
  return slot.phase === "visible" && slot.current.kind === kind;
}
function slotContainsStatusForImport(
  slot: DataTransferOverlaySlot<HomeDataTransferOverlayRequest>,
  requestToken: number,
): boolean {
  if (
    slot.phase !== "idle" &&
    slot.current.kind === "status" &&
    slot.current.importRequestToken === requestToken
  ) {
    return true;
  }
  return slot.queue.some(
    (request) =>
      request.kind === "status" && request.importRequestToken === requestToken,
  );
}
/**
 * Owns the complete import/export/status portal lifecycle. Exactly one dialog
 * may be visible or fading at a time; later status/error messages wait FIFO.
 */
export const HomeDataTransferOverlayController = memo(
  forwardRef<
    HomeDataTransferOverlayHandle,
    HomeDataTransferOverlayControllerProps
  >(function HomeDataTransferOverlayController({ selectedDate }, ref) {
    const { t } = useTranslation();
    const effectiveMode = useVisualEffectiveMode();
    const contentBackgroundColor =
      effectiveMode === "dark"
        ? darkTheme.menuSurface
        : lightTheme.surfaceElevated;
    const selectedDateRef = useRef(selectedDate);
    useLayoutEffect(() => {
      selectedDateRef.current = selectedDate;
    }, [selectedDate]);
    const initialOverlaySlot =
      createEmptyDataTransferOverlaySlot<HomeDataTransferOverlayRequest>();
    const overlaySlotRef = useRef(initialOverlaySlot);
    const [overlaySlot, setOverlaySlot] = useState(initialOverlaySlot);
    const [pendingImportError, setPendingImportError] = useState<string | null>(
      null,
    );
    const [isImporting, setIsImporting] = useState(false);
    const [exportFence] = useState(createSynchronousActionFence);
    const [chooseFileFence] = useState(createSynchronousActionFence);
    const [applyImportFence] = useState(createSynchronousActionFence);
    const [statusRetryFence] = useState(createSynchronousActionFence);
    const pendingImportApplyTokenRef = useRef<number | null>(null);
    const pendingImportPublicationRecoveryRef = useRef<
      (() => Promise<void>) | null
    >(null);
    const updateOverlaySlot = useCallback(
      (
        update: (
          current: DataTransferOverlaySlot<HomeDataTransferOverlayRequest>,
        ) => DataTransferOverlaySlot<HomeDataTransferOverlayRequest>,
      ) => {
        const current = overlaySlotRef.current;
        const next = update(current);
        if (next === current) return;
        overlaySlotRef.current = next;
        setOverlaySlot(next);
      },
      [],
    );
    const enqueueOverlay = useCallback(
      (request: HomeDataTransferOverlayRequest) => {
        updateOverlaySlot((current) =>
          enqueueDataTransferOverlay(current, request),
        );
      },
      [updateOverlaySlot],
    );
    const closeOverlay = useCallback(
      (kind: OverlayKind) => {
        updateOverlaySlot((current) => {
          if (current.phase !== "visible" || current.current.kind !== kind) {
            return current;
          }
          return closeDataTransferOverlay(current, kind);
        });
      },
      [updateOverlaySlot],
    );
    const closeAndEnqueueOverlay = useCallback(
      (kind: OverlayKind, request: HomeDataTransferOverlayRequest) => {
        updateOverlaySlot((current) => {
          if (current.phase !== "visible" || current.current.kind !== kind) {
            return current;
          }
          return closeDataTransferOverlay(
            enqueueDataTransferOverlay(current, request),
            kind,
          );
        });
      },
      [updateOverlaySlot],
    );
    const settleOverlayDismissal = useCallback(
      (kind: OverlayKind) => {
        updateOverlaySlot((current) =>
          settleDataTransferOverlayDismissal(current, kind),
        );
      },
      [updateOverlaySlot],
    );
    useImperativeHandle(
      ref,
      () => ({
        openExport: () => enqueueOverlay({ kind: "export" }),
        openImport: () => enqueueOverlay({ kind: "import-file" }),
        showStatus: (status) => enqueueOverlay(createStatusRequest(status)),
      }),
      [enqueueOverlay],
    );
    useLayoutEffect(() => {
      const requestToken = pendingImportApplyTokenRef.current;
      if (requestToken == null || isImporting) return;
      const hasTerminalUi =
        pendingImportError != null ||
        slotContainsStatusForImport(overlaySlot, requestToken);
      if (!hasTerminalUi) return;
      applyImportFence.release(requestToken);
      pendingImportApplyTokenRef.current = null;
    }, [applyImportFence, isImporting, overlaySlot, pendingImportError]);
    const confirmExport = useCallback(async () => {
      const requestToken = exportFence.tryAcquire();
      if (requestToken == null) {
        return;
      }
      if (!isVisibleOverlay(overlaySlotRef.current, "export")) {
        exportFence.release(requestToken);
        return;
      }
      closeOverlay("export");
      try {
        await exportAllData();
      } catch (error) {
        console.error("Failed to export data", error);
        const translate = currentTransferTranslator();
        enqueueOverlay(
          createStatusRequest(
            {
              title: translate("export.errorTitle"),
              message: translate("export.errorMessage"),
            },
            translate,
          ),
        );
      } finally {
        exportFence.release(requestToken);
      }
    }, [closeOverlay, enqueueOverlay, exportFence]);
    const prepareImport = useCallback(
      (json: string) => {
        try {
          const data = normalizeImportData(json);
          const preview = previewNormalizedImportData(data);
          setPendingImportError(null);
          enqueueOverlay({
            kind: "import-preview",
            data,
            preview,
          });
        } catch (previewError) {
          console.error("Import preview validation failed", previewError);
          const translate = currentTransferTranslator();
          enqueueOverlay(
            createStatusRequest(
              {
                title: translate("import.errorTitle"),
                message: translate("import.errorMessage"),
              },
              translate,
            ),
          );
        }
      },
      [enqueueOverlay],
    );
    const confirmImport = useCallback(async () => {
      const requestToken = chooseFileFence.tryAcquire();
      if (requestToken == null) {
        return;
      }
      if (!isVisibleOverlay(overlaySlotRef.current, "import-file")) {
        chooseFileFence.release(requestToken);
        return;
      }
      closeOverlay("import-file");
      try {
        const result = await selectDataTransferImportFile();
        if (result.status === "cancelled") return;
        prepareImport(result.text);
      } catch (error) {
        const failure = getDataTransferImportFileFailure(error);
        console.error(
          failure?.phase === "request"
            ? "Failed to open import document picker"
            : "Failed to read import file",
          failure?.originalError ?? error,
        );
        const translate = currentTransferTranslator();
        enqueueOverlay(
          createStatusRequest(
            {
              title: translate("import.errorTitle"),
              message: translate("import.errorMessage"),
            },
            translate,
          ),
        );
      } finally {
        chooseFileFence.release(requestToken);
      }
    }, [chooseFileFence, closeOverlay, enqueueOverlay, prepareImport]);
    const applyImport = useCallback(async () => {
      const requestToken = applyImportFence.tryAcquire();
      if (requestToken == null) {
        return;
      }
      const currentSlot = overlaySlotRef.current;
      if (
        currentSlot.phase !== "visible" ||
        currentSlot.current.kind !== "import-preview"
      ) {
        applyImportFence.release(requestToken);
        return;
      }
      const data = currentSlot.current.data;
      pendingImportApplyTokenRef.current = requestToken;
      setIsImporting(true);
      setPendingImportError(null);
      try {
        const publishImportedSnapshot = async () => {
          const habitStore = useHabitStore.getState();
          const targetDate = selectedDateRef.current;
          habitStore.resetInMemoryCaches();
          const [habitsLoaded, dayRecordsLoaded, settingsLoaded] =
            await Promise.all([
              habitStore.loadHabits({ mode: "committed-import" }),
              habitStore.loadAllDayRecords(),
              loadSettingsFromCommittedImport(),
            ]);
          const selectedDayLoaded = await habitStore.loadDayRecords(targetDate);
          if (
            !habitsLoaded ||
            !dayRecordsLoaded ||
            !settingsLoaded ||
            !selectedDayLoaded
          ) {
            throw new Error("Imported snapshot publication failed");
          }
          void habitStore.preloadDayRecordsWindow(
            targetDate,
            IMPORT_PRELOAD_DAY_RADIUS,
          );
        };
        const pendingRecovery = pendingImportPublicationRecoveryRef.current;
        if (pendingRecovery) {
          await pendingRecovery();
          pendingImportPublicationRecoveryRef.current = null;
        } else {
          const imported = await importNormalizedData(
            data,
            publishImportedSnapshot,
          );
          if (!imported.success) {
            console.error(
              "Import transaction/publication failed",
              imported.error,
            );
            if (imported.committed) {
              pendingImportPublicationRecoveryRef.current =
                imported.retryPublication;
            }
            const translate = currentTransferTranslator();
            setPendingImportError(translate("import.errorMessage"));
            return;
          }
        }
        const translate = currentTransferTranslator();
        closeAndEnqueueOverlay(
          "import-preview",
          createStatusRequest(
            {
              title: translate("import.title"),
              message: translate("import.success"),
            },
            translate,
            requestToken,
          ),
        );
      } catch (error) {
        console.error("Failed to apply import", error);
        const translate = currentTransferTranslator();
        setPendingImportError(translate("import.errorMessage"));
      } finally {
        setIsImporting(false);
      }
    }, [applyImportFence, closeAndEnqueueOverlay]);
    const runStatusRetry = useCallback(
      (status: StatusOverlayRequest) => {
        const requestToken = statusRetryFence.tryAcquire();
        if (requestToken == null) {
          return;
        }
        const currentSlot = overlaySlotRef.current;
        if (currentSlot.phase !== "visible" || currentSlot.current !== status) {
          statusRetryFence.release(requestToken);
          return;
        }
        closeOverlay("status");
        const retry = status.onRetry;
        if (!retry) {
          statusRetryFence.release(requestToken);
          return;
        }
        void (async () => {
          try {
            const succeeded = await retry();
            if (!succeeded) enqueueOverlay(status);
          } catch {
            enqueueOverlay(status);
          } finally {
            statusRetryFence.release(requestToken);
          }
        })();
      },
      [closeOverlay, enqueueOverlay, statusRetryFence],
    );
    const currentOverlay = overlaySlot.current;
    const overlayVisible = overlaySlot.phase === "visible";
    const exportOverlay =
      currentOverlay?.kind === "export" ? currentOverlay : null;
    const importFileOverlay =
      currentOverlay?.kind === "import-file" ? currentOverlay : null;
    const importPreviewOverlay =
      currentOverlay?.kind === "import-preview" ? currentOverlay : null;
    const statusOverlay =
      currentOverlay?.kind === "status" ? currentOverlay : null;
    return (
      <>
        <Dialog
          visible={overlayVisible && exportOverlay != null}
          title={t("export.title")}
          message={t("export.message")}
          contentBackgroundColor={contentBackgroundColor}
          onDismiss={() => settleOverlayDismissal("export")}
          actions={[
            {
              label: t("export.cancel"),
              onPress: () => closeOverlay("export"),
              role: "cancel",
            },
            {
              label: t("export.export"),
              onPress: () => void confirmExport(),
            },
          ]}
        />

        <Dialog
          visible={overlayVisible && importFileOverlay != null}
          title={t("import.title")}
          message={t("import.message")}
          contentBackgroundColor={contentBackgroundColor}
          onDismiss={() => settleOverlayDismissal("import-file")}
          actions={[
            {
              label: t("import.cancel"),
              onPress: () => closeOverlay("import-file"),
              role: "cancel",
            },
            {
              label: t("import.chooseFile"),
              onPress: () => void confirmImport(),
            },
          ]}
        />

        <Dialog
          visible={overlayVisible && statusOverlay != null}
          title={statusOverlay?.title ?? ""}
          message={statusOverlay?.message}
          contentBackgroundColor={contentBackgroundColor}
          onDismiss={() => settleOverlayDismissal("status")}
          actions={[
            {
              label: statusOverlay?.dismissLabel ?? t("common.ok"),
              onPress: () => closeOverlay("status"),
              role: "cancel",
            },
            ...(statusOverlay?.onRetry
              ? [
                  {
                    label: statusOverlay.retryLabel,
                    onPress: () => runStatusRetry(statusOverlay),
                  },
                ]
              : []),
          ]}
        />

        <Dialog
          visible={overlayVisible && importPreviewOverlay != null}
          title={t("import.previewTitle")}
          message={
            importPreviewOverlay
              ? `${t("import.previewMessage", {
                  habits: importPreviewOverlay.preview.habitsCount,
                  archived: importPreviewOverlay.preview.archivedHabitsCount,
                  records: importPreviewOverlay.preview.dayRecordsCount,
                  notes: importPreviewOverlay.preview.notesCount,
                })}${pendingImportError ? `\n\n${pendingImportError}` : ""}`
              : undefined
          }
          contentBackgroundColor={contentBackgroundColor}
          onDismiss={() => settleOverlayDismissal("import-preview")}
          actions={[
            {
              label: t("import.cancel"),
              onPress: () => {
                setPendingImportError(null);
                closeOverlay("import-preview");
              },
              role: "cancel",
              disabled:
                isImporting ||
                pendingImportPublicationRecoveryRef.current != null,
            },
            {
              label: isImporting
                ? t("import.importing")
                : t("import.replaceData"),
              onPress: () => void applyImport(),
              variant: "destructive",
              disabled: isImporting,
            },
          ]}
        />
      </>
    );
  }),
);
