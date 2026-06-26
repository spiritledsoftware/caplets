---
date: 2026-06-26
topic: prebuilt-caplets-catalog
---

# Prebuilt Caplets Catalog Requirements

## Summary

Caplets should expand its public prebuilt catalog from a seed set into install-ready coverage for a real agent power-user stack, backed by lockfile-aware install and update commands. The milestone also adds a `writing-caplets` skill so agents can author catalog-grade Caplets with the same safety, setup, auth, and Project Binding expectations.

---

## Problem Frame

The current catalog already proves that Caplets can package useful backends, but it is still closer to a curated example set than a lived-in stack. The next catalog milestone should show that Caplets can carry the practical integrations an agent builder already uses across coding, planning, observability, Google workspace, browser automation, and desktop control.

The install lifecycle is also too shallow for a growing catalog. `caplets install` copies files from a source repository, but it does not record the source revision, installed path, or update relationship needed for repeatable installs and safe updates.

---

## Key Decisions

- **Mirror the personal stack into public install-ready Caplets.** The first catalog expansion should include missing integrations from the user's working config instead of limiting high-risk surfaces to recipes.
- **Update existing catalog entries selectively.** Existing public-friendly entries stay unless the personal config is clearly more production-real, better aligned with hosted provider behavior, or the entry needs metadata changes to satisfy the catalog quality bar.
- **Promote install-ready entries only after validation.** A catalog entry should not count toward install-ready coverage until it has an explicit verification status and a reproducible read-only, dry-run, or no-op validation path.
- **Use Project Binding only for project-file consumers.** A Caplet requires Project Binding when its backend reads, edits, indexes, or runs commands against the current project; being a local process is not enough.
- **Treat lockfiles as part of the install contract.** `caplets install` and `caplets update` should operate from recorded source metadata, not from copied files alone.
- **Let install restore from the lockfile.** `caplets install` with no source arguments should install the Caplets described by the selected project or global lockfile.
- **Keep lockfiles share-safe and integrity-aware.** Lockfiles should prove what was installed without storing credentials or pretending non-portable local sources can be restored elsewhere.
- **Keep live smoke testing outside this brainstorm.** The requirements should specify setup and verification metadata, while the user will run live smoke tests in their own environment.

---

## Actors

- A1. **Agent power-user.** Installs prebuilt Caplets globally or into a project and expects agents to receive a compact, useful capability surface.
- A2. **Catalog authoring agent.** Writes or updates Caplet files and needs a repeatable quality bar.
- A3. **Caplets CLI.** Installs, records, and updates catalog Caplets.
- A4. **Catalog source repository.** Provides installable Caplet files under a `caplets/` directory.
- A5. **Project-bound Caplet.** Requires the current project root before it can run safely.
- A6. **Risky local capability.** Exposes browser, desktop, or other locally powerful behavior and needs explicit setup and safety guidance.

---

## Requirements

**Catalog Expansion**

- R1. The public catalog must add install-ready entries for Browser Use, Computer Use, PostHog, Sentry, Gmail, Google Drive, Google Tasks, and Stealth Browser Use.
- R2. Each new catalog entry must be usable as a normal `caplets install` target rather than only as prose documentation.
- R3. Each new catalog entry must include a concise usage description, tags, auth or setup guidance, and safety notes appropriate to the backend's mutating or high-risk capabilities.
- R4. Existing catalog entries must be revised when the personal config provides a materially better public default, such as a hosted OAuth endpoint replacing a local package install, or when Project Binding, auth, setup, verification, safety, or lockfile metadata requirements make the current entry inconsistent with the catalog quality bar.
- R5. The catalog must keep Caplets framed as a Code Mode-first capability layer for coding agents, not as a generic marketplace of every possible integration.
- R6. Each install-ready entry must name its primary Code Mode workflow and the compact capability surface an agent should use first.
- R7. Each install-ready entry must record verification status and at least one reproducible validation path, preferring read-only or dry-run checks and using local no-op checks when the real provider action would mutate state.
- R8. Entries without successful validation may be documented as unverified drafts or recipes, but must not count toward install-ready catalog coverage.
- R9. The catalog must avoid committing user-specific secrets, machine paths, workspace names, tokens, browser profile paths, or private provider identifiers.

**Project Binding**

