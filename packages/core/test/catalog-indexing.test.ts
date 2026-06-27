import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogIndexingPayloadForLockEntry } from "../src/catalog-indexing/eligibility";
import { indexInstalledCapletsFromLockfile } from "../src/cli/install";
import { writeCapletsLockfile, type CapletsLockEntry } from "../src/cli/lockfile";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.CAPLETS_DISABLE_CATALOG_INDEXING;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("catalog indexing", () => {
  it("builds public revision-bound payloads from lockfile entries", () => {
    expect(catalogIndexingPayloadForLockEntry(lockEntry())).toEqual({
      source: "community/tools",
      capletId: "deploy",
      sourcePath: "caplets/deploy/CAPLET.md",
      resolvedRevision: "abc123",
      contentHash: "sha256-installed",
      entryKey: "github:community:tools:caplets%2Fdeploy%2Fcaplet.md:deploy",
    });
  });

  it("skips official, local, and unpinned sources with categorical results", () => {
    expect(
      catalogIndexingPayloadForLockEntry(
        lockEntry({ repository: "spiritledsoftware/caplets", resolvedRevision: "abc123" }),
      ),
    ).toEqual({ status: "already_current", reason: "official_seed" });
    expect(
      catalogIndexingPayloadForLockEntry({
        ...lockEntry(),
        source: { type: "local", path: "/private/caplets", portability: "non_portable" },
      }),
    ).toEqual({ status: "ineligible", reason: "not_public" });
    expect(
      catalogIndexingPayloadForLockEntry({
        ...lockEntry(),
        source: {
          type: "git",
          repository: "https://token@github.com/private/tools",
          path: "caplets/secret/CAPLET.md",
          resolvedRevision: "abc123",
        },
      }),
    ).toEqual({ status: "ineligible", reason: "credential_url" });
    expect(catalogIndexingPayloadForLockEntry(lockEntry({ resolvedRevision: undefined }))).toEqual({
      status: "revision_unavailable",
      reason: "revision_unavailable",
    });
  });

  it("attaches nonblocking statuses without leaking rejected source values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-catalog-indexing-"));
    tempDirs.push(dir);
    const lockfilePath = join(dir, ".caplets.lock.json");
    writeCapletsLockfile(lockfilePath, {
      version: 1,
      entries: [
        lockEntry(),
        {
          ...lockEntry({ id: "local" }),
          source: { type: "local", path: dir, portability: "non_portable" },
        },
      ],
    });
    const fetchImpl = vi.fn(async () => Response.json({ result: { status: "counted" } }));

    const results = await indexInstalledCapletsFromLockfile(
      [
        { id: "deploy", lockfile: lockfilePath },
        { id: "local", lockfile: lockfilePath },
      ],
      { endpoint: "https://catalog.example.test/install-signals", fetch: fetchImpl },
    );

    expect(results.get("deploy")).toMatchObject({ status: "counted" });
    expect(results.get("local")).toEqual({ status: "ineligible", reason: "not_public" });
    expect(JSON.stringify([...results.values()])).not.toContain("token");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("derives submitted community readiness from CAPLET frontmatter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-catalog-readiness-"));
    tempDirs.push(dir);
    const lockfilePath = join(dir, ".caplets.lock.json");
    const capletPath = join(dir, "deploy.md");
    writeFileSync(
      capletPath,
      [
        "---",
        "name: Deploy",
        "description: Deploy projects.",
        "setup:",
        "  steps:",
        "    - run: npm install",
        "httpApi:",
        "  baseUrl: https://api.example.com",
        "  auth:",
        "    type: bearer",
        "  actions:",
        "    list:",
        "      method: GET",
        "      path: /projects",
        "---",
        "",
        "# Deploy",
        "",
      ].join("\n"),
    );
    writeCapletsLockfile(lockfilePath, {
      version: 1,
      entries: [
        {
          ...lockEntry(),
          destination: "deploy.md",
          risk: {
            ...lockEntry().risk,
            authScopes: undefined,
            runtimeFeatures: undefined,
          },
        },
      ],
    });
    let submitted: unknown;
    const fetchImpl = vi.fn(
      async (_request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        submitted = JSON.parse(String(init?.body));
        return Response.json({ result: { status: "accepted" } });
      },
    );

    await indexInstalledCapletsFromLockfile(
      [{ id: "deploy", destination: capletPath, lockfile: lockfilePath }],
      { endpoint: "https://catalog.example.test/install-signals", fetch: fetchImpl },
    );

    expect(submitted).toMatchObject({
      entry: {
        setupReadiness: "required",
        authReadiness: "required",
      },
    });
  });

  it("honors the catalog indexing environment opt-out", async () => {
    process.env.CAPLETS_DISABLE_CATALOG_INDEXING = "1";
    const fetchImpl = vi.fn();

    const results = await indexInstalledCapletsFromLockfile(
      [{ id: "deploy", lockfile: "unused" }],
      {
        fetch: fetchImpl,
      },
    );

    expect(results.get("deploy")).toEqual({
      status: "ineligible",
      reason: "catalog_indexing_disabled",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("honors an explicit catalog indexing opt-out", async () => {
    const fetchImpl = vi.fn();

    const results = await indexInstalledCapletsFromLockfile(
      [{ id: "deploy", lockfile: "unused" }],
      {
        disableCatalogIndexing: true,
        fetch: fetchImpl,
      },
    );

    expect(results.get("deploy")).toEqual({
      status: "ineligible",
      reason: "catalog_indexing_disabled",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function lockEntry(
  overrides: {
    id?: string;
    repository?: string;
    resolvedRevision?: string | undefined;
  } = {},
): CapletsLockEntry {
  const hasRevisionOverride = Object.prototype.hasOwnProperty.call(overrides, "resolvedRevision");
  return {
    id: overrides.id ?? "deploy",
    destination: `${overrides.id ?? "deploy"}.md`,
    kind: "file",
    source: {
      type: "git",
      repository: overrides.repository ?? "community/tools",
      path: `caplets/${overrides.id ?? "deploy"}/CAPLET.md`,
      trackedRef: "HEAD",
      ...(hasRevisionOverride
        ? overrides.resolvedRevision
          ? { resolvedRevision: overrides.resolvedRevision }
          : {}
        : { resolvedRevision: "abc123" }),
      portability: "portable",
    },
    installedHash: "sha256-installed",
    installedAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    risk: {
      backendFamilies: ["mcp"],
      safety: "standard",
      projectBindingRequired: false,
      mutating: false,
      destructive: false,
    },
  };
}
