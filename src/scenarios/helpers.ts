import type { Payer } from "../harness/client.ts";
import type { AttemptResult, PaymentRecord, RunContext } from "../harness/run.ts";
import type { WorkerHandle } from "../harness/workers.ts";
import type { Check } from "../report/schema.ts";
import { HarnessError } from "./types.ts";

export interface NewPayment {
  payer: Payer;
  payment: PaymentRecord;
  authorization: string;
  challenge: AttemptResult;
}

/**
 * Asks `issuer` for a challenge and builds a credential with the official client.
 * Push mode: the payer broadcasts and confirms on the chain here (level: submitted by client).
 * Pull mode: the payer only signs; the worker that receives the credential submits.
 */
export async function newPayment(ctx: RunContext, issuer: WorkerHandle, label: string): Promise<NewPayment> {
  const payer = ctx.payer();
  const challenge = await ctx.attempt(issuer, `${label}: request challenge from ${issuer.id}`);
  if (challenge.status !== 402 || !challenge.response) {
    throw new HarnessError(`${issuer.id} did not issue a challenge (status ${challenge.status}${challenge.detail ? `: ${challenge.detail}` : ""})`);
  }
  let authorization: string;
  try {
    authorization = await payer.createCredential(challenge.response);
  } catch (error) {
    throw new HarnessError(`client could not build a ${payer.mode}-mode credential: ${(error as Error).message}`);
  }
  const payment = ctx.registerPayment(authorization, payer.mode);
  ctx.fault(
    payer.mode === "push" ? "client-paid" : "client-signed",
    payer.mode === "push" ? `payer broadcast and confirmed transaction ${payment.txHash.slice(0, 12)}… itself (push)` : `payer signed transaction ${payment.txHash.slice(0, 12)}… without broadcasting (pull)`,
  );
  return { payer, payment, authorization, challenge };
}

export const present = (ctx: RunContext, worker: WorkerHandle, p: { authorization: string; payment: PaymentRecord }, label: string) =>
  ctx.attempt(worker, `${label}: present ${p.payment.id} to ${worker.id}`, { authorization: p.authorization, payment: p.payment });

export function check(id: string, description: string, passed: boolean, detail: string): Check {
  return { id, description, passed, detail };
}

/** Number of times a payment's transaction reached the chain, by any sender. */
export function broadcastsOf(ctx: RunContext, txHash: string): number {
  return ctx.env.chain.sendLog.filter((e) => e.hash === txHash).length;
}

/** Reads one store key through a worker's test-harness inspect route. */
export async function inspectKey(worker: WorkerHandle, key: string): Promise<unknown> {
  const response = await fetch(`${worker.url}/__chargeguard/inspect?key=${encodeURIComponent(key)}`);
  const json = (await response.json()) as { value?: unknown; error?: string };
  return response.ok ? (json.value ?? null) : `unreadable: ${json.error ?? response.status}`;
}

/** The SDK's own key for a challenge claim (see @stellar/mpp charge/server, STORE_PREFIX). */
export const challengeKey = (challengeId: string) => `stellar:charge:challenge:${challengeId}`;
