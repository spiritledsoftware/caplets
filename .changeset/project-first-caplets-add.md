---
"caplets": minor
---

Add project-first Caplet authoring with `caplets add`, make `caplets install` write to `./.caplets` by default, and load project Caplets without an explicit trust gate.

Project Caplets now override global Caplets with source and shadowing information surfaced through `caplets list`. Use `-g` or `--global` with `caplets add` and `caplets install` to write to the user Caplets root.
