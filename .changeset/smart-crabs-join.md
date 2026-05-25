---
"@caplets/core": patch
"caplets": patch
"@caplets/opencode": patch
"@caplets/pi": patch
---

Layer remote mode with user-global and project-local Caplets. Local project Caplets now shadow global and remote Caplets, local overlays load best-effort with warnings, mutation commands support explicit project/global/remote targets, and auth commands require explicit scope when local and remote IDs are ambiguous.
