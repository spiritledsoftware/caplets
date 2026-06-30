import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("Codex and Claude manual MCP setup", () => {
  it("does not ship native Codex or Claude plugin artifacts", () => {
    for (const removedPath of [
      "plugins/caplets",
      ".agents/plugins/marketplace.json",
      ".claude-plugin/marketplace.json",
      "scripts/sync-plugin-versions.ts",
    ]) {
      expect(existsSync(path.join(repoRoot, removedPath)), removedPath).toBe(false);
    }
  });

  it("documents daemon-first local MCP setup for Codex and Claude users", async () => {
    const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
    expect(readme).toContain("caplets setup mcp-client --client codex");
    expect(readme).toContain("local Caplets daemon");
    expect(readme).toContain('"command": "caplets"');
    expect(readme).toContain('"args": ["attach", "http://127.0.0.1:5387/"]');
    expect(readme).toContain('"args": ["attach", "https://caplets.example.com/caplets"]');
    expect(readme).toContain("[mcp_servers.caplets]");
    expect(readme).not.toContain("codex mcp add caplets -- caplets serve");
    expect(readme).not.toContain(
      "claude mcp add --transport stdio --scope user caplets -- caplets serve",
    );
    expect(readme).not.toMatch(/plugin marketplace add|plugin (?:add|install) caplets@caplets/u);
  });

  it("documents serve as an advanced fallback and attach for remote MCP", async () => {
    const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
    expect(readme).toContain("advanced manual fallback");
    expect(readme).toContain("caplets serve --transport http");
    expect(readme).toContain("caplets attach");
    expect(readme).toContain("caplets remote login https://caplets.example.com/caplets");
    expect(readme).toContain("CAPLETS_MODE=cloud");
    expect(readme).toContain("CAPLETS_REMOTE_URL=https://cloud.caplets.dev");
  });

  it("does not keep version-package plugin sync wiring", async () => {
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["version-packages"] ?? "").not.toContain("sync-plugin-versions");
  });
});
