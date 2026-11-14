import { useCallback, useState } from "react";

export interface RetainedModalSession<T> {
  key: number;
  snapshot: T;
}

interface RetainedModalSessionState<T> {
  observedVisible: boolean;
  nextKey: number;
  session: RetainedModalSession<T> | null;
}

/**
 * Creates a fresh draft before the first visible commit, then keeps that exact
 * draft mounted until a fading modal reports its native dismissal.
 */
export function useRetainedModalSession<T>(
  visible: boolean,
  createSnapshot: () => T,
): {
  session: RetainedModalSession<T> | null;
  handleDismiss: () => void;
} {
  const [state, setState] = useState<RetainedModalSessionState<T>>(() => ({
    observedVisible: visible,
    nextKey: visible ? 1 : 0,
    session: visible ? { key: 1, snapshot: createSnapshot() } : null,
  }));

  // React immediately restarts this component before committing its children,
  // so the opening frame cannot contain the previous session's draft.
  if (visible !== state.observedVisible) {
    if (visible) {
      const nextKey = state.nextKey + 1;
      setState({
        observedVisible: true,
        nextKey,
        session: { key: nextKey, snapshot: createSnapshot() },
      });
    } else {
      // Do not clear the session here: AppModal still paints it while fading.
      setState({ ...state, observedVisible: false });
    }
  }

  const handleDismiss = useCallback(() => {
    setState((current) =>
      current.observedVisible || current.session == null
        ? current
        : { ...current, session: null },
    );
  }, []);

  return { session: state.session, handleDismiss };
}
