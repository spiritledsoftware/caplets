import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCurrentHostCatalogOperations } from "../src/current-host/catalog-operations";
import type * as CatalogModule from "../src/current-host/catalog";
import type * as InstallModule from "../src/cli/install";
import type {
  CurrentHostOperationsDependencies,
  CurrentHostOperatorPrincipal,
} from "../src/current-host/operations";

const mocks = vi.hoisted(() => ({
  detail: vi.fn(),
  install: vi.fn(),
  restore: vi.fn(),
  update: vi.fn(),
  index: vi.fn(),
  load: vi.fn(),
  persist: vi.fn(),
}));

vi.mock("../src/current-host/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof CatalogModule>()),
  currentHostCatalogDetail: mocks.detail,
}));

vi.mock("../src/cli/install", async (importOriginal) => ({
  ...(await importOriginal<typeof InstallModule>()),
  installCaplets: mocks.install,
  restoreCapletsFromLockfile: mocks.restore,
  updateCapletsFromLockfile: mocks.update,
  indexInstalledCapletsFromLockfile: mocks.index,
}));

const principal: CurrentHostOperatorPrincipal = {
  clientId: "operator",
  clientLabel: "Operator",
  hostUrl: "http://127.0.0.1/",
  role: "operator",
};

const dependencies = {
  control: {
    configPath: "/tmp/config.json",
    projectConfigPath: "/tmp/project.json",
    authDir: "/tmp/auth",
    globalCapletsRoot: "/tmp/caplets",
    globalLockfilePath: "/tmp/caplets.lock.json",
  },
  activityLog: { append: vi.fn() },
  loadGlobalCatalogProvenance: mocks.load,
  persistGlobalCatalogChange: mocks.persist,
} as unknown as CurrentHostOperationsDependencies & {
  loadGlobalCatalogProvenance: typeof mocks.load;
  persistGlobalCatalogChange: typeof mocks.persist;
};

function officialDetail(
  overrides: {
    copyable?: boolean;
    revisionBound?: boolean;
    resolvedRevision?: string;
  } = {},
) {
  return {
    entry: {
      id: "github",
      contentMarkdown: "# GitHub",
      installCommand: {
        text: "caplets install spiritledsoftware/caplets#abc123 github",
        copyable: overrides.copyable ?? true,
        revisionBound: overrides.revisionBound ?? true,
      },
      ...(overrides.resolvedRevision === undefined
        ? {}
        : { resolvedRevision: overrides.resolvedRevision }),
    },
    setupActions: [{ kind: "vault" as const, label: "Configure GitHub token", required: true }],
  };
}

const capletMarkdown = `---
name: GitHub
description: GitHub catalog Caplet
mcpServers:
  github:
    command: npx
    args:
      - "-y"
      - "@example/github"
---
# GitHub
`;

const catalogLockEntry = {
  id: "github",
  destination: "github",
  kind: "directory" as const,
  source: {
    type: "git" as const,
    repository: "spiritledsoftware/caplets",
    path: "caplets/github",
    resolvedRevision: "abc123",
    portability: "portable" as const,
  },
  installedHash: `sha256:${"a".repeat(64)}`,
  installedAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
  risk: {
    backendFamilies: ["mcp"],
    safety: "standard" as const,
    projectBindingRequired: false,
    mutating: false,
    destructive: false,
  },
};

function stagedEntry(
  options: { destinationRoot: string; lockfilePath: string },
  status: "installed" | "content_updated" = "installed",
) {
  const destination = join(options.destinationRoot, "github");
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, "CAPLET.md"), capletMarkdown);
  const lockEntry = catalogLockEntry;
  writeFileSync(
    options.lockfilePath,
    `${JSON.stringify({ version: 1, entries: [lockEntry] }, null, 2)}\n`,
  );
  return {
    installed: [
      {
        id: "github",
        source: "spiritledsoftware/caplets",
        destination,
        kind: "directory" as const,
        status,
        lockfile: options.lockfilePath,
      },
    ],
    lockEntry,
  };
}

