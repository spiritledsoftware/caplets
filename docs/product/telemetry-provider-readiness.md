# Telemetry Provider Readiness

Version: 3

Status: PostHog IP-discard gate verified for the unified production and preview project; overall release readiness remains conditional on the launch gates below.

## Provider Project

| Field                     | Value                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| Environment               | production and preview                                                                             |
| PostHog project           | unified Caplets product analytics project                                                          |
| PostHog intake identifier | public project token only, no private API key                                                      |
| PostHog IP data capture   | Production and preview: **Settings → Project → General → IP data capture configuration → Discard** |
| Sentry project            | separate runtime, landing, docs, and catalog projects                                              |
| Sentry intake identifier  | per-surface DSN plus CI-only source-map auth token                                                 |
| Owner                     | Spirit-Led Software maintainer on release duty                                                     |
| Review date               | 2026-07-10 09:34 UTC                                                                               |
| Review cadence            | before every telemetry-enabled release and after provider key rotation                             |
| Retention                 | provider project retention reviewed before release                                                 |
| Ingestion monitoring      | provider dashboards plus local delivery-health counters                                            |
| Revocation                | rotate PostHog project token, Sentry DSNs, and Sentry auth token                                   |

## Launch Gates

| Gate                 | Required check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Status |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Intake identifiers   | Runtime release has `CAPLETS_POSTHOG_TOKEN`, `CAPLETS_RUNTIME_SENTRY_DSN`, `CAPLETS_SENTRY_AUTH_TOKEN`, `CAPLETS_SENTRY_ORG`, `CAPLETS_RUNTIME_SENTRY_PROJECT`, release, and environment values.                                                                                                                                                                                                                                                                                                                                                                                                    | Ready  |
| Site deploy env      | Deploy and preview jobs have `PUBLIC_CAPLETS_POSTHOG_TOKEN`, `PUBLIC_CAPLETS_POSTHOG_HOST`, per-site browser DSNs, catalog worker DSN, Sentry org/project slugs, release, and environment values.                                                                                                                                                                                                                                                                                                                                                                                                   | Ready  |
| Package artifacts    | No provider management keys, read tokens, admin tokens, or CI secrets are present in package contents, docs examples, tests, or logs.                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Ready  |
| PostHog IP and GeoIP | The unified active production and preview project uses **Settings → Project → General → IP data capture configuration → Discard**. PostHog project `Caplets` (`484122`) was verified through the provider API on 2026-07-10 at 09:34 UTC with `anonymize_ips: true`, whose provider contract drops the IP address from every ingested event. `$geoip_disable: true` remains required on accepted events, but it does not control or prove provider source-IP storage. Browser SDKs also disable autocapture, pageview autocapture, replay, web experiments, surveys, and persistence for this pass. | Ready  |
| Sentry privacy       | Runtime events use sanitized stack frames; browser events use `sendDefaultPii: false`; catalog worker errors send categorical route tags only.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Ready  |
| Source maps          | Runtime release uploads `packages/core/dist` source maps with `sentry-cli`; landing, docs, and catalog builds use the Sentry Vite plugin with hidden source maps when CI upload env is present.                                                                                                                                                                                                                                                                                                                                                                                                     | Ready  |
| Retention            | Provider retention settings are reviewed by the release owner before broad telemetry-enabled rollout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Ready  |
| Ingestion monitoring | Provider ingestion errors, quota pressure, unexpected event spikes, and local delivery-health counters are checked before interpreting missing events as missing usage.                                                                                                                                                                                                                                                                                                                                                                                                                             | Ready  |
| Revocation           | A playbook exists to rotate shipped PostHog/Sentry intake identifiers and validate old identifiers no longer ingest data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Ready  |
| Readout mapping      | `docs/product/telemetry-readout.md` maps decision questions to allowlisted event families and properties.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Ready  |

## Source-Map Release Shape

- Runtime package release: `CAPLETS_SENTRY_RELEASE=caplets-runtime@<sha-or-version>`, project `CAPLETS_RUNTIME_SENTRY_PROJECT`, dist `core`.
- Landing site release: `PUBLIC_CAPLETS_RELEASE=sites@<sha>` or `preview-<pr>@<sha>`, project `CAPLETS_LANDING_SENTRY_PROJECT`.
- Docs site release: same public release value, project `CAPLETS_DOCS_SENTRY_PROJECT`.
- Catalog browser release: same public release value, project `CAPLETS_CATALOG_SENTRY_PROJECT`.
- Catalog worker errors use `CAPLETS_CATALOG_SENTRY_DSN` and the same public release/environment values.

## Revocation Playbook

1. Create replacement PostHog project token, runtime Sentry DSN, public-site Sentry DSNs, and Sentry source-map auth token.
2. Update GitHub Actions secrets for release, deploy, and preview environments.
3. Run `pnpm telemetry:check-release-env`, `pnpm telemetry:check-web-env`, and `pnpm telemetry:check-source-maps` with the target environment.
4. Build and publish a patch release or redeploy affected sites with the replacement identifiers.
5. Revoke the old provider identifiers.
6. Trigger one non-sensitive test event per surface and confirm old identifiers no longer ingest events.
7. Check local delivery-health counters and provider ingestion dashboards for the first release window after rotation.

## Release Gate

Telemetry-enabled packaging must pass `pnpm telemetry:check-release-env` before publishing. Site deploys must pass `pnpm telemetry:check-web-env` and `pnpm telemetry:check-source-maps` before production or same-repo preview deploys. Fork previews do not receive secrets and are skipped by the existing repository guard.

Production and preview both use the unified PostHog project `Caplets` (`484122`). On 2026-07-10 at 09:34 UTC, the release owner enabled and re-read `anonymize_ips: true` through the PostHog project API; the provider schema defines that setting as dropping the IP address from every ingested event. Reverify this setting before every telemetry-enabled release and after provider project or token rotation.
