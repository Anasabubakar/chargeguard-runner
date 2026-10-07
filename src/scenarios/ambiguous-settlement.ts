import { DatabaseSync } from "node:sqlite";
import { broadcastsOf, challengeKey, check, inspectKey, newPayment, present } from "./helpers.ts";
import type { Scenario } from "./types.ts";

export const AMBIGUOUS_VARIANTS = ["unconfirmed-then-lands", "broadcast-rejected", "onchain-failed", "store-fault-after-broadcast", "verification-rpc-outage"] as const;

const PLANS: Record<string, string[]> = {
  "unconfirmed-then-lands": [
    "Stub chain accepts the broadcast (PENDING) but reports NOT_FOUND until the runner lands it.",
    "Present a pull credential to worker-a: it must wait out its polling budget and answer without delivering.",
    "Retry the same credential on worker-a and worker-b: both must refuse and no second broadcast may occur.",
    "Land the transaction on the stub (SUCCESS) and record the four levels: paid on chain, not delivered.",
  ],
  "broadcast-rejected": [
    "Stub chain answers sendTransaction with a synchronous ERROR (the transaction never enters the mempool).",
    "Present a pull credential to worker-a: it must refuse without delivering.",
    "Restore the chain and present the same credential to worker-b: it must be accepted exactly once (the claim was released).",
  ],
  "onchain-failed": [
    "Stub chain accepts the broadcast and then reports the transaction as FAILED.",
    "Present a pull credential to worker-a: it must refuse without delivering.",
    "Retry on worker-b: record whether the challenge stays locked, and that no second broadcast occurs.",
  ],
  "store-fault-after-broadcast": [
    "When the stub receives the worker's broadcast, the runner takes an exclusive lock on the shared database.",
    "The worker's next store write (recording the pending hash) fails while the transaction is already on the chain.",
    "Present the credential to worker-a (expect 503), release the lock, retry on worker-b: record whether it stays locked and that no second broadcast occurs.",
  ],
  "verification-rpc-outage": [
    "Push mode: the payer pays and confirms on the stub chain.",
    "The stub's getTransaction starts failing; present the credential to worker-a (expect refusal, no delivery).",
    "Restore the chain and retry the same credential on worker-b: record whether the challenge was burned by the outage.",
  ],
};

