# Overview

Your SDK can be correct while your deployment breaks its assumptions.

ChargeGuard tests the deployment, not the SDK. It starts **two real worker processes** that serve one paid HTTP endpoint on the official Stellar MPP SDK (`@stellar/mpp` charge), points both at a replay-protection store you choose, and then repeats, races, kills, locks and starves that store while a real client pays. Every run is reported at four levels that are kept apart: **accepted credential**, **submitted transaction**, **chain confirmation**, **service fulfillment**.

The SDK says replay protection needs a store whose `update()` is a linearizable compare-and-set shared by every instance, and that a per-instance `Store.memory()` is not enough. This tool shows what that sentence means on a running system, and whether your store configuration meets it.

> A finite number of runs is evidence, not a proof. Nothing here shows linearizability or exactly-once delivery. Payment channels are out of scope. Not an audit; not endorsed by Stellar, the SDK authors or the mppx maintainers.

Source: [chargeguard-runner on GitHub](https://github.com/Charge-Guard/chargeguard-runner). Releases: [GitHub releases](https://github.com/Charge-Guard/chargeguard-runner/releases).
