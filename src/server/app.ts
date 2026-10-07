import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Credential } from "mppx";
import { Mppx, Store } from "mppx/server";
import { stellar } from "@stellar/mpp/charge/server";
import { StoreUnavailableError } from "../errors.ts";
import { openStore, formatStoreSpec } from "../store/spec.ts";
import type { WorkerConfig } from "./config.ts";
import { appendJsonLine, eventLogPath, fulfillmentLogPath, type FulfillmentRecord, type WorkerEvent } from "./events.ts";

export const PAID_PATH = "/paid";
export const HEALTH_PATH = "/__chargeguard/health";
export const INSPECT_PATH = "/__chargeguard/inspect";

/**
 * The reference paid endpoint: the official @stellar/mpp charge method behind mppx, with a
 * configurable Store, plus the instrumentation the runner needs.
 *
 * Fail-closed rules enforced here (the SDK itself only throws at construction when `store`
 * is absent, and mppx turns any verify failure into a fresh 402):
 * - There is no default store. `createWorkerApp` is only reachable with an explicit StoreSpec.
 * - A store fault during a request is answered with 503, never with the resource, never with
 *   a fresh 402 that would invite a blind retry against a store that cannot answer.
 * - The paid resource is only produced on the `status === 200` branch, after the SDK's verify.
 *
 * The /__chargeguard/* routes are test-harness routes for 127.0.0.1 and are not part of any
 * payment protocol.
 */
export interface WorkerApp {
  handle(request: Request): Promise<Response>;
  close(): void;
  readonly storeKind: "memory" | "sqlite";
}

interface RequestScope {
  fault?: StoreUnavailableError;
}

function observeStore<S extends Store.AtomicStore>(store: S, scope: AsyncLocalStorage<RequestScope>): S {
  const note = (error: unknown): never => {
    if (error instanceof StoreUnavailableError) {
      const s = scope.getStore();
      if (s && !s.fault) s.fault = error;
    }
    throw error;
  };
  const wrapped = {
    get: (key: string) => store.get(key).catch(note),
    put: (key: string, value: unknown) => store.put(key, value as never).catch(note),
    delete: (key: string) => store.delete(key).catch(note),
    update: (key: string, fn: never) => store.update(key, fn).catch(note),
  };
  return Store.from(wrapped as unknown as Store.AtomicStore) as S;
}

function presentedType(request: Request): { presented: WorkerEvent["presented"]; challengeId: string | null } {
  const header = request.headers.get("authorization");
  if (!header || !/^Payment\s/i.test(header)) return { presented: "none", challengeId: null };
  try {
    const credential = Credential.fromRequest<{ type?: string }>(request);
    const type = credential.payload?.type;
    const presented = type === "transaction" || type === "signedHash" || type === "hash" ? type : "unparseable";
    return { presented, challengeId: credential.challenge.id };
  } catch {
    return { presented: "unparseable", challengeId: null };
  }
}

