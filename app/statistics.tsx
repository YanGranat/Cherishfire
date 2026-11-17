/** @jsxImportSource nativewind */
import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Header } from "@/components/layout/Header";
import { ScreenWrapper } from "@/components/layout/ScreenWrapper";
import { BarChart } from "@/features/statistics/components/BarChart";
import { HabitBreakdown } from "@/features/statistics/components/HabitBreakdown";
import { Heatmap } from "@/features/statistics/components/Heatmap";
import { PeriodSelector } from "@/features/statistics/components/PeriodSelector";
import { ReorderableStatisticsBlocks } from "@/features/statistics/components/ReorderableStatisticsBlocks";
import { SummaryCards } from "@/features/statistics/components/SummaryCards";
import { useStatistics } from "@/features/statistics/hooks/useStatistics";
import { useSettingsStore } from "@/stores/settings-store";
import {
  useVisualLanguage,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
import { SettingsErrorBanner } from "@/features/settings/components/SettingsErrorBanner";
import { darkTheme, lightTheme } from "@/theme/colors";
import {
  DEFAULT_STATISTICS_BLOCK_ORDER,
  type StatisticsBlockId,
} from "@/types/settings";
import { normalizeStatisticsBlockOrder } from "@/utils/statistics-block-orders";
import { getAdjacentReorder, type ReorderDirection } from "@/utils/accessibility-reorder";
import { getMonthLabels, getWeekdayLabels, getWeekLabels } from "@/utils/date";
import type { StatisticsPeriodStats } from "@/application/statistics/statistics-session";
type StatsBlockId = StatisticsBlockId;
type Period = "week" | "month" | "year";
function StatisticsEmptyState({
  emptyReason,
  emptyCardBg,
  emptyCardBorder,
  emptyTitleColor,
  emptyMutedColor,
}: {
  emptyReason: StatisticsPeriodStats["emptyReason"];
  emptyCardBg: string;
  emptyCardBorder: string;
  emptyTitleColor: string;
  emptyMutedColor: string;
}) {
  const { t } = useTranslation();
  return (
    <View className="mx-[14px] mt-[10px]">
      <View
        className="items-center rounded-section-card border px-xl py-3xl"
        style={{
          backgroundColor: emptyCardBg,
          borderColor: emptyCardBorder,
          borderWidth: 0.5,
        }}
      >
        <MaterialIcons
          name="show-chart"
          size={60}
          color={emptyMutedColor}
          style={{ opacity: 0.45 }}
        />
        <Text className="mt-base text-base" style={{ color: emptyTitleColor }}>
          {t("statistics.emptyTitle")}
        </Text>
        <Text
          className="mt-xs text-center text-sm"
          style={{ color: emptyMutedColor }}
        >
          {t(
            emptyReason === "no-scheduled"
              ? "statistics.emptyPeriodMessage"
              : "statistics.emptyMessage",
          )}
        </Text>
      </View>
    </View>
  );
}
interface StatisticsPeriodSceneProps {
  period: Period;
  todayStr: string;
  stats: StatisticsPeriodStats;
  persistedBlockOrder: StatisticsBlockId[];
  language: string;
  handleColor: string;
  emptyCardBg: string;
  emptyCardBorder: string;
  emptyTitleColor: string;
  emptyMutedColor: string;
  sceneKey: string;
  active: boolean;
  onReorderPeriod: (
    period: Period,
    blockOrder: StatisticsBlockId[],
    nextVisibleOrder: StatisticsBlockId[],
  ) => void;
}
function StatisticsPeriodSceneView({
  period,
  todayStr,
  stats,
  persistedBlockOrder,
  language,
  handleColor,
  emptyCardBg,
  emptyCardBorder,
  emptyTitleColor,
  emptyMutedColor,
  sceneKey,
  active,
  onReorderPeriod,
}: StatisticsPeriodSceneProps) {
  const blockOrder = React.useMemo(
    () =>
      normalizeStatisticsBlockOrder(
        persistedBlockOrder,
        DEFAULT_STATISTICS_BLOCK_ORDER,
      ),
    [persistedBlockOrder],
  );
  const labels = React.useMemo(
    () =>
      period === "week"
        ? getWeekdayLabels(language)
        : period === "month"
          ? getWeekLabels(language)
          : getMonthLabels(language),
    [language, period],
  );
  const visibleOrder = React.useMemo(() => {
    const visible = new Set<StatsBlockId>(["summary", "habit"]);
    if (stats.heatmapData.length > 0) visible.add("heatmap");
    if (period === "week") visible.add("bar");
    return blockOrder.filter((id) => visible.has(id));
  }, [blockOrder, period, stats.heatmapData.length]);
  const content = React.useMemo<Record<StatsBlockId, React.ReactNode>>(
    () => ({
      summary: (
        <SummaryCards
          periodProgress={stats.periodProgress}
          perfectDays={stats.perfectDays}
        />
      ),
      heatmap: (
        <Heatmap data={stats.heatmapData} period={period} todayStr={todayStr} />
      ),
      bar: (
        <BarChart data={stats.barChartData} labels={labels} period={period} />
      ),
      habit: <HabitBreakdown habits={stats.habitBreakdown} />,
    }),
    [labels, period, stats, todayStr],
  );
  const handleReorder = React.useCallback(
    (nextVisibleOrder: StatsBlockId[]) =>
      onReorderPeriod(period, blockOrder, nextVisibleOrder),
    [blockOrder, onReorderPeriod, period],
  );
  const handleMoveBlock = React.useCallback(
    (id: StatsBlockId, direction: ReorderDirection) => {
      const currentOrder = normalizeStatisticsBlockOrder(
        useSettingsStore.getState().statisticsBlockOrders[period],
        DEFAULT_STATISTICS_BLOCK_ORDER,
      );
      const visible = new Set(visibleOrder);
      const nextVisibleOrder = getAdjacentReorder(
        currentOrder.filter((blockId) => visible.has(blockId)), id, direction,
      );
      if (nextVisibleOrder) onReorderPeriod(period, currentOrder, nextVisibleOrder);
    },
    [onReorderPeriod, period, visibleOrder],
  );
  if (stats.isEmpty) {
    return (
      <View style={{ flex: 1 }}>
        <StatisticsEmptyState
          emptyReason={stats.emptyReason}
          emptyCardBg={emptyCardBg}
          emptyCardBorder={emptyCardBorder}
          emptyTitleColor={emptyTitleColor}
          emptyMutedColor={emptyMutedColor}
        />
      </View>
    );
  }
  return (
    <ReorderableStatisticsBlocks
      visibleOrder={visibleOrder}
      content={content}
      geometryRevision={`${sceneKey}:${language}`}
      handleColor={handleColor}
      active={active}
      onReorder={handleReorder}
      onMoveBlock={handleMoveBlock}
    />
  );
}
const StatisticsPeriodScene = React.memo(StatisticsPeriodSceneView);
export default function StatisticsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const language = useVisualLanguage();
  const setPersistedBlockOrder = useSettingsStore(
    (state) => state.setStatisticsBlockOrder,
  );
  const effectiveMode = useVisualEffectiveMode();
  const isDark = effectiveMode === "dark";
  const emptyCardBg = isDark ? "#262626" : lightTheme.surfaceElevated;
  const emptyCardBorder = isDark ? "#5F5F5F" : lightTheme.border;
  const emptyTitleColor = isDark ? darkTheme.primary : lightTheme.primary;
  const emptyMutedColor = isDark ? darkTheme.muted : lightTheme.muted;
  const dragHandleColor = isDark ? "#9B9B9B" : "#8A8A8A";
  const {
    period,
    setPeriod,
    periodRange,
    canNavigatePrevious,
    canNavigateNext,
    resolveNavigationTarget,
    navigatePeriod,
    retainedScene,
    sceneActive,
    isLoading,
    error,
    reload,
  } = useStatistics();
  const statisticsBlockOrders = useSettingsStore(
    (state) => state.statisticsBlockOrders,
  );
  const retainedSceneBlockOrder =
    retainedScene == null
      ? DEFAULT_STATISTICS_BLOCK_ORDER
      : statisticsBlockOrders[retainedScene.period];
  const handlePeriodReorder = React.useCallback(
    (
      reorderedPeriod: Period,
      baseBlockOrder: StatsBlockId[],
      nextVisibleOrder: StatsBlockId[],
    ) => {
      const visible = new Set(nextVisibleOrder);
      let cursor = 0;
      const nextFullOrder = baseBlockOrder.map((id) =>
        visible.has(id) ? nextVisibleOrder[cursor++] : id,
      );
      void setPersistedBlockOrder(reorderedPeriod, nextFullOrder);
    },
    [setPersistedBlockOrder],
  );
  const currentPeriodSelector = (
    <PeriodSelector
      period={period}
      periodRange={periodRange}
      canNavigatePrevious={canNavigatePrevious}
      canNavigateNext={canNavigateNext}
      onPeriodChange={setPeriod}
      resolveNavigationTarget={resolveNavigationTarget}
      onNavigate={navigatePeriod}
    />
  );
  return (
    <ScreenWrapper>
      <Header
        title={t("statistics.title")}
        showBack
        onBack={() => {
          router.back();
        }}
        centerTitle
      />
      <SettingsErrorBanner />

      <View style={styles.presentationRoot}>
        {currentPeriodSelector}
        <View style={styles.presentationBody}>
          {retainedScene != null ? (
            <View
              pointerEvents={sceneActive ? "auto" : "none"}
              accessibilityElementsHidden={!sceneActive}
              importantForAccessibility={
                sceneActive ? "auto" : "no-hide-descendants"
              }
              style={styles.retainedScene}
            >
              <StatisticsPeriodScene
                period={retainedScene.period}
                todayStr={retainedScene.todayStr}
                stats={retainedScene.stats}
                persistedBlockOrder={retainedSceneBlockOrder}
                language={language}
                handleColor={dragHandleColor}
                emptyCardBg={emptyCardBg}
                emptyCardBorder={emptyCardBorder}
                emptyTitleColor={emptyTitleColor}
                emptyMutedColor={emptyMutedColor}
                sceneKey={String(retainedScene.presentationRevision)}
                active={sceneActive}
                onReorderPeriod={handlePeriodReorder}
              />
            </View>
          ) : null}

          {isLoading ? (
            <View
              className="items-center justify-center bg-background py-3xl"
              style={styles.presentationCover}
            >
              <ActivityIndicator size="small" color={emptyMutedColor} />
            </View>
          ) : error ? (
            <View className="bg-background" style={styles.presentationCover}>
              <View className="mx-[14px] mt-[10px]">
                <View
                  className="items-center rounded-section-card border px-xl py-3xl"
                  style={{
                    backgroundColor: emptyCardBg,
                    borderColor: emptyCardBorder,
                    borderWidth: 0.5,
                  }}
                >
                  <MaterialIcons
                    name="error-outline"
                    size={52}
                    color={emptyMutedColor}
                    style={{ opacity: 0.55 }}
                  />
                  <Text
                    className="mt-base text-center text-base"
                    style={{ color: emptyTitleColor }}
                  >
                    {t("statistics.loadError")}
                  </Text>
                  <Pressable
                    onPress={() => {
                      void reload();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={t("statistics.retry")}
                    className="mt-md min-h-[44px] items-center justify-center px-lg"
                  >
                    <Text
                      className="text-base font-semibold"
                      style={{ color: emptyTitleColor }}
                    >
                      {t("statistics.retry")}
                    </Text>
                  </Pressable>
                </View>
              </View>
            </View>
          ) : null}
        </View>
      </View>
    </ScreenWrapper>
  );
}
const styles = StyleSheet.create({
  presentationRoot: {
    flex: 1,
  },
  presentationBody: {
    flex: 1,
    overflow: "hidden",
  },
  retainedScene: {
    flex: 1,
  },
  presentationCover: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 2,
  },
});
