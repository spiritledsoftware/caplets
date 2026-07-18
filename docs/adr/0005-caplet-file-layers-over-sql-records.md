# Keep Caplet File Layers Above SQL Records

Caplet Files remain live authoritative overlays rather than becoming one-time SQL import inputs. Effective Caplet precedence is project Caplet Files, then global Caplet Files, then SQL-backed Caplet Records, with existing JSON config below those Caplet sources. This preserves project-local capability overrides and lets an image or read-only mount bootstrap a host without making the filesystem a second mutable SQL replica.

A filesystem Caplet shadows but never mutates the lower SQL record; deleting the file reveals that record again. Ordinary runtime and dashboard views show only the Effective Caplet, and filesystem Caplets are read-only in the dashboard. Operator-only storage views may explicitly address hidden SQL records.

Because global files can change host behavior, PostgreSQL Host Nodes must register identical global-file manifests and keyed fingerprints of resolved runtime-affecting configuration. A mismatched node fails readiness instead of serving a different Effective Caplet view.
