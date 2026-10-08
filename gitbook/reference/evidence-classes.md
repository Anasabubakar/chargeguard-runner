# Evidence classes

Every report says which kind of evidence it is, and they are not mixed:

- **in-process**: store and adapter tests inside one process (`test/sqlite-store.test.ts`).
- **integration**: two worker OS processes over real HTTP against a local stub of a Soroban RPC node ([`src/chain/fake-rpc.ts`](https://github.com/Charge-Guard/chargeguard-runner/blob/main/src/chain/fake-rpc.ts)). The stub implements only what the official unsponsored charge flow calls and applies the real sequence-number rule; its confirmations are simulated.
- **testnet settlement**: the same workers and the official client against Stellar testnet, through a logging pass-through ([ADR 0003](https://github.com/Charge-Guard/chargeguard-runner/blob/main/docs/adr/0003-stub-chain-and-testnet-tap.md)). Fault scenarios that need a controllable chain (`ambiguous-settlement`) do not run here.

Recorded runs (commands, environment, planned and actual fault schedule, per-request timeline, per-payment levels, every broadcast the chain endpoint saw) are in [`docs/evidence/`](https://github.com/Charge-Guard/chargeguard-runner/blob/main/docs/evidence): `suite-stub.json|txt` and `suite-testnet.json|txt`. Stub suite: 21 runs, 16 pass, 5 fail (all five are the isolated-memory controls), 21 of 21 matched their expectation. Testnet suite: 9 runs on real Stellar testnet, 6 pass, 3 fail (isolated-memory controls), 9 of 9 matched.
