import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configuredSharedAuthority } from "../src/serve/stdio";

describe("configuredSharedAuthority", () => {
  it("selects canonical assembly only for explicitly configured storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-stdio-storage-"));
    const configPath = join(root, "config.json");
    const projectConfigPath = join(root, "missing-project.json");

    await writeFile(configPath, JSON.stringify({ version: 1 }));
    expect(configuredSharedAuthority({ configPath, projectConfigPath })).toBe(false);

    for (const storage of [
      { provider: "filesystem" },
      { provider: "filesystem", path: "shared-state" },
      { provider: "sqlite", path: "authority.sqlite" },
    ]) {
      await writeFile(configPath, JSON.stringify({ version: 1, storage }));
      expect(configuredSharedAuthority({ configPath, projectConfigPath })).toBe(true);
    }
  });

  it("honors caller env and secret resolver and fails closed on unresolved secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-stdio-secrets-"));
    const configPath = join(root, "config.json");
    const projectConfigPath = join(root, "missing-project.json");

    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        storage: { provider: "postgresql", connection: "env:CUSTOM_DATABASE_URL" },
      }),
    );
    expect(
      configuredSharedAuthority({
        configPath,
        projectConfigPath,
        env: { CUSTOM_DATABASE_URL: "postgres://custom" },
      }),
    ).toBe(true);
    expect(() => configuredSharedAuthority({ configPath, projectConfigPath, env: {} })).toThrow(
      /reference|resolve|empty/i,
    );

    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        storage: { provider: "filesystem", vaultKey: "custom:key" },
      }),
    );
    expect(
      configuredSharedAuthority({
        configPath,
        projectConfigPath,
        env: {},
        secretResolver: (reference) => (reference === "custom:key" ? "secret" : undefined),
      }),
    ).toBe(true);
  });

  it("preserves direct injected authority factory protocol seams", () => {
    expect(
      configuredSharedAuthority({
        configPath: join(tmpdir(), "missing-stdio-config.json"),
        authorityFactory: async () => {
          throw new Error("not invoked by selector");
        },
      }),
    ).toBe(true);
  });
});
