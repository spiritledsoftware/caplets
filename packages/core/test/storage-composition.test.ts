import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliToolsManager } from "../src/cli-tools";
import { loadConfigWithSources } from "../src/config";
import { CapletsError } from "../src/errors";
import {
  composeLegacyFilesystemConfig,
  composeRuntimeConfig,
  computeStagedFingerprint,
  type StagedConfigSource,
} from "../src/storage/composition";
import { ContentAddressedBundleCache } from "../src/storage/bundle-cache";
import type { AuthorityGeneration } from "../src/storage/types";

describe("filesystem composition", () => {
  it("preserves exact legacy global/project precedence and source provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-composition-"));
    const globalPath = join(root, "config.json");
    const projectPath = join(root, "project", ".caplets", "config.json");
    await mkdir(dirname(projectPath), { recursive: true });
    await writeFile(
      globalPath,
      JSON.stringify({
        version: 1,
        mcpServers: {
          global: { name: "Global", description: "Global server", command: "global" },
          shared: { name: "Global shared", description: "Global shared server", command: "global" },
        },
      }),
    );
    await writeFile(
      projectPath,
      JSON.stringify({
        version: 1,
        mcpServers: {
          project: { name: "Project", description: "Project server", command: "project" },
          shared: {
            name: "Project shared",
            description: "Project shared server",
            command: "project",
          },
        },
      }),
    );

    const legacy = loadConfigWithSources(globalPath, projectPath);
    const extracted = composeLegacyFilesystemConfig({
      globalConfigPath: globalPath,
      projectConfigPath: projectPath,
    });
    expect(extracted).toEqual(legacy);
    expect(extracted.config.mcpServers.shared?.command).toBe("project");
    expect(extracted.sources.shared).toMatchObject({ kind: "project-config", path: projectPath });
    expect(extracted.shadows.shared).toEqual([{ kind: "global-config", path: globalPath }]);
  });

  it("rejects staged/authority collisions while allowing distinct authority IDs", async () => {
    const staged: StagedConfigSource = {
      input: {
        mcpServers: {
          github: { name: "GitHub", description: "Staged GitHub server", command: "staged" },
        },
      },
      source: { kind: "global-file", path: "/image/caplets/github/CAPLET.md" },
    };
    const generation = {
      authorityId: "authority-a",
      id: "g1",
      sequence: 1,
      predecessorId: null,
      schemaVersion: 1,
      committedAt: new Date(0).toISOString(),
      provenance: { provider: "filesystem", namespace: "default" },
      digest: "sha256:g1",
      snapshot: {
        records: {
          different: {
            id: "different",
            config: {
              mcpServers: {
                different: {
                  name: "Different",
                  description: "Authority server",
                  command: "authority",
                },
              },
            },
          },
        },
      },
    } satisfies AuthorityGeneration<{
      records: Record<string, { id: string; config: Record<string, unknown> }>;
    }>;

    const composed = await composeRuntimeConfig({
      staged: [staged],
      stagedFingerprint: "sha256:staged",
      authority: { authorityId: "authority-a", generation },
    });
    expect(composed.config.mcpServers.different?.command).toBe("authority");
    expect(composed.sources.different).toMatchObject({
      kind: "authority",
      authorityId: "authority-a",
      recordId: "different",
    });
    await composed.releaseBundles();

    const colliding = {
      ...generation,
      snapshot: {
        records: {
          github: {
            id: "github",
            config: {
              mcpServers: {
                github: {
                  name: "GitHub authority",
                  description: "Authority duplicate",
                  command: "authority",
                },
              },
            },
          },
        },
      },
    } satisfies AuthorityGeneration<{
      records: Record<string, { id: string; config: Record<string, unknown> }>;
    }>;
    await expect(
      composeRuntimeConfig({
        staged: [staged],
        stagedFingerprint: "sha256:staged",
        authority: { authorityId: "authority-a", generation: colliding },
      }),
    ).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("github"),
    } satisfies Partial<CapletsError>);
  });

  it("fingerprints identical staged bytes independently of mount path", async () => {
    const left = await mkdtemp(join(tmpdir(), "caplets-staged-a-"));
    const right = await mkdtemp(join(tmpdir(), "caplets-staged-b-"));
    await writeFile(join(left, "config.json"), "same\n");
    await writeFile(join(right, "config.json"), "same\n");
    expect(await computeStagedFingerprint([left])).toBe(await computeStagedFingerprint([right]));
  });
});

describe("executable authority bundles", () => {
  it("rebases and executes a CLI asset from a materialized bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-bundle-runtime-"));
    const script = "#!/bin/sh\nprintf bundle-executed\n";
    const generation = {
      authorityId: "authority-a",
      id: "g1",
      sequence: 1,
      predecessorId: null,
      schemaVersion: 1,
      committedAt: new Date(0).toISOString(),
      provenance: { provider: "filesystem", namespace: "default" },
      digest: "sha256:g1",
      snapshot: {
        records: {
          app: {
            id: "app",
            bundle: {
              entryPath: "app/CAPLET.md",
              files: [
                {
                  path: "app/CAPLET.md",
                  content: `---
name: App
description: Execute the materialized bundle tool.
cliTools:
  actions:
    run:
      command: ./tool.sh
      cwd: .
      output:
        type: text
--- 
`,
                },
                { path: "app/tool.sh", content: script, mode: 0o755 },
              ],
            },
          },
        },
      },
    } satisfies AuthorityGeneration<{
      records: Record<
        string,
        {
          id: string;
          bundle: {
            entryPath: string;
            files: Array<{ path: string; content: string; mode?: number }>;
          };
        }
      >;
    }>;
    const cache = new ContentAddressedBundleCache({ root });
    const composed = await composeRuntimeConfig({
      staged: [],
      authority: { authorityId: "authority-a", generation, bundleCache: cache },
    });
    const command = composed.config.cliTools.app?.actions.run?.command;
    expect(command).toBe(
      join(root, composed.materializedBundles[0]!.fingerprint, "app", "tool.sh"),
    );
    await chmod(command!, 0o755);
    const fakeRegistry = { setStatus: () => undefined };
    const manager = new CliToolsManager(fakeRegistry as never);
    const result = await manager.callTool(composed.config.cliTools.app!, "run", {});
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.structuredContent)).toContain("bundle-executed");
    await composed.releaseBundles();
  });
});
