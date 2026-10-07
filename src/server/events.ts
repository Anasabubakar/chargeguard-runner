import { appendFileSync } from "node:fs";
import { join } from "node:path";

/** One request as the worker saw it. The runner builds its timeline from these. */
export interface WorkerEvent {
  seq: number;
  at: string;
  workerId: string;
  pid: number;
  requestId: string;
  /** What the request carried: nothing (asking for a challenge) or a credential. */
  presented: "none" | "transaction" | "signedHash" | "hash" | "unparseable";
  challengeId: string | null;
  outcome: "challenge_issued" | "accepted" | "rejected" | "store_unavailable" | "error";
  status: number;
  /** Receipt reference (transaction hash) when accepted. */
  reference: string | null;
  /** Problem detail text when rejected, so the report can show why. */
  reason: string | null;
  fulfillmentId: string | null;
}

/** One delivery of the paid resource. Written before the 200 is sent. */
export interface FulfillmentRecord {
  fulfillmentId: string;
  at: string;
  workerId: string;
  pid: number;
  challengeId: string | null;
  reference: string | null;
}

export const eventLogPath = (runDir: string, workerId: string) => join(runDir, `events-${workerId}.jsonl`);
export const fulfillmentLogPath = (runDir: string, workerId: string) => join(runDir, `fulfillments-${workerId}.jsonl`);

export function appendJsonLine(path: string, value: unknown): void {
  appendFileSync(path, JSON.stringify(value) + "\n");
}
