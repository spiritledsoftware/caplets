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
