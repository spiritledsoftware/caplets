import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { createHostStorage, migrateHostStorage } from "../src/storage";
import type {
  CapletRevisionPageKey,
  CapletRevisionSummaryView,
} from "../src/storage/caplet-records";

const connectionString = process.env.CAPLETS_TEST_POSTGRES_URL;
if (process.env.CAPLETS_REQUIRE_TEST_POSTGRES === "1" && !connectionString) {
  throw new Error("CAPLETS_TEST_POSTGRES_URL is required when CAPLETS_REQUIRE_TEST_POSTGRES=1.");
}
const schemas: string[] = [];
const postgresIt = connectionString ? it : it.skip;

afterEach(async () => {
  if (!connectionString || schemas.length === 0) return;
  const client = new Pool({ connectionString });
  try {
    for (const schema of schemas.splice(0)) {
      await client.query(`drop schema if exists "${schema}" cascade`);
    }
  } finally {
    await client.end();
  }
});

postgresIt("persists and updates Caplet Records through PostgreSQL", async () => {
  const schema = `caplets_test_${randomUUID().replaceAll("-", "")}`;
  schemas.push(schema);
  const config = { type: "postgres" as const, connectionString: connectionString!, schema };
  await migrateHostStorage(config);
  const storage = await createHostStorage(config);
  const files = (name: string) => [
    {
      path: "CAPLET.md",
      executable: false,
      content: Buffer.from(`---
name: ${name}
description: Exercise PostgreSQL Caplet Record persistence.
mcpServer:
  command: postgres-mcp
---
# ${name}
`),
    },
    { path: "run.sh", executable: true, content: Buffer.from("#!/bin/sh\n") },
  ];

  try {
    const created = await storage.caplets.importBundle({
      id: "postgres-record",
      operator: { clientId: "operator_create", role: "operator" },
      historyLimit: 2,
      files: files("First"),
    });
    const updated = await storage.caplets.updateBundle({
      id: "postgres-record",
      operator: { clientId: "operator_update", role: "operator" },
      expectedGeneration: created.headGeneration,
      files: files("Second"),
    });
    expect(updated).toMatchObject({
      headGeneration: 2,
      currentRevision: {
        name: "Second",
        bundle: [{ path: "run.sh", executable: true }],
      },
    });
  } finally {
    await storage.close();
  }
});

postgresIt("migrates the PostgreSQL Caplet Record keyset index", async () => {
  const schema = `caplets_index_${randomUUID().replaceAll("-", "")}`;
  schemas.push(schema);
  const config = { type: "postgres" as const, connectionString: connectionString!, schema };
  await migrateHostStorage(config);
  const client = new Pool({ connectionString });
  try {
    const result = await client.query<{ indexdef: string }>(
      `select indexdef
       from pg_indexes
       where schemaname = $1 and tablename = 'caplet_records'
         and indexname = 'caplet_records_updated_key_idx'`,
      [schema],
    );
    expect(result.rows).toEqual([
      {
        indexdef: expect.stringContaining("USING btree (updated_at, record_key)"),
      },
    ]);
  } finally {
    await client.end();
  }
});

