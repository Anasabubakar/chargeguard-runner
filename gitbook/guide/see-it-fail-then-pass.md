# See it fail, then pass

```bash
git clone <this repository> chargeguard-runner && cd chargeguard-runner
pnpm install --frozen-lockfile && pnpm build

node dist/cli.js run repeated-credential --store memory --mode push   # exit 1: the failing deployment
node dist/cli.js run repeated-credential --store sqlite --mode push   # exit 0: shared atomic store
```

With one private in-memory store per worker, the same credential is accepted twice and one payment buys two deliveries:

```text
VERDICT: FAIL   (expected FAIL: as expected)
  [FAIL] single-acceptance  2 of 3 presentations were accepted (200, 200, 402).
  payment    mode  accepted  submitted  confirmed  fulfilled
  payment-1  push  2         client     SUCCESS    2
```

With the shared sqlite store (below) it is accepted once: `200, 402, 402`, delivered once. The same pair against **real Stellar testnet** is recorded in [docs/evidence/suite-testnet.txt](https://github.com/Charge-Guard/chargeguard-runner/blob/main/docs/evidence/suite-testnet.txt) (transaction hashes can be looked up on any testnet explorer).
