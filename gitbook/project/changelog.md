# Changelog

## 0.1.1
- Package metadata (repository, homepage, bugs) and absolute documentation links. No runtime changes since 0.1.0.

## 0.1.0 (unreleased)
- Reference paid endpoint on the official `@stellar/mpp@0.7.1` charge method (mppx 0.6.31, stellar-sdk 15.1.0) with a configurable store, fail-closed 503 on store faults, and no default store.
- Shared durable atomic store on `node:sqlite` (WAL, BEGIN IMMEDIATE, inode check) behind mppx's `AtomicStore`.
- Two-worker harness: real OS processes, real HTTP, SIGKILL restarts, official client in push and pull mode.
- Stub Soroban RPC with the sequence rule and landing faults; logging tap in front of Stellar testnet.
- Scenarios: repeated credential, concurrent submission, restart persistence, storage unavailable, challenge consumption, six ambiguous-settlement variants.
- Reports with the four levels per payment, generated JSON Schemas for run and suite reports, text rendering, recorded evidence for the stub and testnet suites.
- CLI with documented exit codes.
