import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { capabilityDescription, ServerRegistry } from "../src/registry.js";

describe("registry", () => {
  it("omits disabled servers and builds safe capability cards", () => {
    const config = parseConfig({
      mcpServers: {
        enabled: {
          name: "Enabled Server",
          description: "A useful enabled server.",
          command: "node",
          args: ["secret-arg"],
        },
        disabled: {
          name: "Disabled Server",
          description: "A useful disabled server.",
          command: "node",
          disabled: true,
        },
      },
    });
    const registry = new ServerRegistry(config);
    expect(registry.enabledServers().map((server) => server.server)).toEqual(["enabled"]);
    expect(registry.get("disabled")).toBeUndefined();
    expect(capabilityDescription(config.mcpServers.enabled!)).toContain("Enabled Server");
    expect(capabilityDescription(config.mcpServers.enabled!)).not.toContain("secret-arg");
  });
});
