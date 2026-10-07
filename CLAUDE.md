# chargeguard-runner: working notes

Commands: `pnpm install --frozen-lockfile`, `pnpm run typecheck`, `pnpm test` (spawns worker processes; about 3 minutes), `pnpm run build`, `pnpm run schema` / `check:schema`, `node dist/cli.js list|run|suite|validate`.
Testnet runs: `export CHARGEGUARD_PAYER_SECRETS=$(stellar keys show <alias>) CHARGEGUARD_RECIPIENT=$(stellar keys address <alias>)` then `node dist/cli.js suite --backend testnet`. Keys live in ~/.config/stellar, never in the repo.
Constraints: system under test is pinned exactly (@stellar/mpp 0.7.1, mppx 0.6.31, stellar-sdk 15.1.0); scripts run with `--experimental-strip-types` (no enums or parameter properties); no `rm` with globs, scratch via mktemp; keep the four levels (accepted, submitted, confirmed, fulfilled) separate; label evidence in-process / integration / testnet settlement; never claim linearizability or exactly-once; payment channels out of scope; no AI co-author trailers.
Unfinished: GitHub publishing and CI run, npm publish, tagged release, review by SDK or mppx maintainers, a networked store (Redis/Postgres) test, sponsored feePayer path, docs/evidence re-record after any dependency bump.
