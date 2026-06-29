import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateOfficialCatalogEntries } from "../../../scripts/generate-catalog-index";

const repoRoot = resolve(import.meta.dirname, "../../..");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("official catalog index generation", () => {
  it("derives official entries from checked-in Caplet files with safe catalog metadata", async () => {
    const entries = await generateOfficialCatalogEntries(repoRoot);
    const github = entries.find((entry) => entry.id === "github");

    expect(entries.length).toBeGreaterThan(10);
    expect(github).toMatchObject({
      id: "github",
      name: "GitHub",
      sourcePath: "github/CAPLET.md",
      trustLevel: "official",
      source: {
        provider: "github",
        repository: "spiritledsoftware/caplets",
      },
      installCommand: {
        text: "caplets install spiritledsoftware/caplets github",
        copyable: true,
      },
      icon: {
        type: "url",
        url: "https://github.githubassets.com/favicons/favicon.svg",
      },
      authReadiness: "required",
    });
    expect(github?.contentMarkdown).toContain("# GitHub");
    expect(JSON.stringify(entries)).not.toContain('"shadowing"');
    expect(JSON.stringify(entries)).not.toContain(repoRoot);
  });

  it("matches the checked-in deterministic seed file", async () => {
    const outputPath = join(repoRoot, "apps/catalog/src/data/official-catalog.json");

    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, "utf8")).toBe(
      `${JSON.stringify(await generateOfficialCatalogEntries(repoRoot), null, 2)}\n`,
    );
  });

  it("groups plural Caplet file children under one parent catalog entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-official-catalog-"));
    tempDirs.push(root);
    const capletDir = join(root, "caplets", "google-workspace");
    mkdirSync(capletDir, { recursive: true });
    writeFileSync(
      join(capletDir, "CAPLET.md"),
      `---
name: Google Workspace
description: Work with several Google Workspace APIs.
tags: [google, workspace]
auth:
  type: oauth2
  issuer: https://accounts.google.com
googleDiscoveryApis:
  drive:
    name: Google Drive
    description: Search and inspect Drive files.
    discoveryPath: ./drive.discovery.json
  gmail:
    name: Gmail
    description: Search and inspect Gmail messages.
    discoveryPath: ./gmail.discovery.json
---

# Google Workspace
`,
    );
    writeFileSync(join(capletDir, "drive.discovery.json"), "{}");
    writeFileSync(join(capletDir, "gmail.discovery.json"), "{}");

    const entries = await generateOfficialCatalogEntries(root);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "google-workspace",
      name: "Google Workspace",
      sourcePath: "google-workspace/CAPLET.md",
      authReadiness: "required",
      workflow: { kind: "set", label: "Capability suite" },
      installCommand: {
        text: "caplets install spiritledsoftware/caplets google-workspace",
      },
      children: [
        {
          id: "google-workspace__drive",
          childId: "drive",
          name: "Google Drive",
          backend: "googleDiscovery",
        },
        {
          id: "google-workspace__gmail",
          childId: "gmail",
          name: "Gmail",
          backend: "googleDiscovery",
        },
      ],
    });
  });
});
