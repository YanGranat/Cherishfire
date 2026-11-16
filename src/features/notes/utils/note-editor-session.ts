export interface NoteEditorDraft {
  readonly clientMutationId: string;
  readonly noteId: number;
  readonly text: string;
  readonly baseText: string;
  readonly recoverySequence: number;
  readonly viewportHeight: number;
}

export interface NoteEditorRowOwner {
  live: boolean;
}

/** The logical editor outlives its virtualized native row, but not its route. */
export class NoteEditorSession {
  private draft: NoteEditorDraft | null = null;

  constructor(readonly generation = 0) {}

  getActiveDraft(): NoteEditorDraft | null {
    return this.draft;
  }

  getDraft(clientMutationId: string): NoteEditorDraft | null {
    return this.draft?.clientMutationId === clientMutationId ? this.draft : null;
  }

  begin(draft: NoteEditorDraft): void {
    this.draft = draft;
  }

  update(
    clientMutationId: string,
    patch: Partial<Omit<NoteEditorDraft, "clientMutationId" | "noteId">>,
  ): void {
    if (this.draft?.clientMutationId !== clientMutationId) return;
    this.draft = { ...this.draft, ...patch };
  }

  finish(clientMutationId: string): void {
    if (this.draft?.clientMutationId === clientMutationId) this.draft = null;
  }

  reconcile(notes: readonly { clientMutationId: string }[]): void {
    const active = this.draft;
    if (active && !notes.some((note) => note.clientMutationId === active.clientMutationId)) {
      this.draft = null;
    }
  }
}
