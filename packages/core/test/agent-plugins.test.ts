import { existsSync, lstatSync } from "node:fs";
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
      path.join(repoRoot, "plugins/caplets/.codex-plugin/plugin.json"),
    );

    expect(manifest.skills).toBe("./skills/");
    expect(manifest.mcpServers).toBe("./mcp.json");
    expect(manifest.hooks).toBeUndefined();
  });

  it("declares Claude Code plugin components using Claude-specific files", async () => {
    const manifest = await readJson<Record<string, unknown>>(
      path.join(repoRoot, "plugins/caplets/.claude-plugin/plugin.json"),
    );

    expect(manifest.skills).toBe("./skills/");
    expect(manifest.mcpServers).toBe("./mcp.json");
    expect(manifest.hooks).toBeUndefined();
  });

  it("keeps plugin manifest versions aligned with the CLI package", async () => {
    const [rootPackage, cliPackage, codexManifest, claudeManifest] = await Promise.all([
      readJson<{ scripts: Record<string, string> }>(path.join(repoRoot, "package.json")),
      readJson<{ version: string }>(path.join(repoRoot, "packages/cli/package.json")),
      readJson<{ version: string }>(
        path.join(repoRoot, "plugins/caplets/.codex-plugin/plugin.json"),
      ),
      readJson<{ version: string }>(
        path.join(repoRoot, "plugins/caplets/.claude-plugin/plugin.json"),
      ),
    ]);

    expect(codexManifest.version).toBe(cliPackage.version);
    expect(claudeManifest.version).toBe(cliPackage.version);
    expect(rootPackage.scripts["version-packages"]).toContain("scripts/sync-plugin-versions.ts");
    expect(rootPackage.scripts["version-packages"]).toContain("oxfmt");
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
        source: "./plugins/caplets",
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
        source: { source: "local", path: "./plugins/caplets" },
      }),
    ]);
  });

  it("runs the globally installed Caplets CLI in both MCP configs", async () => {
    const mcp = await readJson<{ mcpServers: { caplets: { command: string; args: string[] } } }>(
      path.join(repoRoot, "plugins/caplets/mcp.json"),
    );

    expect(mcp.mcpServers.caplets).toEqual({
      command: "caplets",
      args: ["serve"],
    });
    expect(JSON.stringify(mcp)).not.toContain("caplets@");
  });

  it("uses a strong shared plugin skill for automatic selection", async () => {
    const skill = await readFile(
      path.join(repoRoot, "plugins/caplets/skills/caplets/SKILL.md"),
      "utf8",
    );

    expect(skill).toContain("name: caplets");
    expect(skill).toContain("when_to_use:");
    expect(skill).toContain("external tools");
    expect(skill).toContain("MCP servers");
    expect(skill).toContain("OpenAPI");
    expect(skill).toContain("GraphQL");
    expect(skill).toContain("HTTP endpoints");
    expect(skill).toContain("call_tool");
    expect(skill).toContain("Skip this skill for normal local code edits");
  });

  it("keeps the Codex marketplace source self-contained for plugin installs", () => {
    const pluginRoot = path.join(repoRoot, "plugins/caplets");
    const skillDir = path.join(pluginRoot, "skills");

    expect(lstatSync(pluginRoot).isDirectory()).toBe(true);
    expect(lstatSync(skillDir).isDirectory()).toBe(true);
    expect(lstatSync(skillDir).isSymbolicLink()).toBe(false);
    expect(existsSync(path.join(pluginRoot, ".codex-plugin/plugin.json"))).toBe(true);
    expect(existsSync(path.join(pluginRoot, "skills/caplets/SKILL.md"))).toBe(true);
    expect(existsSync(path.join(pluginRoot, "mcp.json"))).toBe(true);
  });

  it("keeps plugin metadata and components in documented locations", () => {
    for (const forbiddenPath of [
      "packages/codex",
      "packages/claude-code",
      "packages/agent-plugin-shared",
      ".codex-plugin",
      ".codex-plugins",
      ".mcp.json",
      "hooks",
      ".claude-plugin/plugin.json",
      ".claude-plugin/.mcp.json",
      ".codex-plugin/hooks.json",
      ".claude-plugin/hooks.json",
      ".codex-plugin/hooks",
      ".claude-plugin/hooks",
      ".claude-plugin/skills",
    ]) {
      expect(existsSync(path.join(repoRoot, forbiddenPath)), forbiddenPath).toBe(false);
    }

    for (const requiredPath of [
      "plugins/caplets/.codex-plugin/plugin.json",
      "plugins/caplets/.claude-plugin/plugin.json",
      "plugins/caplets/mcp.json",
      "plugins/caplets/skills/caplets/SKILL.md",
      "plugins/caplets/assets/icon.png",
      ".claude-plugin/marketplace.json",
      ".agents/plugins/marketplace.json",
      "scripts/sync-plugin-versions.ts",
    ]) {
      expect(existsSync(path.join(repoRoot, requiredPath)), requiredPath).toBe(true);
    }
  });
});
