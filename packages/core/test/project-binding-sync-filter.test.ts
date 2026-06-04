import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildProjectSyncManifest } from "../src/project-binding/sync-filter";

describe("Project Binding sync filter", () => {
  it("honors hard denylist, .gitignore, and .capletsignore while allowing safe env templates", () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-sync-filter-"));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "node_modules"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "secret");
    writeFileSync(join(root, "node_modules", "pkg.js"), "ignored");
    writeFileSync(join(root, ".env"), "SECRET=1");
    writeFileSync(join(root, ".env.example"), "SECRET=");
    writeFileSync(join(root, ".gitignore"), "dist\n");
    writeFileSync(join(root, ".capletsignore"), "tmp-local\n.env.example\n");
    writeFileSync(join(root, "dist"), "ignored by gitignore");
    writeFileSync(join(root, "tmp-local"), "ignored by capletsignore");
    writeFileSync(join(root, "src", "index.ts"), "console.log('ok');");

    const manifest = buildProjectSyncManifest({ projectRoot: root });

    expect(manifest.files.map((file) => file.relativePath).sort()).toEqual([
      ".capletsignore",
      ".env.example",
      ".gitignore",
      "src/index.ts",
    ]);
    expect(manifest.exclusionSummary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "hard_denylist", pattern: ".git/" }),
        expect.objectContaining({ source: "hard_denylist", pattern: "node_modules/" }),
        expect.objectContaining({ source: "gitignore", pattern: "dist" }),
        expect.objectContaining({ source: "capletsignore", pattern: "tmp-local" }),
      ]),
    );
    expect(JSON.stringify(manifest.exclusionSummary)).not.toContain(".git/config");
    expect(JSON.stringify(manifest.exclusionSummary)).not.toContain("SECRET=1");
  });
});
