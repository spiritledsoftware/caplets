import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCurrentHostCatalogOperations } from "../src/current-host/catalog-operations";
import type * as CatalogModule from "../src/current-host/catalog";
import type * as InstallModule from "../src/install";
import type {
  CurrentHostOperationsDependencies,
  CurrentHostOperatorPrincipal,
} from "../src/current-host/operations";

const mocks = vi.hoisted(() => ({
  detail: vi.fn(),
  install: vi.fn(),
  update: vi.fn(),
  index: vi.fn(),
}));

vi.mock("../src/current-host/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof CatalogModule>()),
  currentHostCatalogDetail: mocks.detail,
}));

vi.mock("../src/install", async (importOriginal) => ({
  ...(await importOriginal<typeof InstallModule>()),
  installCaplets: mocks.install,
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
    mocks.update.mockReset();
    mocks.index.mockReset();
    mocks.index.mockResolvedValue(new Map());
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
    ).resolves.toMatchObject({ kind: "catalog_install" });
    expect(mocks.install).toHaveBeenCalledWith(
      "spiritledsoftware/caplets#abc123",
      expect.objectContaining({ capletIds: ["github"] }),
    );
  });

  it("relays content updates and keeps committed activity when indexing throws", async () => {
    mocks.update.mockReturnValue({
      installed: [
        {
          id: "github",
          source: "repo",
          destination: "/tmp/caplets/github",
          kind: "directory",
          status: "content_updated",
        },
      ],
    });
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
    expect(dependencies.activityLog.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "catalog_updated",
        metadata: expect.objectContaining({ status: "content_updated" }),
      }),
    );
  });

  it("does not index or append success activity when an update is uncommitted", async () => {
    mocks.update.mockImplementation(() => {
      throw new Error("lock write failed");
    });
    const operations = createCurrentHostCatalogOperations(dependencies);

    await expect(
      operations.update(principal, {
        kind: "catalog_update",
        capletIds: ["github"],
      }),
    ).rejects.toThrow("lock write failed");

    expect(mocks.index).not.toHaveBeenCalled();
    expect(dependencies.activityLog.append).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: "catalog_updated",
        metadata: expect.objectContaining({ status: expect.anything() }),
      }),
    );
  });
});
