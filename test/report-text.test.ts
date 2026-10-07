import { describe, expect, it } from "vitest";
import { LEVELS } from "../src/levels.ts";
import { reportSchema, REPORT_VERSION, STANDARD_LIMITS, suiteSchema, type Report, type Suite } from "../src/report/schema.ts";
import { renderReportText, renderSuiteText } from "../src/report/text.ts";

const report: Report = {
  reportVersion: REPORT_VERSION,
  kind: "run",
  generatedAt: "2026-10-07T00:00:00.000Z",
  command: "node dist/cli.js run repeated-credential --store memory --mode push",
  environment: { node: "v24.0.0", platform: "linux", arch: "x64", chargeguardRunner: "0.1.0", sdk: { "@stellar/mpp": "0.7.1", mppx: "0.6.31", "@stellar/stellar-sdk": "15.1.0" } },
  evidenceClass: "integration",
  chain: { kind: "stub", description: "local stub" },
  deployment: { workers: 2, store: "memory", mode: "push" },
  scenario: { id: "repeated-credential", variant: null, title: "Repeated credential across workers", invariant: "at most one acceptance", faultSchedule: ["start workers", "present twice"] },
  expectation: "fail",
  verdict: "fail",
  matchesExpectation: true,
  summary: "1 of 1 checks failed: single-acceptance.",
  checks: [{ id: "single-acceptance", description: "At most one acceptance.", passed: false, detail: "2 accepted" }],
  observations: ["an observation"],
  payments: [{ id: "payment-1", mode: "push", txHash: "ab".repeat(32), challengeId: "c1", levels: { accepted: 2, submitted: "client", confirmed: "SUCCESS", fulfilled: 2 }, note: "One payment bought more than one delivery." }],
  broadcasts: [{ t: 5, paymentId: "payment-1", txHash: "ab".repeat(32), outcome: "PENDING", resultCode: null }],
  timeline: [{ t: 10, durationMs: 5, worker: "worker-a", label: "present", request: "credential", status: 200, outcome: "accepted", paymentId: "payment-1", detail: null }],
  faultEvents: [{ t: 1, kind: "worker-start", detail: "started" }],
  limits: [...STANDARD_LIMITS],
};

describe("report text", () => {
  it("names all four levels and the evidence class", () => {
    const text = renderReportText(report);
    for (const level of LEVELS) expect(text).toContain(level);
    expect(text).toContain("integration");
    expect(text).toContain("VERDICT: FAIL");
    expect(text).toContain("as expected");
    expect(text).toMatch(/not a proof/);
    expect(text).toMatch(/exactly-once/);
  });

  it("suite text lists each run and the totals", () => {
    const suite: Suite = {
      reportVersion: REPORT_VERSION,
      kind: "suite",
      generatedAt: report.generatedAt,
      command: "x",
      environment: report.environment,
      evidenceClass: "integration",
      reports: [report],
      totals: { runs: 1, pass: 0, fail: 1, inconclusive: 0, matchedExpectation: 1 },
      limits: [...STANDARD_LIMITS],
    };
    expect(suiteSchema.parse(suite)).toBeTruthy();
    const text = renderSuiteText(suite);
    expect(text).toContain("repeated-credential");
    expect(text).toContain("1 matched their expectation");
  });

  it("the sample report validates against the schema, and an altered version does not", () => {
    expect(reportSchema.parse(report)).toBeTruthy();
    expect(reportSchema.safeParse({ ...report, reportVersion: "2" }).success).toBe(false);
    expect(reportSchema.safeParse({ ...report, payments: [{ ...report.payments[0], levels: { accepted: 2 } }] }).success).toBe(false);
  });
});
