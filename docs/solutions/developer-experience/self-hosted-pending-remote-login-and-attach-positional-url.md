---
title: "Self-Hosted Remote Login Uses Pending Approval and Positional Attach URLs"
date: 2026-06-23
category: developer-experience
module: "remote attach cli"
problem_type: developer_experience
component: tooling
severity: medium
applies_when:
  - "Designing remote login or attach flows that should keep credentials out of agent configuration"
  - "Migrating from operator-minted self-hosted Pairing Codes to client-started host approval"
  - "Changing a CLI flag-based primary path to a positional argument while preserving compatibility"
symptoms:
  - "Self-hosted Remote Login required an operator to mint and copy a Pairing Code before the client could start login"
  - "`caplets attach --remote-url <url>` made the common remote attach path look like an advanced option-heavy mode"
  - "Remote agent configuration examples risked teaching users to handle credential-like bootstrap material in argv, environment variables, or config"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components:
  - authentication
  - documentation
  - testing_framework
tags:
  - remote-login
  - remote-attach
  - pairing
  - cli-ergonomics
  - remote-profiles
  - self-hosted
  - agent-config
---

# Self-Hosted Remote Login Uses Pending Approval and Positional Attach URLs

## Context

Self-hosted Remote Login and Remote Attach both had the right long-term product direction — Caplets-owned Remote Profiles instead of credentials in agent configs — but the operator experience still taught the wrong shape.

The old self-hosted login path started from the host. An operator minted a Pairing Code, copied it to a client, and the client exchanged it for final credentials:

```sh
caplets remote host pair --host-url https://caplets.example.com/caplets --json
caplets remote login https://caplets.example.com/caplets --code <pairing-code>
```

That made a human carry credential-like bootstrap material and made the supported flow depend on a hidden prompt. During implementation, a RED test timed out at that hidden Pairing Code prompt, which pushed the workflow toward client-started pending login instead of trying to polish the old prompt (session history).

Remote Attach had a smaller but related ergonomics problem. The common command looked like an advanced option mode:

```sh
caplets attach --remote-url https://caplets.example.com/caplets
```

The old shape was especially awkward for generated agent configuration. A prior Codex setup path had baked a resolved remote URL into an MCP command as `caplets attach --remote-url <current CAPLETS_REMOTE_URL>`, which captured a point-in-time value and made setup more fragile than using runtime-owned Caplets resolution (session history).

The resulting branch coupled two decisions:

- self-hosted Remote Login is client-started and server-approved;
- `caplets attach <url>` is the primary Remote Attach command, while `--remote-url` remains a hidden compatibility alias for old configs.

## Guidance

When a remote CLI flow requires both trust establishment and later agent subprocess execution, make Caplets own the credential lifecycle. The client should initiate trust, the server-local operator should approve pending metadata, final credentials should land in Remote Profiles only after approval and possession proof, and agent configs should contain stable selectors such as `caplets attach <url>` rather than copied secrets or bootstrap codes.

### Make the common attach shape positional

Users attach to a URL, so the URL should be the primary argument:

```sh
caplets attach https://caplets.example.com/caplets
```

Keep the old option only as hidden compatibility while new help, docs, tests, and generated examples converge on the simpler form:

```ts
program
  .command(cliCommands.attach)
  .description("Start a remote-backed Caplets MCP server.")
  .argument("[url]", "remote Caplets service base URL")
  .addOption(
    new Option(
      "--remote-url <url>",
      "legacy alias for the remote Caplets service base URL",
    ).hideHelp(),
  );
```

Centralize the dual-input merge rule and reject ambiguous invocations:

```ts
function attachRemoteUrlFromArgs(
  positionalUrl: string | undefined,
  legacyRemoteUrl: string | undefined,
): string | undefined {
  if (positionalUrl && legacyRemoteUrl && positionalUrl !== legacyRemoteUrl) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Pass either attach URL or --remote-url, not both. Use caplets attach <url> for new configs.",
    );
  }
  return positionalUrl ?? legacyRemoteUrl;
}
```

This gives old scripts a narrow path to keep working without leaving users to debug which URL won.

### Start self-hosted login from the client

The replacement self-hosted flow starts where the credential will be stored:

```sh
caplets remote login https://caplets.example.com/caplets
```

The client creates pending server state, prints only operator-facing material, polls for approval, and completes only after both approval and original client possession proof are present. The host operator approves from server-owned state:

```sh
caplets remote host logins
caplets remote host approve <code> --yes
```

The client output should be useful to the operator but not reveal possession material:

```text
Remote Login Code: cap_login_...
Code fingerprint: ...
Approve from the host with caplets remote host approve cap_login_... --yes
```

Approval stays host-local. The HTTP surface supports start, poll, refresh, complete, and cancel; it does not expose a remote approval route.

