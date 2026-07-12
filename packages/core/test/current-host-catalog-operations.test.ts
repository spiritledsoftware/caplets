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
}));

vi.mock("../src/current-host/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof CatalogModule>()),
  currentHostCatalogDetail: mocks.detail,
}));

vi.mock("../src/cli/install", async (importOriginal) => ({
  ...(await importOriginal<typeof InstallModule>()),
  installCaplets: mocks.install,
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
} as unknown as CurrentHostOperationsDependencies;

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
    setupActions: [],
  };
}

describe("Current Host official catalog installs", () => {
  beforeEach(() => {
    mocks.detail.mockReset();
    mocks.install.mockReset();
    mocks.install.mockReturnValue({ installed: [{ id: "github", kind: "caplet" }] });
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
    ).resolves.toMatchObject({ kind: "catalog_install" });
    expect(mocks.install).toHaveBeenCalledWith(
      "spiritledsoftware/caplets#abc123",
      expect.objectContaining({ capletIds: ["github"] }),
    );
  });
});
describe("Current Host shared catalog updates", () => {
  it("returns the current records without a generation, receipt, activation, or activity", async () => {
    const shared = sharedCatalogDependencies({
      alpha: { id: "alpha" },
      beta: { id: "beta" },
    });
    const operations = createCurrentHostCatalogOperations(shared.dependencies);

    const outcome = await operations.update(principal, {
      kind: "catalog_update",
      capletIds: ["alpha", "beta"],
      expectedGeneration: {
        authorityId: "authority",
        id: "stale-generation",
        sequence: 0,
        predecessorId: null,
      },
      idempotencyKey: "selector-only-noop",
    });

    expect(outcome).toEqual({
      kind: "catalog_update",
      installed: [
        {
          id: "alpha",
          source: "authority://alpha",
          destination: "authority://alpha",
          kind: "file",
          status: "noop",
        },
        {
          id: "beta",
          source: "authority://beta",
          destination: "authority://beta",
          kind: "file",
          status: "noop",
        },
      ],
      setupActions: [],
    });
    expect(shared.commit).not.toHaveBeenCalled();
    expect(shared.activityLog.append).not.toHaveBeenCalled();
  });

  it("replays selector-only updates as the same current outcome without idempotency receipts", async () => {
    const shared = sharedCatalogDependencies({ alpha: { id: "alpha" } });
    const operations = createCurrentHostCatalogOperations(shared.dependencies);
    const request = {
      kind: "catalog_update" as const,
      capletIds: ["alpha"],
      idempotencyKey: "selector-only-replay",
    };

    const first = await operations.update(principal, request);
    const replay = await operations.update(principal, request);

    expect(replay).toEqual(first);
    expect(shared.commit).not.toHaveBeenCalled();
    expect(shared.activityLog.append).not.toHaveBeenCalled();
  });

  it("reserves staged IDs before returning a shared catalog no-op", async () => {
    const shared = sharedCatalogDependencies(
      { alpha: { id: "alpha" } },
      { alpha: { kind: "global-file", path: "/mounted/caplets" } },
    );
    const operations = createCurrentHostCatalogOperations(shared.dependencies);

    await expect(
      operations.update(principal, {
        kind: "catalog_update",
        capletIds: ["alpha"],
      }),
    ).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      details: { id: "alpha", staged: true, authority: false },
    });
    expect(shared.commit).not.toHaveBeenCalled();
    expect(shared.activityLog.append).not.toHaveBeenCalled();
  });
});

function sharedCatalogDependencies(
  caplets: Record<string, { id: string; bundle?: { files: unknown[] } }>,
  stagedProvenance?: CurrentHostOperationsDependencies["stagedProvenance"],
) {
  const commit = vi.fn();
  const activityLog = { append: vi.fn() };
  return {
    dependencies: {
      ...dependencies,
      activityLog,
      activeGeneration: {
        authorityId: "authority",
        id: "generation-1",
        sequence: 1,
        predecessorId: null,
        schemaVersion: 1,
        digest: "sha256:generation-1",
        committedAt: "2026-07-12T00:00:00.000Z",
        provenance: { provider: "filesystem", namespace: "catalog-test" },
        snapshot: { caplets },
      },
      runtime: { commit },
      ...(stagedProvenance === undefined ? {} : { stagedProvenance }),
    } as unknown as CurrentHostOperationsDependencies,
    commit,
    activityLog,
  };
}
