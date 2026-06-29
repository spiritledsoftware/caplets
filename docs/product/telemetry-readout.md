# Telemetry Readout

This readout maps anonymous event families back to product questions. Saved provider queries should use only the allowlisted event names and categorical properties in `packages/core/src/telemetry/events.ts` and `packages/web-observability/src/events.ts`.

## Decision Questions

| Question                                                  | Event families                                                                                  | Required properties                                                                                                                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where does setup fail?                                    | `caplets_cli_command`, `caplets_reliability_error`                                              | `command_family`, `outcome`, `duration_bucket`, `error_code`, `diagnostic_category`                                                                                         |
| Which surfaces are active?                                | `caplets_cli_command`, `caplets_tool_activation`, `caplets_code_mode_outcome`                   | `surface`, `execution_context`, `runtime_mode`, `outcome`                                                                                                                   |
| Is local, remote, or cloud runtime worth more investment? | `caplets_cli_command`, `caplets_tool_activation`, `caplets_reliability_error`                   | `runtime_mode`, `surface`, `outcome`, `error_code`                                                                                                                          |
| Are native integrations used?                             | `caplets_tool_activation`, `caplets_code_mode_outcome`                                          | `surface`, `integration`, `runtime_mode`, `outcome`                                                                                                                         |
| Which exposure modes are used?                            | `caplets_tool_activation`                                                                       | `exposure_mode`, `direct_count`, `progressive_count`, `code_mode_count`, `operation_family`                                                                                 |
| Which backend families deserve investment?                | `caplets_tool_activation`                                                                       | `backend_mcp_count`, `backend_openapi_count`, `backend_google_discovery_count`, `backend_graphql_count`, `backend_http_count`, `backend_cli_count`, `backend_caplets_count` |
| Is Code Mode succeeding?                                  | `caplets_code_mode_outcome`, `caplets_reliability_error`                                        | `outcome`, `duration_bucket`, `timeout_bucket`, `session_category`, `any_caplet_invoked`, `diagnostic_category`                                                             |
| What reliability pressure is highest?                     | `caplets_reliability_error`                                                                     | `surface`, `runtime_mode`, `command_family`, `error_code`, `diagnostic_category`, release                                                                                   |
| Which public surfaces drive install intent?               | `caplets_site_pageview`, `caplets_site_intent`, `caplets_install_intent`, `caplets_cli_command` | `surface`, `route_family`, `page_family`, `section_category`, `install_intent_category`, `attribution_source`, `first_activation`                                           |
| Is catalog search helping users find Caplets?             | `caplets_catalog_search`, `caplets_site_intent`, `caplets_install_intent`                       | `search_length_bucket`, `filter_category`, `result_count_bucket`, `empty_state_category`, `result_interaction_category`                                                     |
| Are source-mapped releases healthy?                       | `caplets_reliability_error` plus Sentry release and source-map health views                     | release, environment, project, `surface`, `error_code`, stack frame source-map status                                                                                       |

## Saved Query Contract

- Setup funnel: count `caplets_cli_command` setup/install outcomes by `command_family` and `outcome`.
- Web-to-runtime funnel: count `caplets_site_pageview` to `caplets_install_intent`, then first successful `caplets_cli_command` or `caplets_tool_activation` with `attribution_source`, `attribution_intent`, and `first_activation`.
- Site intent: count `caplets_site_intent` by `surface`, `route_family`, `section_category`, `navigation_path_category`, and `outbound_action_category`.
- Catalog search: count `caplets_catalog_search` by `search_length_bucket`, `filter_category`, `result_count_bucket`, and `empty_state_category`.
- Surface adoption: count `caplets_cli_command`, `caplets_tool_activation`, and `caplets_code_mode_outcome` by `surface`, `runtime_mode`, and `execution_context`.
- First activation: count `caplets_tool_activation` successes by `surface`, `operation_family`, and `exposure_mode`.
- Code Mode outcomes: count `caplets_code_mode_outcome` by `outcome`, `timeout_bucket`, and `session_category`.
- Reliability: count `caplets_reliability_error` by `surface`, `command_family`, `error_code`, `diagnostic_category`, release, and environment.
- Source-map health: review runtime, landing, docs, and catalog Sentry projects for releases with uploaded artifacts before treating stackless issues as product failures.

## Interpretation Rules

- Check `caplets telemetry status` and local delivery-health counters before concluding that low PostHog volume means low usage.
- Check Sentry source-map upload status for the relevant release before concluding that an issue is not debuggable.
- Catalog public indexing is not anonymous telemetry. Public indexing uses public source identity and Caplet identity; do not count indexing records as web-to-runtime attribution.
- Session replay, heatmaps, raw DOM capture, known-user identity, raw search text, URLs, hostnames, paths, tool payloads, and Code Mode source are outside this telemetry readout.
