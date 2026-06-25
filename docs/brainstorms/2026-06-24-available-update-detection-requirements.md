---
date: 2026-06-24
topic: available-update-detection
---

# Available Update Detection Requirements

## Summary

Caplets should opportunistically detect when a newer published CLI version is available and print a short upgrade notice to stderr when stderr is a human-facing notice channel. The feature must preserve existing command behavior, especially stdout contracts for protocols, structured output, shell completion, help, and version commands, while avoiding passive noise in CI and non-interactive automation.

---

## Problem Frame

Caplets is moving quickly, and users running an older CLI can hit bugs, miss remote attach fixes, or report issues that are already resolved. The CLI is also used as both a human command and an agent-facing protocol process, so update messaging has to be useful without becoming output noise.

Stdout is the hard protocol and structured-output boundary, but it is not the only compatibility boundary. A stderr-only notice can help humans keep Caplets current without corrupting MCP stdio traffic or structured CLI output, as long as Caplets suppresses passive notices when stderr is likely to be consumed by automation rather than a person.

---

## Key Decisions

- **Use passive update notices.** Caplets should notify users about available updates but never auto-update in the first version.
- **Treat stderr as the notice channel only when it is human-facing.** The notice may appear for interactive human commands. It may also appear for stdio-backed commands, including `caplets serve` and `caplets attach`, only when planning validates that the supported host keeps stderr separate from protocol stdout and surfaces the notice to a user who can act on it, or when an explicit host or user opt-in marks stderr as notice-safe.
- **Suppress notice paths that are output products.** Help, version, shell completion, and structured JSON-style outputs must not receive update text.
- **Make update checks best-effort and cached.** Network failures, registry errors, and slow responses must not delay or fail the primary command, and stale-cache refresh behavior must be deterministic.
- **Scope the comparison to the published CLI package.** The user installed `caplets`, so update detection should compare the running CLI version with the latest available `caplets` CLI release.
- **Use default public release metadata only.** Passive checks may contact the default public package metadata source for the published `caplets` CLI package, but they must not send Caplets, project, or user payloads. Custom or project-controlled release metadata sources are out of scope for the first version.
- **Prefer channel-neutral upgrade guidance.** The notice should include enough version information to act, but should use channel-neutral guidance unless Caplets can reliably determine the user's install or update channel.

---

## Actors

- A1. **Caplets user.** Runs CLI commands and needs a low-noise way to learn that a newer Caplets CLI is available.
- A2. **Coding agent or MCP client.** Starts Caplets through stdio-backed `serve` or `attach` commands and depends on stdout remaining protocol-safe.
- A3. **Automation or script.** Runs Caplets commands in scripts, CI, or task runners and depends on stable parseable output and low-noise stderr.
- A4. **Caplets maintainer.** Wants users to receive fixes and diagnostics improvements without adding support burden.

---

## Requirements

**Detection and comparison**

- R1. Caplets must compare the running `caplets` CLI version with the newest available published `caplets` CLI version from the default public package metadata source.
- R2. Caplets must show an update notice only when the available published version is newer than the running CLI version and belongs to the running CLI's eligible release channel.
- R3. Stable builds must compare against the stable release channel only, while prerelease builds must compare against a documented prerelease channel rule that never prompts users to downgrade or move to an unintended channel.
- R4. Update detection must use cached results so ordinary commands do not perform a registry lookup on every invocation.
- R5. Cache freshness must be time-bound so users eventually hear about new releases without needing a manual cache clear.

**Notice behavior**

- R6. The update notice must write only to stderr and must be emitted only when stderr is an eligible human-facing notice channel for the current command context.
- R7. The update notice must include the running version, the available version, and concise channel-neutral upgrade guidance unless Caplets can reliably determine the user's install or update channel.
- R8. The update notice must be short enough to appear before long-running command output without burying useful diagnostics.
- R9. The same available version must not produce noisy repeated notices on every nearby command invocation.
- R10. Caplets must provide a durable way to suppress or defer repeated notices for a version or time window.

**Command eligibility**

- R11. Stdio-backed `caplets serve` and `caplets attach` are eligible for stderr update notices after planning validates that supported stdio hosts keep stderr separate from protocol stdout and surface the notice to a user who can act on it, or after an explicit host or user opt-in marks stderr as notice-safe.
- R12. Update notices must never write to stdout, including during MCP stdio sessions.
- R13. Except for stdio-backed `serve` and `attach` covered by R11 and R12, commands or flags that produce JSON, machine-readable, or structured stdout must suppress passive update notices. CI and non-interactive script contexts must suppress passive notices by default unless a documented opt-in marks stderr as human-facing.
- R14. Shell completion scripts and hidden completion endpoints must suppress passive update notices.
- R15. Top-level help, command help, and version output must suppress passive update notices.

