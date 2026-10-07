import { Store } from "mppx/server";
import { ConfigError } from "../errors.ts";
import { openSqliteStore } from "./sqlite.ts";

/**
 * Store configuration of one worker. There is deliberately no default: a worker with no
 * store setting refuses to start instead of quietly using a per-process in-memory map,
 * which would give every worker its own private replay history.
 */
export type StoreSpec = { kind: "memory" } | { kind: "sqlite"; path: string };

export function parseStoreSpec(raw: string | undefined): StoreSpec {
  const text = raw?.trim();
  if (!text) {
    throw new ConfigError(
      "no store configured: set CHARGEGUARD_STORE to 'sqlite:<path>' (shared, durable) or, for a demonstration of the failure, 'memory'. Refusing to start without one.",
    );
  }
  if (text === "memory") return { kind: "memory" };
  if (text.startsWith("sqlite:")) {
    const path = text.slice("sqlite:".length);
    if (!path) throw new ConfigError("CHARGEGUARD_STORE 'sqlite:' needs a file path");
    return { kind: "sqlite", path };
  }
  throw new ConfigError(`unknown store '${text}': expected 'memory' or 'sqlite:<path>'`);
}

export function formatStoreSpec(spec: StoreSpec): string {
  return spec.kind === "memory" ? "memory" : `sqlite:${spec.path}`;
}

/** Opens the configured store. A sqlite file that does not exist is an error, never created implicitly. */
export function openStore(spec: StoreSpec, options: { busyTimeoutMs?: number } = {}): Store.AtomicStore & { close?: () => void } {
  if (spec.kind === "memory") return Store.memory();
  return openSqliteStore(spec.path, { create: false, ...(options.busyTimeoutMs !== undefined ? { busyTimeoutMs: options.busyTimeoutMs } : {}) });
}
