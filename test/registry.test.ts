import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { capabilityDescription, ServerRegistry } from "../src/registry.js";

describe("registry", () => {
  it("omits disabled servers and builds safe capability cards", () => {
    process.env.SECRET_TOKEN = "secret-env-value";
    const config = parseConfig({
      mcpServers: {
        enabled: {
          name: "Enabled Server",
          description: "A useful enabled server.",
          command: "node",
          args: ["secret-arg", "$env:SECRET_TOKEN"],
          env: { SECRET_TOKEN: "$env:SECRET_TOKEN" },
          auth: undefined,
        },
        remote: {
          name: "Remote Server",
          description: "A useful remote server.",
          transport: "http",
          url: "https://example.com/mcp?token=secret-url-value",
          auth: { type: "bearer", token: "secret-bearer-value" },
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
    expect(registry.enabledServers().map((server) => server.server)).toEqual(["enabled", "remote"]);
    expect(registry.get("disabled")).toBeUndefined();
    const description = capabilityDescription(config.mcpServers.enabled!);
    expect(description).toContain("Enabled Server");
    expect(description).toContain(
      '{"operation":"call_tool","tool":"<tool name>","arguments":{...}}',
    );
    expect(description).toContain("Do not put downstream arguments at the top level");
    expect(description).not.toContain("secret-arg");
    expect(description).not.toContain("secret-env-value");

    const remoteDetail = registry.detail(config.mcpServers.remote!);
    const serialized = JSON.stringify(remoteDetail);
    expect(serialized).toContain('"transport":"http"');
    expect(serialized).not.toContain("secret-url-value");
    expect(serialized).not.toContain("secret-bearer-value");
  });
});
