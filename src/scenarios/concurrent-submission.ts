import { broadcastsOf, check, newPayment } from "./helpers.ts";
import type { Scenario } from "./types.ts";

export const concurrentSubmission: Scenario = {
  id: "concurrent-submission",
  title: "Concurrent submission of one credential to both workers",
  invariant: "When the same credential reaches both workers at the same moment, at most one accepts it, in every round.",
  stores: ["memory", "sqlite"],
  backends: ["stub", "testnet"],
  plan: (p) => [
    `Start worker-a and worker-b (store ${p.store === "memory" ? "memory" : "sqlite, one shared file"}).`,
    `Repeat ${p.rounds} times: build a fresh ${p.mode}-mode credential, then send it to worker-a and worker-b twice each, all four requests in flight together.`,
    "Count acceptances per round. A single round with two acceptances is a failure; zero failures in N rounds is evidence, not proof.",
  ],
  expected: (p) => (p.store === "memory" ? "fail" : "pass"),
  async run(ctx, params) {
    const [a, b] = await ctx.startPair();
    const perRound: Array<{ accepted: number; broadcasts: number; statuses: number[] }> = [];
    for (let round = 1; round <= params.rounds; round++) {
      const pay = await newPayment(ctx, round % 2 === 0 ? b : a, `round ${round}`);
      const targets = [a, b, a, b];
      const results = await Promise.all(
        targets.map((w, i) => ctx.attempt(w, `round ${round}: concurrent presentation ${i + 1} of ${pay.payment.id} to ${w.id}`, { authorization: pay.authorization, payment: pay.payment })),
      );
      perRound.push({ accepted: results.filter((r) => r.status === 200).length, broadcasts: broadcastsOf(ctx, pay.payment.txHash), statuses: results.map((r) => r.status) });
    }
    const worst = Math.max(...perRound.map((r) => r.accepted));
    const roundsWithMany = perRound.filter((r) => r.accepted > 1).length;
    const roundsWithNone = perRound.filter((r) => r.accepted === 0).length;
    const extraBroadcast = perRound.filter((r) => r.broadcasts > 1).length;
    const out = [
      check(
        "liveness",
        "In every round exactly one of the competing requests is accepted (the payment is not lost to the race).",
        roundsWithNone === 0,
        `${roundsWithNone} of ${perRound.length} rounds had no acceptance.`,
      ),
      check(
        "single-acceptance-per-round",
        "In every round at most one response accepts the credential.",
        worst <= 1,
        `${roundsWithMany} of ${perRound.length} rounds had more than one acceptance; accepted per round: ${perRound.map((r) => r.accepted).join(", ")}.`,
      ),
    ];
    if (ctx.mode === "pull") {
      out.push(
        check(
          "store-level-protection",
          "No round let a second broadcast of the same transaction reach the chain.",
          extraBroadcast === 0,
          `${extraBroadcast} of ${perRound.length} rounds sent the same signed transaction to the chain more than once.`,
        ),
      );
    }
    return out;
  },
};
