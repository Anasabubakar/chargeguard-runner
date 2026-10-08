# Security policy

ChargeGuard is a local test tool. Workers and the stub chain bind 127.0.0.1 only. The worker's `/__chargeguard/inspect` route reads a store key and exists for the harness; do not expose a worker beyond loopback. Testnet secret keys are read from the environment (`CHARGEGUARD_PAYER_SECRETS`) and are never written to a report or a file; use throwaway testnet keys only. The tool is fixed to Stellar testnet and has no mainnet mode.

The per-run TLS certificate for the stub is self-signed, generated into a temporary directory, trusted only by the processes the runner starts, and deleted with the run directory.

Report vulnerabilities (for example a way to make a worker reachable beyond loopback, to write a secret into a report, to make a check pass when a replay was accepted, or a fail-open path in the sqlite store) through GitHub's private vulnerability reporting for this repository. Please do not open a public issue for them.

A passing report is evidence for the schedules that were run. It is not a security audit and not a proof that a deployment cannot accept a replay.
