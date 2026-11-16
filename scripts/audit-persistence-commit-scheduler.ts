import assert from "node:assert/strict";
import { withAuditDeadline } from "./fixtures/with-audit-deadline";

import {
  createPersistenceCommitScheduler,
  type PersistenceCommitVisibilityPort,
} from "../src/application/persistence/deferred-commit-scheduler";

interface ControlledVisibility extends PersistenceCommitVisibilityPort {
  setActive(active: boolean): void;
  finishPaint(): void;
  rejectPaint(): void;
  listenerCount(): number;
  paintWaitCount(): number;
  fallbackWaitCount(): number;
  runFallback(): void;
}

function controlledVisibility(
  initiallyActive: boolean,
  synchronousStateOnSubscribe?: boolean,
): ControlledVisibility {
  let active = initiallyActive;
  let paintWaits = 0;
  let finishPaint: (() => void) | null = null;
  let rejectPaint: ((error: Error) => void) | null = null;
  let fallback: (() => void) | null = null;
  let fallbackWaits = 0;
  const listeners = new Set<(isActive: boolean) => void>();
  return {
    isAppActive: () => active,
    waitForUiPaint() {
      paintWaits += 1;
      return new Promise<void>((resolve, reject) => {
        finishPaint = resolve;
        rejectPaint = reject;
      });
    },
    subscribeToAppState(listener) {
      listeners.add(listener);
      if (synchronousStateOnSubscribe != null) {
        listener(synchronousStateOnSubscribe);
      }
      return () => listeners.delete(listener);
    },
    scheduleFallback(listener) {
      fallbackWaits += 1;
      fallback = listener;
      return () => {
        if (fallback === listener) fallback = null;
      };
    },
    setActive(nextActive) {
      active = nextActive;
      for (const listener of [...listeners]) listener(nextActive);
    },
    finishPaint() {
      finishPaint?.();
    },
    rejectPaint() {
      rejectPaint?.(new Error("expected paint failure"));
    },
    listenerCount: () => listeners.size,
    paintWaitCount: () => paintWaits,
    fallbackWaitCount: () => fallbackWaits,
    runFallback() {
      const pending = fallback;
      fallback = null;
      pending?.();
    },
  };
}

async function main() {
  const active = controlledVisibility(true);
  let activeSettles = 0;
  const activeWait = createPersistenceCommitScheduler(active)
    .waitForCommitOpportunity()
    .then(() => {
      activeSettles += 1;
    });
  await Promise.resolve();
  assert.equal(activeSettles, 0, "foreground durability must wait for paint");
  assert.equal(active.listenerCount(), 1);
  active.finishPaint();
  await activeWait;
  assert.equal(activeSettles, 1);
  assert.equal(active.listenerCount(), 0, "paint completion must unsubscribe");
  active.runFallback();
  active.setActive(false);
  await Promise.resolve();
  assert.equal(activeSettles, 1, "late AppState must not resolve twice");

  const background = controlledVisibility(false);
  await createPersistenceCommitScheduler(background).waitForCommitOpportunity();
  assert.equal(background.paintWaitCount(), 0);
  assert.equal(background.listenerCount(), 0);
  assert.equal(background.fallbackWaitCount(), 0);

  const backgroundsDuringWait = controlledVisibility(true);
  let backgroundSettles = 0;
  const backgroundWait = createPersistenceCommitScheduler(
    backgroundsDuringWait,
  )
    .waitForCommitOpportunity()
    .then(() => {
      backgroundSettles += 1;
    });
  backgroundsDuringWait.setActive(false);
  await backgroundWait;
  assert.equal(backgroundSettles, 1);
  assert.equal(backgroundsDuringWait.listenerCount(), 0);
  backgroundsDuringWait.finishPaint();
  await Promise.resolve();
  assert.equal(backgroundSettles, 1, "paint after background must be ignored");
  backgroundsDuringWait.runFallback();

  const missingPaint = controlledVisibility(true);
  let fallbackSettles = 0;
  const missingPaintWait = createPersistenceCommitScheduler(missingPaint, 100)
    .waitForCommitOpportunity()
    .then(() => {
      fallbackSettles += 1;
    });
  await Promise.resolve();
  assert.equal(fallbackSettles, 0);
  assert.equal(missingPaint.fallbackWaitCount(), 1);
  missingPaint.runFallback();
  await missingPaintWait;
  assert.equal(fallbackSettles, 1);
  assert.equal(
    missingPaint.listenerCount(),
    0,
    "bounded fallback must release lifecycle ownership",
  );

  const synchronousBackground = controlledVisibility(true, false);
  await createPersistenceCommitScheduler(
    synchronousBackground,
  ).waitForCommitOpportunity();
  assert.equal(
    synchronousBackground.listenerCount(),
    0,
    "a synchronous subscriber must not leak its eventual unsubscribe",
  );
  assert.equal(synchronousBackground.paintWaitCount(), 0);

  const rejectedPaint = controlledVisibility(true);
  const rejectedWait = createPersistenceCommitScheduler(
    rejectedPaint,
  ).waitForCommitOpportunity();
  rejectedPaint.rejectPaint();
  await rejectedWait;
  assert.equal(rejectedPaint.listenerCount(), 0);

  let synchronousUnsubscribeCount = 0;
  const synchronousThrowingPort: PersistenceCommitVisibilityPort = {
    isAppActive: () => true,
    waitForUiPaint() {
      throw new Error("expected synchronous adapter failure");
    },
    subscribeToAppState() {
      return () => {
        synchronousUnsubscribeCount += 1;
      };
    },
    scheduleFallback() {
      return () => {};
    },
  };
  await createPersistenceCommitScheduler(
    synchronousThrowingPort,
  ).waitForCommitOpportunity();
  assert.equal(synchronousUnsubscribeCount, 1);

  const subscriptionThrowingPort: PersistenceCommitVisibilityPort = {
    isAppActive: () => true,
    waitForUiPaint: () => new Promise<void>(() => {}),
    subscribeToAppState() {
      throw new Error("expected subscription failure");
    },
    scheduleFallback() {
      return () => {};
    },
  };
  await createPersistenceCommitScheduler(
    subscriptionThrowingPort,
  ).waitForCommitOpportunity();

  console.log("Persistence commit scheduler audit passed.");
}

void withAuditDeadline(main, "Persistence commit scheduler audit").catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
