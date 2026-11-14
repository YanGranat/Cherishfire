export function moveStatisticsBlockCode(
  order: number[],
  fromIndex: number,
  toIndex: number
): number[] {
  "worklet";
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= order.length ||
    toIndex >= order.length
  ) {
    return order.slice();
  }
  const next = order.slice();
  const removed = next.splice(fromIndex, 1)[0];
  next.splice(toIndex, 0, removed);
  return next;
}

export function shouldSettleStatisticsAtTop(
  offset: number,
  dragCode: number,
  scrollDragActive: number,
  scrollMomentumActive: number,
  threshold: number
): boolean {
  "worklet";
  return (
    offset <= threshold &&
    dragCode < 0 &&
    scrollDragActive === 0 &&
    scrollMomentumActive === 0
  );
}

export function getStatisticsBlockTop(
  order: number[],
  heights: number[],
  code: number
): number {
  "worklet";
  let top = 0;
  for (let index = 0; index < order.length; index += 1) {
    const itemCode = order[index];
    if (itemCode === code) return top;
    top += heights[itemCode] ?? 0;
  }
  return top;
}

export function getStatisticsBlocksHeight(
  order: number[],
  heights: number[]
): number {
  "worklet";
  let height = 0;
  for (const code of order) height += heights[code] ?? 0;
  return height;
}

export function getStatisticsDraggedTop(
  startTop: number,
  gestureTranslationY: number,
  currentScrollOffset: number,
  startScrollOffset: number,
  maxTop: number
): number {
  "worklet";
  const effectiveTranslation =
    gestureTranslationY + currentScrollOffset - startScrollOffset;
  return Math.max(0, Math.min(maxTop, startTop + effectiveTranslation));
}

export function getStatisticsViewportDragTop(
  contentTop: number,
  scrollOffset: number
): number {
  "worklet";
  return contentTop - scrollOffset;
}

export function getStatisticsDragTargetIndex(
  order: number[],
  heights: number[],
  activeCode: number,
  liveTop: number,
  currentTargetIndex: number,
  hysteresis = 8
): number {
  "worklet";
  const activeHeight = heights[activeCode] ?? 0;
  const liveCenter = liveTop + activeHeight / 2;
  const fromIndex = order.indexOf(activeCode);
  if (fromIndex < 0) return currentTargetIndex;

  let bestIndex = Math.max(0, Math.min(order.length - 1, currentTargetIndex));
  const currentOrder = moveStatisticsBlockCode(order, fromIndex, bestIndex);
  const currentTop = getStatisticsBlockTop(currentOrder, heights, activeCode);
  let bestDistance = Math.abs(liveCenter - (currentTop + activeHeight / 2));

  for (
    let candidateIndex = 0;
    candidateIndex < order.length;
    candidateIndex += 1
  ) {
    if (candidateIndex === bestIndex) continue;
    const candidateOrder = moveStatisticsBlockCode(
      order,
      fromIndex,
      candidateIndex
    );
    const candidateTop = getStatisticsBlockTop(
      candidateOrder,
      heights,
      activeCode
    );
    const candidateDistance = Math.abs(
      liveCenter - (candidateTop + activeHeight / 2)
    );
    if (candidateDistance + Math.max(0, hysteresis) < bestDistance) {
      bestIndex = candidateIndex;
      bestDistance = candidateDistance;
    }
  }
  return bestIndex;
}

export function getStatisticsEdgeScrollVelocity(
  pointerY: number,
  viewportTop: number,
  viewportHeight: number,
  edgeZone = 56,
  maxVelocity = 0.8
): number {
  "worklet";
  if (viewportHeight <= 0 || edgeZone <= 0 || maxVelocity <= 0) {
    return 0;
  }
  const relativeY = pointerY - viewportTop;
  if (relativeY < edgeZone) {
    const proximity = Math.max(
      0,
      Math.min(1, (edgeZone - relativeY) / edgeZone)
    );
    return -maxVelocity * proximity;
  }
  if (relativeY > viewportHeight - edgeZone) {
    const proximity = Math.max(
      0,
      Math.min(1, (relativeY - (viewportHeight - edgeZone)) / edgeZone)
    );
    return maxVelocity * proximity;
  }
  return 0;
}

export function getStatisticsAutoScrollOffset(
  currentOffset: number,
  contentHeight: number,
  viewportHeight: number,
  velocity: number,
  elapsedMs: number
): number {
  "worklet";
  const maxOffset = Math.max(0, contentHeight - viewportHeight);
  return Math.max(
    0,
    Math.min(maxOffset, currentOffset + velocity * Math.max(0, elapsedMs))
  );
}