**Failure and performance**

- R16. Registry lookup failures, network errors, invalid registry responses, cache write failures, and semver parse failures must not fail the primary command.
- R17. Update detection must define whether stale or missing cache results produce no notice on the current invocation, a bounded foreground refresh, or a refresh whose result is shown on a later invocation.
- R18. Update detection must not materially delay the primary command when the cache is missing or stale.
- R19. Long-running commands must start their primary work even when update detection cannot complete.
- R20. If a refresh discovers a newer version after the current command's notice window has passed, Caplets must not interrupt that command and may show the notice on a later eligible invocation.
- R21. Update detection must not require loading user Caplet config, project config, secrets, or backend definitions.

**Controls and privacy**

- R22. Users must be able to disable passive update checks through a clear local or environment control.
- R23. Disabling passive update checks must prevent outbound release metadata lookups.
- R24. Update detection may contact only the default public package metadata source for the published `caplets` CLI package and must send no Caplets, project, or user payloads beyond the minimum package metadata request needed for version lookup.
- R25. Update detection must not send Caplet config, project paths, Caplet IDs, prompts, tool arguments, tool outputs, credentials, tokens, hostnames, or user identifiers.
- R26. Update detection must not depend on anonymous telemetry being enabled.
- R27. Telemetry disablement must not silently disable update notices unless a separate update-check control says so.

---

## Key Flows

- F1. **Eligible interactive command**
  - **Trigger:** A user runs a normal interactive Caplets CLI command outside CI, stderr is human-facing, and the cached latest version is newer than the running version.
  - **Actors:** A1, A4
  - **Steps:** Caplets reads cached update state, decides the command context is notice-eligible, writes a short notice to stderr, and continues the command normally.
  - **Outcome:** The user sees that a newer CLI exists without stdout changing.

- F2. **Stdio serve or attach**
  - **Trigger:** An MCP client starts `caplets serve` or `caplets attach` over stdio while an update is available, and the host has validated human-visible stderr behavior or explicitly opted in.
  - **Actors:** A2, A4
  - **Steps:** Caplets uses host-validated or opted-in stderr behavior, writes any update notice only to stderr, and keeps stdout reserved for MCP protocol traffic.
  - **Outcome:** The client protocol remains valid, and stderr carries update guidance only through a path that can reach the user responsible for upgrading.

- F3. **Structured output command**
  - **Trigger:** A script runs a Caplets command that emits JSON or another machine-readable stdout shape.
  - **Actors:** A3
  - **Steps:** Caplets suppresses the passive update notice and produces the documented stdout response.
  - **Outcome:** Existing scripts continue parsing command output without special update-notice handling.

- F4. **Non-interactive automation**
  - **Trigger:** A CI job, task runner, or non-interactive shell runs a Caplets command while an update is available.
  - **Actors:** A3
  - **Steps:** Caplets detects that stderr is not a default human-facing notice channel and suppresses the passive update notice unless an explicit update-notice opt-in is present.
  - **Outcome:** Automation does not receive unexpected stderr output or alerts from passive update checks.

- F5. **Stale or missing cache**
  - **Trigger:** A command runs after the update cache expires or before any latest-version value is cached.
  - **Actors:** A1, A3
  - **Steps:** Caplets follows the documented refresh lifecycle, either using the cached or absent result for the current invocation, performing a bounded refresh, or saving the refreshed result for a later invocation.
  - **Outcome:** The command behavior stays reliable even when registry access is unavailable.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R6, R7.** Given the running CLI is `0.22.0` and the cached latest CLI version is `0.23.0`, when the user runs an eligible interactive command, then Caplets writes a stderr notice that names both versions, gives channel-neutral upgrade guidance, and writes nothing to stdout.
