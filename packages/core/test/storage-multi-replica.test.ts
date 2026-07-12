import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { assembleCapletsHost, type PreparedRuntimeHost } from "../src/storage/coordinator";
import { AuthorityRemoteServerCredentialStore } from "../src/remote/server-credential-store";
import { LocalSetupStore } from "../src/setup/local-store";
import { createFilesystemAuthority } from "../src/storage/filesystem-authority";
import { createSqliteAuthority } from "../src/storage/sql/authority";
import type { AuthorityGenerationIdentity, WritableAuthority } from "../src/storage/types";

function identity(value: AuthorityGenerationIdentity): AuthorityGenerationIdentity {
  return {
    authorityId: value.authorityId,
    id: value.id,
    sequence: value.sequence,
    predecessorId: value.predecessorId,
  };
}

async function commit(
  authority: WritableAuthority<unknown, unknown>,
  id: string,
  expectedGeneration: AuthorityGenerationIdentity | null,
  worker: string,
) {
  return await authority.commit({
    authorityId: id,
    currentHostId: worker,
    principalId: worker,
    expectedGeneration,
    idempotencyKey: `u9-race-${worker}`,
    requestDigest: `u9-race-${worker}`,
    command: {
      kind: "replace_snapshot",
      snapshot: { caplets: { [`${worker}-caplet`]: { id: `${worker}-caplet` } }, worker },
    },
  });
}

function traceConfig(capletId: string): Record<string, unknown> {
  return {
    version: 1,
    mcpServers: {
      [capletId]: {
        name: `Trace ${capletId}`,
        description: "A deterministic multi-replica trace Caplet.",
        command: process.execPath,
      },
    },
  };
}

