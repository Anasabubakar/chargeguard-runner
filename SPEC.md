# chargeguard-runner: specification (v0.1)

## User
An operator or integrator who runs a paid HTTP endpoint on the official Stellar MPP SDK (`@stellar/mpp` charge) behind more than one worker process, and wants evidence that replay protection still holds in that deployment shape. "Your SDK can be correct while your deployment breaks its assumptions."

## Supported scope
- Charge mode only, unsponsored (no `feePayer`), on Stellar testnet. Both credential modes: **pull** (the worker verifies, broadcasts and waits for confirmation) and **push** (the payer broadcasts; the worker verifies a `signedHash` credential on chain).
- Reference deployment: two worker OS processes, each running the SDK's charge method behind mppx on loopback HTTP, with a configurable store (`memory` or `sqlite:<file>`).
- One shared durable atomic store without Docker or root: `openSqliteStore` on `node:sqlite` (ADR 0002).
- Pinned system under test: `@stellar/mpp 0.7.1`, `mppx 0.6.31`, `@stellar/stellar-sdk 15.1.0`.

## Non-goals
- Payment channels (out of scope).
- The sponsored `feePayer` path, fee bumps, `allowUnsignedPush`.
- Testing an arbitrary third-party server; the runner tests its own reference server.
- Multi-host stores (SQLite on NFS is not supported). Redis, PostgreSQL, Upstash and Cloudflare KV are not exercised.
- Throughput or latency benchmarking.
- Proving linearizability or exactly-once delivery. Finite tests are evidence, not proof, and every report says so.

## The four levels
Every payment is reported at four independent levels (`src/levels.ts`):

| Level | Meaning | Observed by |
|---|---|---|
| accepted | a worker verified the credential and answered 200 with a receipt | client responses, cross-checked against worker logs |
| submitted | a transaction for the payment reached a Stellar node (worker in pull mode, payer in push mode) | the chain backend's send log / lookup |
| confirmed | the ledger reports SUCCESS (or FAILED, NOT_FOUND, UNKNOWN) | the runner querying the chain, never a worker's claim |
| fulfilled | the paid resource was delivered, once per delivery | worker fulfillment logs |

Replay protection decides the first level; the other three show its cost.

## Evidence classes
`in-process` (store logic in one process), `integration` (separate worker processes over real HTTP against the local stub chain), `testnet settlement` (the same workers against Stellar testnet through a logging tap). Each report carries exactly one class in `evidenceClass`.

## Data model
- `Report` (`schema/report.v1.schema.json`, generated from zod): version, command, environment, evidence class, chain, deployment, scenario (id, variant, invariant, planned fault schedule), expectation, verdict, matches-expectation, summary, checks, observations, payments (four levels each), timeline (client view of every request), fault events (injected faults and harness actions as they happened), limits.
- `Suite` (`schema/suite.v1.schema.json`): reports plus totals.
- Verdict: `pass` (every check passed), `fail` (a check failed), `inconclusive` (the scenario could not reach its precondition, or client and worker logs disagree). `expectation` is `fail` for control runs on isolated memory stores; `matchesExpectation` compares the two.

## Scenarios
| id | Invariant | Variants |
|---|---|---|
| repeated-credential | a credential accepted by one worker is not accepted by the other; delivered once | store x mode |
| concurrent-submission | with the same credential in flight to both workers, at most one acceptance per round | store x mode, rounds |
| restart-persistence | a credential consumed before a SIGKILL restart stays consumed | store x mode |
| storage-unavailable | locked or removed store: 503, no acceptance, no broadcast, no fallback; no store configuration: refuse to start | mode |
| challenge-consumption | a challenge is accepted at most once; forged and lapsed challenges are refused | store x mode |
| ambiguous-settlement | unresolved settlement is not delivered, not re-broadcast, and reported by level | unconfirmed-then-lands, broadcast-rejected, onchain-failed, store-fault-after-broadcast, verification-rpc-outage, response-lost |

Checks named `store-level-protection` ask a stricter question than the invariant: was the replay stopped by the store before any second broadcast, or only by the ledger's sequence rule. In pull mode the ledger alone would stop a repeated signed transaction; ChargeGuard reports that as a failure of the deployment's own protection and records the ledger refusal as an observation.

## Interfaces
- CLI `chargeguard`: `list`, `run <scenario> [--store --mode --variant --rounds --backend --out --text-out]`, `suite [--backend --only --out --text-out]`, `validate <file>`. Exit codes: 0 invariants held (run) / all runs matched expectation (suite); 1 invariant violated / expectation not met; 2 invalid usage or invalid report; 3 inconclusive.
- Worker process (`src/worker/main.ts`), configured by `CHARGEGUARD_*` environment variables. Exit codes: 0 stopped, 78 configuration refused (no store, unknown store, bad key or secret), 70 the store could not be opened.
- Library: `openSqliteStore`, `parseStoreSpec`, report schemas, `runScenario`, `runSuite`.

## Failure classes covered
Replay across workers; simultaneous presentation; amnesia on restart; store lock; store file removed or replaced; missing store configuration; reuse of a consumed, forged or lapsed challenge; broadcast rejected; settlement never confirmed; on-chain failure; store fault after broadcast; chain lookup outage during push verification; a response lost after the worker delivered.

## Architecture
`src/server` (paid endpoint on the SDK, fail-closed wrapper, request and fulfillment logs) - `src/worker` (process entry) - `src/store` (spec, sqlite adapter) - `src/chain` (stub, tap, tls) - `src/harness` (spawn workers, official client, run context) - `src/scenarios` - `src/runner.ts` and `src/suite.ts` - `src/report` (schema, text) - `src/cli.ts`.

## Safety
Workers and chain endpoints bind 127.0.0.1. The `/__chargeguard/*` routes exist for the harness only. Testnet secret keys are read from the environment and never written to a file or report. Mainnet is not supported (network is fixed to testnet).

## Acceptance criteria (each tested)
1. The adapter and `Store.memory()` pass the same contract tests; four OS processes claim each of 60 keys exactly once.
2. Isolated memory stores: the same push credential is accepted by both workers and delivered twice (recorded as the failing deployment); with the shared store it is accepted once.
3. Concurrent presentation over N rounds: zero rounds with two acceptances on the shared store; every round with two on isolated stores.
4. A SIGKILL restart forgets on memory and does not forget on sqlite.
5. A worker with no store configuration exits 78; a missing database exits 70; a locked or deleted database yields 503 and no delivery.
6. A challenge is accepted at most once on the shared store; a one-character-altered challenge id and a lapsed challenge are refused.
7. Each ambiguous-settlement variant reaches the four-level state written for it and no variant broadcasts a transaction twice.
8. Client-observed responses equal the workers' own logs in every run (`evidence-consistent`), or the run is inconclusive.
9. Reports validate against the generated JSON Schema; `chargeguard validate` exits 2 on anything that does not.
