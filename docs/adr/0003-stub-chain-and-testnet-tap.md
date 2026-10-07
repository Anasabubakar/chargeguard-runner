# ADR 0003: Two chain backends and three evidence classes

Status: accepted, 2026-10-07.

Problem: some scenarios need Stellar to behave in a controlled way (confirm late, reject a broadcast, fail a transaction, stop answering `getTransaction`); real testnet cannot be told to do that. Others should run against real settlement. Mixing the two silently would overstate the evidence.

Decision: two backends behind one `Chain` interface (`src/chain/chain.ts`), and every report labels its evidence class.

- **stub** (`src/chain/fake-rpc.ts`): a local JSON-RPC server that implements only what the official unsponsored charge flow calls (`getLedgerEntries`, `simulateTransaction`, `sendTransaction`, `getTransaction`). It applies one real Stellar rule: a transaction is accepted only at account sequence + 1, so the same signed transaction cannot be applied twice. It does not execute contracts; the transfer event it returns is read from the transaction's own arguments. It cannot serve the sponsored (`feePayer`) path, which needs `getLatestLedger` header XDR. Reports from it are labelled **integration**.
- **testnet tap** (`src/chain/tap.ts`): a pass-through that forwards every call unchanged to `https://soroban-testnet.stellar.org` and logs each `sendTransaction` with the node's answer. That is what lets a report show a second worker's broadcast being refused by the real network. Reports from it are labelled **testnet settlement**.
- **in-process**: store-level tests inside one process (`test/sqlite-store.test.ts`) are labelled in-process.

`@stellar/stellar-sdk`'s RPC client rejects `http://` endpoints unless `allowHttp` is set, and `@stellar/mpp` does not pass it. Both backends therefore serve https with a certificate generated per run by the `openssl` CLI (`src/chain/tls.ts`), trusted by workers through `NODE_EXTRA_CA_CERTS` and by the runner through `tls.setDefaultCACertificates`. Nothing is committed and the certificate lives only in the run's temp directory.

Consequences:
- Ambiguous-settlement and fault scenarios run on the stub only; the CLI refuses them on testnet.
- A stub "SUCCESS" is a simulated confirmation. The report's `chain.description` and `limits` say so.
- Testnet runs need funded keys supplied through the environment (`CHARGEGUARD_PAYER_SECRETS`, `CHARGEGUARD_RECIPIENT`); they are never written to a report or a file.
- The runner's `confirmed` and `submitted` levels come from `Chain.observe`, not from worker claims.
