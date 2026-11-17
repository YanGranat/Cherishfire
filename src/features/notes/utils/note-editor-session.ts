export interface NoteEditorDraft {
  readonly clientMutationId: string;
  readonly noteId: number;
  readonly text: string;
  /** Editing ancestry seed for recovery merges without duplicated input. */
  readonly baseText: string;
  /** Latest displayed note text for dirty comparison; it may be optimistic. */
  readonly sourceText: string;
  readonly recoverySequence: number;
  readonly viewportHeight: number;
}

export interface NoteEditorRowOwner {
  live: boolean;
}

/** The logical editor outlives its virtualized native row, but not its route. */
export class NoteEditorSession {
  private draft: NoteEditorDraft | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(readonly generation = 0) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly hasUnsavedChanges = (): boolean =>
    this.draft != null && this.draft.text.trim() !== this.draft.sourceText.trim();

  private notifyIfChanged(previous: boolean): void {
    if (previous === this.hasUnsavedChanges()) return;
    for (const listener of this.listeners) listener();
  }

  getActiveDraft(): NoteEditorDraft | null {
    return this.draft;
  }

  getDraft(clientMutationId: string): NoteEditorDraft | null {
    return this.draft?.clientMutationId === clientMutationId ? this.draft : null;
  }

  begin(draft: NoteEditorDraft): void {
    const previous = this.hasUnsavedChanges();
    this.draft = draft;
    this.notifyIfChanged(previous);
  }

  update(
    clientMutationId: string,
    patch: Partial<Omit<NoteEditorDraft, "clientMutationId" | "noteId">>,
  ): void {
    if (this.draft?.clientMutationId !== clientMutationId) return;
    const previous = this.hasUnsavedChanges();
    this.draft = { ...this.draft, ...patch };
    this.notifyIfChanged(previous);
  }

  finish(clientMutationId: string): void {
    if (this.draft?.clientMutationId !== clientMutationId) return;
    const previous = this.hasUnsavedChanges();
    this.draft = null;
    this.notifyIfChanged(previous);
  }

  reconcile(notes: readonly { clientMutationId: string }[]): void {
    const active = this.draft;
    if (active && !notes.some((note) => note.clientMutationId === active.clientMutationId)) {
      this.finish(active.clientMutationId);
    }
  }
}
