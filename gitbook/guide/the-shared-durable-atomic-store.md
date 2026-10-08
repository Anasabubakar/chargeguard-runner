# The shared durable atomic store

mppx ships `memory`, `cloudflare`, `redis` and `upstash` stores. Memory is per process; Cloudflare and Upstash are hosted services; `redis` is atomic only if you supply the `update` function and a running Redis. None fits "shared, durable, atomic, no Docker, no root", so [`src/store/sqlite.ts`](https://github.com/Charge-Guard/chargeguard-runner/blob/main/src/store/sqlite.ts) implements mppx's `AtomicStore` on Node's built-in `node:sqlite` ([ADR 0002](https://github.com/Charge-Guard/chargeguard-runner/blob/main/docs/adr/0002-sqlite-store-adapter.md)):

- `update()` = `BEGIN IMMEDIATE` read-modify-write; SQLite serialises writers across processes. WAL mode, `synchronous=FULL`.
- Fails closed: lock contention past a deadline, a deleted or replaced database file, or any I/O error raises `StoreUnavailableError`, which the worker turns into HTTP 503. It never falls back to local state.
- No default: a worker with no `CHARGEGUARD_STORE` exits 78; `memory` must be named explicitly; a `sqlite:` path that does not exist exits 70 instead of creating a private empty store.
- Held to the same contract tests as mppx's own `Store.memory()`, plus four OS processes racing 60 keys (each claimed exactly once).

Limit: SQLite needs a local filesystem. It is not a multi-host store and is not tested on NFS/SMB. Redis or PostgreSQL stores are not exercised.
