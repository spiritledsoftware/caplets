import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { assembleCapletsHost } from "../src/storage/coordinator";
import { createFilesystemAuthority } from "../src/storage/filesystem-authority";
import { createPostgresAuthority, createSqliteAuthority } from "../src/storage/sql/authority";
import type { WritableAuthority } from "../src/storage/types";
import { runProviderContract } from "./storage-provider-contract";

async function runLocalProvider(
  provider: "filesystem" | "sqlite",
  root: string,
): Promise<WritableAuthority<unknown, unknown>> {
  if (provider === "filesystem") {
    return await createFilesystemAuthority({
      root,
      authorityId: `matrix-${provider}`,
      namespace: `matrix-${provider}`,
      maintenanceLeaseMs: 300,
      maintenanceRenewIntervalMs: 100,
    });
  }
  return await createSqliteAuthority({
    databasePath: join(root, "authority.db"),
    authorityId: `matrix-${provider}`,
    namespace: `matrix-${provider}`,
    verifySchema: false,
    busyTimeoutMs: 5_000,
    maintenanceLeaseMs: 300,
    maintenanceRenewIntervalMs: 100,
  });
}

describe("storage provider matrix", () => {
  it("executes one unchanged semantic contract against filesystem and SQLite", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-u9-provider-matrix-"));
    const authorities: WritableAuthority<unknown, unknown>[] = [];
    try {
      for (const provider of ["filesystem", "sqlite"] as const) {
        const authority = await runLocalProvider(provider, join(root, provider));
        authorities.push(authority);
        const result = await runProviderContract({
          authority,
          authorityId: `matrix-${provider}`,
          namespace: `matrix-${provider}`,
          provider,
          makeReplica: async () => await runLocalProvider(provider, join(root, provider)),
          makeRestoreTarget: async () =>
            await runLocalProvider(provider, join(root, `${provider}-restore`)),
        });
        expect(result.steps).toEqual(
          expect.arrayContaining([
            "conditional-commit-provenance",
            "conflict-receipt-replay",
            "encrypted-vault-wrong-key",
            "encrypted-oauth-wrong-key",
            "setup-approval-revocation",
            "session-approval-revoke-non-resurrection-lost-hint",
            "auxiliary-session-security-events",
            "migration-backup-restore-wrong-key",
            "maintenance-fence-replacement",
          ]),
        );
        expect(result.generationSequence).toBeGreaterThan(1);
        const host = await assembleCapletsHost({
          authority,
          configPath: join(root, `${provider}-runtime-config.json`),
          autoRefresh: false,
        });
        try {
          expect(host.view.authoritySequence).toBe(result.generationSequence);
          expect(host.engine.currentConfig().mcpServers).toBeDefined();
        } finally {
          await host.close();
        }
      }
    } finally {
      await Promise.all(authorities.reverse().map((authority) => authority.close()));
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
  it("fails closed when a configured PostgreSQL authority is unreachable", async () => {
    await expect(
      createPostgresAuthority({
        connectionString: "postgres://u9:u9@127.0.0.1:1/u9",
        authorityId: "u9-unreachable",
        namespace: "u9-unreachable",
        connectTimeoutSeconds: 1,
      }),
    ).rejects.toThrow();
  }, 10_000);
});