function outageAuthority(
  authority: WritableAuthority<unknown, unknown>,
  isOutage: () => boolean,
): WritableAuthority<unknown, unknown> {
  const blocked: Record<string, true> = {
    readHead: true,
    readGeneration: true,
    commit: true,
    readAuxiliary: true,
    commitAuxiliary: true,
    exportState: true,
    restoreState: true,
  };
  return new Proxy(authority, {
    get(target, property, receiver) {
      if (!isOutage()) return Reflect.get(target, property, receiver);
      if (property === "health") {
        return async () => {
          const healthy = await target.health();
          return {
            ...healthy,
            connectivity: "degraded" as const,
            writable: false,
            refresh: "failed" as const,
          };
        };
      }
      if (typeof property === "string" && blocked[property]) {
        return async () => {
          throw new Error("simulated shared-authority outage");
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}
describe("storage multi-replica contract", () => {
  it("rejects one of two stale SQLite writers without losing the winner", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-u9-replicas-"));
    const first = await createSqliteAuthority({
      databasePath: join(root, "authority.db"),
      authorityId: "replica-authority",
      namespace: "replica-namespace",
      verifySchema: false,
      busyTimeoutMs: 5_000,
    });
    const second = await createSqliteAuthority({
      databasePath: join(root, "authority.db"),
      authorityId: "replica-authority",
      namespace: "replica-namespace",
      verifySchema: true,
      busyTimeoutMs: 5_000,
    });
    try {
      const baseline = await commit(first, "replica-authority", null, "baseline");
      expect(baseline.kind).toBe("committed");
      if (baseline.kind !== "committed") throw new Error("expected baseline commit");
      const head = await second.readHead();
      expect(head).not.toBeNull();
      if (!head) throw new Error("expected shared head");
      const expected = identity(head);
      const results = await Promise.all([
        commit(first, "replica-authority", expected, "writer-a"),
        commit(second, "replica-authority", expected, "writer-b"),
      ]);
      const committed = results.filter((result) => result.kind === "committed");
      expect(committed).toHaveLength(1);
      expect(results.filter((result) => result.kind === "conflict")).toHaveLength(1);
      const winner = committed[0];
      if (!winner || winner.kind !== "committed") throw new Error("expected committed race winner");
      expect(winner.generation.sequence).toBe(2);
      expect((await first.readHead())?.id).toBe((await second.readHead())?.id);
    } finally {
      await Promise.all([first.close(), second.close()]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reopens a shared filesystem authority without resurrecting a replaced head", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-u9-fs-replicas-"));
    const first = await createFilesystemAuthority({
      root,
      authorityId: "fs-replica",
      namespace: "fs-replica",
    });
    try {
      const initial = await commit(first, "fs-replica", null, "initial");
      expect(initial.kind).toBe("committed");
      const replacement = await createFilesystemAuthority({
        root,
        authorityId: "fs-replica",
        namespace: "fs-replica",
      });
      try {
        const head = await replacement.readHead();
        expect(head?.sequence).toBe(1);
        expect((await replacement.readGeneration(head!.id)).snapshot).toMatchObject({
          worker: "initial",
        });
      } finally {
        await replacement.close();
      }
    } finally {
      await first.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("converges assembled runtime epochs through shared security state, outage, and replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-u9-runtime-replicas-"));
    const authorityId = "runtime-replica";
    const namespace = "runtime-replica";
    const now = () => new Date("2026-07-01T00:00:00.000Z");
    const encryptionKey = Buffer.alloc(32, 17);
    let first: WritableAuthority<unknown, unknown> | undefined;
    let second: WritableAuthority<unknown, unknown> | undefined;
    let secondReplica: WritableAuthority<unknown, unknown> | undefined;
    let hostA: PreparedRuntimeHost | undefined;
    let hostB: PreparedRuntimeHost | undefined;
    let outage = false;
    try {
      first = await createFilesystemAuthority({
        root,
        authorityId,
        namespace,
      });
      second = await createFilesystemAuthority({
        root,
        authorityId,
        namespace,
      });
      const seed = await first!.commit({
        authorityId,
        currentHostId: "seed",
        principalId: "seed",
        expectedGeneration: null,
        idempotencyKey: "runtime-seed",
        requestDigest: "runtime-seed",
        command: {
          kind: "replace_snapshot",
          snapshot: {
            config: traceConfig("initial"),
            setupApprovals: {},
            setupActivity: [],
            remoteCredentials: {
              version: 1,
              pairingCodes: [],
              pendingLogins: [],
              clients: [],
            },
          },
        },
      });
      expect(seed.kind).toBe("committed");
      secondReplica = outageAuthority(second!, () => outage);
      hostA = await assembleCapletsHost({
        authority: first!,
        configPath: join(root, "missing-a.json"),
        autoRefresh: false,
      });
      hostB = await assembleCapletsHost({
        authority: secondReplica!,
        configPath: join(root, "missing-b.json"),
        autoRefresh: false,
      });
      const initial = identity(hostA.view.authorityGeneration!);
      const mutation = await hostA.commit({
        authorityId,
        currentHostId: "runtime-a",
        principalId: "runtime-a",
        expectedGeneration: initial,
        idempotencyKey: "runtime-shared-mutation",
        requestDigest: "runtime-shared-mutation",
        command: {
          kind: "replace_snapshot",
          snapshot: {
            ...hostA.view.authorityGeneration!.snapshot,
            config: traceConfig("shared"),
          },
        },
      });
      expect(mutation.kind).toBe("committed");
      expect(await hostB.refresh()).toBe(true);
      expect(hostB.view.authorityGenerationId).toBe(
        mutation.kind === "committed" ? mutation.generation.id : "",
      );
      expect(hostB.engine.currentConfig().mcpServers).toHaveProperty("shared");

      const setupInput = {
        projectFingerprint: "runtime-project",
        capletId: "shared",
        contentHash: "runtime-content",
        targetKind: "local_host" as const,
        actor: "automation" as const,
        approvedAt: now().toISOString(),
      };
      const setupA = new LocalSetupStore({
        authority: first!,
        authorityId,
        currentHostId: "runtime-setup-a",
        principalId: "runtime-setup-a",
        now,
      });
      const setupB = new LocalSetupStore({
        authority: secondReplica!,
        authorityId,
        currentHostId: "runtime-setup-b",
        principalId: "runtime-setup-b",
        now,
      });
      expect((await setupA.approve(setupInput)).decision).toBe("grant");
      await hostB.refresh();
      expect(
        (await setupB.getApproval("runtime-project", "shared", "runtime-content", "local_host"))
          ?.decision,
      ).toBe("grant");
      expect((await setupA.revoke(setupInput)).decision).toBe("revoke");
      await hostB.refresh();
      expect(
        (await setupB.getApproval("runtime-project", "shared", "runtime-content", "local_host"))
          ?.decision,
      ).toBe("revoke");

      const remoteA = new AuthorityRemoteServerCredentialStore({
        authority: first!,
        authorityId,
        currentHostId: "runtime-remote-a",
        principalId: "runtime-remote-a",
        encryptionKey,
      });
      const remoteB = new AuthorityRemoteServerCredentialStore({
        authority: secondReplica!,
        authorityId,
        currentHostId: "runtime-remote-b",
        principalId: "runtime-remote-b",
        encryptionKey,
      });
      const pending = await remoteA.createPendingLogin({
        hostUrl: "https://runtime.invalid",
        requestedRole: "operator",
        clientLabel: "runtime-replica",
        now: now(),
        idempotencyKey: "runtime-pending-create",
      });
      const refreshed = await remoteA.refreshPendingLogin({
        flowId: pending.flowId,
        pendingCompletionSecret: pending.pendingCompletionSecret,
        pendingRefreshSecret: pending.pendingRefreshSecret,
        now: now(),
        idempotencyKey: "runtime-pending-refresh",
      });
      await remoteA.approvePendingLogin({
        operatorCode: refreshed.operatorCode,
        grantedRole: "operator",
        now: now(),
        idempotencyKey: "runtime-pending-approve",
      });
      const issued = await remoteA.completePendingLogin({
        flowId: pending.flowId,
        pendingCompletionSecret: pending.pendingCompletionSecret,
        hostUrl: "https://runtime.invalid",
        requiredRole: "operator",
        now: now(),
        idempotencyKey: "runtime-pending-complete",
      });
      await expect(
        remoteB.validateAccessToken({
          hostUrl: "https://runtime.invalid",
          accessToken: issued.accessToken,
          now: now(),
        }),
      ).resolves.toMatchObject({ clientId: issued.clientId });
      expect(
        await remoteA.revokeClient(issued.clientId, now(), {
          idempotencyKey: "runtime-client-revoke",
        }),
      ).toBe(true);
      await hostB.refresh();
      await expect(
        remoteB.validateAccessToken({
          hostUrl: "https://runtime.invalid",
          accessToken: issued.accessToken,
          now: now(),
        }),
      ).rejects.toThrow();

      const lastKnownGood = identity(hostB.view.authorityGeneration!);
      outage = true;
      await hostB.refresh();
      expect(hostB.view.authorityGenerationId).toBe(lastKnownGood.id);
      await expect(hostB.health()).resolves.toMatchObject({
        connectivity: "degraded",
        readiness: "ready",
        writable: false,
      });
      await expect(
        hostB.commit({
          authorityId,
          currentHostId: "runtime-b",
          principalId: "runtime-b",
          expectedGeneration: lastKnownGood,
          idempotencyKey: "runtime-outage-write",
          requestDigest: "runtime-outage-write",
          command: {
            kind: "replace_snapshot",
            snapshot: hostB.view.authorityGeneration!.snapshot,
          },
        }),
      ).rejects.toThrow();
      outage = false;
      await hostB.refresh();
      await expect(hostB.health()).resolves.toMatchObject({
        connectivity: "healthy",
        readiness: "ready",
        writable: true,
      });
      const finalSnapshot = hostB.view.authorityGeneration!.snapshot;
      await hostA.close();
      await hostB.close();
      hostA = undefined;
      hostB = undefined;
      await first!.close();
      await secondReplica!.close();
      first = undefined;
      secondReplica = undefined;
      await second!.close();
      second = undefined;

      first = await createFilesystemAuthority({ root, authorityId, namespace });
      second = await createFilesystemAuthority({ root, authorityId, namespace });
      secondReplica = outageAuthority(second!, () => false);
      hostA = await assembleCapletsHost({
        authority: first!,
        configPath: join(root, "replacement-a.json"),
        autoRefresh: false,
      });
      hostB = await assembleCapletsHost({
        authority: secondReplica!,
        configPath: join(root, "replacement-b.json"),
        autoRefresh: false,
      });
      expect(hostA.view.authorityGenerationId).toBe(hostB.view.authorityGenerationId);
      expect(hostA.view.authorityGenerationId).toBe(lastKnownGood.id);
      expect(hostA.view.authorityGeneration!.snapshot).toEqual(finalSnapshot);
      expect(hostB.view.authorityGeneration!.snapshot).toEqual(finalSnapshot);
    } finally {
      await Promise.all([hostA?.close(), hostB?.close()]);
      await Promise.all([first?.close(), second?.close()]);
      await rm(root, { recursive: true, force: true });
    }
  });
});
