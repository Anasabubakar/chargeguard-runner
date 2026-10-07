import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { tryStartWorker, type WorkerOptions } from "../src/harness/workers.ts";
import { EXIT_CONFIG } from "../src/worker/exit-codes.ts";

const base = (): WorkerOptions => ({
  id: "w",
  store: "memory",
  runDir: mkdtempSync(join(process.env.CHARGEGUARD_TMPDIR ?? tmpdir(), "cg-worker-")),
  recipient: Keypair.random().publicKey(),
  mppSecret: "k".repeat(40),
});

describe("worker process", () => {
  it("a worker with no store setting exits 78 and says why, without listening", async () => {
    const r = await tryStartWorker({ ...base(), store: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.exitCode).toBe(EXIT_CONFIG);
      expect(r.stderr).toMatch(/no store configured/);
      expect(r.stderr).toMatch(/Refusing to start/);
    }
  });

  it("a worker with an explicit memory store starts, binds to loopback only, and issues a 402 challenge", async () => {
    const r = await tryStartWorker(base());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    try {
      expect(r.worker.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await fetch(`${r.worker.url}/paid`);
      expect(res.status).toBe(402);
      expect(res.headers.get("www-authenticate")).toMatch(/^Payment /);
      expect(res.headers.get("x-chargeguard-worker")).toBe("w");
      expect((await fetch(`${r.worker.url}/elsewhere`)).status).toBe(404);
    } finally {
      await r.worker.stop();
    }
  });

  it("two challenges from two different workers share a realm and secret, so either can verify the other's", async () => {
    const options = base();
    const a = await tryStartWorker({ ...options, id: "a" });
    const b = await tryStartWorker({ ...options, id: "b" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    try {
      const ca = (await fetch(`${a.worker.url}/paid`)).headers.get("www-authenticate")!;
      const cb = (await fetch(`${b.worker.url}/paid`)).headers.get("www-authenticate")!;
      for (const h of [ca, cb]) expect(h).toContain('realm="chargeguard"');
    } finally {
      await a.worker.stop();
      await b.worker.stop();
    }
  });
});
