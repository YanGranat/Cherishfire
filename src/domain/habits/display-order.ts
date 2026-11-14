export interface DisplayOrderRow {
  id: number;
  displayOrder: number;
}

export interface DisplayOrderAssignments {
  active: DisplayOrderRow[];
  archived: DisplayOrderRow[];
}

function normalizedSlot(value: number): number {
  const slot = Number.isInteger(value) && value >= 0 ? value : 0;
  assertValidDisplayOrder(slot);
  return slot;
}

export function assertValidDisplayOrder(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Habit display order exceeds the supported integer range");
  }
}

/**
 * Preserve archived positions while assigning a collision-free order to the
 * active list. This is a domain rule, not drag geometry: presentation only
 * supplies the final active-id intent.
 */
export function assignDisplayOrdersAroundArchivedSlots(
  orderedActiveIds: readonly number[],
  archivedRows: readonly DisplayOrderRow[],
): DisplayOrderAssignments {
  const occupied = new Set<number>();
  const archived = [...archivedRows]
    .sort((a, b) => a.displayOrder - b.displayOrder || a.id - b.id)
    .map((row) => {
      let displayOrder = normalizedSlot(row.displayOrder);
      while (occupied.has(displayOrder)) {
        assertValidDisplayOrder(displayOrder + 1);
        displayOrder += 1;
      }
      occupied.add(displayOrder);
      return { id: row.id, displayOrder };
    });

  let nextSlot = 0;
  const active = orderedActiveIds.map((id) => {
    while (occupied.has(nextSlot)) nextSlot += 1;
    assertValidDisplayOrder(nextSlot);
    const assignment = { id, displayOrder: nextSlot };
    nextSlot += 1;
    return assignment;
  });

  return { active, archived };
}

/**
 * Applies authoritative display-order metadata without replacing rows whose
 * value did not change. Returning the original array for an equal projection
 * lets Zustand acknowledgements remain true no-ops instead of waking every
 * Home row after the optimistic order is already visible.
 */
export function reconcileDisplayOrderRows<T extends DisplayOrderRow>(
  rows: T[],
  assignments: readonly DisplayOrderRow[],
): T[] {
  if (rows.length === 0 || assignments.length === 0) return rows;

  const displayOrderById = new Map(
    assignments.map(({ id, displayOrder }) => [id, displayOrder]),
  );
  let valuesChanged = false;
  const reconciled = rows.map((row) => {
    const displayOrder = displayOrderById.get(row.id);
    if (displayOrder == null || displayOrder === row.displayOrder) return row;
    valuesChanged = true;
    return { ...row, displayOrder } as T;
  });
  const isAlreadySorted = reconciled.every(
    (row, index) =>
      index === 0 ||
      reconciled[index - 1].displayOrder < row.displayOrder ||
      (reconciled[index - 1].displayOrder === row.displayOrder &&
        reconciled[index - 1].id <= row.id),
  );

  if (!valuesChanged && isAlreadySorted) return rows;
  if (isAlreadySorted) return reconciled;
  return reconciled.sort(
    (left, right) =>
      left.displayOrder - right.displayOrder || left.id - right.id,
  );
}