postgresIt("pages Caplet Records and revisions through PostgreSQL keysets", async () => {
  const schema = `caplets_pages_${randomUUID().replaceAll("-", "")}`;
  schemas.push(schema);
  const config = { type: "postgres" as const, connectionString: connectionString!, schema };
  await migrateHostStorage(config);
  const storage = await createHostStorage(config);
  const operator = { clientId: "operator_pages", role: "operator" } as const;
  const files = (name: string, tags: string[]) => [
    {
      path: "CAPLET.md",
      executable: false,
      content: Buffer.from(`---
name: ${name}
description: Exercise PostgreSQL Caplet keyset pages.
tags: [${tags.join(", ")}]
mcpServer:
  command: postgres-pages-mcp
---
# ${name}
`),
    },
  ];

  try {
    const alpha = await storage.caplets.importBundle({
      id: "postgres-alpha",
      historyLimit: 3,
      files: files("Alpha", ["shared", "alpha"]),
      installation: { sourceKind: "catalog", sourceIdentity: "official/alpha" },
      operator,
    });
    const beta = await storage.caplets.importBundle({
      id: "postgres-beta",
      files: files("Beta", ["shared", "beta"]),
      installation: { sourceKind: "local", sourceIdentity: "/tmp/beta" },
      operator,
    });
    const betaInstallation = await storage.installations.getActive("postgres-beta");
    if (!betaInstallation) throw new Error("Expected postgres-beta installation.");
    await storage.installations.detach({
      capletId: "postgres-beta",
      installationKey: betaInstallation.installationKey,
      expectedGeneration: 1,
      operator,
    });
    const expectedRecords = [alpha, beta].sort((left, right) =>
      left.updatedAt === right.updatedAt
        ? left.recordKey < right.recordKey
          ? 1
          : -1
        : left.updatedAt < right.updatedAt
          ? 1
          : -1,
    );
    const expectedSummaries = expectedRecords.map(
      ({ currentRevision: { revisionKey, sequence, name, createdAt }, ...record }) => ({
        ...record,
        currentRevision: { revisionKey, sequence, name, createdAt },
      }),
    );
    const firstRecordPage = await storage.caplets.listRecordsPage({ limit: 1 });
    const secondRecordPage = await storage.caplets.listRecordsPage({
      limit: 1,
      after: firstRecordPage.nextKey,
    });
    expect([...firstRecordPage.items, ...secondRecordPage.items]).toEqual(expectedSummaries);
    await expect(
      storage.caplets.listRecordsPage({ source: "local", status: "detached", tag: "shared" }),
    ).resolves.toMatchObject({ items: [{ id: "postgres-beta" }] });

    const secondRevision = await storage.caplets.updateBundle({
      id: "postgres-alpha",
      expectedGeneration: 1,
      detachInstallation: true,
      files: files("Alpha Two", ["shared"]),
      operator,
    });
    const thirdRevision = await storage.caplets.updateBundle({
      id: "postgres-alpha",
      expectedGeneration: 2,
      files: files("Alpha Three", ["shared"]),
      operator,
    });
    const expectedRevisions = [
      alpha.currentRevision,
      secondRevision.currentRevision,
      thirdRevision.currentRevision,
    ].sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.revisionKey < right.revisionKey
          ? 1
          : -1
        : left.createdAt < right.createdAt
          ? 1
          : -1,
    );
    const revisionItems: CapletRevisionSummaryView[] = [];
    let after: CapletRevisionPageKey | undefined;
    do {
      const page = await storage.caplets.listRevisionsPage("postgres-alpha", operator, {
        limit: 1,
        after,
      });
      revisionItems.push(...page.items);
      after = page.nextKey;
    } while (after);
    expect(revisionItems).toEqual(
      expectedRevisions.map(({ revisionKey, sequence, name, createdAt }) => ({
        revisionKey,
        sequence,
        name,
        createdAt,
      })),
    );
  } finally {
    await storage.close();
  }
});

postgresIt(
  "allows exactly one of two competing PostgreSQL imports for the same Record",
  async () => {
    const schema = `caplets_race_${randomUUID().replaceAll("-", "")}`;
    schemas.push(schema);
    const config = { type: "postgres" as const, connectionString: connectionString!, schema };
    await migrateHostStorage(config);
    const firstStorage = await createHostStorage(config);
    const secondStorage = await createHostStorage(config);
    const input = {
      id: "competing-record",
      operator: { clientId: "operator_create", role: "operator" as const },
      files: [
        {
          path: "CAPLET.md",
          executable: false,
          content: Buffer.from(`---
name: Competing Record
description: Exercise atomic PostgreSQL create collision behavior.
mcpServer:
  command: competing-mcp
---
# Competing Record
`),
        },
      ],
    };

    try {
      const results = await Promise.allSettled([
        firstStorage.caplets.importBundle(input),
        secondStorage.caplets.importBundle(input),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected?.status !== "rejected") throw new Error("Expected one rejected import.");
      expect(rejected.reason).toMatchObject({ code: "CONFIG_EXISTS" });
      await expect(firstStorage.caplets.get("competing-record")).resolves.toMatchObject({
        id: "competing-record",
        headGeneration: 1,
      });
    } finally {
      await firstStorage.close();
      await secondStorage.close();
    }
  },
);

postgresIt("notifies peer listeners after a committed Caplet Record mutation", async () => {
  const schema = `caplets_notify_${randomUUID().replaceAll("-", "")}`;
  schemas.push(schema);
  const config = { type: "postgres" as const, connectionString: connectionString!, schema };
  await migrateHostStorage(config);
  const listener = await createHostStorage(config);
  const writer = await createHostStorage(config);
  let markListening: (() => void) | undefined;
  const listening = new Promise<void>((resolve) => {
    markListening = resolve;
  });
  const currentGeneration = listener.coordination.currentConfigGeneration.bind(
    listener.coordination,
  );
  vi.spyOn(listener.coordination, "currentConfigGeneration").mockImplementation(async () => {
    const generation = await currentGeneration();
    markListening?.();
    return generation;
  });
  const nextGeneration = listener.coordination.waitForConfigGeneration(0);
  try {
    await listening;
    const startedAt = Date.now();
    await writer.caplets.importBundle({
      id: "notified-record",
      operator: { clientId: "operator_create", role: "operator" },
      files: [
        {
          path: "CAPLET.md",
          executable: false,
          content: Buffer.from(`---
name: Notified
description: Exercise transactional PostgreSQL generation notifications.
mcpServer:
  command: postgres-mcp
---
# Notified
`),
        },
      ],
    });
    await expect(nextGeneration).resolves.toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  } finally {
    vi.restoreAllMocks();
    await listener.close();
    await writer.close();
  }
});
