import { broadcastsOf, check, newPayment, present } from "./helpers.ts";
import type { Scenario } from "./types.ts";

export const repeatedCredential: Scenario = {
  id: "repeated-credential",
  title: "Repeated credential across workers",
  invariant: "A credential that one worker accepted is not accepted by the other worker, and the paid resource is delivered once.",
  stores: ["memory", "sqlite"],
  backends: ["stub", "testnet"],
  plan: (p) => [
    `Start worker-a and worker-b, each a separate OS process, store ${p.store === "memory" ? "memory (one private map per process)" : "sqlite (one shared file)"}.`,
    `Obtain one challenge and build one ${p.mode}-mode credential with the official client.`,
    "Present the credential to worker-a, then the identical credential to worker-b, then to worker-a again.",
  ],
  expected: (p) => (p.store === "memory" ? "fail" : "pass"),
  async run(ctx) {
    const [a, b] = await ctx.startPair();
    const pay = await newPayment(ctx, a, "payment");

    const first = await present(ctx, a, pay, "first presentation");
    const second = await present(ctx, b, pay, "replay to the other worker");
    const third = await present(ctx, a, pay, "replay to the first worker");

    const accepted = [first, second, third].filter((r) => r.status === 200).length;
    const broadcasts = broadcastsOf(ctx, pay.payment.txHash);
    const out = [
      check("first-presentation-accepted", "The first presentation is accepted (otherwise the run proves nothing).", first.status === 200, `worker-a answered ${first.status}.`),
      check("single-acceptance", "At most one response across both workers accepts the credential.", accepted <= 1, `${accepted} of 3 presentations were accepted (${[first, second, third].map((r) => r.status).join(", ")}).`),
    ];
    // Filled in after levels are computed: single-fulfillment needs the workers' logs.
    out.push(
      check(
        "store-level-protection",
        "The replay is stopped by the store before any second transaction reaches the chain, not only by the ledger's sequence rule.",
        ctx.mode === "pull" ? broadcasts <= 1 : accepted <= 1,
        ctx.mode === "pull"
          ? `${broadcasts} sendTransaction call${broadcasts === 1 ? "" : "s"} for this transaction reached the chain (answers: ${ctx.env.chain.sendLog.filter((e) => e.hash === pay.payment.txHash).map((e) => e.outcome).join(", ") || "none"}).`
          : `push mode: the chain cannot refuse a repeated hash, so the store is the only defence; ${accepted} acceptance${accepted === 1 ? "" : "s"}.`,
      ),
    );
    if (ctx.mode === "pull" && accepted <= 1 && broadcasts > 1) {
      ctx.observe("The second worker's broadcast of the same signed transaction was refused by the network (sequence number already used). The deployment was saved by the ledger, not by its store.");
    }
    return out;
  },
};
