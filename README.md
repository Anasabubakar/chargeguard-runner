# chargeguard-runner

**Documentation:** https://stellar-developer-tools.gitbook.io/chargeguard-runner/

Your SDK can be correct while your deployment breaks its assumptions.

ChargeGuard tests the deployment, not the SDK. It starts **two real worker processes** that serve one paid HTTP endpoint on the official Stellar MPP SDK (`@stellar/mpp` charge), points both at a replay-protection store you choose, and then repeats, races, kills, locks and starves that store while a real client pays. Every run is reported at four levels that are kept apart: **accepted credential**, **submitted transaction**, **chain confirmation**, **service fulfillment**.

The SDK says replay protection needs a store whose `update()` is a linearizable compare-and-set shared by every instance, and that a per-instance `Store.memory()` is not enough. This tool shows what that sentence means on a running system, and whether your store configuration meets it.

> A finite number of runs is evidence, not a proof. Nothing here shows linearizability or exactly-once delivery. Payment channels are out of scope. Not an audit; not endorsed by Stellar, the SDK authors or the mppx maintainers.

## See it fail, then pass

```bash
git clone <this repository> chargeguard-runner && cd chargeguard-runner
pnpm install --frozen-lockfile && pnpm build

node dist/cli.js run repeated-credential --store memory --mode push   # exit 1: the failing deployment
node dist/cli.js run repeated-credential --store sqlite --mode push   # exit 0: shared atomic store
```

With one private in-memory store per worker, the same credential is accepted twice and one payment buys two deliveries:

```text
VERDICT: FAIL   (expected FAIL: as expected)
  [FAIL] single-acceptance  2 of 3 presentations were accepted (200, 200, 402).
  payment    mode  accepted  submitted  confirmed  fulfilled
  payment-1  push  2         client     SUCCESS    2
```

