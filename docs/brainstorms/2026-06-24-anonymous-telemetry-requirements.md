---
date: 2026-06-24
topic: anonymous-telemetry
---

# Anonymous Telemetry Requirements

## Summary

Add opt-out anonymous telemetry across the Caplets CLI, native integrations, and remote or Cloud attach flows. Sentry captures sanitized reliability data, while PostHog captures feature-level product usage with categorical metadata only.

---

## Problem Frame

Caplets needs broader usage data to decide where to invest. The current product questions span setup drop-off, CLI versus native adoption, local versus remote or Cloud usage, Code Mode versus progressive or direct exposure, and backend-family investment.

Crash reporting alone does not answer those questions. Coarse lifecycle telemetry also falls short because it shows that Caplets ran without explaining which product surfaces created value.

---

## Product Rationale

Opt-out telemetry is a deliberate product tradeoff. Caplets needs enough aggregate data to understand setup friction, surface adoption, runtime mode, exposure mode, backend-family usage, and reliability without requiring every user to notice and approve a prompt first.

The trust risk is real because Caplets runs near config, prompts, tools, local files, and agent workflows. The implementation must make the data boundaries concrete, show a notice before any user-visible first event leaves the process, provide obvious disable controls, and revisit the opt-out default if telemetry complaints, disable rates, or support feedback show that the default is harming adoption.

---

## Decision Questions

The first implementation should answer these product questions with the minimum viable event set and a lightweight readout path such as saved provider queries or a recurring usage report.

- **Setup funnel:** Where do users drop between init, setup, add, auth, remote login, doctor, first serve or attach, and first successful tool execution?
- **Surface adoption:** Which surfaces produce real usage: CLI, OpenCode, Pi, MCP serving, native service, remote attach, and Cloud attach?
- **Runtime investment:** Are users primarily local, self-hosted remote, or hosted Cloud, and how much of that use is CI or non-interactive automation?
- **Exposure-mode investment:** Are users succeeding with Code Mode, progressive tools, direct tools, or mixed exposure modes?
- **Backend-family investment:** Which backend families are configured and actually invoked enough to justify deeper investment?
- **Reliability investment:** Which sanitized error codes, command families, native integrations, and runtime categories create the most user-visible failure pressure?

These questions should be reviewed on a recurring cadence. Telemetry should drive investment only when event volume and delivery health are good enough to distinguish real non-usage from missing or failed telemetry.

---

## Key Decisions

- **Use feature-level anonymous telemetry.** Caplets should collect enough categorical detail to connect setup, runtime mode, exposure mode, backend family, native integration, and outcome.
- **Split responsibilities between providers.** PostHog is for product usage events; Sentry is for sanitized errors and reliability.
- **Default to opt-out.** Anonymous telemetry is enabled by default, but users can disable it durably or per process.
- **Use a stable anonymous installation ID.** The ID is needed to connect setup, later usage, and retention without identifying a person.
- **Collect CI usage, suppress tests.** CI and non-interactive runs are real automation usage; test environments are noise and should not send telemetry.
- **Prefer ongoing transparency over repeated notices.** Caplets should show a first-run notice on stderr and expose durable status, debug, enable, and disable commands.

---

## Actors

- A1. **Caplets user:** Runs the CLI, installs Caplets, configures Caplets, and expects clear privacy controls.
- A2. **Coding agent:** Uses Caplets through CLI-backed workflows, MCP serving, Code Mode, progressive tools, or direct tools.
- A3. **Native integration user:** Uses Caplets through OpenCode or Pi native integrations.
- A4. **Caplets maintainer:** Reviews aggregate usage and reliability data to prioritize product work.
- A5. **Telemetry providers:** Sentry and PostHog receive only the approved anonymous payloads.

---

## Requirements

**Consent and controls**

- R1. Caplets must enable anonymous telemetry by default unless a local or process-level control disables it.
- R2. `telemetry: false` in Caplets `config.json` must disable both PostHog and Sentry telemetry.
- R3. `CAPLETS_DISABLE_TELEMETRY=1` must disable both PostHog and Sentry telemetry for the current process.
- R4. `CAPLETS_DISABLE_TELEMETRY=1` must take precedence over config and command-based enablement.
- R5. Caplets must add `caplets telemetry status`, `caplets telemetry enable`, `caplets telemetry disable`, and `caplets telemetry debug`.
- R6. `caplets telemetry status` must explain whether telemetry is enabled, which control decided that state, and whether an anonymous installation ID exists.
- R7. `caplets telemetry debug` must show the sanitized events Caplets would send without sending them.

