# The four levels

| Level | Meaning | Observed by |
|---|---|---|
| accepted | a worker verified the credential and answered 200 with a receipt | the workers' own logs, cross-checked with the client's responses |
| submitted | a transaction for the payment reached a Stellar node (by the worker in pull mode, by the payer in push mode) | the chain endpoint's send log |
| confirmed | the ledger reports SUCCESS / FAILED / not found | the runner asking the chain, never a worker's claim |
| fulfilled | the paid resource was delivered, once per delivery | worker fulfillment logs |

Replay protection decides the first level; the other three show what it cost. A payment can be **confirmed and not fulfilled** (paid, not served) or **fulfilled twice** (one payment, two deliveries); a single "paid" flag would hide both.
