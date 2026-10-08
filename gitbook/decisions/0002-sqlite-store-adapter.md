# ADR 0002: A shared durable atomic store on node:sqlite

Status: accepted, 2026-10-07.

Problem: `@stellar/mpp@0.7.1` needs an mppx `AtomicStore` whose `update()` is an atomic read-modify-write that holds across processes. The bundled options (ADR 0001) are per-process memory, two hosted services, and a Redis wrapper that needs a Redis server and a caller-written `update`. Docker and root are unavailable in this environment and the harness has to run in CI without a service container.

Decision: implement `openSqliteStore(path)` in `src/store/sqlite.ts` on Node's built-in `node:sqlite`, typed as mppx's `Store.AtomicStore`.

- `update(key, fn)` runs `BEGIN IMMEDIATE`, reads the row, calls `fn`, applies `set`/`delete`/`noop` and `COMMIT`s. SQLite grants one writer at a time across processes on the same file, so two workers racing one key cannot both see it absent.
- `journal_mode=WAL`, `synchronous=FULL`: a committed claim survives a process kill and an OS crash.
- Lock contention is retried with `setTimeout` (not `busy_timeout`, which would block the event loop) up to `busyTimeoutMs`, then raised as `StoreUnavailableError("busy")`.
- The file's device and inode are checked before every operation. If the file is deleted or replaced, the store raises `removed` instead of continuing on an unlinked file that no other worker sees.
- Every other SQLite failure is raised as `StoreUnavailableError("io")`. The worker turns any `StoreUnavailableError` into HTTP 503; it never answers from local state.
- A missing file is an error unless `create: true`; only the harness creates the file, so a mistyped path cannot silently create a private empty store.
- Values use mppx's own JSON encoding (bigint as `<digits>#__bigint`).

Verification: the adapter and mppx's `Store.memory()` run the same contract tests (round trip, bigint, overwrite, delete, typed `update` results, 50 concurrent set-if-absent calls yield exactly one claim). A separate test starts four OS processes that each try to claim 60 keys; every key is claimed exactly once.

Consequences and limits:
- SQLite needs a local filesystem. On NFS or SMB its locking is not reliable and workers on different machines cannot share the file. Multi-host deployments need a networked store with a genuine atomic `update` (the SDK names Redis Lua or PostgreSQL conditional `UPDATE`); that is out of scope and not tested here.
- One writer at a time is a throughput ceiling, adequate for a test harness and small deployments, not a claim about production load.
- WAL readers are not blocked by a writer, so `get()` can answer while `update()` is locked; the SDK's replay decisions use `update()`.
- A passing run on this store is evidence for the tested schedules. It is not a linearizability proof.