- R10. Catalog entries whose backends consume the current project files must declare Project Binding as required.
- R11. `lsp`, `ast-grep`, and repository-local CLI catalog entries must require Project Binding unless planning finds a stronger reason to split them into project-bound and non-project variants.
- R12. Browser, desktop-control, and hosted SaaS entries must not require Project Binding solely because they run locally or can affect a project indirectly.
- R13. A project-bound catalog entry must explain why it needs the bound project root and what behavior degrades or disappears without it.
- R14. Project-bound catalog entries must rely on the runtime's bound project context rather than hardcoded local paths.

**Install And Update Lifecycle**

- R15. `caplets install` must write or update an entry in the selected scope's lockfile for every installed catalog Caplet.
- R16. Project installs must write their lockfile at `./.caplets.lock.json`.
- R17. Global installs must write their lockfile in the target machine's Caplets state directory, with the Linux default path `~/.local/state/caplets/caplets.lock.json` and platform-equivalent paths on Windows and macOS; remote global installs therefore update the remote machine's global lockfile rather than a local project lockfile.
- R18. Each lock entry must record the Caplet ID, source repository, normalized credential-free source URL or local source identity, source path inside the repository, destination path, installed kind, tracked source ref or channel, resolved git revision when available, content hash, install time, update time, and portability status.
- R19. Installs from a Git repository must resolve and record the exact commit revision used for the copied Caplet and the source ref or channel future updates should track.
- R20. Installs from a local directory must record enough source metadata to explain provenance and portability, and must mark the entry as not reliably restorable or updatable when no stable git revision or available local source can be resolved.
- R21. `caplets install` with no source arguments must read the selected scope's lockfile and install the Caplets described there.
- R22. No-argument `caplets install` must honor project and global scope flags so project lockfiles restore project installs and global lockfiles restore global installs.
- R23. No-argument `caplets install` must be idempotent when installed files match the lockfile content and must surface conflicts when installed files differ.
- R24. No-argument `caplets install` must restore from the exact recorded revision when one is available and verify the recorded content hash before writing installed files.
- R25. `caplets update` must read the selected scope's lockfile, resolve updates against the recorded source repository and tracked source ref or channel, replace selected installed Caplets when updates are available, and update the lock entries.
- R26. `caplets update` must support updating all tracked Caplets and updating named Caplets.
- R27. `caplets update` must support project and global scopes consistently with `caplets install`.
- R28. `caplets update` must not silently overwrite local modifications that differ from the recorded content hash unless the user chooses a force path.
- R29. `caplets update` must detect risk-increasing changes before replacement, including backend family changes, broader auth requirements, new Project Binding requirements, new mutating operations, or changed high-risk safety metadata, and must require confirmation or a force path before applying them.
- R30. Lockfile writes must be atomic enough that interruption does not leave an unreadable or partially written lockfile.
- R31. Lockfile operations must expose machine-readable errors for missing lockfiles, missing tracked Caplets, deleted upstream repositories, unavailable revisions, content hash mismatches, unavailable local sources, non-portable local-source entries, and local modification conflicts.
- R32. Project lockfiles must be share-safe by default: they must not store credential-bearing URLs, must prefer project-relative destinations over absolute local paths, must mark local directory entries as non-portable when appropriate, and must warn when provenance metadata may expose private source identity.

**Writing-Caplets Skill**

- R33. The repo must add a `writing-caplets` skill under `skills/`.
- R34. The skill must teach agents how to author catalog-grade Caplets, not just how to use configured Caplets.
- R35. The skill must distinguish catalog-grade install-ready entries from local/private Caplets, unverified drafts, and recipes.
- R36. The skill must instruct agents to inspect the Caplet schema, existing catalog style, and relevant docs before writing a new Caplet.
- R37. The skill must include guidance for setup and verify metadata, auth and Vault references, least-privilege provider scopes, Project Binding, runtime features, Code Mode workflows, safety notes, and avoiding secrets.
- R38. The skill must tell agents when to create bundled reference files next to a directory Caplet.
- R39. The skill must tell agents to validate Caplet files and run the relevant focused checks after authoring.

**Safety And Documentation**

