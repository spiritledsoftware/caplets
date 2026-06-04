import { describe, expect, it } from "vitest";
import type { CapletConfig } from "../src/config-runtime";
import { inferRuntimeFeatures, resolveRuntimeResources } from "../src/runtime-plan";

describe("runtime feature inference", () => {
  it("does not infer features for ordinary filesystem MCP packages", () => {
    expect(
      inferRuntimeFeatures(mcp("npx", ["-y", "@modelcontextprotocol/server-filesystem"])),
    ).toMatchObject({ features: [], provenance: [] });
  });

  it("infers docker from executable and package command patterns", () => {
    expect(inferRuntimeFeatures(mcp("docker", ["run", "mcp/server"]))).toMatchObject({
      features: ["docker"],
    });
    expect(inferRuntimeFeatures(mcp("npx", ["-y", "docker-mcp"])).provenance).toEqual([
      expect.objectContaining({
        feature: "docker",
        source: "mcp.command",
        command: "npx -y docker-mcp",
        matched: "docker-mcp",
      }),
    ]);
  });

  it("infers browser from Playwright, browser-use, and setup commands with provenance", () => {
    expect(inferRuntimeFeatures(mcp("npx", ["-y", "@playwright/mcp"]))).toMatchObject({
      features: ["browser"],
    });
    expect(inferRuntimeFeatures(mcp("uvx", ["browser-use"]))).toMatchObject({
      features: ["browser"],
    });

    const inferred = inferRuntimeFeatures({
      ...mcp("node", ["server.js"]),
      setup: { verify: [{ label: "Browsers", command: "npx", args: ["playwright", "install"] }] },
    });
    expect(inferred.provenance).toEqual([
      expect.objectContaining({
        feature: "browser",
        source: "setup.verify",
        command: "npx playwright install",
        matched: "playwright install",
      }),
    ]);
  });

  it("merges explicit features before inferred features in stable order", () => {
    const inferred = inferRuntimeFeatures({
      ...mcp("npx", ["-y", "@playwright/mcp"]),
      runtime: { features: ["docker"] },
    });

    expect(inferred.features).toEqual(["docker", "browser"]);
    expect(inferred.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          feature: "docker",
          source: "explicit",
          matched: "runtime.features",
        }),
        expect.objectContaining({ feature: "browser", source: "mcp.command" }),
      ]),
    );
  });

  it("extracts CLI action commands and resolves resource defaults", () => {
    const caplet = {
      server: "repo",
      backend: "cli",
      name: "Repo",
      description: "Run repository automation.",
      disabled: false,
      actions: {
        inspect: { command: "uvx", args: ["browser-use"] },
      },
      timeoutMs: 1000,
      maxOutputBytes: 1000,
    } satisfies CapletConfig;
    const inferred = inferRuntimeFeatures(caplet);

    expect(inferred).toMatchObject({ features: ["browser"] });
    expect(resolveRuntimeResources(caplet, inferred.features)).toEqual({
      class: "large",
      cpu: 4,
      memoryMb: 8192,
      diskMb: 20480,
    });
    expect(
      resolveRuntimeResources(
        { ...caplet, runtime: { resources: { class: "heavy" } } },
        inferred.features,
        { maxClass: "large" },
      ),
    ).toMatchObject({ class: "large" });
  });
});

function mcp(command: string, args: string[] = []): CapletConfig {
  return {
    server: "mcp",
    backend: "mcp",
    name: "MCP",
    description: "Run an MCP test server.",
    disabled: false,
    transport: "stdio",
    command,
    args,
    startupTimeoutMs: 1000,
    callTimeoutMs: 1000,
    toolCacheTtlMs: 1000,
  };
}
