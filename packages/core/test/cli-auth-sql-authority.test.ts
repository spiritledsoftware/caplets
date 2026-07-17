import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig, runtimeFingerprintForConfig } from "../src/config";
import { CapletsError } from "../src/errors";
import type { ControlPlaneRuntimeSnapshot } from "../src/control-plane/snapshot";

const authority = vi.hoisted(() => ({
  snapshot: undefined as ControlPlaneRuntimeSnapshot | undefined,
  requireLive: vi.fn(async (_operation: string) => undefined),
  listTokenBundles: vi.fn(async () => []),
}));

vi.mock("../src/engine", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createCapletsEngine: vi.fn(async () => ({
      requireLiveControlPlane: authority.requireLive,
      controlPlaneSecurityRepository: () => ({ listTokenBundles: authority.listTokenBundles }),
      currentControlPlaneRuntimeSnapshot: () => authority.snapshot,
      close: async () => undefined,
    })),
  };
});

import { runCli } from "../src/cli";

const roots: string[] = [];

afterEach(() => {
  authority.snapshot = undefined;
  authority.requireLive.mockClear();
  authority.listTokenBundles.mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CLI SQL auth listing", () => {
  it("lists only activated effective config and requires live admin authority", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-cli-auth-sql-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          filesystem_only: {
            name: "Filesystem only",
            description: "Must not bypass activated SQL configuration.",
            transport: "http",
            url: "https://filesystem.example/mcp",
            auth: { type: "oauth2", clientId: "filesystem" },
          },
        },
      }),
    );
    const config = parseConfig({
      mcpServers: {
        sql_only: {
          name: "SQL only",
          description: "Activated SQL OAuth configuration.",
          transport: "http",
          url: "https://sql.example/mcp",
          auth: { type: "oauth2", clientId: "sql" },
        },
      },
    });
    authority.snapshot = {
      config,
      configWithSources: {
        config,
        sources: { sql_only: { kind: "sql", path: "" } },
        runtimeFingerprint: runtimeFingerprintForConfig(config),
      },
    } as unknown as ControlPlaneRuntimeSnapshot;
    const output: string[] = [];

    await runCli(["auth", "list", "--format", "json"], {
      env: { CAPLETS_CONFIG: configPath },
      writeOut: (value) => output.push(value),
    });

    expect(JSON.parse(output.join(""))).toEqual([
      { server: "sql_only", status: "missing", source: "global" },
    ]);
    expect(output.join("")).not.toContain("filesystem_only");
    expect(authority.requireLive).toHaveBeenCalledOnce();
    expect(authority.requireLive).toHaveBeenCalledWith("admin");

    authority.listTokenBundles.mockClear();
    authority.requireLive.mockRejectedValueOnce(
      new CapletsError("SERVER_UNAVAILABLE", "Control-plane migration drain is active."),
    );
    await expect(
      runCli(["auth", "list", "--format", "json"], {
        env: { CAPLETS_CONFIG: configPath },
        writeOut: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
    expect(authority.listTokenBundles).not.toHaveBeenCalled();
  });
});
