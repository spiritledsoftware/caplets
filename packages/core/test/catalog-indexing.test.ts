import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogIndexingPayloadForLockEntry } from "../src/catalog-indexing/eligibility";
import { indexInstalledCapletsFromLockfile } from "../src/install";
import { writeCapletsLockfile, type CapletsLockEntry } from "../src/lockfile";

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
      sourcePath: "deploy/CAPLET.md",
      resolvedRevision: "abc123",
      contentHash: "sha256-installed",
      entryKey: "github:community:tools:deploy%2Fcaplet.md:deploy",
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
        "catalog:",
        "  icon: ./icon.svg",
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
        icon: {
          type: "bundled",
          path: "icon.svg",
          url: "https://raw.githubusercontent.com/community/tools/abc123/deploy/icon.svg",
        },
        sourcePath: "deploy/CAPLET.md",
        installCommand: {
          text: "caplets install community/tools#abc123 deploy",
          copyable: true,
          revisionBound: true,
        },
      },
    });
  });

  it("submits community suite workflow and child summaries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-catalog-suite-indexing-"));
    tempDirs.push(dir);
    const lockfilePath = join(dir, ".caplets.lock.json");
    const capletRoot = join(dir, "user", "workspace");
    mkdirSync(capletRoot, { recursive: true });
    writeFileSync(
      join(capletRoot, "CAPLET.md"),
      [
        "---",
        "name: Workspace",
        "description: Work with workspace APIs.",
        "tags:",
        "  - workspace",
        "auth:",
        "  type: oauth2",
        "  issuer: https://accounts.google.com",
        "googleDiscoveryApis:",
        "  drive:",
        "    name: Drive",
        "    description: Search Drive files and folders.",
        "    discoveryPath: ./drive.discovery.json",
        "  gmail:",
        "    name: Gmail",
        "    description: Search Gmail messages and labels.",
        "    discoveryPath: ./gmail.discovery.json",
        "---",
        "",
        "# Workspace",
        "",
      ].join("\n"),
    );
    writeFileSync(join(capletRoot, "drive.discovery.json"), "{}");
    writeFileSync(join(capletRoot, "gmail.discovery.json"), "{}");
    writeCapletsLockfile(lockfilePath, {
      version: 1,
      entries: [
        {
          ...lockEntry({ id: "workspace" }),
          destination: "workspace",
          kind: "directory",
          source: {
            ...lockEntry({ id: "workspace" }).source,
            path: "caplets/workspace/CAPLET.md",
          },
          risk: {
            ...lockEntry().risk,
            backendFamilies: ["googleDiscovery"],
            safety: "mutating_saas",
            mutating: true,
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
      [{ id: "workspace", destination: capletRoot, lockfile: lockfilePath }],
      { endpoint: "https://catalog.example.test/install-signals", fetch: fetchImpl },
    );

    expect(submitted).toMatchObject({
      entry: {
        id: "workspace",
        workflow: { kind: "set", label: "Capability suite" },
        children: [
          {
            id: "workspace__drive",
            childId: "drive",
            name: "Drive",
            backend: "googleDiscovery",
            workflow: { kind: "google_discovery", label: "Google Discovery API" },
          },
          {
            id: "workspace__gmail",
            childId: "gmail",
            name: "Gmail",
            backend: "googleDiscovery",
            workflow: { kind: "google_discovery", label: "Google Discovery API" },
          },
        ],
      },
    });
  });

  it("keeps catalog indexing best-effort when a lockfile cannot be read", async () => {
    const results = await indexInstalledCapletsFromLockfile(
      [{ id: "deploy", lockfile: "/missing/.caplets.lock.json" }],
      { endpoint: "https://catalog.example.test/install-signals", fetch: vi.fn() },
    );

    expect(results.get("deploy")).toEqual({
      status: "unavailable",
      reason: "lockfile_unavailable",
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