### Separate visible approval codes from possession material

Pending login state should distinguish the values used by different actors:

```ts
const operatorCode = `cap_login_${randomToken(5)}`;
const pendingRefreshSecret = `cap_pending_refresh_${randomToken(32)}`;
const pendingCompletionSecret = `cap_pending_complete_${randomToken(32)}`;
```

The operator code is visible and approval-only. The pending refresh and completion secrets are client-held possession material. The server stores hashes, not plaintext:

```ts
state.pendingLogins.push({
  flowId,
  operatorCodeHash: hashSecret(operatorCode),
  pendingRefreshHash: hashSecret(pendingRefreshSecret),
  pendingCompletionHash: hashSecret(pendingCompletionSecret),
  operatorCodeFingerprint: pendingOperatorCodeFingerprint(operatorCode),
  status: "pending",
});
```

Tests should assert that this separation holds:

```ts
expect(pending.pendingRefreshSecret).not.toBe(pending.pendingCompletionSecret);
expect(JSON.stringify(store.dumpForTest())).not.toContain(pending.operatorCode);
expect(JSON.stringify(store.dumpForTest())).not.toContain(pending.pendingRefreshSecret);
expect(JSON.stringify(store.dumpForTest())).not.toContain(pending.pendingCompletionSecret);
```

The host can use a non-secret fingerprint to correlate what the client displayed with what `remote host logins` shows, without exposing refresh or completion material.

### Convert old Pairing Code entry points into migration guidance

Do not silently keep the old Pairing Code bootstrap as a supported self-hosted workflow. Old entry points should return explicit guidance and avoid minting new login material:

```ts
const guidance =
  "Self-hosted Pairing Code bootstrap is no longer supported. Run caplets remote login <url> from the client, then approve the pending login with caplets remote host logins and caplets remote host approve <code> from the host.";
```

Likewise, `remote login --code` should reject before network I/O so users get deterministic migration guidance rather than an inconsistent partial legacy path:

```ts
if (options.code?.trim() || options.codeStdin) {
  throw new CapletsError(
    "REQUEST_INVALID",
    `Self-hosted Remote Login no longer accepts Pairing Codes. Run caplets remote login ${normalizeRemoteProfileHostUrl(url)} without --code and approve the pending login from the host.`,
  );
}
```

### Treat expiry, replay, cancellation, and races as protocol behavior

Pending login is not complete when the happy path works once. It needs deterministic behavior around the failure windows that matter for auth flows:

- visible operator codes expire independently from the longer pending flow;
- refresh rotates the visible code and refresh secret while preserving the completion proof;
- refresh and completion responses can be replayed briefly to tolerate lost responses;
- cancellation is possession-based and can cancel approved-but-unexchanged flows;
- the client polls before refreshing so it does not rotate away from an approval it could observe;
- if refresh races with approval, the client does one final poll before surfacing failure.

Those were not theoretical edges. Review found refresh-before-poll could race with approval, interrupt handling could leave sleeps or in-flight requests uncancelled, source hints and host metadata had abuse-control gaps, and the initial profile save derived host identity from CLI input rather than server-reported credentials (session history).

## Why This Matters

The old workflow asked the server operator to mint and transfer a bearer-like bootstrap artifact before the client could even start login. That blurred who owned each part of trust establishment:

- the client is the party that wants credentials;
- the host owns the authorization decision;
- a visible operator code should prove approval intent, not become attach credential material;
- the client should prove possession before final credentials are issued;
- final credentials should be stored in Caplets-owned Remote Profiles, not in shell history, agent configs, or long-lived process arguments.

The new workflow maps each responsibility to the right surface. A user or automation can configure an agent with a stable command such as:

```toml
args = ["attach", "https://caplets.example.com/caplets"]
```

That command remains local mediation. It can resolve Remote Profiles, refresh credentials, apply project binding or overlays, and keep secret-bearing state inside Caplets-owned runtime paths rather than pushing credentials into the agent harness. Earlier Codex setup exploration compared direct remote MCP with local `caplets attach`; the durable decision was to keep local attach as the mediation point when Caplets-specific credential and config behavior is needed (session history).

The attach ergonomics change is what makes that safer shape easy to teach. Hiding `--remote-url` from help lets existing scripts survive while making new docs and generated configs converge on `caplets attach <url>`.

## When to Apply

Use this pattern when an established CLI or auth workflow has these traits:

- there is a clearer command shape users should adopt going forward;
- existing scripts or generated configs may still use the old shape;
- the old shape can remain harmless if hidden from help and guarded by an explicit conflict rule;
- the workflow crosses a trust boundary, especially where operator approval and client possession are different concepts;
- bootstrap material previously moved through humans, docs, terminals, or agent configuration;
- the replacement can separate visible approval codes, client-held pending material, server-owned pending state, and final credentials;
- expiry, cancellation, replay, and race behavior can be covered with deterministic tests.

