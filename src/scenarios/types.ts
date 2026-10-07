import type { RunContext, StoreKind } from "../harness/run.ts";
import type { PayMode } from "../harness/client.ts";
import type { Check } from "../report/schema.ts";

export interface ScenarioParams {
  store: StoreKind;
  mode: PayMode;
  variant: string | null;
  /** Repetitions for scenarios that loop (concurrent submission). */
  rounds: number;
}

export interface Scenario {
  id: string;
  title: string;
  /** The statement the run tries to refute. */
  invariant: string;
  variants?: readonly string[];
  stores: readonly StoreKind[];
  /** Backends the scenario can run on. Fault injection into the chain needs the stub. */
  backends: ReadonlyArray<"stub" | "testnet">;
  /** Written before the run. */
  plan(params: ScenarioParams): string[];
  /** What a correct shared-store deployment shows ('pass'), or what a known-bad one shows ('fail'). */
  expected(params: ScenarioParams): "pass" | "fail";
  run(ctx: RunContext, params: ScenarioParams): Promise<Check[]>;
}

/** The scenario could not reach the state it needs to test (not a verdict on the deployment). */
export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessError";
  }
}
