export type ReorderDirection = "up" | "down";

export function getReorderDirection(
  actionName: string,
  labels?: { up: string; down: string },
): ReorderDirection | null {
  if (actionName === "decrement" || actionName === "moveUp" ||
    actionName === labels?.up) return "up";
  if (actionName === "increment" || actionName === "moveDown" ||
    actionName === labels?.down) return "down";
  return null;
}

export function getAdjacentReorder<T>(
  order: readonly T[],
  id: T,
  direction: ReorderDirection,
): T[] | null {
  const from = order.indexOf(id);
  if (from < 0 || order.lastIndexOf(id) !== from) return null;
  const to = from + (direction === "up" ? -1 : 1);
  if (to < 0 || to >= order.length) return null;
  const next = order.slice();
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function getReorderActions(
  index: number,
  count: number,
  labels: { up: string; down: string },
  adjustable = true,
  platform?: string,
): { name: string; label: string }[] {
  if (!Number.isInteger(index) || !Number.isInteger(count) ||
    index < 0 || index >= count) return [];
  const names = platform === "ios" ? labels : {
    up: adjustable ? "decrement" : "moveUp",
    down: adjustable ? "increment" : "moveDown",
  };
  return [
    ...(index > 0
      ? [{ name: names.up, label: labels.up }]
      : []),
    ...(index < count - 1
      ? [{ name: names.down, label: labels.down }]
      : []),
  ];
}