Do not use hidden compatibility as an excuse to keep old UX alive indefinitely. The alias is for old automation; help, docs, examples, tests, and generated configs should teach the new path.

## Examples

### Attach before and after

Before:

```sh
caplets attach --remote-url https://caplets.example.com/caplets
```

After:

```sh
caplets attach https://caplets.example.com/caplets
```

Compatibility still works, but is hidden from help:

```sh
caplets attach --remote-url https://caplets.example.com/caplets
```

The help test anchors the public shape:

```ts
expect(out.join("")).toContain("Usage: caplets attach [options] [url]");
expect(out.join("")).not.toContain("--remote-url <url>");
```

Conflicting inputs are rejected:

```sh
caplets attach https://caplets.example.com/caplets \
  --remote-url https://other.example.com/caplets
```

Expected error:

```text
Pass either attach URL or --remote-url, not both. Use caplets attach <url> for new configs.
```

### Self-hosted Remote Login before and after

Before:

```sh
caplets remote host pair --host-url https://caplets.example.com/caplets --json
caplets remote login https://caplets.example.com/caplets --code <pairing-code>
```

After:

```sh
caplets remote login https://caplets.example.com/caplets
# client prints cap_login_... and waits

caplets remote host logins
caplets remote host approve <code> --yes
```

The CLI tests assert the client prints an approvable host command and a code fingerprint while avoiding possession-secret leaks:

```ts
expect(out.join("")).toContain(
  `Approve from the host with caplets remote host approve ${pending?.operatorCode} --yes`,
);
expect(out.join("")).toContain(`Code fingerprint: ${pending?.operatorCodeFingerprint}`);
expect(out.join("")).not.toContain(pending?.pendingRefreshSecret ?? "missing");
expect(out.join("")).not.toContain(pending?.pendingCompletionSecret ?? "missing");
```

### Pending refresh and replay

Visible operator code expiry is independent from flow expiry. After the visible code expires, approval fails, but the original client can refresh to continue the same pending flow:

```ts
expect(() =>
  store.approvePendingLogin({
    operatorCode: pending.operatorCode,
    now: new Date("2026-06-19T12:10:01.000Z"),
  }),
).toThrow(/code has expired/u);

const refreshed = store.refreshPendingLogin({
  flowId: pending.flowId,
  pendingRefreshSecret: pending.pendingRefreshSecret,
  pendingCompletionSecret: pending.pendingCompletionSecret,
  now: new Date("2026-06-19T12:10:02.000Z"),
});

expect(refreshed.operatorCode).not.toBe(pending.operatorCode);
expect(refreshed.pendingRefreshSecret).not.toBe(pending.pendingRefreshSecret);
```

The implementation also stores short replay material for refresh and completion responses so a lost response does not wedge the flow after the server has already rotated or issued material.

### Verification focus

The targeted verification for this cluster covered attach CLI behavior, pending-login CLI behavior, server credential state, and HTTP routes:

```sh
pnpm --filter @caplets/core test -- \
  test/attach-cli.test.ts \
  test/remote-login-cli.test.ts \
  test/remote-pairing.test.ts \
  test/serve-http.test.ts
pnpm --filter @caplets/core typecheck
```

Session history also reported a later full `pnpm verify` and pre-push verification passing after PR review fixes (session history).

## Related

- Requirements source: [Unified Remote Attach Auth requirements](../../brainstorms/2026-06-19-unified-remote-attach-auth-requirements.md).
- Related solution: [Native Remote Clients Refresh Runtime Credentials Before Polls and Reconnects](../integration-issues/stale-remote-profile-credentials-refresh.md). It covers the same Remote Profile/runtime-owned credential direction for long-lived native clients.
- Related solution: [Vault CLI, Runtime, and Remote Paths Handle $vault Refs Consistently](../integration-issues/vault-cli-runtime-integration-fixes.md). It covers the same principle that secret-bearing values belong in runtime-owned state, not generic remote-control or agent config boundaries.
- User-facing docs: [`apps/docs/src/content/docs/remote-attach.mdx`](../../../apps/docs/src/content/docs/remote-attach.mdx) and [`README.md`](../../../README.md).
- Release notes: [self-hosted pending Remote Login](../../../.changeset/self-hosted-pending-remote-login.md) and [attach positional URL](../../../.changeset/attach-positional-url.md).
- Refresh candidate: `docs/plans/2026-06-19-001-feat-unified-remote-attach-auth-plan.md` describes the earlier `--remote-url` and operator-minted Pairing Code shape; the brainstorm requirements and current branch supersede those details.