**Notice and transparency**

- R8. Caplets must show a first-run telemetry notice on stderr before sending the first telemetry event.
- R9. The first-run notice must include the fact that Caplets collects anonymous telemetry and the exact disable controls.
- R10. The first-run notice must never write to stdout.
- R11. The first-run notice gate must cover every telemetry-emitting CLI, daemon, attach, serve, setup, auth, doctor, native integration, and tool-execution surface before that surface sends its first telemetry event.
- R12. Native-first telemetry must either use a user-visible notice or status channel before telemetry is sent, or suppress native telemetry until a durable CLI or status notice has been recorded.
- R13. CI, daemon, native, and other non-interactive or hidden-stderr runs must not mark the telemetry notice as shown unless the notice was actually user-visible.
- R14. Repeated `serve`, `attach`, daemon, and native integration runs must not print repeated telemetry notices after a user-visible telemetry notice has been recorded.

**Identity and environment**

- R15. Caplets must use one stable anonymous installation ID for telemetry correlation.
- R16. The anonymous installation ID must not be derived from names, emails, paths, hostnames, URLs, config contents, remote credentials, or Caplet IDs.
- R17. Caplets must define anonymous installation ID generation, storage scope, reset behavior, and behavior after telemetry disablement and re-enablement.
- R18. `caplets telemetry status` must show whether an anonymous installation ID exists, and telemetry controls must provide a way to delete or rotate the local anonymous installation ID.
- R19. CI and non-interactive telemetry events must be collected by default and tagged with categorical CI or non-interactive state.
- R20. CI and ephemeral automation must have explicit identity handling so setup-to-retention analysis does not merge unrelated environments or fragment one durable installation unexpectedly.
- R21. Test environments must suppress telemetry automatically.

**PostHog product events**

- R22. PostHog events must cover setup and activation milestones including init, setup, add, auth, remote login, doctor, serve, attach, daemon, native startup, and first successful tool execution.
- R23. PostHog events must distinguish surface category: CLI, OpenCode, Pi, MCP serving, native service, remote attach, and Cloud attach.
- R24. PostHog events must distinguish runtime mode category: local, self-hosted remote, and hosted Cloud.
- R25. PostHog events must distinguish execution-context category such as interactive, non-interactive, and CI separately from runtime mode.
- R26. PostHog events must include backend-family counts using only categories such as MCP, OpenAPI, Google Discovery API, GraphQL, HTTP, CLI tools, and Caplet sets.
- R27. PostHog events must include exposure-mode counts using only categories such as Code Mode, progressive, direct, and mixed exposure modes.
- R28. PostHog events must capture Code Mode outcome categories including success, failure, timeout bucket, duration bucket, session created or reused, diagnostic codes, and whether any Caplet was invoked.
- R29. PostHog events must capture operation-family categories for progressive and CLI operations, such as inspect, check, tools, search, describe, call, resources, prompts, and complete.
- R30. PostHog event transport must not delay or fail the primary CLI, server, attach, daemon, or native integration workflow.

**Sentry reliability events**

- R31. Sentry must capture sanitized Caplets errors from CLI and native integration surfaces.
- R32. Sentry events must include categorical context such as package name, package version, surface, runtime mode, command family, Caplets error code, operating system family, architecture, and Node major version.
- R33. Sentry must not receive raw config, prompts, Code Mode code, tool arguments, tool outputs, resource contents, prompt contents, file paths, URLs, hostnames, Caplet IDs, environment variables, credentials, tokens, or unsanitized stack traces.
- R34. Sentry and PostHog disablement must be evaluated before provider clients are initialized.

**Privacy boundaries**

- R35. Telemetry must never collect raw config, prompts, Code Mode code, tool arguments, tool outputs, logs, resource contents, prompt contents, file paths, URLs, hostnames, Caplet IDs, credential values, token values, or raw environment variables.
- R36. Telemetry must only use allowlisted event names and allowlisted property keys.
- R37. Telemetry properties must be categorical, boolean, numeric count, or bucketed timing values unless a requirement explicitly allows another shape.
- R38. Provider-side IP capture and geolocation enrichment must be disabled or scrubbed for Caplets telemetry projects where the provider supports it.
- R39. Provider-side event retention limits must be defined for both PostHog product events and Sentry reliability events.
- R40. Local telemetry redaction must happen before data leaves the process.

