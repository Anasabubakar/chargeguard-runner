# What it runs

Pinned system under test: `@stellar/mpp 0.7.1`, `mppx 0.6.31`, `@stellar/stellar-sdk 15.1.0` (exact versions, see [ADR 0001](https://github.com/Charge-Guard/chargeguard-runner/blob/main/docs/adr/0001-incremental-value-over-existing-tools.md) for why these and what was read).

| Scenario | Invariant | Variants |
|---|---|---|
| `repeated-credential` | a credential one worker accepted is not accepted by the other; delivered once | store x credential mode |
| `concurrent-submission` | the same credential in flight to both workers at once: at most one acceptance per round | store x mode, `--rounds N` |
| `restart-persistence` | a credential consumed before a SIGKILL restart stays consumed | store x mode |
| `storage-unavailable` | locked or deleted store: 503, no acceptance, no broadcast, no silent local fallback; no store setting: refuse to start | mode |
| `challenge-consumption` | a challenge is accepted at most once; a forged or lapsed challenge is refused | store x mode |
| `ambiguous-settlement` | unresolved settlement is not delivered and not re-broadcast; the report says which levels were reached | `unconfirmed-then-lands`, `broadcast-rejected`, `onchain-failed`, `store-fault-after-broadcast`, `verification-rpc-outage`, `response-lost` |

Credential modes: **pull** (the worker verifies, broadcasts and waits for confirmation) and **push** (the payer broadcasts; the worker looks the hash up). In pull mode the ledger's sequence rule would refuse a repeated signed transaction on its own, so a check named `store-level-protection` asks the stricter question: did the **store** stop the replay before a second broadcast reached the chain? An isolated-memory deployment fails it even when the ledger saved the day, and the report records the ledger's refusal as an observation.
