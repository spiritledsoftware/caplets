import type { AddMcpClientId } from "./add-mcp-adapter";
import { listSupportedAddMcpClients } from "./add-mcp-adapter";

/** Native integrations that Caplets configures without an MCP client entry. */
export const nativeSetupIntegrationIds = ["opencode", "pi"] as const;

/** Integration accepted by `caplets setup`: an add-mcp client or a Caplets-native host. */
export type SetupIntegrationId = AddMcpClientId | "pi";

/** All direct `caplets setup` integration names from add-mcp plus Pi. */
export const setupIntegrationIds: readonly SetupIntegrationId[] = [
  ...listSupportedAddMcpClients()
    .filter((client) => client.supportsStdio)
    .map((client) => client.id),
  "pi",
];

/** Reports whether setup must install a native Caplets integration instead of MCP config. */
export function isNativeSetupIntegrationId(value: string): value is "opencode" | "pi" {
  return nativeSetupIntegrationIds.some((id) => id === value);
}
