import type { StatisticsPeriod } from "@/types/settings";

export const MAX_STATISTICS_CACHE_ENTRIES = 12;

export function getStatisticsCacheKey(
  period: StatisticsPeriod,
  periodOffset: number,
): string {
  return `${period}:${periodOffset}`;
}

export function getOrCreateStatisticsCacheValue<T>(
  cache: Map<string, T>,
  period: StatisticsPeriod,
  periodOffset: number,
  create: () => T,
): { value: T; cacheHit: boolean } {
  const key = getStatisticsCacheKey(period, periodOffset);
  if (cache.has(key)) {
    const value = cache.get(key)!;
    // Reinserting the hit makes this a real LRU instead of insertion-order
    // FIFO, so frequently visited current periods survive older cold entries.
    cache.delete(key);
    cache.set(key, value);
    return { value, cacheHit: true };
  }

  const value = create();
  if (cache.size >= MAX_STATISTICS_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey != null) cache.delete(oldestKey);
  }
  cache.set(key, value);
  return { value, cacheHit: false };
}
