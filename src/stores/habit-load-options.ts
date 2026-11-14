export interface HabitLoadOptions {
  /** Only the committed-import publisher may bypass pending old-generation writes. */
  readonly mode?: "committed-import";
  /** Keep false only when the caller owns the resulting error presentation. */
  readonly publishError?: boolean;
}

export function shouldPublishHabitLoadError(
  options?: HabitLoadOptions,
): boolean {
  return options?.publishError !== false;
}
