import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Keypair } from "@stellar/stellar-sdk";
import type { Chain } from "../chain/chain.ts";
import type { FakeChain } from "../chain/fake-rpc.ts";
import type { PaymentLevels } from "../levels.ts";
import type { Check, FaultEvent, Payment, TimelineEntry } from "../report/schema.ts";
import { eventLogPath, fulfillmentLogPath, type FulfillmentRecord, type WorkerEvent } from "../server/events.ts";
import { openSqliteStore } from "../store/sqlite.ts";
import { createPayer, describeCredential, type PayMode, type Payer } from "./client.ts";
import { startWorker, type WorkerHandle, type WorkerOptions } from "./workers.ts";

export type StoreKind = "memory" | "sqlite";

export interface Timing {
  ttlSeconds: number;
  pollDelayMs: number;
  pollTimeoutMs: number;
  pollMaxAttempts: number;
  requestTimeoutMs: number;
}

export interface ScenarioEnv {
  chain: Chain;
  /** Present only for the stub: scenarios that inject chain faults need it. */
  stub: FakeChain | null;
  recipient: string;
  payerKeys: Keypair[];
  runDir: string;
  mppSecret: string;
  timing: Timing;
}

export interface AttemptResult {
  status: number;
  outcome: TimelineEntry["outcome"];
  body: string;
  /** The raw response, for building a credential from a 402. Its body is unread. */
  response: Response | null;
  receiptRef: string | null;
  fulfillmentId: string | null;
  detail: string | null;
}

export interface PaymentRecord {
  id: string;
  mode: PayMode;
  txHash: string;
  challengeId: string;
  authorization: string;
}

const WORKER_NAMES = ["worker-a", "worker-b"] as const;

/**
 * One scenario run: owns the workers it starts, records everything the client sees, and at the
 * end reconciles it with the workers' own logs and the chain.
 */
export class RunContext {
  readonly env: ScenarioEnv;
  readonly store: StoreKind;
  readonly mode: PayMode;
  readonly startedAt = Date.now();
  readonly timeline: TimelineEntry[] = [];
  readonly faultEvents: FaultEvent[] = [];
  readonly observations: string[] = [];
  readonly workersStarted = new Set<WorkerHandle>();
  private readonly paymentRecords: PaymentRecord[] = [];
  private payerIndex = 0;
  /** Requests the client deliberately abandoned; the worker may still have processed them. */
  private abandoned = 0;
  readonly dbPath: string;

  constructor(env: ScenarioEnv, store: StoreKind, mode: PayMode) {
    this.env = env;
    this.store = store;
    this.mode = mode;
    this.dbPath = join(env.runDir, "shared-store.db");
  }

  elapsed(): number {
    return Date.now() - this.startedAt;
  }

  fault(kind: string, detail: string): void {
    this.faultEvents.push({ t: this.elapsed(), kind, detail });
  }

  observe(text: string): void {
    this.observations.push(text);
  }

  /** The store setting handed to workers for this deployment. */
  storeSetting(): string {
    return this.store === "memory" ? "memory" : `sqlite:${this.dbPath}`;
  }

  /** Creates the shared sqlite file and schema. Workers never create it themselves. */
  initSharedStore(): void {
    openSqliteStore(this.dbPath, { create: true }).close();
  }

  workerOptions(id: string, overrides: Partial<WorkerOptions> = {}): WorkerOptions {
    const t = this.env.timing;
    return {
      id,
      store: this.storeSetting(),
      runDir: this.env.runDir,
      recipient: this.env.recipient,
      mppSecret: this.env.mppSecret,
      rpcUrl: this.env.chain.url,
      caCertPath: this.env.chain.cert.certPath,
      ttlSeconds: t.ttlSeconds,
      pollDelayMs: t.pollDelayMs,
      pollTimeoutMs: t.pollTimeoutMs,
      pollMaxAttempts: t.pollMaxAttempts,
      ...overrides,
    };
  }

  async startWorker(id: string, overrides: Partial<WorkerOptions> = {}): Promise<WorkerHandle> {
    const worker = await startWorker(this.workerOptions(id, overrides));
    this.workersStarted.add(worker);
    this.fault("worker-start", `${id} started as pid ${worker.pid} with store ${worker.options.store?.startsWith("sqlite:") ? "sqlite (shared file)" : worker.options.store}`);
    return worker;
  }

