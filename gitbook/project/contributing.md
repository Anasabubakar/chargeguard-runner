# Contributing

```bash
pnpm install --frozen-lockfile
pnpm run typecheck && pnpm test && pnpm run check:schema
pnpm run schema     # after changing src/report/schema.ts; commit the output
pnpm run build && node dist/cli.js run repeated-credential --store sqlite --mode push
```

- Requires Node 22.13+ (developed on 24.19; `node:sqlite` and `tls.setDefaultCACertificates` are used) and the `openssl` CLI (the stub chain serves https with a per-run certificate).
- The system under test is pinned: `@stellar/mpp 0.7.1`, `mppx 0.6.31`, `@stellar/stellar-sdk 15.1.0`. Bumping one means re-reading its source, re-running both suites and re-recording `docs/evidence/`.
- A new scenario needs: an invariant written as a sentence a stranger can refute, a planned fault schedule, expectations derived from the replay requirement or from a Stellar rule (never copied from the runner's own output), a test in `test/scenarios.test.ts`, and checks whose details say what was observed.
- Keep the four levels apart. Never add a single "paid" or "success" field. A `pass` needs the workers' logs and the client's view to agree; otherwise the run is `inconclusive`.
- A scenario that injects chain faults runs on the stub only. Label evidence as `in-process`, `integration` or `testnet settlement` exactly; do not blur them.
- Never put a secret key, a funded account's secret or a token in a file, a report or a log. Testnet keys come from the environment.
- Do not claim linearizability, exactly-once delivery, an audit, or endorsement by Stellar, the SDK authors or mppx maintainers.
- Tests that spawn workers must not depend on timing luck; prefer waiting on a condition (ready line, exit code) over sleeping.
- One logical change per commit; AI-assisted changes are welcome if you understand and verified them.
