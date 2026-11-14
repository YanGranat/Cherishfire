import { createPersistenceCommitScheduler } from "@/application/persistence/deferred-commit-scheduler";
import { reactNativePersistenceCommitVisibility } from "@/platform/react-native/persistence-commit-visibility";

// Composition only: application owns the policy; React Native owns AppState.
const scheduler = createPersistenceCommitScheduler(
  reactNativePersistenceCommitVisibility,
);

export const persistenceCommitScheduler = {
  waitForCommitOpportunity: scheduler.waitForCommitOpportunity,
};
