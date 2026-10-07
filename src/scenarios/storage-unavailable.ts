import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tryStartWorker } from "../harness/workers.ts";
import { EXIT_CONFIG, EXIT_STORE } from "../worker/exit-codes.ts";
import { broadcastsOf, check, newPayment, present } from "./helpers.ts";
import type { Scenario } from "./types.ts";

export const storageUnavailable: Scenario = {
  id: "storage-unavailable",
  title: "Storage unavailable: fail closed, never fall back",
  invariant: "When the shared store cannot answer, a worker refuses (503) and never accepts, never delivers, and never falls back to a local in-memory store; a worker with no store configuration refuses to start.",
  stores: ["sqlite"],
  backends: ["stub", "testnet"],
  plan: (p) => [
    "Start a worker with no store setting, with an empty one and with an unknown backend: each must exit with the configuration refusal code (78).",
    "Start a worker pointing at a sqlite file that does not exist: it must refuse to start (70) and must not create the file.",
    `Start worker-a and worker-b on one shared sqlite file. Build a ${p.mode}-mode credential.`,
    "Hold an exclusive write lock on the database from the runner, present the credential to both workers (expect 503, no acceptance, no broadcast), release the lock, present again (expect it to be accepted once: the failed attempts did not consume it).",
    "Build a second credential, delete the database file under the running workers, present it (expect 503 and an unhealthy /health), then try to restart a worker on the missing file (expect refusal).",
  ],
  expected: () => "pass",
  async run(ctx) {
    const out = [];

    // 1. Configuration that must stop a worker from starting.
    const noStore = await tryStartWorker(ctx.workerOptions("worker-x", { store: undefined }));
    const emptyStore = await tryStartWorker(ctx.workerOptions("worker-x", { store: "" }));
    const unknownStore = await tryStartWorker(ctx.workerOptions("worker-x", { store: "redis://localhost:6379" }));
    for (const r of [noStore, emptyStore, unknownStore]) if (r.ok) await r.worker.stop();
    ctx.fault("start-without-store", "worker started with CHARGEGUARD_STORE unset, empty, and set to an unknown backend");
    const refusedConfig = [noStore, emptyStore, unknownStore].every((r) => !r.ok && r.exitCode === EXIT_CONFIG);
    out.push(
      check(
        "missing-store-config-refuses-to-start",
        "A worker with no store configuration (unset, empty or unknown) refuses to start with exit code 78.",
        refusedConfig,
        [noStore, emptyStore, unknownStore].map((r, i) => `${["unset", "empty", "unknown backend"][i]}: ${r.ok ? "STARTED" : `exit ${r.exitCode}`}`).join("; ") + (noStore.ok ? "" : ` | message: ${noStore.stderr.trim().split("\n")[0]}`),
      ),
    );

    const missingPath = join(ctx.env.runDir, "does-not-exist.db");
    const missingFile = await tryStartWorker(ctx.workerOptions("worker-x", { store: `sqlite:${missingPath}` }));
    if (missingFile.ok) await missingFile.worker.stop();
    out.push(
      check(
        "missing-database-refuses-to-start",
        "A worker pointed at a sqlite file that does not exist refuses to start (exit 70) instead of creating an empty private store.",
        !missingFile.ok && missingFile.exitCode === EXIT_STORE,
        missingFile.ok ? "STARTED" : `exit ${missingFile.exitCode}: ${missingFile.stderr.trim().split("\n")[0]}`,
      ),
    );

    // 2. Locked database.
    const [a, b] = await (async () => {
      ctx.initSharedStore();
      const wa = await ctx.startWorker("worker-a", { storeBusyMs: 250 });
      const wb = await ctx.startWorker("worker-b", { storeBusyMs: 250 });
      return [wa, wb] as const;
    })();
    const p1 = await newPayment(ctx, a, "payment before the lock");
    const locker = new DatabaseSync(ctx.dbPath);
    locker.exec("BEGIN EXCLUSIVE");
    ctx.fault("lock-database", "runner holds BEGIN EXCLUSIVE on the shared database");
    const lockedA = await present(ctx, a, p1, "while locked");
    const lockedB = await present(ctx, b, p1, "while locked");
    const challengeWhileLocked = await ctx.attempt(a, "challenge request while locked (stateless, should still work)");
    const broadcastsWhileLocked = broadcastsOf(ctx, p1.payment.txHash);
    locker.exec("ROLLBACK");
    locker.close();
    ctx.fault("unlock-database", "runner released the lock");
    const afterUnlock = await present(ctx, b, p1, "after unlock");
    const afterUnlockAgain = await present(ctx, a, p1, "after unlock, replay");

    out.push(
      check(
        "locked-store-fails-closed",
        "While the database is locked both workers answer 503 and accept nothing.",
        lockedA.status === 503 && lockedB.status === 503,
        `worker-a ${lockedA.status}, worker-b ${lockedB.status}${lockedA.detail ? ` (${lockedA.detail})` : ""}.`,
      ),
      check(
        "locked-store-no-broadcast",
        "No transaction for the credential reaches the chain while the store cannot record the claim.",
        broadcastsWhileLocked === 0,
        `${broadcastsWhileLocked} sendTransaction call(s) while locked${ctx.mode === "push" ? " (push mode: the payer had already paid before the lock, which is not a worker action)" : ""}.`,
      ),
      check("locked-store-recovers", "After the lock is released the same credential is accepted once (the failed attempts did not consume it) and not twice.", afterUnlock.status === 200 && afterUnlockAgain.status !== 200, `after unlock: worker-b ${afterUnlock.status}, then worker-a replay ${afterUnlockAgain.status}.`),
    );
    ctx.observe(`Challenge issuance does not touch the store (the id is an HMAC), so a worker with a locked store still issues challenges: it answered ${challengeWhileLocked.status}. Only verification needs the store.`);

    // 3. Database removed under running workers.
    const p2 = await newPayment(ctx, b, "payment before the file is removed");
    rmSync(ctx.dbPath);
    ctx.fault("remove-database", "shared database file deleted while both workers keep running");
    const removedA = await present(ctx, a, p2, "database removed");
    const removedB = await present(ctx, b, p2, "database removed");
    const health = await fetch(`${b.url}/__chargeguard/health`).then((r) => r.status).catch(() => 0);
    const restart = await tryStartWorker(ctx.workerOptions("worker-b", { store: `sqlite:${ctx.dbPath}` }));
    if (restart.ok) await restart.worker.stop();
    out.push(
      check("removed-store-fails-closed", "With the database file deleted both workers answer 503 and accept nothing (no silent fall back to a local map).", removedA.status === 503 && removedB.status === 503, `worker-a ${removedA.status}, worker-b ${removedB.status}.`),
      check("removed-store-reports-unhealthy", "The worker's health endpoint reports the store as unhealthy (503).", health === 503, `GET /__chargeguard/health answered ${health}.`),
      check("removed-store-no-restart", "A worker restarted against the missing database refuses to start (exit 70).", !restart.ok && restart.exitCode === EXIT_STORE, restart.ok ? "STARTED" : `exit ${restart.exitCode}`),
    );
    return out;
  },
};
