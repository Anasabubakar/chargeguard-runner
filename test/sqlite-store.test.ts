import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { Store } from "mppx/server";
import { StoreUnavailableError } from "../src/errors.ts";
import { openSqliteStore } from "../src/store/sqlite.ts";
import { scratch } from "./helpers.ts";

const run = promisify(execFile);
const child = new URL("./fixtures/claim-child.ts", import.meta.url).pathname;

// The same behavioural contract is asserted against mppx's own Store.memory() so the adapter
// is held to what the reference implementation does, not to its own idea of correct.
const impls: Array<[string, () => Store.AtomicStore]> = [
  ["mppx Store.memory()", () => Store.memory()],
  ["sqlite adapter", () => openSqliteStore(join(scratch(), "s.db"), { create: true })],
];

describe.each(impls)("AtomicStore contract: %s", (_name, make) => {
  it("round-trips nested values and returns null for a missing key", async () => {
    const s = make();
    expect(await s.get("missing")).toBeNull();
    await s.put("k", { a: 1, nested: { list: [1, 2, 3], ok: true } });
    expect(await s.get("k")).toEqual({ a: 1, nested: { list: [1, 2, 3], ok: true } });
  });

  it("round-trips bigint values", async () => {
    const s = make();
    await s.put("k", { amount: 12345678901234567890n });
    expect(await s.get("k")).toEqual({ amount: 12345678901234567890n });
  });

  it("put overwrites and delete removes", async () => {
    const s = make();
    await s.put("k", { v: 1 });
    await s.put("k", { v: 2 });
    expect(await s.get("k")).toEqual({ v: 2 });
    await s.delete("k");
    expect(await s.get("k")).toBeNull();
  });

  it("update can noop, set and delete and forwards the typed result", async () => {
    const s = make();
    const inserted = await s.update("k", (cur) => {
      expect(cur).toBeNull();
      return { op: "set", value: { count: 1 }, result: "inserted" as const };
    });
    const kept = await s.update("k", (cur) => {
      expect(cur).toEqual({ count: 1 });
      return { op: "noop", result: "unchanged" as const };
    });
    const removed = await s.update("k", () => ({ op: "delete", result: "removed" as const }));
    expect([inserted, kept, removed]).toEqual(["inserted", "unchanged", "removed"]);
    expect(await s.get("k")).toBeNull();
  });

  it("concurrent set-if-absent from one process yields exactly one claim", async () => {
    const s = make();
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        s.update("race", (cur) => (cur ? { op: "noop", result: "taken" as const } : { op: "set", value: { t: 1 }, result: "claimed" as const })),
      ),
    );
    expect(results.filter((r) => r === "claimed")).toHaveLength(1);
  });
});

describe("sqlite adapter durability and sharing", () => {
  it("keeps values across close and reopen", async () => {
    const path = join(scratch(), "s.db");
    const a = openSqliteStore(path, { create: true });
    await a.put("k", { v: 1 });
    a.close();
    const b = openSqliteStore(path);
    expect(await b.get("k")).toEqual({ v: 1 });
    b.close();
  });

  it("two connections see each other's committed writes", async () => {
    const path = join(scratch(), "s.db");
    const a = openSqliteStore(path, { create: true });
    const b = openSqliteStore(path);
    await a.put("k", { from: "a" });
    expect(await b.get("k")).toEqual({ from: "a" });
    a.close();
    b.close();
  });

  it("at most one of several OS processes claims each key", async () => {
    const path = join(scratch(), "s.db");
    openSqliteStore(path, { create: true }).close();
    const keys = 60;
    const outs = await Promise.all(
      ["w1", "w2", "w3", "w4"].map((n) => run(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", child, path, String(keys), n])),
    );
    const claimed = outs.flatMap((o) => (JSON.parse(o.stdout) as { claimed: string[] }).claimed);
    expect(claimed).toHaveLength(keys);
    expect(new Set(claimed).size).toBe(keys);
  }, 60_000);
});

describe("sqlite adapter fails closed", () => {
  it("refuses to open a missing file unless create is set", () => {
    const path = join(scratch(), "nope.db");
    expect(() => openSqliteStore(path)).toThrow(StoreUnavailableError);
  });

  it("refuses to open a file that is not a database", () => {
    const path = join(scratch(), "junk.db");
    writeFileSync(path, "this is not sqlite");
    expect(() => openSqliteStore(path)).toThrow(StoreUnavailableError);
  });

  it("raises 'removed' once the file is deleted under a running store", async () => {
    const path = join(scratch(), "s.db");
    const s = openSqliteStore(path, { create: true });
    await s.put("k", { v: 1 });
    rmSync(path);
    await expect(s.get("k")).rejects.toMatchObject({ name: "StoreUnavailableError", code: "removed" });
    await expect(s.update("k", () => ({ op: "noop", result: 1 }))).rejects.toMatchObject({ code: "removed" });
  });

  it("raises 'removed' when the file is replaced by a different one", async () => {
    const dir = scratch();
    const path = join(dir, "s.db");
    const s = openSqliteStore(path, { create: true });
    renameSync(path, join(dir, "old.db"));
    openSqliteStore(path, { create: true }).close();
    await expect(s.get("k")).rejects.toMatchObject({ code: "removed" });
  });

  it("raises 'busy' while another connection holds the write lock, and recovers after", async () => {
    const path = join(scratch(), "s.db");
    const s = openSqliteStore(path, { create: true, busyTimeoutMs: 120, retryDelayMs: 10 });
    const locker = new DatabaseSync(path);
    locker.exec("BEGIN EXCLUSIVE");
    await expect(s.update("k", () => ({ op: "set", value: { v: 1 }, result: "x" }))).rejects.toMatchObject({ code: "busy" });
    // WAL readers are not blocked by a writer: get() still sees the last committed snapshot.
    expect(await s.get("k")).toBeNull();
    await expect(s.put("k", { v: 9 })).rejects.toMatchObject({ code: "busy" });
    locker.exec("ROLLBACK");
    locker.close();
    expect(await s.update("k", () => ({ op: "set", value: { v: 1 }, result: "ok" }))).toBe("ok");
  });

  it("raises 'closed' after close()", async () => {
    const s = openSqliteStore(join(scratch(), "s.db"), { create: true });
    s.close();
    await expect(s.get("k")).rejects.toMatchObject({ code: "closed" });
  });

  it("rolls back when the update callback throws, leaving the key untouched", async () => {
    const s = openSqliteStore(join(scratch(), "s.db"), { create: true });
    await expect(
      s.update("k", () => {
        throw new Error("boom");
      }),
    ).rejects.toBeInstanceOf(StoreUnavailableError);
    expect(await s.get("k")).toBeNull();
    expect(await s.update("k", () => ({ op: "set", value: { v: 1 }, result: "ok" }))).toBe("ok");
  });
});
