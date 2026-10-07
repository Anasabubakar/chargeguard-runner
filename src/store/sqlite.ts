import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { Store } from "mppx/server";
import { StoreUnavailableError } from "../errors.ts";
import { decodeValue, encodeValue } from "./json.ts";

/**
 * A shared, durable, atomic MPP store on node:sqlite (no Docker, no server, no root).
 *
 * Contract with mppx's `Store.AtomicStore`:
 * - `update(key, fn)` runs `fn` inside `BEGIN IMMEDIATE ... COMMIT`. SQLite grants the
 *   write lock to one connection at a time across processes, so two workers racing the
 *   same key observe each other: exactly one sees `null` and may `set`.
 * - Values are durable on commit (`journal_mode=WAL`, `synchronous=FULL`).
 *
 * Fail-closed behaviour (it never answers from stale or local state):
 * - Lock contention is retried without blocking the event loop until `busyTimeoutMs`,
 *   then raises `StoreUnavailableError("busy")`.
 * - The database file's identity (device + inode) is re-checked on every operation. A file
 *   that was deleted or swapped for another one is raised as `StoreUnavailableError("removed")`
 *   because the worker would otherwise keep writing to an unlinked file nobody else sees.
 * - Any other SQLite failure is raised as `StoreUnavailableError("io")`.
 *
 * SQLite on a network filesystem (NFS/SMB) does not give these guarantees; workers must
 * share a local disk. That limit is stated in the README and SPEC.
 */
export interface SqliteStoreOptions {
  /** Create the file and schema when missing. Default false: a missing file is an error. */
  create?: boolean;
  /** How long `update` keeps retrying a locked database. Default 1500 ms. */
  busyTimeoutMs?: number;
  /** Retry spacing while locked. Default 10 ms. */
  retryDelayMs?: number;
}

export interface SqliteAtomicStore extends Store.AtomicStore {
  readonly kind: "sqlite";
  readonly path: string;
  close(): void;
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: number } | null)?.errcode;
  return code !== undefined && ((code & 0xff) === SQLITE_BUSY || (code & 0xff) === SQLITE_LOCKED);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function openSqliteStore(path: string, options: SqliteStoreOptions = {}): SqliteAtomicStore {
  const { create = false, busyTimeoutMs = 1500, retryDelayMs = 10 } = options;

  let identity: { dev: number; ino: number };
  try {
    const st = statSync(path);
    identity = { dev: st.dev, ino: st.ino };
  } catch (cause) {
    if (!create) {
      throw new StoreUnavailableError("removed", `sqlite store file does not exist: ${path}`, { cause });
    }
    identity = { dev: -1, ino: -1 };
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
    // busy_timeout 0: contention is handled by our own async retry so the event loop never blocks.
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    if (create) db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) WITHOUT ROWID");
    db.prepare("SELECT 1 FROM kv LIMIT 1").get();
    const st = statSync(path);
    identity = { dev: st.dev, ino: st.ino };
  } catch (cause) {
    throw new StoreUnavailableError("io", `cannot open sqlite store at ${path}: ${(cause as Error).message}`, { cause });
  }

  let closed = false;

  const guard = (): void => {
    if (closed) throw new StoreUnavailableError("closed", "sqlite store is closed");
    try {
      const st = statSync(path);
      if (st.dev !== identity.dev || st.ino !== identity.ino) {
        throw new StoreUnavailableError("removed", `sqlite store file was replaced: ${path}`);
      }
    } catch (error) {
      if (error instanceof StoreUnavailableError) throw error;
      throw new StoreUnavailableError("removed", `sqlite store file is missing: ${path}`, { cause: error });
    }
  };

  const wrap = (error: unknown): StoreUnavailableError => {
    if (error instanceof StoreUnavailableError) return error;
    if (isBusy(error)) return new StoreUnavailableError("busy", "sqlite store is locked", { cause: error });
    return new StoreUnavailableError("io", `sqlite store failure: ${(error as Error).message}`, { cause: error });
  };

  const getStmt = db.prepare("SELECT value FROM kv WHERE key = ?");
  const putStmt = db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const delStmt = db.prepare("DELETE FROM kv WHERE key = ?");

  const retrying = async <T>(op: () => T): Promise<T> => {
    const deadline = Date.now() + busyTimeoutMs;
    for (;;) {
      guard();
      try {
        return op();
      } catch (error) {
        if (!isBusy(error)) throw wrap(error);
        if (Date.now() >= deadline) throw wrap(error);
        await sleep(retryDelayMs);
      }
    }
  };

  const base = {
    async get(key: string) {
      const row = await retrying(() => getStmt.get(key) as { value: string } | undefined);
      return (row ? decodeValue(row.value) : null) as never;
    },
    async put(key: string, value: unknown) {
      const text = encodeValue(value);
      await retrying(() => void putStmt.run(key, text));
    },
    async delete(key: string) {
      await retrying(() => void delStmt.run(key));
    },
    async update<result>(key: string, fn: (current: unknown | null) => Store.Change<unknown, result>) {
      return retrying(() => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const row = getStmt.get(key) as { value: string } | undefined;
          const change = fn(row ? decodeValue(row.value) : null);
          if (change.op === "set") putStmt.run(key, encodeValue(change.value));
          else if (change.op === "delete") delStmt.run(key);
          db.exec("COMMIT");
          return change.result;
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* the connection may already have rolled back */
          }
          throw error;
        }
      });
    },
  };

  const store = Store.from(base as unknown as Store.AtomicStore) as Store.AtomicStore;
  return Object.assign(store, {
    kind: "sqlite" as const,
    path,
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  });
}
