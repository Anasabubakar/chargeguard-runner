import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { ConfigError } from "../src/errors.ts";
import { workerConfigFromEnv } from "../src/server/config.ts";
import { parseStoreSpec } from "../src/store/spec.ts";

const good = {
  CHARGEGUARD_WORKER_ID: "w",
  CHARGEGUARD_STORE: "sqlite:/tmp/x.db",
  CHARGEGUARD_RECIPIENT: Keypair.random().publicKey(),
  CHARGEGUARD_MPP_SECRET: "s".repeat(40),
  CHARGEGUARD_RUN_DIR: "/tmp",
};

describe("store spec", () => {
  it("refuses a missing, empty or blank setting: there is no default store", () => {
    for (const raw of [undefined, "", "   "]) expect(() => parseStoreSpec(raw)).toThrow(ConfigError);
  });
  it("accepts memory only when named explicitly, and sqlite with a path", () => {
    expect(parseStoreSpec("memory")).toEqual({ kind: "memory" });
    expect(parseStoreSpec("sqlite:/data/a.db")).toEqual({ kind: "sqlite", path: "/data/a.db" });
  });
  it("rejects unknown backends and an empty sqlite path", () => {
    expect(() => parseStoreSpec("redis://x")).toThrow(ConfigError);
    expect(() => parseStoreSpec("sqlite:")).toThrow(ConfigError);
  });
});

describe("worker config", () => {
  it("parses a complete environment", () => {
    const c = workerConfigFromEnv(good);
    expect(c.store).toEqual({ kind: "sqlite", path: "/tmp/x.db" });
    expect(c.amount).toBe("0.01");
  });
  it.each([
    ["CHARGEGUARD_STORE"],
    ["CHARGEGUARD_RECIPIENT"],
    ["CHARGEGUARD_MPP_SECRET"],
    ["CHARGEGUARD_WORKER_ID"],
    ["CHARGEGUARD_RUN_DIR"],
  ])("refuses to start without %s", (name) => {
    const env: Record<string, string | undefined> = { ...good };
    delete env[name];
    expect(() => workerConfigFromEnv(env)).toThrow(ConfigError);
  });
  it("rejects a short secret and an invalid recipient", () => {
    expect(() => workerConfigFromEnv({ ...good, CHARGEGUARD_MPP_SECRET: "short" })).toThrow(ConfigError);
    expect(() => workerConfigFromEnv({ ...good, CHARGEGUARD_RECIPIENT: "not-a-key" })).toThrow(ConfigError);
  });
});
