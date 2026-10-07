import type { Report, Suite } from "./report/schema.ts";
import { REPORT_VERSION, STANDARD_LIMITS } from "./report/schema.ts";
import { evidenceClassOf, runScenario, type RunOptions } from "./runner.ts";
import { findScenario } from "./scenarios/index.ts";
import { AMBIGUOUS_VARIANTS } from "./scenarios/ambiguous-settlement.ts";
import type { PayMode } from "./harness/client.ts";
import type { StoreKind } from "./harness/run.ts";
import { installedVersion, runnerVersion } from "./versions.ts";

interface Entry {
  scenario: string;
  store: StoreKind;
  mode: PayMode;
  variant?: string;
  rounds?: number;
}

/**
 * The built-in matrix. Every scenario runs against the shared sqlite store (expected to pass)
 * and, where the failure can be shown, against isolated per-process memory stores (the control,
 * expected to fail). The testnet matrix is smaller: each payment is a real transaction, and
 * faults that need a controllable chain (ambiguous settlement) cannot be injected there.
 */
export function suiteMatrix(backend: "stub" | "testnet"): Entry[] {
  if (backend === "testnet") {
    return [
      { scenario: "repeated-credential", store: "memory", mode: "push" },
      { scenario: "repeated-credential", store: "sqlite", mode: "push" },
      { scenario: "repeated-credential", store: "memory", mode: "pull" },
      { scenario: "repeated-credential", store: "sqlite", mode: "pull" },
      { scenario: "concurrent-submission", store: "memory", mode: "push", rounds: 2 },
      { scenario: "concurrent-submission", store: "sqlite", mode: "push", rounds: 2 },
      { scenario: "restart-persistence", store: "sqlite", mode: "push" },
      { scenario: "challenge-consumption", store: "sqlite", mode: "push" },
      { scenario: "storage-unavailable", store: "sqlite", mode: "pull" },
    ];
  }
  return [
    { scenario: "repeated-credential", store: "memory", mode: "push" },
    { scenario: "repeated-credential", store: "sqlite", mode: "push" },
    { scenario: "repeated-credential", store: "memory", mode: "pull" },
    { scenario: "repeated-credential", store: "sqlite", mode: "pull" },
    { scenario: "concurrent-submission", store: "memory", mode: "push", rounds: 10 },
    { scenario: "concurrent-submission", store: "sqlite", mode: "push", rounds: 10 },
    { scenario: "concurrent-submission", store: "sqlite", mode: "pull", rounds: 10 },
    { scenario: "restart-persistence", store: "memory", mode: "push" },
    { scenario: "restart-persistence", store: "sqlite", mode: "push" },
    { scenario: "restart-persistence", store: "sqlite", mode: "pull" },
    { scenario: "challenge-consumption", store: "memory", mode: "push" },
    { scenario: "challenge-consumption", store: "sqlite", mode: "push" },
    { scenario: "challenge-consumption", store: "sqlite", mode: "pull" },
    { scenario: "storage-unavailable", store: "sqlite", mode: "pull" },
    { scenario: "storage-unavailable", store: "sqlite", mode: "push" },
    ...AMBIGUOUS_VARIANTS.map((variant): Entry => ({ scenario: "ambiguous-settlement", store: "sqlite", mode: variant === "verification-rpc-outage" ? "push" : "pull", variant })),
  ];
}

export async function runSuite(options: {
  backend: "stub" | "testnet";
  command: string;
  payerSecrets?: string[];
  recipient?: string;
  only?: string[];
  onProgress?: (line: string) => void;
}): Promise<Suite> {
  const reports: Report[] = [];
  const entries = suiteMatrix(options.backend).filter((e) => !options.only?.length || options.only.includes(e.scenario));
  for (const e of entries) {
    const scenario = findScenario(e.scenario)!;
    const label = `${e.scenario}${e.variant ? `/${e.variant}` : ""} store=${e.store} mode=${e.mode}`;
    options.onProgress?.(`running ${label}`);
    const run: RunOptions = {
      scenario,
      params: { store: e.store, mode: e.mode, variant: e.variant ?? null, rounds: e.rounds ?? 10 },
      backend: options.backend,
      command: options.command,
      ...(options.payerSecrets ? { payerSecrets: options.payerSecrets } : {}),
      ...(options.recipient ? { recipient: options.recipient } : {}),
    };
    const report = await runScenario(run);
    reports.push(report);
    options.onProgress?.(`  -> ${report.verdict} (expected ${report.expectation})`);
  }
  const first = reports[0];
  return {
    reportVersion: REPORT_VERSION,
    kind: "suite",
    generatedAt: new Date().toISOString(),
    command: options.command,
    environment: first?.environment ?? {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      chargeguardRunner: runnerVersion(),
      sdk: { "@stellar/mpp": installedVersion("@stellar/mpp"), mppx: installedVersion("mppx"), "@stellar/stellar-sdk": installedVersion("@stellar/stellar-sdk") },
    },
    evidenceClass: evidenceClassOf(options.backend),
    reports,
    totals: {
      runs: reports.length,
      pass: reports.filter((r) => r.verdict === "pass").length,
      fail: reports.filter((r) => r.verdict === "fail").length,
      inconclusive: reports.filter((r) => r.verdict === "inconclusive").length,
      matchedExpectation: reports.filter((r) => r.matchesExpectation).length,
    },
    limits: [...STANDARD_LIMITS],
  };
}
