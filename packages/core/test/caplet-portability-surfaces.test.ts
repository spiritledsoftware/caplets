import { describe, expect, it, vi } from "vitest";
import {
  createPortableArtifactReference,
  parsePortableArtifactReference,
} from "../src/media/artifacts";
import { servicePaths } from "../src/serve/http";
import { runCli } from "../src/cli";
import type { CurrentHostPortableOperationOutcome } from "../src/current-host/operations";

describe("Caplet portability adapter surfaces", () => {
  it("publishes base-path-aware dashboard and authenticated remote artifact routes", () => {
    const paths = servicePaths("/caplets");

    expect(paths.dashboardPortable).toBe("/caplets/dashboard/api/portable");
    expect(paths.dashboardPortableArtifacts).toBe("/caplets/dashboard/api/portable/artifacts");
    expect(paths.controlPortableArtifacts).toBe("/caplets/v1/admin/portable/artifacts");
    expect(paths.mcp).toBe("/caplets/v1/mcp");
    expect(paths.attachInvoke).toBe("/caplets/v1/attach/invoke");
  });

  it("round-trips actor- and operation-bound references without local provider details", () => {
    const reference = createPortableArtifactReference({
      artifactId: "artifact_surface",
      logicalHostId: "host_surface",
      storeId: "store_surface",
      providerIdentityId: "provider_surface",
      actorId: "rcli_abcdefghijklmnop",
      operationId: "operation_surface",
      direction: "download",
      byteLength: 4096,
      sha256: "b".repeat(64),
      mimeType: "application/vnd.caplets.portable+json",
      expiresAt: "2026-07-17T12:15:00.000Z",
    });

    expect(parsePortableArtifactReference(reference.uri)).toEqual(reference);
    expect(JSON.stringify(reference)).not.toMatch(
      /(?:\/tmp\/|\\\\|bucket|prefix|accessKey|secret|path)/iu,
    );
  });

  it("keeps status fields stable across live, stale, and recovered while blocking mutations", async () => {
    const statuses: Array<"live" | "stale-read-only"> = [
      "stale-read-only",
      "live",
      "stale-read-only",
      "live",
    ];
    const executePortable = vi.fn(
      async (): Promise<CurrentHostPortableOperationOutcome> => ({
        kind: "portable_status",
        status: statuses.shift() ?? "live",
        health: {
          backend: "sqlite",
          readiness: "ready",
          connectivity: "connected",
          migration: "current",
          authorityToken: { authorityGeneration: 2, effectiveGeneration: 3 },
          bootstrapCompatibility: "current",
          convergence: "single-node",
          guidanceCode: "ok",
        },
        guidanceCode: "ok",
      }),
    );
    const client = {
      target: "global",
      identity: {
        logicalHostId: "host_surface",
        storeId: "store_surface",
        operationNamespace: "namespace_surface",
      },
      createBinding: (
        _request: unknown,
        options?: { operationId?: string; operationClass?: "logical-state" | "external-effect" },
      ) => ({
        operationId: options?.operationId ?? "operation_surface",
        target: "global",
        logicalHostId: "host_surface",
        storeId: "store_surface",
        operationNamespace: "namespace_surface",
        actorId: "local_surface_operator",
        requestIdentity: "d".repeat(64),
        operationClass: options?.operationClass ?? "logical-state",
      }),
      executePortable,
    } as never;
    const human: string[] = [];
    await runCli(["storage", "portable", "status", "--global"], {
      internalCurrentHostManagement: client,
      writeOut: (value) => human.push(value),
      writeErr: () => undefined,
    });
    expect(human.join("")).toContain(
      "Status: stale-read-only\nBackend: sqlite\nReadiness: ready\nConnectivity: connected\nMigration: current\nConvergence: single-node\nGuidance: ok",
    );
    const outputs: string[] = [];
    const exitCodes: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      await runCli(["storage", "portable", "status", "--global", "--json"], {
        internalCurrentHostManagement: client,
        writeOut: (value) => outputs.push(value),
        writeErr: () => undefined,
        setExitCode: (code) => exitCodes.push(code),
      });
    }
    const observed = outputs.map((value) => JSON.parse(value) as Record<string, unknown>);
    expect(observed.map((value) => value.status)).toEqual(["live", "stale-read-only", "live"]);
    expect(observed.map((value) => Object.keys(value).sort())).toEqual([
      ["guidanceCode", "health", "kind", "status"],
      ["guidanceCode", "health", "kind", "status"],
      ["guidanceCode", "health", "kind", "status"],
    ]);
    expect(exitCodes).toEqual([]);

    executePortable.mockResolvedValueOnce({
      kind: "portable_import_activate",
      status: "rejected",
      reason: "stale-generation",
    });
    await runCli(
      [
        "storage",
        "portable",
        "operation",
        JSON.stringify({
          kind: "portable_import_activate",
          proposalId: "proposal_surface",
          proposalHash: "c".repeat(64),
        }),
        "--global",
        "--operation-id",
        "operation_surface",
      ],
      {
        internalCurrentHostManagement: client,
        writeOut: (value) => outputs.push(value),
        writeErr: () => undefined,
        setExitCode: (code) => exitCodes.push(code),
      },
    );
    expect(exitCodes).toEqual([1]);
    expect(outputs.at(-1)).toContain("recovery guidance");
  });
});
