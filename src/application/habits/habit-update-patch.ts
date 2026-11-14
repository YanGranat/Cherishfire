import type { HabitPatch } from "@/application/habits/habit-persistence";
import type { UpdateHabitInput } from "@/types/habit";

export type HabitEditableMutationScope =
  | "description"
  | "description-visible"
  | "reminder-enabled"
  | "reminder-time"
  | "metadata";

const EDITABLE_PATCH_FIELDS = [
  ["description", "description"],
  ["descriptionVisible", "description-visible"],
  ["reminderEnabled", "reminder-enabled"],
  ["reminderTime", "reminder-time"],
  ["updatedAt", "metadata"],
] as const satisfies readonly (readonly [
  keyof HabitPatch,
  HabitEditableMutationScope,
])[];

/**
 * Select only the row fields still owned by one optimistic habit mutation.
 * Commit opportunities may resolve out of order, so persisting the original
 * whole patch would let an older command overwrite a newer durable value even
 * though the visible store correctly kept the newer value.
 */
export function selectPersistableHabitUpdatePatch(
  patch: HabitPatch,
  canPersist: (scope: HabitEditableMutationScope) => boolean,
): HabitPatch | null {
  const selected: HabitPatch = {};

  for (const [field, scope] of EDITABLE_PATCH_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    if (!canPersist(scope)) continue;
    Object.assign(selected, { [field]: patch[field] });
  }

  return Object.keys(selected).length > 0 ? selected : null;
}

export interface PartitionedHabitUpdateInput {
  schedule: Partial<UpdateHabitInput>;
  editable: Partial<UpdateHabitInput>;
}

/**
 * A schedule edit is a destructive transaction: it may remove day records and
 * their reason notes. Keep that transaction under its own ownership token even
 * if a future caller submits schedule and ordinary row fields together.
 */
export function partitionMixedHabitUpdateInput(
  input: Partial<UpdateHabitInput>,
): PartitionedHabitUpdateInput | null {
  const hasSchedule =
    input.repeatSchedule !== undefined || input.startDate !== undefined;
  const hasEditable =
    input.description !== undefined ||
    input.descriptionVisible !== undefined ||
    input.reminderEnabled !== undefined ||
    input.reminderTime !== undefined;
  if (!hasSchedule || !hasEditable) return null;

  return {
    schedule: {
      ...(input.repeatSchedule !== undefined
        ? { repeatSchedule: input.repeatSchedule }
        : null),
      ...(input.startDate !== undefined ? { startDate: input.startDate } : null),
    },
    editable: {
      ...(input.description !== undefined
        ? { description: input.description }
        : null),
      ...(input.descriptionVisible !== undefined
        ? { descriptionVisible: input.descriptionVisible }
        : null),
      ...(input.reminderEnabled !== undefined
        ? { reminderEnabled: input.reminderEnabled }
        : null),
      ...(input.reminderTime !== undefined
        ? { reminderTime: input.reminderTime }
        : null),
    },
  };
}
