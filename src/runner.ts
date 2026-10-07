import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import type { Chain } from "./chain/chain.ts";
import { startFakeChain, type FakeChain } from "./chain/fake-rpc.ts";
import { startTestnetTap } from "./chain/tap.ts";
import type { PayMode } from "./harness/client.ts";
import { RunContext, type ScenarioEnv, type StoreKind, type Timing } from "./harness/run.ts";
import type { EvidenceClass } from "./levels.ts";
import { REPORT_VERSION, STANDARD_LIMITS, type Check, type Report } from "./report/schema.ts";
import { HarnessError, type Scenario, type ScenarioParams } from "./scenarios/types.ts";
import { installedVersion, runnerVersion } from "./versions.ts";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface RunOptions {
  scenario: Scenario;
  params: ScenarioParams;
  backend: "stub" | "testnet";
  /** The command line recorded in the report. */
  command: string;
  /** Testnet only: funded payer secrets and funded recipient, supplied by the operator. Never written anywhere. */
  payerSecrets?: string[];
  recipient?: string;
  /** Keep the run directory (worker logs, sqlite file) instead of deleting it. */
  keepRunDir?: boolean;
}

export function evidenceClassOf(backend: "stub" | "testnet"): EvidenceClass {
  return backend === "testnet" ? "testnet settlement" : "integration";
}

const STUB_TIMING: Timing = { ttlSeconds: 120, pollDelayMs: 40, pollTimeoutMs: 1500, pollMaxAttempts: 40, requestTimeoutMs: 60_000 };
const TESTNET_TIMING: Timing = { ttlSeconds: 180, pollDelayMs: 1000, pollTimeoutMs: 45_000, pollMaxAttempts: 60, requestTimeoutMs: 120_000 };

function validate(opts: RunOptions): void {
  const { scenario, params, backend } = opts;
  if (!scenario.stores.includes(params.store)) throw new UsageError(`${scenario.id} runs with store ${scenario.stores.join(" or ")}, not ${params.store}`);
  if (!scenario.backends.includes(backend)) throw new UsageError(`${scenario.id} needs fault injection that the ${backend} backend cannot do; it runs on: ${scenario.backends.join(", ")}`);
  if (scenario.variants) {
    if (!params.variant || !scenario.variants.includes(params.variant)) throw new UsageError(`${scenario.id} needs --variant ${scenario.variants.join("|")}`);
  } else if (params.variant) {
    throw new UsageError(`${scenario.id} has no variants`);
  }
  if (scenario.id === "ambiguous-settlement" && params.variant !== "verification-rpc-outage" && params.mode !== "pull") throw new UsageError(`${scenario.id}/${params.variant} is a pull-mode scenario`);
  if (scenario.id === "ambiguous-settlement" && params.variant === "verification-rpc-outage" && params.mode !== "push") throw new UsageError(`${scenario.id}/verification-rpc-outage is a push-mode scenario`);
  if (backend === "testnet" && (!opts.payerSecrets?.length || !opts.recipient)) {
    throw new UsageError("testnet runs need CHARGEGUARD_PAYER_SECRETS (funded testnet secret keys, comma separated) and CHARGEGUARD_RECIPIENT (a funded testnet public key)");
  }
}

