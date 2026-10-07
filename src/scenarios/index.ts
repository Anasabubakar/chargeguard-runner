import { ambiguousSettlement } from "./ambiguous-settlement.ts";
import { challengeConsumption } from "./challenge-consumption.ts";
import { concurrentSubmission } from "./concurrent-submission.ts";
import { repeatedCredential } from "./repeated-credential.ts";
import { restartPersistence } from "./restart-persistence.ts";
import { storageUnavailable } from "./storage-unavailable.ts";
import type { Scenario } from "./types.ts";

export const SCENARIOS: readonly Scenario[] = [repeatedCredential, concurrentSubmission, restartPersistence, storageUnavailable, challengeConsumption, ambiguousSettlement];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

export type { Scenario, ScenarioParams } from "./types.ts";
