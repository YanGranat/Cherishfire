/** @jsxImportSource nativewind */
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useNavigationIntentGate } from "@/hooks/useNavigationIntentGate";
import {
  ActivityIndicator,
  Pressable,
  View,
  Text,
  FlatList,
} from "react-native";
import type { ListRenderItem } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Header } from "@/components/layout/Header";
import { InlineErrorBanner } from "@/components/ui/InlineErrorBanner";
import { ScreenWrapper } from "@/components/layout/ScreenWrapper";
import { Dialog } from "@/components/ui/Dialog";
import { ArchiveCard } from "@/features/archive/components/ArchiveCard";
import { getArchivedHabitsForState, useHabitStore } from "@/stores/habit-store";
import type { Habit } from "@/types/habit";
type ArchiveDialogType = "single" | "all" | "restoreAll";
const archiveHabitKeyExtractor = (habit: Habit) => habit.id.toString();
const ARCHIVE_LIST_CONTENT_STYLE = { paddingTop: 8 };
// Archive list and single/bulk mutation confirmations share one mutation gate.
export default function ArchiveScreen() {
  const router = useRouter();
  const runNavigationIntent = useNavigationIntentGate();
  const { t } = useTranslation();
  const restoreHabits = useHabitStore((s) => s.restoreHabits);
  const deleteHabits = useHabitStore((s) => s.deleteHabits);
  const archivedHabits = useHabitStore(getArchivedHabitsForState);
  const allHabitsLoaded = useHabitStore((s) => s.allHabitsLoaded);
  const loadHabits = useHabitStore((s) => s.loadHabits);
  const [loadError, setLoadError] = useState<string | null>(null);
  // A failed load leaves the global cache unresolved. The error is nevertheless
  // terminal for this attempt and must replace the spinner so Retry is reachable.
  const isLoading = !allHabitsLoaded && loadError == null;
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingHabitId, setPendingHabitId] = useState<number | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<{
    visible: boolean;
    habitId?: number;
    type: ArchiveDialogType;
  }>({ visible: false, type: "single" });
  const [isApplyingDialogAction, setIsApplyingDialogAction] = useState(false);
  const archiveMutationBusyRef = useRef(false);
  const loadArchive = useCallback(async () => {
    setLoadError(null);
    try {
      await loadHabits();
      if (!useHabitStore.getState().allHabitsLoaded) {
        setLoadError(t("archive.loadError"));
      }
    } catch {
      setLoadError(t("archive.loadError"));
    }
  }, [loadHabits, t]);
  useEffect(() => {
    if (!allHabitsLoaded) void loadArchive();
  }, [allHabitsLoaded, loadArchive]);
  const handleRestore = useCallback(
    async (id: number) => {
      if (archiveMutationBusyRef.current) {
        return;
      }
      archiveMutationBusyRef.current = true;
      setPendingHabitId(id);
      setActionError(null);
      try {
        await restoreHabits([id]);
      } catch {
        setActionError(t("archive.actionError"));
      } finally {
        archiveMutationBusyRef.current = false;
        setPendingHabitId(null);
      }
    },
    [restoreHabits, t],
  );
  const handleDeleteRequest = useCallback((id: number) => {
    setDeleteDialog({
      visible: true,
      habitId: id,
      type: "single",
    });
  }, []);
  const handleOpenHabit = useCallback(
    (id: number) => {
      const target = `/habit/${id}`;
      const result = runNavigationIntent({
        target,
        dispatch: () => {
          router.push(target);
        },
      });
      if (result.status === "blocked") {
      } else if (result.status === "failed") {
        console.error("Failed to open archived habit", result.error);
      }
    },
    [router, runNavigationIntent],
  );
  const isArchiveInteractionBlocked = useCallback(
    () => archiveMutationBusyRef.current,
    [],
  );
  const archiveListDisabled = pendingHabitId != null || isApplyingDialogAction;
  const renderArchiveHabit = useCallback<ListRenderItem<Habit>>(
    ({ item }) => (
      <ArchiveCard
        habit={item}
        onDelete={handleDeleteRequest}
        onRestore={handleRestore}
        onPress={handleOpenHabit}
        isInteractionBlocked={isArchiveInteractionBlocked}
      />
    ),
    [
      handleDeleteRequest,
      handleOpenHabit,
      handleRestore,
      isArchiveInteractionBlocked,
    ],
  );
  const handleDelete = async (id: number) => {
    await deleteHabits([id]);
  };
  const handleRestoreAll = async () => {
    await restoreHabits(archivedHabits.map((habit) => habit.id));
  };
  const handleDeleteAll = async () => {
    await deleteHabits(archivedHabits.map((habit) => habit.id));
  };
  const confirmAction = async () => {
    if (archiveMutationBusyRef.current) {
      return;
    }
    archiveMutationBusyRef.current = true;
    const currentDialog = deleteDialog;
    setIsApplyingDialogAction(true);
    setActionError(null);
    const d = currentDialog;
    setDeleteDialog({ ...currentDialog, visible: false });
    try {
      if (d.type === "single" && d.habitId != null) {
        await handleDelete(d.habitId);
      } else if (d.type === "all") {
        await handleDeleteAll();
      } else if (d.type === "restoreAll") {
        await handleRestoreAll();
      }
    } catch {
      setActionError(t("archive.actionError"));
    } finally {
      archiveMutationBusyRef.current = false;
      setIsApplyingDialogAction(false);
    }
  };
  // Bulk actions are available only for a nonempty archive.
  const headerActions =
    archivedHabits.length > 0
      ? [
          {
            icon: "restore" as const,
            accessibilityLabel: t("archive.restoreAll"),
            disabled: archiveListDisabled,
            onPress: () => {
              if (archiveMutationBusyRef.current) {
                return;
              }
              setDeleteDialog({
                visible: true,
                type: "restoreAll",
              });
            },
          },
          {
            icon: "trash-sharp" as const,
            iconFamily: "ionicons" as const,
            accessibilityLabel: t("archive.deleteAll"),
            disabled: archiveListDisabled,
            onPress: () => {
              if (archiveMutationBusyRef.current) {
                return;
              }
              setDeleteDialog({ visible: true, type: "all" });
            },
          },
        ]
      : [];
  // Confirmation copy follows the retained action type while dismissing.
  const dialogTitle =
    deleteDialog.type === "all"
      ? t("archive.deleteAllTitle")
      : deleteDialog.type === "restoreAll"
        ? t("archive.restoreAllTitle")
        : t("archive.deleteTitle");
  const dialogMessage =
    deleteDialog.type === "all"
      ? t("archive.deleteAllMessage")
      : deleteDialog.type === "restoreAll"
        ? t("archive.restoreAllMessage")
        : t("archive.deleteMessage");
  const dialogConfirmLabel =
    deleteDialog.type === "all"
      ? t("archive.deleteAll")
      : deleteDialog.type === "restoreAll"
        ? t("archive.restoreAll")
        : t("archive.delete");
  return (
    <ScreenWrapper>
      <Header
        title={t("archive.title")}
        showBack
        onBack={() => {
          router.back();
        }}
        centerTitle
        rightActions={headerActions}
      />

      {actionError ? <InlineErrorBanner message={actionError} /> : null}

      {isLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#9E9E9E" />
        </View>
      ) : loadError ? (
        <View className="flex-1 items-center justify-center px-xl">
          <Text className="text-muted text-base text-center mb-md">
            {loadError}
          </Text>
          <Pressable
            onPress={() => {
              void loadArchive();
            }}
            accessibilityRole="button"
            accessibilityLabel={t("archive.retry")}
            className="px-md py-sm"
          >
            <Text className="text-primary text-base">{t("archive.retry")}</Text>
          </Pressable>
        </View>
      ) : archivedHabits.length === 0 ? (
        <View className="flex-1 items-center justify-center">
          <MaterialIcons
            name="archive"
            size={64}
            color="#9E9E9E"
            style={{ opacity: 0.4 }}
          />
          <Text className="text-muted text-base mt-base">
            {t("archive.emptyTitle")}
          </Text>
        </View>
      ) : (
        <FlatList
          data={archivedHabits}
          keyExtractor={archiveHabitKeyExtractor}
          renderItem={renderArchiveHabit}
          pointerEvents={archiveListDisabled ? "box-only" : "auto"}
          accessibilityElementsHidden={archiveListDisabled}
          importantForAccessibility={
            archiveListDisabled ? "no-hide-descendants" : "auto"
          }
          contentContainerStyle={ARCHIVE_LIST_CONTENT_STYLE}
        />
      )}

      <Dialog
        visible={deleteDialog.visible}
        title={dialogTitle}
        message={dialogMessage}
        actions={[
          {
            label: t("archive.cancel"),
            onPress: () => {
              setDeleteDialog((currentDialog) => ({
                ...currentDialog,
                visible: false,
              }));
            },
            role: "cancel",
            disabled: isApplyingDialogAction,
          },
          {
            label: dialogConfirmLabel,
            onPress: () => {
              void confirmAction();
            },
            variant:
              deleteDialog.type === "restoreAll" ? "default" : "destructive",
            disabled: isApplyingDialogAction,
          },
        ]}
      />
    </ScreenWrapper>
  );
}
