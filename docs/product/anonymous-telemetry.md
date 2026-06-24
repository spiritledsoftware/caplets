# Anonymous Telemetry

Caplets collects opt-out anonymous telemetry to understand setup friction, runtime adoption, integration usage, backend-family investment, exposure-mode usage, Code Mode outcomes, and reliability pressure.

Telemetry is disabled when `CAPLETS_DISABLE_TELEMETRY=1` is set, when the user config has top-level `"telemetry": false`, or in test environments. Use `caplets telemetry status`, `caplets telemetry disable`, `caplets telemetry enable`, `caplets telemetry rotate-id`, and `caplets telemetry delete-id` to inspect or change local telemetry state.

The first eligible interactive CLI run writes this notice to stderr only:

```text
Caplets collects anonymous telemetry for product usage and reliability. Disable it with CAPLETS_DISABLE_TELEMETRY=1 or `caplets telemetry disable`.
```

Caplets never collects raw config, prompts, Code Mode code, tool arguments, tool outputs, logs, resource contents, prompt contents, file paths, URLs, hostnames, Caplet IDs, credentials, tokens, raw environment variables, raw error messages, or unsanitized stack traces.

`delete-id` and `rotate-id` affect only the local anonymous installation ID. They do not delete provider-side historical anonymous events; provider retention settings govern historical data.

Provider readiness, retention, scrubbing, revocation, quota, and ingestion-monitoring gates are tracked in `docs/product/telemetry-provider-readiness.md`.
