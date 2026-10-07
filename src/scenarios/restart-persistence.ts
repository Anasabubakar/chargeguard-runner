import { broadcastsOf, check, newPayment, present } from "./helpers.ts";
import type { Scenario } from "./types.ts";

export const restartPersistence: Scenario = {
  id: "restart-persistence",
  title: "Worker restart persistence",
  invariant: "A credential consumed before a worker is killed and restarted stays consumed afterwards.",
  stores: ["memory", "sqlite"],
  backends: ["stub", "testnet"],
  plan: (p) => [
    `Start worker-a and worker-b (store ${p.store === "memory" ? "memory" : "sqlite, one shared file"}).`,
    `Build a ${p.mode}-mode credential and have worker-a accept it.`,
    "Kill worker-a with SIGKILL (no shutdown hooks) and start a new process with the same configuration.",
    "Present the consumed credential to the restarted worker-a and to worker-b.",
    "Build a second credential and present it to the restarted worker-a (it must still serve new payments).",
  ],
  expected: (p) => (p.store === "memory" ? "fail" : "pass"),
  async run(ctx) {
    const [a0, b] = await ctx.startPair();
    const pay = await newPayment(ctx, a0, "first payment");
    const first = await present(ctx, a0, pay, "before restart");
    const a1 = await ctx.crashAndRestart(a0);
    const afterA = await present(ctx, a1, pay, "after restart");
    const afterB = await present(ctx, b, pay, "to the other worker after restart");
    const fresh = await newPayment(ctx, a1, "second payment");
    const second = await present(ctx, a1, fresh, "new payment on restarted worker");

    const accepted = [first, afterA, afterB].filter((r) => r.status === 200).length;
    const broadcasts = broadcastsOf(ctx, pay.payment.txHash);
    const out = [
      check("accepted-before-restart", "The credential is accepted before the restart.", first.status === 200, `answered ${first.status}.`),
      check("stays-consumed", "After the restart the credential is not accepted again by the restarted worker or by the other worker.", accepted <= 1, `${accepted} acceptance${accepted === 1 ? "" : "s"} in total; after restart: worker-a ${afterA.status}, worker-b ${afterB.status}.`),
      check("serves-new-payments", "The restarted worker still accepts a new, valid payment.", second.status === 200, `answered ${second.status}.`),
    ];
    if (ctx.mode === "pull") {
      out.push(check("store-level-protection", "No second broadcast of the consumed transaction reached the chain after the restart.", broadcasts <= 1, `${broadcasts} sendTransaction call${broadcasts === 1 ? "" : "s"} for the first transaction.`));
    }
    return out;
  },
};