export function createWorkerApp(config: WorkerConfig): WorkerApp {
  const rawStore = openStore(config.store, { busyTimeoutMs: config.storeBusyTimeoutMs });
  const scope = new AsyncLocalStorage<RequestScope>();
  const store = observeStore(rawStore, scope);
  const eventsPath = eventLogPath(config.runDir, config.workerId);
  const fulfillPath = fulfillmentLogPath(config.runDir, config.workerId);
  let seq = 0;

  const mppx = Mppx.create({
    secretKey: config.mppSecret,
    // The realm is part of the challenge HMAC; it must be identical on every worker.
    realm: "chargeguard",
    methods: [
      stellar.charge({
        recipient: config.recipient,
        currency: config.currency,
        network: "stellar:testnet",
        store,
        challengeLifetimeSeconds: config.challengeTtlSeconds,
        pollDelayMs: config.pollDelayMs,
        pollTimeoutMs: config.pollTimeoutMs,
        pollMaxAttempts: config.pollMaxAttempts,
        ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
      }),
    ],
  });

  const record = (e: Omit<WorkerEvent, "seq" | "at" | "workerId" | "pid">) =>
    appendJsonLine(eventsPath, { seq: ++seq, at: new Date().toISOString(), workerId: config.workerId, pid: process.pid, ...e } satisfies WorkerEvent);

  async function paid(request: Request): Promise<Response> {
    const requestId = randomUUID();
    const { presented, challengeId } = presentedType(request);
    const ctx: RequestScope = {};
    try {
      const result = await scope.run(ctx, () =>
        mppx.charge({
          amount: config.amount,
          description: "ChargeGuard reference resource",
          expires: new Date(Date.now() + config.challengeTtlSeconds * 1000).toISOString(),
        })(request),
      );

      if (result.status === 402) {
        if (ctx.fault) {
          record({ requestId, presented, challengeId, outcome: "store_unavailable", status: 503, reference: null, reason: `${ctx.fault.code}: ${ctx.fault.message}`, fulfillmentId: null });
          return new Response(JSON.stringify({ error: "store_unavailable", code: ctx.fault.code }), {
            status: 503,
            headers: { "content-type": "application/json", "retry-after": "1", "x-chargeguard-worker": config.workerId },
          });
        }
        let reason: string | null = null;
        if (presented !== "none") {
          try {
            reason = ((await result.challenge.clone().json()) as { detail?: string }).detail ?? null;
          } catch {
            reason = null;
          }
        }
        record({
          requestId,
          presented,
          challengeId,
          outcome: presented === "none" ? "challenge_issued" : "rejected",
          status: 402,
          reference: null,
          reason,
          fulfillmentId: null,
        });
        const headers = new Headers(result.challenge.headers);
        headers.set("x-chargeguard-worker", config.workerId);
        return new Response(result.challenge.body, { status: 402, headers });
      }

      // Level "accepted" has happened (the SDK verified and claimed). Now level "fulfilled":
      const fulfillmentId = randomUUID();
      const response = result.withReceipt(Response.json({ fulfillmentId, workerId: config.workerId, resource: "chargeguard-reference-resource" }));
      const reference = (() => {
        try {
          const raw = response.headers.get("payment-receipt");
          return raw ? ((JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { reference?: string }).reference ?? null) : null;
        } catch {
          return null;
        }
      })();
      appendJsonLine(fulfillPath, {
        fulfillmentId,
        at: new Date().toISOString(),
        workerId: config.workerId,
        pid: process.pid,
        challengeId,
        reference,
      } satisfies FulfillmentRecord);
      record({ requestId, presented, challengeId, outcome: "accepted", status: 200, reference, reason: null, fulfillmentId });
      response.headers.set("x-chargeguard-worker", config.workerId);
      return response;
    } catch (error) {
      // Anything unexpected is a refusal, not an acceptance.
      const fault = ctx.fault ?? (error instanceof StoreUnavailableError ? error : undefined);
      record({
        requestId,
        presented,
        challengeId,
        outcome: fault ? "store_unavailable" : "error",
        status: fault ? 503 : 500,
        reference: null,
        reason: (error as Error).message,
        fulfillmentId: null,
      });
      return new Response(JSON.stringify({ error: fault ? "store_unavailable" : "internal_error" }), {
        status: fault ? 503 : 500,
        headers: { "content-type": "application/json", "x-chargeguard-worker": config.workerId },
      });
    }
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === PAID_PATH) return paid(request);
    if (url.pathname === HEALTH_PATH) {
      try {
        await scope.run({}, () => store.get("chargeguard:health"));
        return Response.json({ workerId: config.workerId, store: formatStoreSpec(config.store), healthy: true });
      } catch (error) {
        return Response.json({ workerId: config.workerId, store: formatStoreSpec(config.store), healthy: false, error: (error as Error).message }, { status: 503 });
      }
    }
    if (url.pathname === INSPECT_PATH) {
      const key = url.searchParams.get("key");
      if (!key) return new Response("key required", { status: 400 });
      try {
        const value = await scope.run({}, () => store.get(key));
        return Response.json({ key, value: JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) });
      } catch (error) {
        return Response.json({ key, error: (error as Error).message }, { status: 503 });
      }
    }
    return new Response("not found", { status: 404 });
  }

  return {
    handle,
    close: () => rawStore.close?.(),
    storeKind: config.store.kind,
  };
}
