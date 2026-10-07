import { describe, expect, it } from "vitest";
import { reportSchema, type Report } from "../src/report/schema.ts";
import { defaultParams, runScenario } from "../src/runner.ts";
import { findScenario } from "../src/scenarios/index.ts";
import type { PayMode } from "../src/harness/client.ts";
import type { StoreKind } from "../src/harness/run.ts";

// Expectations below are written from the replay-protection requirement (a shared atomic store means at most one
// acceptance; private per-process stores cannot give that) and from Stellar's sequence rule (the same signed
// transaction cannot be applied twice). They are not read back from the runner's output.

async function run(id: string, store: StoreKind, mode: PayMode, variant: string | null = null, rounds = 4): Promise<Report> {
  const scenario = findScenario(id)!;
  const report = await runScenario({ scenario, params: defaultParams(scenario, { store, mode, variant, rounds }), backend: "stub", command: "test" });
  expect(reportSchema.parse(report)).toBeTruthy();
  return report;
}
const failedIds = (r: Report) => r.checks.filter((c) => !c.passed).map((c) => c.id);

describe("repeated-credential", () => {
  it("isolated memory stores, push: both workers accept one payment (the failing deployment)", async () => {
    const r = await run("repeated-credential", "memory", "push");
    expect(r.verdict).toBe("fail");
    expect(r.matchesExpectation).toBe(true);
    expect(r.payments).toHaveLength(1);
    expect(r.payments[0]!.levels).toMatchObject({ accepted: 2, submitted: "client", confirmed: "SUCCESS", fulfilled: 2 });
    expect(failedIds(r)).toContain("single-acceptance");
    expect(failedIds(r)).toContain("single-fulfillment");
  });

  it("shared sqlite store, push: at most one acceptance and one delivery", async () => {
    const r = await run("repeated-credential", "sqlite", "push");
    expect(r.verdict).toBe("pass");
    expect(r.payments[0]!.levels).toMatchObject({ accepted: 1, submitted: "client", confirmed: "SUCCESS", fulfilled: 1 });
  });

  it("isolated memory stores, pull: one acceptance only because the ledger refused the second broadcast", async () => {
    const r = await run("repeated-credential", "memory", "pull");
    expect(r.payments[0]!.levels).toMatchObject({ accepted: 1, submitted: "worker", fulfilled: 1 });
    expect(failedIds(r)).toEqual(["store-level-protection"]);
    expect(r.observations.join(" ")).toMatch(/ledger/);
  });

  it("shared sqlite store, pull: exactly one broadcast reaches the chain", async () => {
    const r = await run("repeated-credential", "sqlite", "pull");
    expect(r.verdict).toBe("pass");
    expect(r.checks.find((c) => c.id === "store-level-protection")!.detail).toMatch(/^1 sendTransaction/);
  });
});

describe("concurrent-submission", () => {
  it("isolated memory stores: every round has two acceptances", async () => {
    const r = await run("concurrent-submission", "memory", "push");
    expect(r.verdict).toBe("fail");
    expect(r.payments.every((p) => p.levels.accepted === 2 && p.levels.fulfilled === 2)).toBe(true);
  });
  for (const mode of ["push", "pull"] as const) {
    it(`shared sqlite store, ${mode}: exactly one acceptance and one delivery in every round`, async () => {
      const r = await run("concurrent-submission", "sqlite", mode);
      expect(r.verdict).toBe("pass");
      expect(r.payments).toHaveLength(4);
      expect(r.payments.every((p) => p.levels.accepted === 1 && p.levels.fulfilled === 1)).toBe(true);
    });
  }
});

describe("restart-persistence", () => {
  it("isolated memory stores forget a consumed credential after SIGKILL", async () => {
    const r = await run("restart-persistence", "memory", "push");
    expect(r.verdict).toBe("fail");
    expect(failedIds(r)).toContain("stays-consumed");
    expect(r.faultEvents.map((f) => f.kind)).toContain("worker-kill");
  });
  for (const mode of ["push", "pull"] as const) {
    it(`shared sqlite store keeps it consumed (${mode})`, async () => {
      const r = await run("restart-persistence", "sqlite", mode);
      expect(r.verdict).toBe("pass");
      expect(r.payments[0]!.levels.fulfilled).toBe(1);
    });
  }
});

describe("storage-unavailable", () => {
  for (const mode of ["push", "pull"] as const) {
    it(`fails closed and refuses to start without a store (${mode})`, async () => {
      const r = await run("storage-unavailable", "sqlite", mode);
      expect(failedIds(r)).toEqual([]);
      expect(r.verdict).toBe("pass");
      for (const id of ["missing-store-config-refuses-to-start", "missing-database-refuses-to-start", "locked-store-fails-closed", "locked-store-no-broadcast", "removed-store-fails-closed", "removed-store-no-restart"]) {
        expect(r.checks.find((c) => c.id === id)?.passed, id).toBe(true);
      }
      expect(r.timeline.filter((e) => e.outcome === "unavailable").length).toBeGreaterThanOrEqual(4);
    });
  }
});

describe("challenge-consumption", () => {
  it("isolated memory stores accept one challenge twice", async () => {
    const r = await run("challenge-consumption", "memory", "push");
    expect(r.verdict).toBe("fail");
    expect(failedIds(r)).toContain("challenge-accepted-once");
  });
  for (const mode of ["push", "pull"] as const) {
    it(`shared sqlite store accepts a challenge once; forged and lapsed challenges are refused (${mode})`, async () => {
      const r = await run("challenge-consumption", "sqlite", mode);
      expect(r.verdict).toBe("pass");
      const paid = r.payments.filter((p) => p.levels.fulfilled > 0);
      expect(paid.length).toBe(2); // the first payment and the control payment on worker-c
      const second = r.payments[1]!;
      expect(second.levels.accepted).toBe(0);
      expect(second.levels.fulfilled).toBe(0);
    });
  }
});

describe("ambiguous-settlement", () => {
  const expectLevels: Array<[string, PayMode, Partial<Report["payments"][number]["levels"]>]> = [
    ["unconfirmed-then-lands", "pull", { accepted: 0, submitted: "worker", confirmed: "SUCCESS", fulfilled: 0 }],
    ["broadcast-rejected", "pull", { accepted: 1, submitted: "worker", confirmed: "SUCCESS", fulfilled: 1 }],
    ["onchain-failed", "pull", { accepted: 0, submitted: "worker", confirmed: "FAILED", fulfilled: 0 }],
    ["store-fault-after-broadcast", "pull", { accepted: 0, submitted: "worker", confirmed: "SUCCESS", fulfilled: 0 }],
    ["verification-rpc-outage", "push", { accepted: 0, submitted: "client", confirmed: "SUCCESS", fulfilled: 0 }],
    ["response-lost", "pull", { accepted: 1, submitted: "worker", confirmed: "SUCCESS", fulfilled: 1 }],
  ];
  it.each(expectLevels)("%s keeps the four levels apart", async (variant, mode, levels) => {
    const r = await run("ambiguous-settlement", "sqlite", mode, variant);
    expect(r.verdict).toBe("pass");
    expect(r.payments[0]!.levels).toMatchObject(levels);
  });
});
