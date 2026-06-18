# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used for this repo's GitHub issue tracker.

Current GitHub labels were checked for `spiritledsoftware/caplets` on 2026-06-18. `question` and `wontfix` already exist. The other mapped labels are the desired canonical labels for triage roles and may need to be created before first use if they are still absent.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `question`           | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role, use the corresponding label string from this table.

If the repo later adopts different GitHub label names, edit the right-hand column to match the live labels rather than creating duplicates.
