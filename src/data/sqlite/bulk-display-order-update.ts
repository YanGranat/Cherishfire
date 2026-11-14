import type { AsyncDatabaseExecutor } from "@/db/runtime";
import { assertValidDisplayOrder, type DisplayOrderRow } from "@/domain/habits/display-order";

// Three bind values are used per row (CASE id/value plus WHERE id). Keeping
// each statement below the conservative 999-variable SQLite limit makes the
// bulk path safe on older Android SQLite builds as well as current Expo.
export const HABIT_DISPLAY_ORDER_UPDATE_CHUNK_SIZE = 250;

export async function patchHabitDisplayOrders(
  executor: AsyncDatabaseExecutor,
  assignments: readonly DisplayOrderRow[],
): Promise<void> {
  for (const assignment of assignments) {
    if (!Number.isSafeInteger(assignment.id) || assignment.id <= 0) {
      throw new RangeError("Invalid habit identity for display order update");
    }
    assertValidDisplayOrder(assignment.displayOrder);
  }
  for (
    let offset = 0;
    offset < assignments.length;
    offset += HABIT_DISPLAY_ORDER_UPDATE_CHUNK_SIZE
  ) {
    const chunk = assignments.slice(
      offset,
      offset + HABIT_DISPLAY_ORDER_UPDATE_CHUNK_SIZE,
    );
    const cases = chunk.map(() => "WHEN ? THEN ?").join(" ");
    const ids = chunk.map(() => "?").join(", ");
    const caseValues = chunk.flatMap(({ id, displayOrder }) => [
      id,
      displayOrder,
    ]);

    await executor.run(
      `UPDATE habits
       SET display_order = CASE id ${cases} ELSE display_order END
       WHERE id IN (${ids})`,
      [...caseValues, ...chunk.map(({ id }) => id)],
    );
  }
}
