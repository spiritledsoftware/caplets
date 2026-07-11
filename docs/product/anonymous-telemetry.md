# Anonymous Telemetry

Caplets collects opt-out anonymous telemetry to understand setup friction, runtime adoption, integration usage, backend-family investment, exposure-mode usage, Code Mode outcomes, and reliability pressure.

Telemetry is disabled when `CAPLETS_DISABLE_TELEMETRY=1` is set, when the user config has top-level `"telemetry": false`, or in test environments. Use `caplets telemetry status`, `caplets telemetry disable`, `caplets telemetry enable`, `caplets telemetry rotate-id`, and `caplets telemetry delete-id` to inspect or change local telemetry state.

The first eligible interactive CLI run writes this notice to stderr only:

```text
Caplets collects anonymous telemetry for product usage and reliability. Disable it with CAPLETS_DISABLE_TELEMETRY=1 or `caplets telemetry disable`.
```

Caplets never collects raw config, prompts, Code Mode code, tool arguments, tool outputs, logs, resource contents, prompt contents, file paths, URLs, hostnames, Caplet IDs, user credentials, provider management keys, token-shaped application data, raw environment variables, raw error messages, or unsanitized stack traces.

Public-site analytics use the same anonymous boundary. Landing, docs, and catalog events use categorical route, section, search, filter, and install-intent fields. Their final PostHog envelopes retain the configured public project token and an anonymous `distinct_id` only for provider routing; neither is a user credential, management key, or application token field. Known-user and person-profile attribution are prohibited, and no browser identity is handed into CLI or runtime telemetry. Browser analytics disable session replay, heatmaps, broad autocapture, raw DOM capture, persistence, and known-user identification for this pass.

Install attribution is a short command-visible marker such as `CAPLETS_INSTALL_ATTRIBUTION=catalog_install`. It is categorical, nonsecret, one-way, and consumed on the first eligible successful runtime product event. It is not a browser visitor identifier and is not linked to a PostHog person profile.

Runtime reliability events may include sanitized stack frames. Runtime sanitization removes local paths, URLs, hostnames, token-shaped values, raw arguments, tool payloads, Code Mode source, output content, raw messages, breadcrumbs, request data, and arbitrary extra payloads. Browser/public-site Sentry events keep browser stack frames for source mapping but exclude user context, request bodies, credentials, analytics identifiers, and arbitrary extra payloads.

`delete-id` and `rotate-id` affect only the local anonymous installation ID. They do not delete provider-side historical anonymous events; provider retention settings govern historical data.

Provider readiness, retention, scrubbing, revocation, quota, and ingestion-monitoring gates are tracked in `docs/product/telemetry-provider-readiness.md`.

Catalog public indexing remains separate from anonymous telemetry. Public indexing can publish public source identity and Caplet identity for searchable catalog entries; anonymous telemetry cannot.
