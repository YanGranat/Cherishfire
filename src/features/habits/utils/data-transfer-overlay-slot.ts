export interface DataTransferOverlayRequest {
  readonly kind: string;
}
export type DataTransferOverlaySlot<T extends DataTransferOverlayRequest> =
  | {
      readonly phase: "idle";
      readonly current: null;
      readonly queue: readonly T[];
    }
  | {
      readonly phase: "visible" | "closing";
      readonly current: T;
      readonly queue: readonly T[];
    };
export function createEmptyDataTransferOverlaySlot<
  T extends DataTransferOverlayRequest,
>(): DataTransferOverlaySlot<T> {
  return { phase: "idle", current: null, queue: [] };
}
/**
 * Adds work without replacing a dialog that is visible or still fading out.
 * This guarantees deterministic FIFO delivery for status/error messages.
 */
export function enqueueDataTransferOverlay<
  T extends DataTransferOverlayRequest,
>(state: DataTransferOverlaySlot<T>, request: T): DataTransferOverlaySlot<T> {
  if (state.phase === "idle") {
    return { phase: "visible", current: request, queue: [] };
  }
  return { ...state, queue: [...state.queue, request] };
}
/** Retains the current payload until AppModal reports the real dismissal. */
export function closeDataTransferOverlay<T extends DataTransferOverlayRequest>(
  state: DataTransferOverlaySlot<T>,
  expectedKind: T["kind"],
): DataTransferOverlaySlot<T> {
  if (state.phase !== "visible" || state.current.kind !== expectedKind) {
    return state;
  }
  return { ...state, phase: "closing" };
}
/** Opens the next request only after the previous native/portal dismissal. */
export function settleDataTransferOverlayDismissal<
  T extends DataTransferOverlayRequest,
>(
  state: DataTransferOverlaySlot<T>,
  expectedKind: T["kind"],
): DataTransferOverlaySlot<T> {
  if (state.phase !== "closing" || state.current.kind !== expectedKind) {
    return state;
  }
  const [next, ...remaining] = state.queue;
  return next
    ? { phase: "visible", current: next, queue: remaining }
    : createEmptyDataTransferOverlaySlot<T>();
}
export interface SynchronousActionFence {
  tryAcquire(): number | null;
  release(token: number): void;
  getOwner(): number | null;
}
/**
 * A same-turn admission fence. Each accepted flow receives a product-owned
 * token; duplicate taps and stale completions cannot replace or release it.
 */
export function createSynchronousActionFence(): SynchronousActionFence {
  let owner: number | null = null;
  let nextToken = 0;
  return {
    tryAcquire() {
      if (owner != null) return null;
      owner = ++nextToken;
      return owner;
    },
    release(token) {
      if (owner === token) owner = null;
    },
    getOwner() {
      return owner;
    },
  };
}