/** Runs one scenario and returns its report. */
export async function runScenario(opts: RunOptions): Promise<Report> {
  validate(opts);
  const { scenario, params, backend } = opts;
  const base = process.env.CHARGEGUARD_TMPDIR ?? tmpdir();
  const runDir = mkdtempSync(join(base, "chargeguard-run-"));
  let chain: Chain | null = null;
  const ctxRef: { ctx: RunContext | null } = { ctx: null };
  const checks: Check[] = [];
  let harnessProblem: string | null = null;

  try {
    chain = backend === "stub" ? await startFakeChain() : await startTestnetTap();
    const payerKeys = backend === "stub" ? [Keypair.random()] : opts.payerSecrets!.map((s) => Keypair.fromSecret(s));
    const recipient = backend === "stub" ? Keypair.random().publicKey() : opts.recipient!;
    const env: ScenarioEnv = {
      chain,
      stub: backend === "stub" ? (chain as FakeChain) : null,
      recipient,
      payerKeys,
      runDir,
      mppSecret: Buffer.from(Keypair.random().rawSecretKey()).toString("hex"),
      timing: backend === "stub" ? STUB_TIMING : TESTNET_TIMING,
    };
    const ctx = new RunContext(env, params.store, params.mode);
    ctxRef.ctx = ctx;
    try {
      checks.push(...(await scenario.run(ctx, params)));
    } catch (error) {
      harnessProblem = error instanceof HarnessError ? error.message : `unexpected error: ${(error as Error).stack ?? (error as Error).message}`;
    } finally {
      await ctx.stopAll();
    }

    const payments = await ctx.computeLevels();
    const overPaid = payments.filter((p) => p.levels.fulfilled > 1);
    const byChallenge = new Map<string, number>();
    for (const p of payments) byChallenge.set(p.challengeId, (byChallenge.get(p.challengeId) ?? 0) + p.levels.fulfilled);
    const overChallenge = [...byChallenge.entries()].filter(([, n]) => n > 1);
    checks.push(
      {
        id: "single-fulfillment",
        description: "Each payment is delivered at most once (counted from the workers' fulfillment logs).",
        passed: overPaid.length === 0,
        detail: overPaid.length === 0 ? `max deliveries per payment: ${Math.max(0, ...payments.map((p) => p.levels.fulfilled))}.` : `${overPaid.map((p) => `${p.id} delivered ${p.levels.fulfilled} times`).join("; ")}.`,
      },
      {
        id: "single-fulfillment-per-challenge",
        description: "Each challenge is delivered against at most once.",
        passed: overChallenge.length === 0,
        detail: overChallenge.length === 0 ? "no challenge was delivered more than once." : overChallenge.map(([id, n]) => `challenge ${id.slice(0, 10)}… delivered ${n} times`).join("; "),
      },
    );
    const integrity = ctx.integrityCheck();

    const failed = checks.filter((c) => !c.passed);
    const verdict: Report["verdict"] = harnessProblem || !integrity.passed ? "inconclusive" : failed.length === 0 ? "pass" : "fail";
    const expectation = scenario.expected(params);
    const summary =
      verdict === "inconclusive"
        ? `Inconclusive: ${harnessProblem ?? integrity.detail}`
        : verdict === "pass"
          ? `All ${checks.length} checks passed.`
          : `${failed.length} of ${checks.length} checks failed: ${failed.map((c) => c.id).join(", ")}.`;

    const report: Report = {
      reportVersion: REPORT_VERSION,
      kind: "run",
      generatedAt: new Date().toISOString(),
      command: opts.command,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        chargeguardRunner: runnerVersion(),
        sdk: { "@stellar/mpp": installedVersion("@stellar/mpp"), mppx: installedVersion("mppx"), "@stellar/stellar-sdk": installedVersion("@stellar/stellar-sdk") },
      },
      evidenceClass: evidenceClassOf(backend),
      chain: { kind: chain.kind, description: chain.description },
      deployment: { workers: 2, store: params.store, mode: params.mode },
      scenario: { id: scenario.id, variant: params.variant, title: scenario.title, invariant: scenario.invariant, faultSchedule: scenario.plan(params) },
      expectation,
      verdict,
      matchesExpectation: verdict === expectation,
      summary,
      checks: [...checks, integrity],
      observations: ctx.observations,
      payments,
      broadcasts: chain.sendLog.map((e) => ({
        t: Math.max(0, new Date(e.at).getTime() - ctx.startedAt),
        paymentId: payments.find((p) => p.txHash === e.hash)?.id ?? null,
        txHash: e.hash,
        outcome: e.outcome,
        resultCode: e.resultCode ?? null,
      })),
      timeline: ctx.timeline,
      faultEvents: ctx.faultEvents,
      limits: [...STANDARD_LIMITS, ...(backend === "stub" ? ["The chain is a local stub: confirmations are simulated and no real transaction was made."] : ["Testnet is a shared network with its own latency; a run shows what happened once."])],
    };
    return report;
  } finally {
    if (ctxRef.ctx) await ctxRef.ctx.stopAll();
    if (chain) await chain.close();
    if (!opts.keepRunDir && basename(runDir).startsWith("chargeguard-run-")) rmSync(runDir, { recursive: true, force: true });
  }
}

export function defaultParams(scenario: Scenario, overrides: Partial<ScenarioParams> = {}): ScenarioParams {
  return {
    store: overrides.store ?? scenario.stores[scenario.stores.length - 1]!,
    mode: overrides.mode ?? "push",
    variant: overrides.variant ?? null,
    rounds: overrides.rounds ?? 10,
  };
}

export type { PayMode, StoreKind };