describe("Current Host official catalog installs", () => {
  beforeEach(() => {
    mocks.detail.mockReset();
    mocks.install.mockReset();
    mocks.install.mockImplementation(
      (_repo, options: { destinationRoot: string; lockfilePath: string }) => stagedEntry(options),
    );
    mocks.restore.mockReset();
    mocks.update.mockReset();
    mocks.update.mockImplementation((options: { destinationRoot: string; lockfilePath: string }) =>
      stagedEntry(options, "content_updated"),
    );
    mocks.index.mockReset();
    mocks.index.mockResolvedValue(new Map());
    mocks.load.mockReset();
    mocks.load.mockResolvedValue([catalogLockEntry]);
    mocks.persist.mockReset();
    mocks.persist.mockImplementation(async ({ artifacts }) => ({
      installed: artifacts.map(({ installed }: { installed: Record<string, unknown> }) => ({
        ...installed,
        destination: `sql:${String(installed.id)}`,
      })),
    }));
    vi.mocked(dependencies.activityLog.append).mockReset();
  });

  it.each([
    ["an unbound command", { revisionBound: false, resolvedRevision: "abc123" }],
    [
      "a non-copyable command",
      { copyable: false, revisionBound: true, resolvedRevision: "abc123" },
    ],
    ["a missing resolved revision", { revisionBound: true }],
    ["an empty resolved revision", { revisionBound: true, resolvedRevision: "" }],
  ])("rejects %s before invoking install machinery", async (_label, detailOverrides) => {
    mocks.detail.mockResolvedValue(officialDetail(detailOverrides));
    const operations = createCurrentHostCatalogOperations(dependencies);

    await expect(
      operations.install(principal, {
        kind: "catalog_install",
        source: "official",
        entryKey: "official-entry",
        disableCatalogIndexing: true,
      }),
    ).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      message: "Catalog entry is not currently installable.",
    });
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("installs an official entry from its resolved revision", async () => {
    mocks.detail.mockResolvedValue(officialDetail({ resolvedRevision: "abc123" }));
    const operations = createCurrentHostCatalogOperations(dependencies);

    await expect(
      operations.install(principal, {
        kind: "catalog_install",
        source: "official",
        entryKey: "official-entry",
        disableCatalogIndexing: true,
      }),
    ).resolves.toMatchObject({
      kind: "catalog_install",
      setupActions: [{ kind: "vault", label: "Configure GitHub token", required: true }],
    });
    expect(mocks.install).toHaveBeenCalledWith(
      "spiritledsoftware/caplets#abc123",
      expect.objectContaining({
        capletIds: ["github"],
        destinationRoot: expect.not.stringMatching(/^\/tmp\/caplets(?:\/|$)/u),
        lockfilePath: expect.not.stringMatching(/^\/tmp\/caplets\.lock\.json$/u),
      }),
    );
    const installOptions = mocks.install.mock.calls[0]![1] as {
      destinationRoot: string;
      lockfilePath: string;
    };
    expect(installOptions.destinationRoot).not.toBe(dependencies.control!.globalCapletsRoot);
    expect(installOptions.lockfilePath).not.toBe(dependencies.control!.globalLockfilePath);
    expect(existsSync(installOptions.destinationRoot)).toBe(false);
    expect(existsSync(installOptions.lockfilePath)).toBe(false);
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "install",
        principal,
        source: {
          repository: "spiritledsoftware/caplets#abc123",
          catalogSource: "official",
          entryKey: "official-entry",
        },
        artifacts: [
          expect.objectContaining({
            lockEntry: catalogLockEntry,
            portable: expect.objectContaining({ id: "github" }),
            provenance: expect.objectContaining({
              sourceKind: "git",
              contentHash: "a".repeat(64),
            }),
            setupActions: [{ kind: "vault", label: "Configure GitHub token", required: true }],
          }),
        ],
      }),
    );
  });

  it("persists updates in SQL and keeps committed activity when indexing throws", async () => {
    mocks.index.mockRejectedValue(new Error("indexer unavailable"));
    const operations = createCurrentHostCatalogOperations(dependencies);

    const result = await operations.update(principal, {
      kind: "catalog_update",
      capletIds: ["github"],
    });

    expect(result).toMatchObject({
      kind: "catalog_update",
      installed: [
        {
          status: "content_updated",
          catalogIndexing: { status: "unavailable", reason: "indexer_unavailable" },
        },
      ],
    });
    expect(mocks.load).toHaveBeenCalledWith(["github"]);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        capletIds: ["github"],
        destinationRoot: expect.not.stringMatching(/^\/tmp\/caplets(?:\/|$)/u),
        lockfilePath: expect.not.stringMatching(/^\/tmp\/caplets\.lock\.json$/u),
      }),
    );
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "update",
        artifacts: [
          expect.objectContaining({
            lockEntry: catalogLockEntry,
            portable: expect.objectContaining({ id: "github" }),
          }),
        ],
      }),
    );
    expect(dependencies.activityLog.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "catalog_updated",
        metadata: expect.objectContaining({ status: "content_updated" }),
      }),
    );
    const updateOptions = mocks.update.mock.calls[0]![0] as {
      destinationRoot: string;
      lockfilePath: string;
    };
    expect(updateOptions.destinationRoot).not.toBe(dependencies.control!.globalCapletsRoot);
    expect(updateOptions.lockfilePath).not.toBe(dependencies.control!.globalLockfilePath);
    expect(existsSync(updateOptions.destinationRoot)).toBe(false);
    expect(existsSync(updateOptions.lockfilePath)).toBe(false);
  });

  it("does not index or append success activity when the SQL update is uncommitted", async () => {
    mocks.persist.mockRejectedValue(new Error("SQL write failed"));
    const operations = createCurrentHostCatalogOperations(dependencies);

    await expect(
      operations.update(principal, {
        kind: "catalog_update",
        capletIds: ["github"],
      }),
    ).rejects.toThrow("SQL write failed");

    expect(mocks.index).not.toHaveBeenCalled();
    expect(dependencies.activityLog.append).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: "catalog_updated",
        metadata: expect.objectContaining({ status: expect.anything() }),
      }),
    );
  });
});