  /** The default deployment: two workers sharing the configured store setting. */
  async startPair(): Promise<[WorkerHandle, WorkerHandle]> {
    if (this.store === "sqlite") this.initSharedStore();
    const a = await this.startWorker(WORKER_NAMES[0]);
    const b = await this.startWorker(WORKER_NAMES[1]);
    return [a, b];
  }

  /** SIGKILL a worker and start a new process with the same id and store setting. */
  async crashAndRestart(worker: WorkerHandle): Promise<WorkerHandle> {
    this.fault("worker-kill", `${worker.id} (pid ${worker.pid}) killed with SIGKILL`);
    await worker.kill();
    this.workersStarted.delete(worker);
    const restarted = await this.startWorker(worker.id, { ...worker.options });
    this.fault("worker-restart", `${worker.id} restarted as pid ${restarted.pid}`);
    return restarted;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.workersStarted].map((w) => w.stop().catch(() => undefined)));
    this.workersStarted.clear();
  }

  payer(mode: PayMode = this.mode): Payer {
    const key = this.env.payerKeys[this.payerIndex % this.env.payerKeys.length]!;
    this.payerIndex++;
    return createPayer({ keypair: key, mode, rpcUrl: this.env.chain.url, pollDelayMs: this.env.timing.pollDelayMs, pollTimeoutMs: Math.max(this.env.timing.pollTimeoutMs, 30_000) });
  }

  /** Sends one request to a worker and records what came back. */
  async attempt(worker: WorkerHandle, label: string, options: { authorization?: string; payment?: PaymentRecord; abandonAfterMs?: number } = {}): Promise<AttemptResult> {
    const t = this.elapsed();
    const started = Date.now();
    const kind: TimelineEntry["request"] = options.authorization ? "credential" : "challenge";
    let result: AttemptResult;
    try {
      const response = await fetch(`${worker.url}/paid`, {
        headers: options.authorization ? { authorization: options.authorization } : {},
        signal: options.abandonAfterMs !== undefined ? AbortSignal.timeout(options.abandonAfterMs) : AbortSignal.timeout(this.env.timing.requestTimeoutMs),
      });
      const keep = response.clone();
      const text = await response.text();
      let receiptRef: string | null = null;
      let fulfillmentId: string | null = null;
      let detail: string | null = null;
      try {
        const json = JSON.parse(text) as { fulfillmentId?: string; detail?: string; error?: string; code?: string };
        fulfillmentId = json.fulfillmentId ?? null;
        detail = json.detail ?? (json.error ? `${json.error}${json.code ? ` (${json.code})` : ""}` : null);
      } catch {
        /* non-JSON body */
      }
      const receipt = response.headers.get("payment-receipt");
      if (receipt) {
        try {
          receiptRef = (JSON.parse(Buffer.from(receipt, "base64url").toString("utf8")) as { reference?: string }).reference ?? null;
        } catch {
          receiptRef = null;
        }
      }
      const outcome: TimelineEntry["outcome"] =
        response.status === 200 ? "accepted" : response.status === 402 ? (kind === "challenge" ? "challenge" : "rejected") : response.status === 503 ? "unavailable" : "error";
      result = { status: response.status, outcome, body: text, response: keep, receiptRef, fulfillmentId, detail };
    } catch (error) {
      if (options.abandonAfterMs !== undefined) this.abandoned++;
      result = {
        status: 0,
        outcome: "error",
        body: "",
        response: null,
        receiptRef: null,
        fulfillmentId: null,
        detail: options.abandonAfterMs !== undefined ? `client dropped the connection after ${options.abandonAfterMs} ms, before any response (a lost response)` : (error as Error).message,
      };
    }
    this.timeline.push({
      t,
      durationMs: Date.now() - started,
      worker: worker.id,
      label,
      request: kind,
      status: result.status,
      outcome: result.outcome,
      paymentId: options.payment?.id ?? null,
      detail: result.detail,
    });
    return result;
  }

  /** Registers a credential as a payment so its four levels can be reported. Idempotent per hash. */
  registerPayment(authorization: string, mode: PayMode = this.mode): PaymentRecord {
    const info = describeCredential(authorization);
    const existing = this.paymentRecords.find((p) => p.txHash === info.txHash && p.challengeId === info.challengeId);
    if (existing) return existing;
    const record: PaymentRecord = { id: `payment-${this.paymentRecords.length + 1}`, mode, txHash: info.txHash, challengeId: info.challengeId, authorization };
    this.paymentRecords.push(record);
    return record;
  }

  get payments(): readonly PaymentRecord[] {
    return this.paymentRecords;
  }

  /** Worker-side logs, read after the fact. Missing files mean the worker never wrote that kind of record. */
  readWorkerLogs(): { events: WorkerEvent[]; fulfillments: FulfillmentRecord[] } {
    const events: WorkerEvent[] = [];
    const fulfillments: FulfillmentRecord[] = [];
    const ids = new Set<string>([...WORKER_NAMES, ...[...this.workersStarted].map((w) => w.id), ...this.timeline.map((e) => e.worker)]);
    for (const id of ids) {
      for (const [path, sink] of [
        [eventLogPath(this.env.runDir, id), events],
        [fulfillmentLogPath(this.env.runDir, id), fulfillments],
      ] as const) {
        if (!existsSync(path)) continue;
        for (const line of readFileSync(path, "utf8").split("\n")) {
          if (line.trim()) (sink as unknown[]).push(JSON.parse(line));
        }
      }
    }
    return { events, fulfillments };
  }

  /** The four levels for every registered payment, with chain facts observed by the runner. */
  async computeLevels(): Promise<Payment[]> {
    const { events, fulfillments } = this.readWorkerLogs();
    const out: Payment[] = [];
    for (const p of this.paymentRecords) {
      // Level "accepted" is what the workers decided, read from their own logs (a client can lose a response).
      const accepted = events.filter((e) => e.outcome === "accepted" && e.reference === p.txHash).length;
      const fulfilled = fulfillments.filter((f) => f.reference === p.txHash).length;
      const observed = await this.env.chain.observe(p.txHash);
      const submitted: PaymentLevels["submitted"] = !observed.submitted ? null : p.mode === "push" ? "client" : "worker";
      const levels: PaymentLevels = { accepted, submitted, confirmed: observed.status, fulfilled };
      out.push({ id: p.id, mode: p.mode, txHash: p.txHash, challengeId: p.challengeId, levels, note: readLevels(levels) });
    }
    return out;
  }

  /** Integrity check: what the client saw must match what the workers logged. */
  integrityCheck(): Check {
    const { events, fulfillments } = this.readWorkerLogs();
    const clientAccepted = this.timeline.filter((e) => e.outcome === "accepted").length;
    const workerAccepted = events.filter((e) => e.outcome === "accepted").length;
    const clientTotal = this.timeline.filter((e) => e.status !== 0).length;
    const workerTotal = events.length;
    // A deliberately abandoned request is processed by the worker but never answered to the client.
    const ok =
      workerAccepted >= clientAccepted &&
      workerAccepted - clientAccepted <= this.abandoned &&
      fulfillments.length === workerAccepted &&
      workerTotal - clientTotal >= 0 &&
      workerTotal - clientTotal <= this.abandoned;
    return {
      id: "evidence-consistent",
      description: "Client-observed responses match the workers' own request and fulfillment logs.",
      passed: ok,
      detail: `client saw ${clientTotal} responses (${clientAccepted} accepted); workers logged ${workerTotal} requests (${workerAccepted} accepted) and ${fulfillments.length} fulfillments${this.abandoned ? `; ${this.abandoned} request(s) were abandoned by the client on purpose` : ""}.`,
    };
  }
}

export function readLevels(l: PaymentLevels): string {
  const parts: string[] = [];
  parts.push(l.accepted === 0 ? "no worker accepted the credential" : `${l.accepted} worker response${l.accepted > 1 ? "s" : ""} accepted the credential`);
  parts.push(l.submitted === null ? "no transaction submission was observed" : `the transaction was submitted by the ${l.submitted}`);
  parts.push(`chain: ${l.confirmed}`);
  parts.push(l.fulfilled === 0 ? "the resource was never delivered" : `the resource was delivered ${l.fulfilled} time${l.fulfilled > 1 ? "s" : ""}`);
  let verdict = "";
  if (l.fulfilled > 1) verdict = " One payment bought more than one delivery.";
  else if (l.confirmed === "SUCCESS" && l.fulfilled === 0) verdict = " Paid on chain but not delivered: needs reconciliation.";
  return parts.join("; ") + "." + verdict;
}