**Telemetry quality and provider operations**

- R41. Distributed Sentry and PostHog identifiers must be intake-only, environment-specific, revocable, and must not include management API keys, private tokens, or credentials with read or admin access to telemetry data.
- R42. Telemetry transport must remain fire-and-forget for users, but provider initialization failures, event drops, delivery-health uncertainty, and provider ingestion issues must be observable in aggregate or explicitly accounted for in analysis.
- R43. Telemetry transport and provider projects must include abuse controls such as bounded queues, sampling or rate limiting for repeated failures and CI loops, and provider-side quota or ingestion monitoring.
- R44. The first implementation must include a lightweight analysis surface, such as saved provider queries or a recurring product usage report, that maps collected events back to the decision questions in this document.

---

## Key Flows

- F1. **First eligible CLI run**
  - **Trigger:** A user runs an eligible command before any telemetry notice has been recorded.
  - **Actors:** A1, A4, A5
  - **Steps:** Caplets resolves telemetry state, prints the notice to stderr if telemetry is enabled and stderr is user-visible, records that the notice was shown, and then emits the allowed event.
  - **Outcome:** The user receives disable instructions before the first event leaves the process.

- F2. **Telemetry-disabled run**
  - **Trigger:** A user sets `telemetry: false` or `CAPLETS_DISABLE_TELEMETRY=1`.
  - **Actors:** A1, A2, A3
  - **Steps:** Caplets resolves telemetry state before provider initialization and skips both PostHog and Sentry.
  - **Outcome:** The primary workflow runs with no telemetry network traffic.

- F3. **Native integration usage**
  - **Trigger:** OpenCode or Pi initializes and executes Caplets native tools.
  - **Actors:** A2, A3, A4, A5
  - **Steps:** Caplets verifies that telemetry is enabled and a user-visible notice has already been recorded, or uses a native-visible notice or status channel before recording native startup, service reload, tool execution outcome, and Code Mode outcome categories.
  - **Outcome:** Maintainers can compare native integration usage against CLI and attach usage without collecting user content.

- F4. **Sanitized error capture**
  - **Trigger:** A CLI, attach, daemon, or native integration surface encounters a reportable error.
  - **Actors:** A1, A3, A4, A5
  - **Steps:** Caplets converts the failure into a sanitized categorical error payload and sends it to Sentry only if telemetry is enabled.
  - **Outcome:** Maintainers see reliability patterns without receiving local paths, raw stack traces, URLs, credentials, or user-provided content.

---

## Acceptance Examples

- AE1. **Covers R2, R34.** Given `telemetry: false` and no disabling environment variable, when a user runs `caplets doctor`, then neither Sentry nor PostHog is initialized or called.
- AE2. **Covers R3, R4, R34.** Given telemetry is enabled in config and `CAPLETS_DISABLE_TELEMETRY=1` is set, when a native integration starts, then neither Sentry nor PostHog is initialized or called.
- AE3. **Covers R8, R9, R10, R11.** Given telemetry is enabled and no notice has been recorded, when a user runs `caplets serve`, then Caplets writes the telemetry notice to stderr before sending the first event and writes no notice to stdout.
- AE4. **Covers R14.** Given the telemetry notice has already been recorded, when the user later starts `caplets attach`, then Caplets does not print the notice again.
- AE5. **Covers R7.** Given a user runs `caplets telemetry debug`, when Caplets would normally send a usage event, then the sanitized payload is printed locally and no provider request is sent.
- AE6. **Covers R19, R25.** Given telemetry is enabled in CI, when a setup command runs locally, then the PostHog event is sent with runtime mode `local` and execution context `CI`.
- AE7. **Covers R21.** Given a test environment is detected, when any Caplets command or native integration runs, then telemetry is suppressed automatically.
- AE8. **Covers R15, R22, R23, R24, R25.** Given a user completes remote login and later uses Cloud attach through a native integration, when telemetry is enabled, then PostHog can connect those categorical milestones through the stable anonymous installation ID.
- AE9. **Covers R26, R27, R35.** Given a config contains MCP and HTTP Caplets with mixed exposure modes, when Caplets emits a product event, then the event contains only backend-family and exposure-mode counts rather than Caplet IDs or config values.
- AE10. **Covers R28, R33, R35.** Given a Code Mode run fails diagnostics on user code, when telemetry is enabled, then telemetry may include diagnostic codes and duration bucket but must not include the code or logs.
- AE11. **Covers R31, R32, R33.** Given a command fails with a Caplets error, when Sentry capture is enabled, then Sentry receives the Caplets error code and categorical context but not file paths, URLs, raw stack traces, or raw error payloads.
- AE12. **Covers R38.** Given Caplets telemetry projects are configured in Sentry and PostHog, when provider-side privacy settings are inspected, then IP capture and geolocation enrichment are disabled or scrubbed where supported.
- AE13. **Covers R12, R13.** Given a user's first telemetry-capable action happens through a native integration or hidden-stderr daemon, when no user-visible notice channel is available, then Caplets suppresses telemetry instead of recording the notice as shown.
- AE14. **Covers R17, R18, R39.** Given a user disables telemetry, when they inspect telemetry status, then Caplets explains whether the anonymous installation ID still exists and offers the documented delete or rotate control.
- AE15. **Covers R41.** Given shipped package contents are inspected, when provider identifiers are present, then they are intake-only, environment-specific, revocable, and not read or admin credentials.
- AE16. **Covers R42.** Given provider delivery fails, when a Caplets command runs, then the command succeeds without telemetry blocking and aggregate delivery health records the failure or uncertainty.
- AE17. **Covers R43.** Given a CI loop repeatedly emits the same telemetry shape, when telemetry is enabled, then bounded queues, sampling, rate limiting, or provider quotas prevent unbounded ingestion.
- AE18. **Covers R44.** Given the first telemetry release is reviewed, when maintainers inspect product usage, then saved queries or a recurring report maps collected events back to the decision questions.

