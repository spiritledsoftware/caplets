# Available Update Detection

Caplets passively detects when a newer published `caplets` CLI version is available and reports it
through a short stderr-only notice on eligible human-facing CLI invocations.

The first version is deliberately conservative. It does not auto-update Caplets, does not add a
`caplets update` command, and does not read user Caplet config, project config, npm config, custom
registries, backend definitions, secrets, Caplet IDs, prompts, tool arguments, tool outputs, paths,
hostnames, credentials, tokens, or user identifiers.

## Behavior

- Caplets compares the injected published CLI version with public npm metadata for the `caplets`
  package.
- Stable builds compare only against stable releases.
- Prerelease builds compare only against newer releases with the same base version and first
  prerelease identifier.
- Notices are one-line stderr messages that name the running version, the available version, and
  channel-neutral upgrade guidance.
- Repeated notices for the same available version are suppressed for a local repeat window.

## Suppression

Passive notices and refreshes are suppressed for:

- help, version, shell completion, and hidden completion output
- JSON and `--format json` output paths
- parse-error paths
- CI and non-interactive contexts without explicit opt-in
- daemon-managed service processes
- native integrations
- default stdio `caplets serve` and `caplets attach`

Foreground HTTP `caplets serve --transport http` may show a cached update notice when stderr is
human-facing.

## Controls

`CAPLETS_DISABLE_UPDATE_CHECK=1` disables passive update notices and prevents outbound update
metadata lookups.

`CAPLETS_UPDATE_NOTICE_STDERR=1` marks stderr as notice-safe for the current foreground invocation.
Use it only when stderr is visible to the user responsible for upgrading and separate from protocol
stdout. This opt-in does not override help, version, completion, JSON, daemon, or native-integration
suppression.

Update-check controls are independent from telemetry controls. `CAPLETS_DISABLE_TELEMETRY=1` does
not disable update detection.

## Local State

Caplets stores update-check cache under its cache directory and notice suppression state under its
state directory. These records contain public package metadata, timestamps, lock/backoff markers, and
shown-version state only.

Registry failures, network errors, timeouts, invalid metadata, oversized metadata, semver parse
failures, and cache read/write failures degrade to no update notice and do not affect the primary
command.