- R40. High-risk install-ready entries such as Computer Use and Stealth Browser Use must include explicit setup, scope, and safety guidance before they are promoted into the public catalog.
- R41. Local-control entries such as Browser Use, Computer Use, Stealth Browser Use, and desktop-control backends must treat installation as user acceptance of their local-control risk and must document bounded targets, browser profile or device assumptions, and credential isolation expectations.
- R42. Mutating SaaS entries such as Gmail, Google Drive, Google Tasks, Linear, GitHub, Sentry, and PostHog must guide agents to read first and write deliberately.
- R43. Catalog entries using OAuth, bearer tokens, or provider client credentials must document the expected Caplets auth or Vault setup without exposing credential values, list minimum required provider scopes or permissions, distinguish read-only from mutating scopes when providers support it, and warn against overbroad credentials.
- R44. Documentation examples must show lockfile-aware install and update workflows once the lifecycle commands exist.

---

## Key Flows

- F1. Install a project catalog Caplet
  - **Trigger:** A user installs a Caplet from a source repo while working in a project.
  - **Actors:** A1, A3, A4
  - **Steps:** The CLI resolves the source, copies the selected Caplet into the project Caplets root, records provenance in `./.caplets.lock.json`, and reports the installed ID and destination.
  - **Covered by:** R15, R16, R18, R19

- F2. Update tracked project Caplets
  - **Trigger:** A user runs `caplets update` in a project with a lockfile.
  - **Actors:** A1, A3, A4
  - **Steps:** The CLI reads the project lockfile, checks each selected source channel for newer content, refuses local edits or risk-increasing changes without confirmation, replaces safe-to-update installed Caplets, and rewrites the lockfile with the new revision and content hash.
  - **Covered by:** R25, R26, R27, R28, R29, R30

- F3. Restore project Caplets from a lockfile
  - **Trigger:** A user runs `caplets install` with no source arguments in a project with `./.caplets.lock.json`.
  - **Actors:** A1, A3, A4
  - **Steps:** The CLI reads the project lockfile, installs any missing tracked Caplets from their exact recorded source metadata, verifies content hashes before writing, leaves matching installed files alone, and reports conflicts or non-portable local sources.
  - **Covered by:** R21, R22, R23, R24, R31

- F4. Use a project-bound catalog Caplet
  - **Trigger:** An agent receives an installed Caplet whose backend needs current project files.
  - **Actors:** A1, A5
  - **Steps:** The Caplet is exposed only when a valid Project Binding context exists, and its backend uses the bound project root rather than a hardcoded path.
  - **Covered by:** R10, R13, R14

- F5. Author a new catalog-grade Caplet
  - **Trigger:** An agent is asked to add or update a prebuilt catalog entry.
  - **Actors:** A2, A4
  - **Steps:** The agent loads the `writing-caplets` skill, checks schema and existing catalog patterns, writes the Caplet and any nearby references, validates it, and reports verification.
  - **Covered by:** R33, R34, R36, R37, R38, R39

- F6. Install a high-risk local capability
  - **Trigger:** A user installs Computer Use, Browser Use, or Stealth Browser Use from the catalog.
  - **Actors:** A1, A3, A6
  - **Steps:** The catalog entry installs normally, with installation treated as user acceptance of the local-control risk, and carries setup and safety guidance that makes the risk explicit.
  - **Covered by:** R1, R2, R40, R41, R43

---

## Acceptance Examples

- AE1. **Covers R15, R16, R18, R19.** Given a user runs `caplets install spiritledsoftware/caplets sentry` in a project, when install succeeds, then `./.caplets.lock.json` records the `sentry` entry with source repo, source path, destination, tracked source ref, git revision, content hash, and timestamps.
- AE2. **Covers R17, R22, R27.** Given a user installs, restores, or updates global Caplets, when the command succeeds, then the global lockfile is read from or written under the Caplets state directory rather than the current project.
- AE3. **Covers R21, R22, R23, R24.** Given a project lockfile tracks `posthog` and `sentry`, when the user runs `caplets install` with no source arguments, then Caplets installs missing tracked entries from their recorded revisions, verifies content hashes, and leaves matching installed entries unchanged.
- AE4. **Covers R25, R26.** Given a lockfile tracks `posthog` and `sentry`, when the user runs `caplets update sentry`, then only the selected tracked Caplet is considered for replacement and its recorded source channel determines what update is eligible.
- AE5. **Covers R28, R29.** Given an installed Caplet was locally edited after install or an update broadens its auth scope, when install restore or update would replace it, then the CLI refuses or asks for a force path instead of silently overwriting the edit or expanding risk.
- AE6. **Covers R10, R11, R14.** Given an agent exposes the `lsp` catalog Caplet without Project Binding context, then the Caplet is withheld from callable surfaces rather than starting against an arbitrary process working directory.
- AE7. **Covers R33, R37, R39.** Given an agent uses `writing-caplets` to add a Google Drive Caplet, then the skill guides it to document OAuth setup, least-privilege scopes, mutating-operation caution, schema validation, and focused checks.
- AE8. **Covers R5, R6, R7, R8.** Given a new provider entry has not completed a reproducible validation path, when the catalog is assessed for this milestone, then the entry is marked unverified and does not count toward install-ready coverage.
- AE9. **Covers R31, R32.** Given a project lockfile is written after installing from a credential-bearing URL or local directory, then the lockfile strips credentials, avoids absolute project paths where possible, marks local-source portability, and reports non-portable restore behavior with a machine-readable error.

