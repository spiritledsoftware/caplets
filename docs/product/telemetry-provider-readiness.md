# Telemetry Provider Readiness

Version: 1

Status: not ready for broad release until every launch gate below is checked for the release environment.

## Provider Project

| Field                     | Value                                  |
| ------------------------- | -------------------------------------- |
| Environment               | production                             |
| PostHog project           | TODO before release                    |
| PostHog intake identifier | project token only, no private API key |
| Sentry project            | TODO before release                    |
| Sentry intake identifier  | DSN only, no auth token                |
| Owner                     | TODO before release                    |
| Review date               | TODO before release                    |
| Review cadence            | before every telemetry-enabled release |

## Launch Gates

| Gate                 | Required check                                                                                                                                                        | Status |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Intake identifiers   | PostHog token and Sentry DSN are environment-specific, revocable, and contain no management, read, or admin privileges.                                               | TODO   |
| Package artifacts    | No provider management keys, private API keys, read tokens, admin tokens, or CI secrets are present in package contents, docs examples, tests, or logs.               | TODO   |
| PostHog IP and GeoIP | Project settings disable or scrub IP/geolocation capture where supported; SDK captures set `$geoip_disable: true` and `$process_person_profile: false`.               | TODO   |
| Sentry privacy       | Project server-side scrubbing is enabled; SDK uses `sendDefaultPii: false`; adapter tests prove raw stack, message, request, breadcrumb, and extra data are stripped. | TODO   |
| Retention            | Retention limits for PostHog and Sentry are recorded and accepted by the owner.                                                                                       | TODO   |
| Ingestion monitoring | Provider ingestion errors, quota pressure, and unexpected event spikes have an owner-visible monitoring path.                                                         | TODO   |
| Revocation           | A playbook exists to rotate shipped PostHog/Sentry intake identifiers and validate old identifiers no longer ingest data.                                             | TODO   |
| Delivery health      | Local delivery-health counters are reviewed before interpreting missing events as missing usage.                                                                      | TODO   |
| Readout mapping      | `docs/product/telemetry-readout.md` maps decision questions to allowlisted event families and properties.                                                             | TODO   |

## Revocation Playbook

1. Create replacement PostHog project token and Sentry DSN in the release environment.
2. Build a patch release with the replacement intake identifiers or environment configuration.
3. Revoke or disable the old identifiers in provider settings.
4. Validate that old identifiers no longer ingest events.
5. Check delivery-health counters and provider ingestion dashboards for the first release window after rotation.

## Release Gate

Telemetry-enabled packaging must not ship with intake identifiers until this document has non-TODO owner, review date, retention, ingestion-monitoring, and revocation entries for the target environment.

The GitHub Actions release workflow requires the release environment to define `CAPLETS_POSTHOG_TOKEN` and `CAPLETS_SENTRY_DSN` as repository or environment secrets. These values are passed only to the release job environment and must remain runtime intake identifiers, not hardcoded package contents.
