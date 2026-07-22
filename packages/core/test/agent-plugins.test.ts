import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("Codex and Claude MCP distribution", () => {
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

  it("does not keep version-package plugin sync wiring", async () => {
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["version-packages"] ?? "").not.toContain("sync-plugin-versions");
  });
});
