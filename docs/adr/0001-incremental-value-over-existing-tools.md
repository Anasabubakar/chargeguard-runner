# ADR 0001: What ChargeGuard adds over stellar-mpp-sdk and mppx

Status: accepted, 2026-10-07. Based on the sources listed below, read on that date. Statements about behavior come from reading code and tests, plus the runs recorded in `docs/evidence/`; READMEs describe intent, not tested behavior.

## What was read

- **stellar/stellar-mpp-sdk** (GitHub, `main` at commit `c6d537a`, 2026-09-29): `README.md`, `docs/migrating-to-v0.7.md`, `sdk/src/charge/server/Charge.test.ts`, `sdk/src/charge/integration/mocked/rejects/cross-process-replay.test.ts`, `sdk/src/charge/integration/live/accepts/e2e.test.ts`, `examples/charge-server.ts`.
- **@stellar/mpp 0.7.1** (npm, published 2026-07-02): the compiled `dist/charge/server/Charge.js` and `dist/charge/client/Charge.js`. This is the artifact ChargeGuard pins. Its peer ranges are `@stellar/stellar-sdk ^15.1.0` and `mppx ^0.6.29`. The repository's `main` has since moved its declared peers to `^16.3.0` and `^0.10.1`, so `main` is not what the published package does; ChargeGuard reads and runs the published one.
- **mppx 0.6.31** (npm, the highest 0.6.x, which is what `@stellar/mpp@0.7.1` accepts): `src/Store.ts`, `src/Store.test.ts`, `src/server/Mppx.ts`, `src/tempo/server/Charge.test.ts`. **mppx 0.13.1** (npm `latest`): `dist/Store.js` exports, to check whether a durable local store appeared later.

## What the existing tools say and do

- The SDK's README states that replay protection depends on `store.update()` being a linearizable compare-and-set. `Store.memory()` is "a correct single-process reference"; for multiple processes it asks for "a backend whose `update()` maps to a genuine atomic CAS" and names a Redis Lua script or a PostgreSQL conditional `UPDATE`, and says a per-instance `Store.memory()`, a get-then-put on a shared cache, or an eventually consistent backend "is **not** sufficient". It also notes the constructor can check that `update()` exists but not that it is correct.
- `@stellar/mpp@0.7.1` `charge()` throws at construction when no store, or a store without `update`, is given. At verify time it claims `stellar:charge:challenge:<id>` with `store.update` before it checks the credential, claims `stellar:charge:hash:<hash>` (push after verification, pull just before broadcast), releases both claims if the transaction cannot have reached the network, and keeps them when it might have. When polling for confirmation fails it throws "Settlement status is ambiguous — challenge locked pending reconciliation".
- The SDK's tests use `Store.memory()` almost everywhere. Its cross-process replay test (`cross-process-replay.test.ts`) is named "two independent instances" but both instances share **one in-process** `Store.memory()` object and a mocked `getTransaction`; it tests the claim logic, not two OS processes or a real shared backend. Its live end-to-end test builds a fresh `Store.memory()` per flow.
- mppx's `Store` (0.6.31 and 0.13.1) ships `memory`, `cloudflare`, `redis` and `upstash` adapters plus `keyPrefix`. The `redis` and `cloudflare` adapters are atomic only if the caller supplies an `update` function; the library cannot supply one. `Store.test.ts` exercises them with in-memory fake key-value objects and checks JSON round-tripping and typed `update` results, not concurrency or processes. mppx's tempo `Charge.test.ts` has "rejects concurrent replay" tests that run inside one process on `Store.memory()`.
- Neither project ships a replay test that starts separate server processes, and neither ships a store that works across processes on one machine without an external service.

## The gap this fills (and does not claim beyond)

A way to run the **deployment** assumption instead of reading about it: two real worker processes, real HTTP, one configurable store, then repeat, race, kill, break and starve the store and report what each worker accepted. The SDK states the requirement; these tests show whether a given store configuration meets it, and what a failure looks like at each of the four levels (accepted credential, submitted transaction, chain confirmation, service fulfillment). Absence from the sources read is not proof that no such harness exists privately.

## Decision

1. Use the published `@stellar/mpp@0.7.1` with `mppx@0.6.31` and `@stellar/stellar-sdk@15.1.0`, pinned exactly, as the system under test. Do not reimplement charge verification.
2. Do not use `Store.memory()` for a shared deployment, and do not use `Store.upstash()`/`Store.cloudflare()`: they need an external account. `Store.redis()` needs a running Redis and our own atomic `update`; no Redis is available here and Docker is unusable. Per ADR 0002, ship a small adapter on `node:sqlite` behind the official `AtomicStore` type.
3. Keep `Store.memory()` as the control: it is what the SDK README itself calls insufficient for multiple instances, so a run that uses it is expected to fail, and the report says "expected".
4. Report outcomes at four levels per payment rather than a single "paid" flag.

## Consequences

- ChargeGuard tests the SDK as published, not as on `main`. A later SDK version needs a re-run; `docs/evidence/` records the exact versions.
- The runner exercises its own reference server (a thin wrapper around the SDK), not an arbitrary user server. A user's server is covered only to the extent it uses the same SDK and store configuration.
- Findings about SDK behavior (for example that an on-chain FAILED is treated like an ambiguous outcome and leaves the challenge locked) are observations from runs with the pinned versions, reported as observations, not as defects.
- No maintainer of the SDK or mppx has reviewed this work.
