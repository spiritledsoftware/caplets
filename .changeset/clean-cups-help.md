---
"@caplets/core": patch
"caplets": patch
---

**Required upgrade migration:** Hosts that ran `caplets@0.25.x` or earlier must stop every Caplets Host Node and run `caplets storage migrate-legacy --dry-run`, then `caplets storage migrate-legacy`, before restarting the daemon, running `caplets setup`, or serving requests. The migration now imports standard legacy auth, Vault, remote security, setup, Operator Activity, and tracked-Caplet state; preserves file-layer Vault grants and shared Vault key access; uses platform paths by default; and reports actionable missing tracked entries.