---

## Success Criteria

- The catalog includes install-ready entries for the missing personal-stack integrations named in R1, each with verification status and a reproducible validation path.
- Each install-ready entry names the primary Code Mode workflow and compact capability surface an agent should use first.
- Project-file consumer Caplets declare and use Project Binding consistently with the runtime contract.
- High-risk local-control entries treat installation as user acceptance of local-control risk and make that risk explicit in setup and safety guidance.
- `caplets install` produces a share-safe, integrity-aware lockfile entry for local project and global installs.
- `caplets install` with no source arguments restores the Caplets described by the selected project or global lockfile and verifies recorded content before writing files.
- `caplets update` can refresh tracked Caplets from lockfile provenance and the recorded source channel without requiring the user to remember the original install command.
- `caplets update` refuses local modifications and risk-increasing changes unless the user chooses a confirmation or force path.
- `writing-caplets` gives a future agent enough guidance to author a safe catalog entry without rediscovering the quality bar from scattered docs.
- The user can perform live smoke tests against their own provider accounts and machine-local dependencies after implementation.

---

## Scope Boundaries

- Hosted registry search, ratings, popularity, or marketplace UX are outside this milestone.
- Recipe-only treatment for Computer Use or Stealth Browser Use is outside this milestone; those entries should be install-ready with strong safety guidance.
- Remote-control project install semantics may be planned separately if they add risk beyond the local project and global lockfile behavior.
- Live provider smoke testing is owned by the user, not by this requirements artifact.

---

## Dependencies / Assumptions

- The current Caplet file schema supports `projectBinding.required`, setup metadata, runtime requirements, and the backend families needed for the catalog entries.
- The current install command already resolves a source repo and copies selected Caplet files, but it does not maintain lock state.
- The target machine's Caplets state directory remains the right home for global install metadata, including global installs performed against a remote host.
- Provider endpoints and auth models may change; implementation should verify current public endpoints and auth requirements before finalizing each catalog entry.
- Local-directory installs are allowed, but lockfile restore and update must fail closed when the local source cannot be proven available and unchanged.
- The first lockfile version can be Caplets-specific and does not need to copy the skills CLI schema exactly.

---

## Implementation Discovery

- Inventory existing catalog entries during implementation, starting with Context7, and update only the entries whose endpoint, auth, setup, Project Binding, verification, safety, or lockfile metadata falls short of the catalog quality bar.

---

## Sources / Research

- `STRATEGY.md` for the Code Mode-first product frame.
- `CONTEXT.md` and `CONCEPTS.md` for Caplet and Project Binding vocabulary.
- `apps/docs/src/content/docs/reference/caplet-files.mdx` for Caplet file fields and the Project Binding example.
- `docs/project-binding.md` for the runtime Project Binding contract.
- `packages/core/src/cli/install.ts` and `packages/core/src/cli.ts` for current install behavior.
- `skills/caplets/SKILL.md` for the existing Caplets usage skill that `writing-caplets` must complement rather than duplicate.
- `/tmp/compound-engineering/ce-brainstorm/caplets-catalog-1782465510/grounding.md` for the extraction dossier used during brainstorming.
- Public skills-lock discussions in `vercel-labs/skills` issues 283 and 549 for the lockfile lifecycle analogy.
