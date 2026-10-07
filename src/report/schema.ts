import { z } from "zod";
import { EVIDENCE_CLASSES } from "../levels.ts";

/**
 * Report format v1. One `Report` describes one scenario run against one deployment shape;
 * a `Suite` bundles several. The JSON Schemas under schema/ are generated from these zod
 * definitions (`pnpm schema`) and are what other tools (the workbench) validate against.
 */

export const REPORT_VERSION = "1" as const;

const iso = z.string().describe("ISO 8601 timestamp");

export const evidenceClassSchema = z.enum(EVIDENCE_CLASSES);

export const levelsSchema = z
  .object({
    accepted: z.number().int().nonnegative().describe("Worker responses that accepted a credential for this payment (HTTP 200 with receipt)."),
    submitted: z.enum(["worker", "client"]).nullable().describe("Who put the transaction on the network; null when no submission was observed."),
    confirmed: z.enum(["SUCCESS", "FAILED", "NOT_FOUND", "UNKNOWN"]).describe("Ledger status of the transaction, observed by the runner."),
    fulfilled: z.number().int().nonnegative().describe("Deliveries of the paid resource recorded in worker fulfillment logs."),
  })
  .describe("The four levels kept apart for one payment: accepted credential, submitted transaction, chain confirmation, service fulfillment.");

export const paymentSchema = z.object({
  id: z.string(),
  mode: z.enum(["push", "pull"]),
  txHash: z.string().describe("Inner transaction hash (hex), the payment's identity at every level."),
  challengeId: z.string(),
  levels: levelsSchema,
  note: z.string().nullable().describe("Plain-language reading of the four levels for this payment."),
});

export const timelineEntrySchema = z.object({
  t: z.number().describe("Milliseconds since the run started, when the request was sent."),
  durationMs: z.number(),
  worker: z.string(),
  label: z.string().describe("What the scenario was doing, e.g. 'present credential to worker-b'."),
  request: z.enum(["challenge", "credential"]),
  status: z.number().int().describe("HTTP status the client saw; 0 when the request failed before a response."),
  outcome: z.enum(["challenge", "accepted", "rejected", "unavailable", "error"]),
  paymentId: z.string().nullable(),
  detail: z.string().nullable(),
});

export const faultEventSchema = z
  .object({
    t: z.number().describe("Milliseconds since the run started."),
    kind: z.string(),
    detail: z.string(),
  })
  .describe("A fault the runner injected, or a harness action (a worker start, a payer broadcast), in the order it happened.");

export const broadcastSchema = z
  .object({
    t: z.number().describe("Milliseconds since the run started."),
    paymentId: z.string().nullable(),
    txHash: z.string(),
    outcome: z.enum(["PENDING", "DUPLICATE", "ERROR", "DROPPED", "UNKNOWN"]).describe("What the node answered to sendTransaction. DROPPED: the connection was cut before an answer."),
    resultCode: z.string().nullable().describe("For ERROR: the transaction result code the node gave (for example txBadSeq), when decodable."),
  })
  .describe("One sendTransaction call that reached the chain endpoint, whoever sent it.");

export const checkSchema = z.object({
  id: z.string(),
  description: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});

export const environmentSchema = z.object({
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
  chargeguardRunner: z.string(),
  sdk: z.object({
    "@stellar/mpp": z.string(),
    mppx: z.string(),
    "@stellar/stellar-sdk": z.string(),
  }),
});

export const chainSchema = z.object({
  kind: z.enum(["stub", "testnet"]),
  description: z.string(),
});

export const deploymentSchema = z.object({
  workers: z.number().int().positive(),
  store: z.enum(["memory", "sqlite"]),
  mode: z.enum(["push", "pull"]),
});

export const scenarioSchema = z.object({
  id: z.string(),
  variant: z.string().nullable(),
  title: z.string(),
  invariant: z.string().describe("The statement this run tries to refute."),
  faultSchedule: z.array(z.string()).describe("Planned faults, in order, written before the run."),
});

export const reportSchema = z.object({
  reportVersion: z.literal(REPORT_VERSION),
  kind: z.literal("run"),
  generatedAt: iso,
  command: z.string().describe("The command line that produced this report."),
  environment: environmentSchema,
  evidenceClass: evidenceClassSchema,
  chain: chainSchema,
  deployment: deploymentSchema,
  scenario: scenarioSchema,
  expectation: z.enum(["pass", "fail"]).describe("What this run was expected to show. A control run (isolated memory stores) expects 'fail'."),
  verdict: z.enum(["pass", "fail", "inconclusive"]),
  matchesExpectation: z.boolean(),
  summary: z.string(),
  checks: z.array(checkSchema),
  observations: z.array(z.string()).describe("Findings that are reported but are not pass/fail checks."),
  payments: z.array(paymentSchema),
  broadcasts: z.array(broadcastSchema).describe("Every sendTransaction the chain endpoint saw, with the node's answer: the runner's independent record of level 'submitted'."),
  timeline: z.array(timelineEntrySchema),
  faultEvents: z.array(faultEventSchema).describe("Faults injected and harness actions, in order, as they actually happened (the plan is scenario.faultSchedule)."),
  limits: z.array(z.string()),
});

export const suiteSchema = z.object({
  reportVersion: z.literal(REPORT_VERSION),
  kind: z.literal("suite"),
  generatedAt: iso,
  command: z.string(),
  environment: environmentSchema,
  evidenceClass: evidenceClassSchema,
  reports: z.array(reportSchema),
  totals: z.object({
    runs: z.number().int(),
    pass: z.number().int(),
    fail: z.number().int(),
    inconclusive: z.number().int(),
    matchedExpectation: z.number().int(),
  }),
  limits: z.array(z.string()),
});

export type Report = z.infer<typeof reportSchema>;
export type Suite = z.infer<typeof suiteSchema>;
export type Payment = z.infer<typeof paymentSchema>;
export type Broadcast = z.infer<typeof broadcastSchema>;
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;
export type FaultEvent = z.infer<typeof faultEventSchema>;
export type Check = z.infer<typeof checkSchema>;

/** Statements every report carries. They are part of the format, not marketing. */
export const STANDARD_LIMITS: readonly string[] = [
  "A finite number of runs is evidence, not a proof: this report does not show linearizability or exactly-once delivery.",
  "Only the two-worker reference deployment shape of this runner was exercised, not your own server code.",
  "Payment channels are out of scope.",
];
