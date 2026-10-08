# Run it

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

Reports are versioned JSON ([`schema/report.v1.schema.json`](https://github.com/Charge-Guard/chargeguard-runner/blob/main/schema/report.v1.schema.json), [`schema/suite.v1.schema.json`](https://github.com/Charge-Guard/chargeguard-runner/blob/main/schema/suite.v1.schema.json), generated from zod with `pnpm schema`) plus a text rendering. [chargeguard-workbench](https://github.com/Charge-Guard/chargeguard-workbench) renders the recorded reports in a browser.
