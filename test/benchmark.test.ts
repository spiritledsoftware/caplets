import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { capabilityDescription, ServerRegistry } from "../src/registry.js";

describe("progressive disclosure benchmark fixture", () => {
  it("exposes a much smaller initial tool list than direct aggregation", () => {
    const mcpServers = Object.fromEntries(
      Array.from({ length: 5 }, (_, serverIndex) => [
        `server_${serverIndex}`,
        {
          name: `Server ${serverIndex}`,
          description: `Capability card for server ${serverIndex} with focused domain guidance.`,
          command: "node",
        },
      ]),
    );
    const config = parseConfig({ mcpServers });
    const registry = new ServerRegistry(config);
    const capletsToolsPayload = JSON.stringify(
      registry.enabledServers().map((server) => ({
        name: server.server,
        description: capabilityDescription(server),
        inputSchema: {
          properties: {
            operation: {
              enum: [
                "get_caplet",
                "check_mcp_server",
                "list_tools",
                "search_tools",
                "get_tool",
                "call_tool",
              ],
            },
          },
        },
      })),
    );
    const directToolsPayload = JSON.stringify(
      Array.from({ length: 50 }, (_, index) => ({
        name: `tool_${index % 10}`,
        description: `Verbose downstream tool description ${index} with enough detail to represent real metadata.`,
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query for the target downstream service.",
            },
            limit: { type: "number", description: "Maximum result count." },
          },
          required: ["query"],
        },
      })),
    );

    const reduction = 1 - capletsToolsPayload.length / directToolsPayload.length;
    expect(reduction).toBeGreaterThan(0.7);
  });
});