- AE2. **Covers R2.** Given the running CLI version matches the cached latest CLI version, when the user runs an eligible command, then Caplets prints no update notice.
- AE3. **Covers R3.** Given the running CLI is a stable build and a newer prerelease exists, when the user runs an eligible command, then Caplets does not prompt the stable user to move to the prerelease channel.
- AE4. **Covers R11, R12.** Given supported stdio host behavior has been validated as human-visible or explicitly opted in and an update is available, when an MCP client starts `caplets serve` over stdio, then stdout contains only protocol output and any update notice is written to stderr.
- AE5. **Covers R11, R12.** Given supported stdio host behavior has been validated as human-visible or explicitly opted in and an update is available, when an MCP client starts `caplets attach` over stdio, then stdout contains only protocol output and any update notice is written to stderr.
- AE6. **Covers R13.** Given an update is available, when a command is invoked with JSON output, then the command's stdout remains parseable JSON and the passive update notice is suppressed.
- AE7. **Covers R14.** Given an update is available, when shell completion asks Caplets for completions, then completion output contains only completion candidates or script content.
- AE8. **Covers R15.** Given an update is available, when the user runs `caplets --version`, `caplets --help`, or a command-specific help flag, then output remains the documented help or version text with no passive update notice.
- AE9. **Covers R4, R5, R17, R18, R19, R20.** Given the update cache is stale, when the user starts a long-running command, then Caplets follows the documented refresh lifecycle without waiting on an unbounded registry request or interrupting the running command after startup.
- AE10. **Covers R16.** Given registry access fails, when the user runs an eligible command, then the command result is unchanged and no registry failure is shown during ordinary execution.
- AE11. **Covers R9, R10.** Given a user has already seen or dismissed the notice for the latest available version, when they run another nearby eligible command, then Caplets does not repeat the same notice immediately.
- AE12. **Covers R22, R23.** Given the user disables passive update checks, when a newer CLI version is available, then Caplets does not perform outbound release metadata lookup or print the passive notice.
- AE13. **Covers R24, R25, R26, R27.** Given telemetry is disabled, when update detection runs, then it still uses only package-version lookup data and sends no Caplets config, project, credential, telemetry identity, or other user payload data.
- AE14. **Covers R6, R13.** Given an update is available, when Caplets runs in CI or another non-interactive script context without an explicit update-notice opt-in, then Caplets suppresses the passive update notice entirely.

---

## Success Criteria

- Users running outdated Caplets versions receive clear upgrade guidance during ordinary human-facing CLI use.
- MCP stdio sessions continue to reserve stdout for protocol traffic.
- JSON, completion, help, and version output remain stable and parseable.
- CI and non-interactive scripts do not receive passive update notices by default.
- Network or registry problems never change the success or failure of the user's original command.
- Repeated notices are rare enough that users do not treat them as command noise.

---

## Scope Boundaries

- Auto-updating Caplets is out of scope.
- Writing update notices to stdout is out of scope.
- Surfacing passive update-check failures during ordinary commands is out of scope.
- Forcing every invocation to perform a live registry lookup is out of scope.
- Tying update detection to anonymous telemetry is out of scope.
- Designing a full release-channel manager is out of scope for the first version.
- A dedicated explicit update-inspection command is out of scope for the first version.
- Custom, project-controlled, or user-configured release metadata sources are out of scope for the first version.
- Forcing passive update notices into CI, non-interactive, or stderr-sensitive automation is out of scope.

---

## Dependencies and Assumptions

- The first version assumes the published `caplets` CLI package is the user-facing package whose version should drive update notices.
- The first version assumes the default public package metadata source exposes enough version metadata to answer "newer than this CLI" without authenticated requests.
- Planning must validate stderr-only notices against supported stdio hosts before enabling passive notices for stdio-backed `serve` and `attach`, including whether the host surfaces stderr to a user who can act on the notice.
- Planning must define exact cache paths, cache freshness, refresh budget, suppression controls, release-channel semantics, human-facing stderr detection, and any explicit opt-in controls.
- Planning must define the wording for channel-neutral upgrade guidance and any reliable install-channel detection.

---

## Sources / Research

- `STRATEGY.md` names release readiness and runtime diagnosability as product priorities.
- `packages/cli/src/index.ts` is the published `caplets` binary wrapper and passes the CLI package version into core.
- `packages/core/src/cli.ts` owns command dispatch, version output, telemetry notice behavior, stdio `serve`, `attach`, completion, and JSON-producing command surfaces.
- `packages/core/test/cli.test.ts` covers version, help, stdio serve defaults, attach setup, completion, and JSON command output expectations.
- `packages/core/test/telemetry-cli.test.ts` shows the existing stderr-only notice precedent and tests that notice failures do not break commands.
