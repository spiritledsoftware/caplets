import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { createHostStorage, migrateHostStorage } from "../src/storage";

const connectionString = process.env.CAPLETS_TEST_POSTGRES_URL;
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
