import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

describe("root agent plugin artifacts", () => {
  it("declares Codex plugin components using Codex-specific files", async () => {
    const manifest = await readJson<Record<string, unknown>>(
      path.join(repoRoot, ".codex-plugin/plugin.json"),
    );

    expect(manifest.skills).toBe("./skills/");
    expect(manifest.mcpServers).toBe("./codex.mcp.json");
    expect(manifest.hooks).toBe("./codex.hooks.json");
  });

  it("declares Claude Code plugin components using Claude-specific files", async () => {
    const manifest = await readJson<Record<string, unknown>>(
      path.join(repoRoot, ".claude-plugin/plugin.json"),
    );

    expect(manifest.skills).toBe("./skills/");
    expect(manifest.mcpServers).toBe("./claude.mcp.json");
    expect(manifest.hooks).toBe("./claude.hooks.json");
  });

  it("keeps plugin manifest versions aligned with the CLI package", async () => {
    const [cliPackage, codexManifest, claudeManifest] = await Promise.all([
      readJson<{ version: string }>(path.join(repoRoot, "packages/cli/package.json")),
      readJson<{ version: string }>(path.join(repoRoot, ".codex-plugin/plugin.json")),
      readJson<{ version: string }>(path.join(repoRoot, ".claude-plugin/plugin.json")),
    ]);

    expect(codexManifest.version).toBe(cliPackage.version);
    expect(claudeManifest.version).toBe(cliPackage.version);
  });

  it("declares a Claude Code marketplace entry using Claude's schema", async () => {
    const marketplace = await readJson<{
      name: string;
      owner: { name: string };
      plugins: Array<{
        name: string;
        source: string;
      }>;
    }>(path.join(repoRoot, ".claude-plugin/marketplace.json"));

    expect(marketplace.name).toBe("caplets");
    expect(marketplace.owner.name).toBe("Spirit-Led Software LLC");
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({
        name: "caplets",
        source: "./",
      }),
    ]);
  });

  it("declares a Codex marketplace entry using Codex's schema", async () => {
    const marketplace = await readJson<{
      name: string;
      plugins: Array<{
        name: string;
        source: { source: string; path: string };
      }>;
    }>(path.join(repoRoot, ".agents/plugins/marketplace.json"));

    expect(marketplace.name).toBe("caplets");
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({
        name: "caplets",
        source: { source: "local", path: "./" },
      }),
    ]);
  });

  it("runs the globally installed Caplets CLI in both MCP configs", async () => {
    const [codexMcp, claudeMcp] = await Promise.all([
      readJson<{ caplets: { command: string; args: string[] } }>(
        path.join(repoRoot, "codex.mcp.json"),
      ),
      readJson<{ mcpServers: { caplets: { command: string; args: string[] } } }>(
        path.join(repoRoot, "claude.mcp.json"),
      ),
    ]);

    expect(codexMcp.caplets).toMatchObject({
      command: "caplets",
      args: ["serve"],
    });
    expect(claudeMcp.mcpServers.caplets).toEqual({
      command: "caplets",
      args: ["serve"],
    });
    expect(JSON.stringify(codexMcp)).not.toContain("caplets@");
    expect(JSON.stringify(claudeMcp)).not.toContain("caplets@");
  });

  it("uses the shared root skill and keeps hooks agent-specific", async () => {
    const [skill, codexHooks, claudeHooks] = await Promise.all([
      readFile(path.join(repoRoot, "skills/caplets/SKILL.md"), "utf8"),
      readJson<Record<string, unknown>>(path.join(repoRoot, "codex.hooks.json")),
      readJson<Record<string, unknown>>(path.join(repoRoot, "claude.hooks.json")),
    ]);

    expect(skill).toContain("name: caplets");
    expect(skill).toContain("call_tool");
    expect(JSON.stringify(codexHooks)).toContain("statusMessage");
    expect(JSON.stringify(claudeHooks)).not.toContain("statusMessage");
  });

  it("keeps plugin metadata and components in documented locations", () => {
    for (const forbiddenPath of [
      "packages/codex",
      "packages/claude-code",
      "packages/agent-plugin-shared",
      "plugins",
      ".mcp.json",
      "hooks",
      ".codex-plugin/.mcp.json",
      ".claude-plugin/.mcp.json",
      ".codex-plugin/hooks.json",
      ".claude-plugin/hooks.json",
      ".codex-plugin/hooks",
      ".claude-plugin/hooks",
      ".codex-plugin/skills",
      ".claude-plugin/skills",
    ]) {
      expect(existsSync(path.join(repoRoot, forbiddenPath)), forbiddenPath).toBe(false);
    }

    for (const requiredPath of [
      ".codex-plugin/plugin.json",
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      ".agents/plugins/marketplace.json",
      "codex.mcp.json",
      "claude.mcp.json",
      "codex.hooks.json",
      "claude.hooks.json",
      "skills/caplets/SKILL.md",
    ]) {
      expect(existsSync(path.join(repoRoot, requiredPath)), requiredPath).toBe(true);
    }
  });
});
