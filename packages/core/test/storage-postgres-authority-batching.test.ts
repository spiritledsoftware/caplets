import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createPostgresAuthority, type PostgresAuthority } from "../src/storage/sql/authority";
import { migratePostgresDatabase } from "../src/storage/sql/migrate";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { stableJsonStringify } from "../src/stable-json";

const require = createRequire(import.meta.url);
const loadPostgres = require("postgres") as typeof postgres;
const connectionString = process.env.TEST_POSTGRES_URL;

const RECEIPT_COUNT = 10_000;
const SESSION_COUNT = 50_000;
const EVENT_COUNT = 10_000;
const BULK_INSERT_ROWS = 2_000;

describe.skipIf(!connectionString)("PostgreSQL SQL authority batching", () => {
  it("keeps export and restore query counts bounded at maximum domain shapes", async () => {
    const authorityId = `authority-pg-batch-${randomUUID()}`;
    const queries: string[] = [];
    const client = loadPostgres(connectionString!, {
      max: 1,
      prepare: false,
      debug: (_connection, query) => queries.push(query),
    });
    let source: PostgresAuthority<{ value: number }, { snapshot: { value: number } }> | undefined;
    let target: PostgresAuthority<{ value: number }, { snapshot: { value: number } }> | undefined;
    try {
      await migratePostgresDatabase({
        client,
        authorityId,
        namespace: "test",
      });
      source = await createPostgresAuthority<{ value: number }, { snapshot: { value: number } }>({
        client,
        authorityId,
        namespace: "test",
        initialSnapshot: { value: 0 },
        verifySchema: true,
        applyCommand: ({ command }) => ({ snapshot: command.snapshot }),
      });
      const envelope = {
        authorityId,
        currentHostId: "host",
        principalId: "operator",
        expectedGeneration: null,
        idempotencyKey: "initial",
        requestDigest: "digest-initial",
        command: { snapshot: { value: 1 } },
      };
      const committed = await source.commit(envelope);
      expect(committed.kind).toBe("committed");
      if (committed.kind !== "committed") throw new Error("expected initial PostgreSQL commit");

      const expiresAt = "2099-01-01T00:00:00.000Z";
      const occurredAt = "2026-01-01T00:00:00.000Z";
      await client.begin(async (tx) => {
        const receiptRows = Array.from({ length: RECEIPT_COUNT - 1 }, (_, index) => ({
          authority_id: authorityId,
          current_host_id: "host",
          principal_id: "operator",
          idempotency_key: `bulk-${index}`,
          request_digest: `digest-${index}`,
          generation_id: committed.generation.id,
          result_json: JSON.stringify({ index }),
          expires_at: expiresAt,
        }));
        for (let start = 0; start < receiptRows.length; start += BULK_INSERT_ROWS) {
          await tx`INSERT INTO authority_receipts ${tx(
            receiptRows.slice(start, start + BULK_INSERT_ROWS),
            "authority_id",
            "current_host_id",
            "principal_id",
            "idempotency_key",
            "request_digest",
            "generation_id",
            "result_json",
            "expires_at",
          )}`;
        }

        const sessionRows = Array.from({ length: SESSION_COUNT }, (_, index) => ({
          authority_id: authorityId,
          session_id: `session-${index}`,
          revision: 1,
          last_used_at: occurredAt,
          revoked: index % 2,
        }));
        for (let start = 0; start < sessionRows.length; start += BULK_INSERT_ROWS) {
          await tx`INSERT INTO authority_sessions ${tx(
            sessionRows.slice(start, start + BULK_INSERT_ROWS),
            "authority_id",
            "session_id",
            "revision",
            "last_used_at",
            "revoked",
          )}`;
        }

        const eventJson = JSON.stringify({ kind: "conflicted", occurredAt, code: "CONFLICTED" });
        const eventRows = Array.from({ length: EVENT_COUNT }, (_, index) => ({
          authority_id: authorityId,
          watermark: index + 1,
          kind: "conflicted",
          occurred_at: occurredAt,
          event_json: eventJson,
        }));
        for (let start = 0; start < eventRows.length; start += BULK_INSERT_ROWS) {
          await tx`INSERT INTO authority_events ${tx(
            eventRows.slice(start, start + BULK_INSERT_ROWS),
            "authority_id",
            "watermark",
            "kind",
            "occurred_at",
            "event_json",
          )}`;
        }
        await tx`UPDATE authority_schema_meta SET auxiliary_watermark = ${EVENT_COUNT} WHERE authority_id = ${authorityId}`;
      });

      queries.length = 0;
      const exported = await source.exportState();
      expect(exported.receipts).toHaveLength(RECEIPT_COUNT);
      expect(Object.keys(exported.auxiliary?.sessions ?? {})).toHaveLength(SESSION_COUNT);
      expect(exported.auxiliary?.securityEvents).toHaveLength(EVENT_COUNT);
      const exportQueries = [...queries];
      expect(
        exportQueries.filter((query) => query.includes("LEFT JOIN authority_generations")).length,
      ).toBe(1);
      expect(
        exportQueries.filter((query) =>
          query.includes("FROM authority_generations WHERE authority_id"),
        ).length,
      ).toBe(1);
      expect(exportQueries.length).toBeLessThan(15);

      await source.close();
      source = undefined;
      await client.begin(async (tx) => {
        await tx`DELETE FROM authority_receipts WHERE authority_id = ${authorityId}`;
        await tx`DELETE FROM authority_sessions WHERE authority_id = ${authorityId}`;
        await tx`DELETE FROM authority_events WHERE authority_id = ${authorityId}`;
        await tx`DELETE FROM authority_generations WHERE authority_id = ${authorityId}`;
        await tx`UPDATE authority_schema_meta SET auxiliary_watermark = 0 WHERE authority_id = ${authorityId}`;
        await tx`UPDATE authority_heads SET generation_id = NULL, sequence = 0, predecessor_id = NULL, digest = NULL, committed_at = NULL WHERE authority_id = ${authorityId}`;
      });

      target = await createPostgresAuthority<{ value: number }, { snapshot: { value: number } }>({
        client,
        authorityId,
        namespace: "test",
        initialSnapshot: { value: 0 },
        verifySchema: true,
        applyCommand: ({ command }) => ({ snapshot: command.snapshot }),
      });
      queries.length = 0;
      const restored = await target.restoreState(exported);
      const restoreQueries = [...queries];
      expect(restored.generation).toEqual({
        authorityId,
        id: exported.generation.id,
        sequence: exported.generation.sequence,
        predecessorId: exported.generation.predecessorId,
      });
      expect(restored.auxiliaryWatermark).toBe(exported.auxiliaryWatermark);
      expect(
        restoreQueries.filter((query) => query.includes("INSERT INTO authority_receipts")).length,
      ).toBe(Math.ceil(RECEIPT_COUNT / BULK_INSERT_ROWS));
      expect(
        restoreQueries.filter((query) => query.includes("INSERT INTO authority_sessions")).length,
      ).toBe(Math.ceil(SESSION_COUNT / BULK_INSERT_ROWS));
      expect(
        restoreQueries.filter((query) => query.includes("INSERT INTO authority_events")).length,
      ).toBe(Math.ceil(EVENT_COUNT / BULK_INSERT_ROWS));
      expect(restoreQueries.length).toBeLessThan(60);

      const restoredExport = await target.exportState();
      expect(stableJsonStringify(restoredExport)).toBe(stableJsonStringify(exported));
      const replay = await target.commit(envelope);
      expect(replay.kind).toBe("replayed");
    } finally {
      await source?.close().catch(() => undefined);
      await target?.close().catch(() => undefined);
      await client.end({ timeout: 2 }).catch(() => undefined);
    }
  });
});
