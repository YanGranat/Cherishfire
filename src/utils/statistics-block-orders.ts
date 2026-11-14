import {
  DEFAULT_STATISTICS_BLOCK_ORDER,
  type StatisticsBlockId,
  type StatisticsBlockOrders,
  type StatisticsPeriod,
} from "@/types/settings";

const VALID_STATISTICS_BLOCK_IDS = new Set<StatisticsBlockId>(
  DEFAULT_STATISTICS_BLOCK_ORDER
);

export function normalizeStatisticsBlockOrder(
  value: unknown,
  fallback: readonly StatisticsBlockId[] = DEFAULT_STATISTICS_BLOCK_ORDER
): StatisticsBlockId[] {
  if (!Array.isArray(value)) return [...fallback];

  const uniqueValid: StatisticsBlockId[] = [];
  for (const item of value) {
    if (
      typeof item === "string" &&
      VALID_STATISTICS_BLOCK_IDS.has(item as StatisticsBlockId) &&
      !uniqueValid.includes(item as StatisticsBlockId)
    ) {
      uniqueValid.push(item as StatisticsBlockId);
    }
  }

  for (const id of DEFAULT_STATISTICS_BLOCK_ORDER) {
    if (!uniqueValid.includes(id)) uniqueValid.push(id);
  }

  return uniqueValid;
}

export function isCompleteStatisticsBlockOrder(
  value: unknown
): value is StatisticsBlockId[] {
  return (
    Array.isArray(value) &&
    value.length === DEFAULT_STATISTICS_BLOCK_ORDER.length &&
    new Set(value).size === DEFAULT_STATISTICS_BLOCK_ORDER.length &&
    DEFAULT_STATISTICS_BLOCK_ORDER.every((id) => value.includes(id))
  );
}

export function areStatisticsBlockOrdersEqual(
  left: readonly StatisticsBlockId[],
  right: readonly StatisticsBlockId[]
): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

export function replaceStatisticsBlockOrder(
  current: StatisticsBlockOrders,
  period: StatisticsPeriod,
  value: unknown
): StatisticsBlockOrders {
  const normalized = normalizeStatisticsBlockOrder(value);
  const previous = current[period];
  if (areStatisticsBlockOrdersEqual(previous, normalized)) {
    return current;
  }

  return {
    ...current,
    [period]: normalized,
  };
}