With the shared sqlite store (below) it is accepted once: `200, 402, 402`, delivered once. The same pair against **real Stellar testnet** is recorded in [docs/evidence/suite-testnet.txt](https://github.com/Anasabubakar/chargeguard-runner/blob/main/docs/evidence/suite-testnet.txt) (transaction hashes can be looked up on any testnet explorer).

## The four levels

| Level | Meaning | Observed by |
|---|---|---|
| accepted | a worker verified the credential and answered 200 with a receipt | the workers' own logs, cross-checked with the client's responses |
| submitted | a transaction for the payment reached a Stellar node (by the worker in pull mode, by the payer in push mode) | the chain endpoint's send log |
| confirmed | the ledger reports SUCCESS / FAILED / not found | the runner asking the chain, never a worker's claim |
| fulfilled | the paid resource was delivered, once per delivery | worker fulfillment logs |

Replay protection decides the first level; the other three show what it cost. A payment can be **confirmed and not fulfilled** (paid, not served) or **fulfilled twice** (one payment, two deliveries); a single "paid" flag would hide both.

## What it runs

Pinned system under test: `@stellar/mpp 0.7.1`, `mppx 0.6.31`, `@stellar/stellar-sdk 15.1.0` (exact versions, see [ADR 0001](https://github.com/Anasabubakar/chargeguard-runner/blob/main/docs/adr/0001-incremental-value-over-existing-tools.md) for why these and what was read).

| Scenario | Invariant | Variants |
|---|---|---|
| `repeated-credential` | a credential one worker accepted is not accepted by the other; delivered once | store x credential mode |
| `concurrent-submission` | the same credential in flight to both workers at once: at most one acceptance per round | store x mode, `--rounds N` |
| `restart-persistence` | a credential consumed before a SIGKILL restart stays consumed | store x mode |
| `storage-unavailable` | locked or deleted store: 503, no acceptance, no broadcast, no silent local fallback; no store setting: refuse to start | mode |
| `challenge-consumption` | a challenge is accepted at most once; a forged or lapsed challenge is refused | store x mode |
| `ambiguous-settlement` | unresolved settlement is not delivered and not re-broadcast; the report says which levels were reached | `unconfirmed-then-lands`, `broadcast-rejected`, `onchain-failed`, `store-fault-after-broadcast`, `verification-rpc-outage`, `response-lost` |

Credential modes: **pull** (the worker verifies, broadcasts and waits for confirmation) and **push** (the payer broadcasts; the worker looks the hash up). In pull mode the ledger's sequence rule would refuse a repeated signed transaction on its own, so a check named `store-level-protection` asks the stricter question: did the **store** stop the replay before a second broadcast reached the chain? An isolated-memory deployment fails it even when the ledger saved the day, and the report records the ledger's refusal as an observation.

## The shared durable atomic store

mppx ships `memory`, `cloudflare`, `redis` and `upstash` stores. Memory is per process; Cloudflare and Upstash are hosted services; `redis` is atomic only if you supply the `update` function and a running Redis. None fits "shared, durable, atomic, no Docker, no root", so [`src/store/sqlite.ts`](https://github.com/Anasabubakar/chargeguard-runner/blob/main/src/store/sqlite.ts) implements mppx's `AtomicStore` on Node's built-in `node:sqlite` ([ADR 0002](https://github.com/Anasabubakar/chargeguard-runner/blob/main/docs/adr/0002-sqlite-store-adapter.md)):

- `update()` = `BEGIN IMMEDIATE` read-modify-write; SQLite serialises writers across processes. WAL mode, `synchronous=FULL`.
- Fails closed: lock contention past a deadline, a deleted or replaced database file, or any I/O error raises `StoreUnavailableError`, which the worker turns into HTTP 503. It never falls back to local state.
- No default: a worker with no `CHARGEGUARD_STORE` exits 78; `memory` must be named explicitly; a `sqlite:` path that does not exist exits 70 instead of creating a private empty store.
- Held to the same contract tests as mppx's own `Store.memory()`, plus four OS processes racing 60 keys (each claimed exactly once).

Limit: SQLite needs a local filesystem. It is not a multi-host store and is not tested on NFS/SMB. Redis or PostgreSQL stores are not exercised.

## Evidence classes

Every report says which kind of evidence it is, and they are not mixed:

- **in-process**: store and adapter tests inside one process (`test/sqlite-store.test.ts`).
- **integration**: two worker OS processes over real HTTP against a local stub of a Soroban RPC node ([`src/chain/fake-rpc.ts`](https://github.com/Anasabubakar/chargeguard-runner/blob/main/src/chain/fake-rpc.ts)). The stub implements only what the official unsponsored charge flow calls and applies the real sequence-number rule; its confirmations are simulated.
- **testnet settlement**: the same workers and the official client against Stellar testnet, through a logging pass-through ([ADR 0003](https://github.com/Anasabubakar/chargeguard-runner/blob/main/docs/adr/0003-stub-chain-and-testnet-tap.md)). Fault scenarios that need a controllable chain (`ambiguous-settlement`) do not run here.

Recorded runs (commands, environment, planned and actual fault schedule, per-request timeline, per-payment levels, every broadcast the chain endpoint saw) are in [`docs/evidence/`](https://github.com/Anasabubakar/chargeguard-runner/blob/main/docs/evidence): `suite-stub.json|txt` and `suite-testnet.json|txt`. Stub suite: 21 runs, 16 pass, 5 fail (all five are the isolated-memory controls), 21 of 21 matched their expectation. Testnet suite: 9 runs on real Stellar testnet, 6 pass, 3 fail (isolated-memory controls), 9 of 9 matched.

## Run it

```bash
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js list
node dist/cli.js run <scenario> [--store memory|sqlite] [--mode push|pull] [--variant <v>] [--rounds <n>] [--backend stub|testnet] [--out report.json] [--text-out report.txt]
node dist/cli.js suite [--backend stub|testnet] [--only <scenario,...>] [--out suite.json] [--text-out suite.txt]
node dist/cli.js validate report.json
```

Testnet needs throwaway funded keys in the environment (never written anywhere):

```bash
stellar keys generate cg-payer --network testnet --fund && stellar keys generate cg-recipient --network testnet --fund
export CHARGEGUARD_PAYER_SECRETS=$(stellar keys show cg-payer) CHARGEGUARD_RECIPIENT=$(stellar keys address cg-recipient)
node dist/cli.js suite --backend testnet --out suite-testnet.json
```

Exit codes: **0** every invariant held (`run`) or every run matched its expectation (`suite`); **1** an invariant was violated, or a run did not match its expectation; **2** invalid usage, unsupported combination or a report that fails `validate`; **3** inconclusive (the run could not reach the state it needed, or client and worker logs disagreed). A control run on isolated memory stores *expects* to fail: `suite` counts that as matching its expectation, `run` reports it as exit 1.

Reports are versioned JSON ([`schema/report.v1.schema.json`](https://github.com/Anasabubakar/chargeguard-runner/blob/main/schema/report.v1.schema.json), [`schema/suite.v1.schema.json`](https://github.com/Anasabubakar/chargeguard-runner/blob/main/schema/suite.v1.schema.json), generated from zod with `pnpm schema`) plus a text rendering. [chargeguard-workbench](https://github.com/Anasabubakar/chargeguard-workbench) renders the recorded reports in a browser.

## What the runs taught (observed with the pinned versions, not defects)

- A short challenge lifetime can make a testnet pull payment fail `txTooLate`: the transaction's `maxTime` equals the challenge expiry and the next ledger closes seconds later. The broadcast log shows the node's result code.
- A failed on-chain transaction is treated like an ambiguous one: the challenge stays locked and a retry is refused (`onchain-failed`).
- A store fault after the broadcast leaves a confirmed payment with no delivery and a challenge that stays claimed (`store-fault-after-broadcast`).
- A transient chain-lookup failure on a push credential burns the challenge (`verification-rpc-outage`).
- A response lost after delivery cannot be retried: a retry is indistinguishable from a replay (`response-lost`).
- A second payment against an already-consumed challenge is confirmed on chain and never delivered (`challenge-consumption`).

## Supported scope and limits

Charge mode, unsponsored, testnet only; no `feePayer`, no payment channels, no mainnet. It exercises this runner's reference server (a thin wrapper on the SDK), not your own server code. The stub chain is a stub. Testnet runs are a single observation of a shared network. See [SPEC.md](https://github.com/Anasabubakar/chargeguard-runner/blob/main/SPEC.md).

## Verification

```bash
pnpm run typecheck && pnpm test && pnpm run check:schema   # 67 tests in 7 files, about 2 minutes (spawns worker processes), no external network
```

Supported: Node 22.13+ (developed on 24.19), TypeScript 7.0.2, vitest 5.0.3, zod 4.6.5; the `openssl` CLI for the stub's per-run certificate.

## Status

Engineering complete for the declared version-one scope. Published on GitHub (CI green) and npm; not done: review by the SDK or mppx maintainers, a networked-store (Redis/PostgreSQL) test, the sponsored `feePayer` path. MIT licensed.

## Contributors

<a href="https://github.com/Anasabubakar/chargeguard-runner/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Anasabubakar/chargeguard-runner" alt="Contributors to chargeguard-runner" />
</a>
