export type DatePickerSelectionIntentOutcome =
  | "pending"
  | "stable"
  | "unchanged";

export interface DatePickerSelectionIntentResolution {
  draftChanged: boolean;
  publishSelection: boolean;
  outcome: DatePickerSelectionIntentOutcome;
}

/**
 * Resolves a day tap against both the latest draft and the last committed UI.
 * Keeping those values separate prevents a rapid A -> B -> A sequence from
 * leaving an action open when React correctly skips the net-zero render.
 */
export function resolveDatePickerSelectionIntent(
  pickedDate: string,
  renderedPickedDate: string,
  nextDate: string,
): DatePickerSelectionIntentResolution {
  const draftChanged = pickedDate !== nextDate;

  if (nextDate === renderedPickedDate) {
    return {
      draftChanged,
      publishSelection: draftChanged,
      outcome: draftChanged ? "stable" : "unchanged",
    };
  }

  return {
    draftChanged,
    // A repeated tap on a not-yet-rendered draft must keep the latest action
    // attached to the already scheduled selection-state publication.
    publishSelection: true,
    outcome: "pending",
  };
}
