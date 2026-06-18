---
"@caplets/core": patch
---

Keep local overlay startup alive when a Caplet references a missing environment variable by skipping only the affected Caplet and warning with the missing variable and config path.
