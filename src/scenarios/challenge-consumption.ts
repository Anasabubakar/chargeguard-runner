import { Credential } from "mppx";
import { broadcastsOf, check, newPayment, present } from "./helpers.ts";
import type { Scenario } from "./types.ts";

export const challengeConsumption: Scenario = {
  id: "challenge-consumption",
  title: "Challenge consumption",
  invariant: "A challenge is accepted at most once, across both workers; a forged or expired challenge is never accepted.",
  stores: ["memory", "sqlite"],
  backends: ["stub", "testnet"],
  plan: (p) => [
    `Start worker-a and worker-b (store ${p.store === "memory" ? "memory" : "sqlite, one shared file"}).`,
    `Get one challenge and pay it twice with two distinct ${p.mode}-mode credentials (two transactions, one challenge).`,
    "Present the first to worker-a and the second to worker-b, then to worker-a.",
    "Present a credential whose challenge id was altered by one character to both workers.",
    "Start worker-c with a 2 second challenge lifetime, wait for it to lapse, present a credential for the lapsed challenge.",
  ],
  expected: (p) => (p.store === "memory" ? "fail" : "pass"),
  async run(ctx) {
    const [a, b] = await ctx.startPair();

    // Two payments against one challenge. The first is presented before the second is built so that in
    // pull mode the payer's sequence number has moved on and the second transaction is a distinct payment.
    const first = await newPayment(ctx, a, "first payment");
    const r1 = await present(ctx, a, first, "first credential");
    const secondAuthorization = await first.payer.createCredential(first.challenge.response!.clone());
    const second = { authorization: secondAuthorization, payment: ctx.registerPayment(secondAuthorization, first.payer.mode) };
    ctx.fault(
      first.payer.mode === "push" ? "client-paid" : "client-signed",
      `second credential for the same challenge built (${second.payment.txHash.slice(0, 12)}…)`,
    );
    const distinct = second.payment.txHash !== first.payment.txHash;
    const r2 = await present(ctx, b, second, "second credential, same challenge, other worker");
    const r3 = await present(ctx, a, second, "second credential, same challenge, same worker");
    const accepted = [r1, r2, r3].filter((r) => r.status === 200).length;

    const out = [
      check("two-distinct-payments", "The two credentials are distinct payments for the same challenge (otherwise the run only repeats the replay test).", distinct && first.payment.challengeId === second.payment.challengeId, `challenge ${first.payment.challengeId.slice(0, 10)}…, transactions ${first.payment.txHash.slice(0, 10)}… and ${second.payment.txHash.slice(0, 10)}….`),
      check("first-accepted", "The first credential is accepted.", r1.status === 200, `answered ${r1.status}.`),
      check("challenge-accepted-once", "The challenge is accepted at most once across both workers.", accepted <= 1, `${accepted} acceptance(s); statuses ${[r1, r2, r3].map((r) => r.status).join(", ")}.`),
    ];

    // Forged challenge: change one character of the challenge id, keep everything else.
    const forged = (() => {
      const credential = Credential.deserialize(first.authorization);
      const id = credential.challenge.id;
      const tweaked = id.slice(0, -1) + (id.endsWith("A") ? "B" : "A");
      return Credential.serialize({ ...credential, challenge: { ...credential.challenge, id: tweaked } });
    })();
    const forgedA = await ctx.attempt(a, "forged challenge id presented to worker-a", { authorization: forged });
    const forgedB = await ctx.attempt(b, "forged challenge id presented to worker-b", { authorization: forged });
    out.push(check("forged-challenge-rejected", "A credential whose challenge id was altered is rejected by both workers.", forgedA.status === 402 && forgedB.status === 402, `worker-a ${forgedA.status}, worker-b ${forgedB.status}.`));

    // Expired challenge, on a worker with a short lifetime. Pull mode is used here whatever the scenario mode:
    // a credential costs nothing to build, and "no broadcast happened" shows the refusal came before settlement.
    // Testnet needs a longer lifetime: a transaction whose maxTime is a few seconds away can be refused as txTooLate before it is included.
    const lapseSeconds = ctx.env.stub ? 2 : 20;
    const c = await ctx.startWorker("worker-c", { ttlSeconds: lapseSeconds });
    const expiring = await ctx.attempt(c, `challenge from worker-c (${lapseSeconds} second lifetime)`);
    const lapsed = await ctx.payer("pull").createCredential(expiring.response!);
    const lapsedPayment = ctx.registerPayment(lapsed, "pull");
    await new Promise((resolve) => setTimeout(resolve, lapseSeconds * 1000 + 700));
    ctx.fault("wait", `waited ${(lapseSeconds * 1000 + 700) / 1000} s so the ${lapseSeconds} second challenge lapsed`);
    const lapsedResult = await ctx.attempt(c, `present ${lapsedPayment.id} after its challenge lapsed`, { authorization: lapsed, payment: lapsedPayment });
    const lapsedBroadcasts = broadcastsOf(ctx, lapsedPayment.txHash);
    const freshChallenge = await ctx.attempt(c, "fresh challenge from worker-c (control)");
    const freshAuthorization = await ctx.payer("pull").createCredential(freshChallenge.response!);
    const freshPayment = ctx.registerPayment(freshAuthorization, "pull");
    const freshResult = await ctx.attempt(c, `present ${freshPayment.id} within its lifetime (control)`, { authorization: freshAuthorization, payment: freshPayment });
    out.push(
      check("expired-challenge-rejected", "A credential for a challenge past its lifetime is refused (402) before anything is broadcast.", lapsedResult.status === 402 && lapsedBroadcasts === 0, `answered ${lapsedResult.status}; ${lapsedBroadcasts} broadcast(s) for its transaction.`),
      check("expiry-control", "The same worker accepts a fresh credential within its lifetime, so the refusal above was about the lapsed challenge.", freshResult.status === 200, `control answered ${freshResult.status}.`),
    );

    if (accepted <= 1 && second.payment.txHash !== first.payment.txHash) {
      ctx.observe(
        "Consuming a challenge does not refund or void a second payment made against it: the second transaction is a separate on-chain payment that no worker delivered for. Whether that is acceptable is an operator decision; the report shows it as submitted/confirmed with zero fulfillments.",
      );
    }
    return out;
  },
};
