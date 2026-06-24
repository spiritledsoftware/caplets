# Telemetry Readout

This readout maps anonymous event families back to the product questions that motivated telemetry. Saved provider queries should use only the allowlisted event names and categorical properties in `packages/core/src/telemetry/events.ts`.

## Decision Questions

| Question                                                  | Event families                                                                | Required properties                                                                                                                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where does setup fail?                                    | `caplets_cli_command`, `caplets_reliability_error`                            | `command_family`, `outcome`, `duration_bucket`, `error_code`, `diagnostic_category`                                                                                         |
| Which surfaces are active?                                | `caplets_cli_command`, `caplets_tool_activation`, `caplets_code_mode_outcome` | `surface`, `execution_context`, `runtime_mode`, `outcome`                                                                                                                   |
| Is local, remote, or cloud runtime worth more investment? | `caplets_cli_command`, `caplets_tool_activation`, `caplets_reliability_error` | `runtime_mode`, `surface`, `outcome`, `error_code`                                                                                                                          |
| Are native integrations used?                             | `caplets_tool_activation`, `caplets_code_mode_outcome`                        | `surface`, `integration`, `runtime_mode`, `outcome`                                                                                                                         |
| Which exposure modes are used?                            | `caplets_tool_activation`                                                     | `exposure_mode`, `direct_count`, `progressive_count`, `code_mode_count`, `operation_family`                                                                                 |
| Which backend families deserve investment?                | `caplets_tool_activation`                                                     | `backend_mcp_count`, `backend_openapi_count`, `backend_google_discovery_count`, `backend_graphql_count`, `backend_http_count`, `backend_cli_count`, `backend_caplets_count` |
| Is Code Mode succeeding?                                  | `caplets_code_mode_outcome`, `caplets_reliability_error`                      | `outcome`, `duration_bucket`, `timeout_bucket`, `session_category`, `any_caplet_invoked`, `diagnostic_category`                                                             |
| What reliability pressure is highest?                     | `caplets_reliability_error`                                                   | `surface`, `runtime_mode`, `command_family`, `error_code`, `diagnostic_category`                                                                                            |

## Saved Query Contract

- Setup funnel: count `caplets_cli_command` setup/install outcomes by `command_family` and `outcome`.
- Surface adoption: count `caplets_cli_command`, `caplets_tool_activation`, and `caplets_code_mode_outcome` by `surface`, `runtime_mode`, and `execution_context`.
- First activation: count `caplets_tool_activation` successes by `surface`, `operation_family`, and `exposure_mode`.
- Code Mode outcomes: count `caplets_code_mode_outcome` by `outcome`, `timeout_bucket`, and `session_category`.
- Reliability: count `caplets_reliability_error` by `surface`, `command_family`, `error_code`, and `diagnostic_category`.