export const ambiguousSettlement: Scenario = {
  id: "ambiguous-settlement",
  title: "Ambiguous settlement outcomes",
  invariant: "When settlement cannot be confirmed, the worker does not deliver, does not broadcast the same transaction a second time, and the report says which of the four levels were reached.",
  variants: AMBIGUOUS_VARIANTS,
  stores: ["sqlite"],
  backends: ["stub"],
  plan: (p) => PLANS[p.variant ?? ""] ?? [],
  expected: () => "pass",
  async run(ctx, params) {
    const chain = ctx.env.stub!;
    const variant = params.variant;
    // The settlement wait is bounded by the transaction's validity (the challenge lifetime), so these
    // runs use a short lifetime to keep the ambiguous window to a few seconds.
    const ttl = 4;
    ctx.initSharedStore();
    const a = await ctx.startWorker("worker-a", { ttlSeconds: ttl, storeBusyMs: 300 });
    const b = await ctx.startWorker("worker-b", { ttlSeconds: ttl, storeBusyMs: 300 });

    if (variant === "verification-rpc-outage") {
      const pay = await newPayment(ctx, a, "payment");
      chain.faults.lookup = "error";
      ctx.fault("chain-lookup-outage", "stub getTransaction answers with an error");
      const during = await present(ctx, a, pay, "during chain lookup outage");
      chain.faults.lookup = "ok";
      ctx.fault("chain-lookup-restored", "stub getTransaction restored");
      const state = await inspectKey(a, challengeKey(pay.payment.challengeId));
      const retry = await present(ctx, b, pay, "retry after the outage");
      const out = [
        check("no-delivery-without-confirmation", "During the outage the worker does not deliver.", during.status !== 200, `answered ${during.status}.`),
        check("no-double-delivery", "The credential is delivered at most once overall.", [during, retry].filter((r) => r.status === 200).length <= 1, `statuses ${during.status}, ${retry.status}.`),
      ];
      ctx.observe(
        retry.status === 200
          ? "After the outage the same credential was accepted: the outage did not burn the challenge."
          : `After the outage the same credential was refused (${retry.status}). The challenge was already claimed when the lookup failed (store state: ${JSON.stringify(state)}) and a push-mode failure does not release it, so a payer who paid on chain needs a reconciliation or a new challenge.`,
      );
      return out;
    }

    const pay = await newPayment(ctx, a, "payment");
    const hash = pay.payment.txHash;

    if (variant === "unconfirmed-then-lands") {
      chain.faults.land = "manual";
      ctx.fault("chain-hold", "stub accepts broadcasts but will not confirm them");
      const first = await present(ctx, a, pay, "broadcast, never confirmed");
      const state = await inspectKey(a, challengeKey(pay.payment.challengeId));
      const retryA = await present(ctx, a, pay, "retry while unresolved");
      const retryB = await present(ctx, b, pay, "retry while unresolved");
      const broadcasts = broadcastsOf(ctx, hash);
      const landed = chain.land(hash, "SUCCESS");
      ctx.fault("chain-land", `runner landed ${hash.slice(0, 12)}… as ${landed.status}`);
      const out = [
        check("no-delivery-while-unconfirmed", "The unconfirmed payment is not delivered.", first.status !== 200, `answered ${first.status}.`),
        check("no-rebroadcast", "Retrying does not broadcast the transaction again.", broadcasts === 1, `${broadcasts} sendTransaction call(s) for the transaction.`),
        check("retries-refused-while-unresolved", "Retries on both workers are refused while the outcome is unresolved.", retryA.status !== 200 && retryB.status !== 200, `worker-a ${retryA.status}, worker-b ${retryB.status}.`),
      ];
      ctx.observe(`While unresolved the store held ${JSON.stringify(state)} for the challenge. After the runner landed the transaction the chain says SUCCESS but nothing was delivered: this payment needs reconciliation by the operator.`);
      return out;
    }

    if (variant === "broadcast-rejected") {
      chain.faults.send = "error";
      ctx.fault("chain-send-error", "stub answers sendTransaction with a synchronous ERROR");
      const first = await present(ctx, a, pay, "broadcast rejected");
      chain.faults.send = "ok";
      ctx.fault("chain-send-restored", "stub accepts broadcasts again");
      const retry = await present(ctx, b, pay, "retry after the chain recovered");
      const again = await present(ctx, a, pay, "replay after acceptance");
      return [
        check("no-delivery-when-rejected", "A broadcast the network rejected is not delivered.", first.status !== 200, `answered ${first.status}.`),
        check("claim-released-for-retry", "Because the transaction never reached the network the claim is released and the same credential is accepted on retry.", retry.status === 200, `retry answered ${retry.status}.`),
        check("accepted-once", "After the retry the credential is not accepted again.", again.status !== 200, `replay answered ${again.status}.`),
      ];
    }

    if (variant === "onchain-failed") {
      chain.faults.landAs = "FAILED";
      ctx.fault("chain-fail", "stub confirms the broadcast as FAILED");
      const first = await present(ctx, a, pay, "broadcast, chain reports FAILED");
      const state = await inspectKey(a, challengeKey(pay.payment.challengeId));
      const retry = await present(ctx, b, pay, "retry after FAILED");
      const broadcasts = broadcastsOf(ctx, hash);
      ctx.observe(`The chain reported FAILED, which is a definitive answer, yet the store kept ${JSON.stringify(state)}: the SDK groups an on-chain failure with 'ambiguous' and leaves the challenge locked (retry answered ${retry.status}).`);
      return [
        check("no-delivery-on-failed", "A transaction that failed on chain is not delivered.", first.status !== 200 && retry.status !== 200, `first ${first.status}, retry ${retry.status}.`),
        check("no-rebroadcast", "Retrying does not broadcast the failed transaction again.", broadcasts === 1, `${broadcasts} sendTransaction call(s).`),
      ];
    }

    if (variant === "store-fault-after-broadcast") {
      let locker: DatabaseSync | null = null;
      chain.onSend = () => {
        locker = new DatabaseSync(ctx.dbPath);
        locker.exec("BEGIN EXCLUSIVE");
        ctx.fault("lock-database", "runner locked the shared database as the broadcast arrived at the chain");
      };
      const first = await present(ctx, a, pay, "store fails after broadcast");
      chain.onSend = null;
      if (locker) {
        (locker as DatabaseSync).exec("ROLLBACK");
        (locker as DatabaseSync).close();
        ctx.fault("unlock-database", "runner released the lock");
      }
      const state = await inspectKey(b, challengeKey(pay.payment.challengeId));
      const retry = await present(ctx, b, pay, "retry after the store recovered");
      const broadcasts = broadcastsOf(ctx, hash);
      ctx.observe(`The transaction was already on the chain when the store failed; afterwards the store held ${JSON.stringify(state)} and the retry answered ${retry.status}. The payer paid and was not served; this needs reconciliation.`);
      return [
        check("fails-closed-after-broadcast", "A store fault after the broadcast is answered 503 and delivers nothing.", first.status === 503, `answered ${first.status}.`),
        check("no-delivery-after-fault", "The retry does not deliver a payment the store could not record.", retry.status !== 200, `retry answered ${retry.status}.`),
        check("no-rebroadcast", "Retrying does not broadcast the transaction again.", broadcasts === 1, `${broadcasts} sendTransaction call(s).`),
      ];
    }

    throw new Error(`unknown variant ${String(variant)}`);
  },
};