---

## Success Criteria

- Maintainers can answer which setup steps, integration surfaces, runtime modes, exposure modes, and backend families are actually used.
- Maintainers can map those answers to documented product decision questions, thresholds, and review cadence.
- Maintainers can compare Code Mode, progressive, and direct usage without inspecting user content.
- Maintainers can see sanitized error frequency by package, surface, runtime mode, and Caplets error code.
- Maintainers can detect when telemetry delivery health is too weak to distinguish missing events from real non-usage.
- Users can discover telemetry status and disable telemetry without reading source code.
- Telemetry cannot break MCP stdio, long-running serve or attach sessions, daemon workflows, or native integration startup.

---

## Scope Boundaries

- Capturing raw config, prompts, Code Mode code, tool arguments, tool outputs, logs, file paths, URLs, hostnames, Caplet IDs, and raw stack traces is out of scope.
- Full product analytics dashboards are out of scope for the first implementation, but saved queries or a recurring lightweight usage report are in scope.
- Per-user accounts, email identity, workspace identity, and organization-level identity are out of scope.
- Provider-side setup automation is out of scope; provider privacy configuration is a launch prerequisite.
- Self-hosted telemetry backends are out of scope for the first version.

---

## Dependencies and Assumptions

- The telemetry layer depends on Sentry and PostHog projects that are configured to minimize IP and geolocation capture.
- The first implementation assumes provider identifiers can be distributed as intake-only, environment-specific, revocable identifiers without exposing management, read, or admin access.
- The first implementation assumes event transport can be fire-and-forget for user workflows while retaining aggregate delivery-health visibility for analysis.
- The first implementation assumes docs can describe exactly what is collected, what is never collected, and how to disable or debug telemetry.

---

## Sources / Research

- `STRATEGY.md` frames runtime diagnosability, native agent surfaces, remote runtime, and public proof as active product priorities.
- `packages/cli/src/index.ts` is the published CLI wrapper that delegates to core CLI execution.
- `packages/core/src/cli.ts` centralizes CLI command handling, injected IO, env handling, remote routing, setup, daemon, attach, Code Mode, auth, vault, and operation commands.
- `packages/core/src/cli/commands.ts` defines top-level and nested CLI command families.
- `packages/core/src/native/service.ts` centralizes native service creation, local and remote mode resolution, tool listing, reload, and execution.
- `packages/opencode/src/index.ts` and `packages/opencode/src/hooks.ts` initialize the native service and execute native Caplets tools for OpenCode.
- `packages/pi/src/index.ts` initializes the native service, tracks Pi session lifecycle, and executes native Caplets tools for Pi.
- `packages/core/src/errors.ts` and `packages/core/src/redaction.ts` provide existing Caplets error codes and redaction helpers that telemetry should build on.
- Sentry server-side scrubbing docs: https://docs.sentry.io/security-legal-pii/scrubbing/server-side-scrubbing/
- PostHog privacy controls docs: https://posthog.com/docs/product-analytics/privacy
