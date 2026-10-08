# What the runs taught (observed with the pinned versions, not defects)

- A short challenge lifetime can make a testnet pull payment fail `txTooLate`: the transaction's `maxTime` equals the challenge expiry and the next ledger closes seconds later. The broadcast log shows the node's result code.
- A failed on-chain transaction is treated like an ambiguous one: the challenge stays locked and a retry is refused (`onchain-failed`).
- A store fault after the broadcast leaves a confirmed payment with no delivery and a challenge that stays claimed (`store-fault-after-broadcast`).
- A transient chain-lookup failure on a push credential burns the challenge (`verification-rpc-outage`).
- A response lost after delivery cannot be retried: a retry is indistinguishable from a replay (`response-lost`).
- A second payment against an already-consumed challenge is confirmed on chain and never delivered (`challenge-consumption`).
