import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, ne, sql } from "drizzle-orm";
import { CapletsError } from "../errors";
import * as postgres from "./schema/postgres";
import * as sqlite from "./schema/sqlite";
import type { HostDatabase, PostgresHostDatabase, SqliteHostDatabase } from "./types";

export const CONFIG_GENERATION_CHANNEL = "caplets_config_generation";
const CONFIG_GENERATION_POLL_INTERVAL_MS = 5_000;

type PostgresNotification = {
  channel: string;
};

type PostgresListenerClient = {
  query(queryText: string): Promise<unknown>;
  on(event: "notification", listener: (notification: PostgresNotification) => void): unknown;
  removeListener(
    event: "notification",
    listener: (notification: PostgresNotification) => void,
  ): unknown;
  release(): void;
};

type PostgresListenerPool = {
  connect(): Promise<PostgresListenerClient>;
};

export type WaitForConfigGenerationOptions = {
  pollIntervalMs?: number | undefined;
  signal?: AbortSignal | undefined;
};

export type HostNodeRegistration = {
  hostId: string;
  nodeId: string;
  ready: boolean;
  conflict: "global_file_manifest" | "runtime_fingerprint" | null;
};

export type MaintenanceLease = {
  leaseName: string;
  ownerNodeId: string;
  fencingToken: number;
  expiresAt: string;
};

type RegisterNodeInput = {
  nodeId: string;
  globalFileManifest: string;
  runtimeFingerprint: string;
  heartbeatTtlMs?: number | undefined;
  now?: Date | undefined;
};

type AcquireLeaseInput = {
  leaseName: string;
  ownerNodeId: string;
  ttlMs: number;
  now?: Date | undefined;
};

export class HostCoordinationStore {
  private readonly activeWaits = new Map<AbortController, Promise<number>>();
  private closed = false;

  constructor(
    private readonly database: HostDatabase,
    private readonly postgresListenerPool?: PostgresListenerPool | undefined,
  ) {}

  async registerNode(input: RegisterNodeInput): Promise<HostNodeRegistration> {
    validateNodeInput(input);
    return this.database.dialect === "sqlite"
      ? await registerSqlite(this.database.db, input)
      : await registerPostgres(this.database.db, input);
  }

  async heartbeat(input: RegisterNodeInput): Promise<HostNodeRegistration> {
    return await this.registerNode(input);
  }

  async unregisterNode(nodeId: string): Promise<void> {
    if (this.database.dialect === "sqlite") {
      await this.database.db
        .delete(sqlite.hostNodes)
        .where(eq(sqlite.hostNodes.nodeId, nodeId))
        .run();
    } else {
      await this.database.db
        .delete(postgres.hostNodes)
        .where(eq(postgres.hostNodes.nodeId, nodeId));
    }
  }

  async nodeReady(nodeId: string): Promise<boolean> {
    const row =
      this.database.dialect === "sqlite"
        ? await this.database.db
            .select({ ready: sqlite.hostNodes.ready })
            .from(sqlite.hostNodes)
            .where(eq(sqlite.hostNodes.nodeId, nodeId))
            .get()
        : (
            await this.database.db
              .select({ ready: postgres.hostNodes.ready })
              .from(postgres.hostNodes)
              .where(eq(postgres.hostNodes.nodeId, nodeId))
              .limit(1)
          )[0];
    return row?.ready === true;
  }

  async activeNodeCount(maxHeartbeatAgeMs = 5_000): Promise<number> {
    if (this.database.dialect === "sqlite") {
      const row = await this.database.db
        .select({ count: count() })
        .from(sqlite.hostNodes)
        .where(
          gt(sqlite.hostNodes.heartbeatAt, new Date(Date.now() - maxHeartbeatAgeMs).toISOString()),
        )
        .get();
      return row?.count ?? 0;
    }
    const [row] = await this.database.db
      .select({ count: count() })
      .from(postgres.hostNodes)
      .where(
        sql`${postgres.hostNodes.heartbeatAt} >= to_char(
          clock_timestamp() - (${maxHeartbeatAgeMs} * interval '1 millisecond'),
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )`,
      );
    return row?.count ?? 0;
  }

  async publishConfigGeneration(contentHash: string, createdBy: string): Promise<number> {
    return this.database.dialect === "sqlite"
      ? this.database.db.transaction(
          async (transaction) =>
            await advanceSqliteConfigGeneration(transaction, contentHash, createdBy, true),
        )
      : await this.database.db.transaction(
          async (transaction) =>
            await advancePostgresConfigGeneration(transaction, contentHash, createdBy, true),
        );
  }

  async currentConfigGeneration(): Promise<number> {
    const row =
      this.database.dialect === "sqlite"
        ? await this.database.db
            .select({ generation: sqlite.hostConfigGenerations.generation })
            .from(sqlite.hostConfigGenerations)
            .orderBy(desc(sqlite.hostConfigGenerations.generation))
            .get()
        : (
            await this.database.db
              .select({ generation: postgres.hostConfigGenerations.generation })
              .from(postgres.hostConfigGenerations)
              .orderBy(desc(postgres.hostConfigGenerations.generation))
              .limit(1)
          )[0];
    return row?.generation ?? 0;
  }

  async waitForConfigGeneration(
    afterGeneration: number,
    options: WaitForConfigGenerationOptions = {},
  ): Promise<number> {
    if (this.closed) throw configGenerationWaitAborted();
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const pollIntervalMs = options.pollIntervalMs ?? CONFIG_GENERATION_POLL_INTERVAL_MS;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
      options.signal?.removeEventListener("abort", forwardAbort);
      throw new CapletsError(
        "REQUEST_INVALID",
        "Config generation poll interval must be positive.",
      );
    }
    const wait =
      this.database.dialect === "sqlite"
        ? this.waitForSqliteConfigGeneration(afterGeneration, pollIntervalMs, controller.signal)
        : this.waitForPostgresConfigGeneration(afterGeneration, pollIntervalMs, controller.signal);
    this.activeWaits.set(controller, wait);
    try {
      return await wait;
    } finally {
      this.activeWaits.delete(controller);
      options.signal?.removeEventListener("abort", forwardAbort);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const waits = [...this.activeWaits.entries()];
    for (const [controller] of waits) controller.abort();
    await Promise.allSettled(waits.map(([, wait]) => wait));
  }

  private async waitForSqliteConfigGeneration(
    afterGeneration: number,
    pollIntervalMs: number,
    signal: AbortSignal,
  ): Promise<number> {
    const latest = await this.currentConfigGeneration();
    if (latest > afterGeneration) return latest;
    await waitForNotificationOrPoll(undefined, pollIntervalMs, signal);
    return await this.currentConfigGeneration();
  }

  private async waitForPostgresConfigGeneration(
    afterGeneration: number,
    pollIntervalMs: number,
    signal: AbortSignal,
  ): Promise<number> {
    if (this.database.dialect !== "postgres" || !this.postgresListenerPool) {
      throw new CapletsError(
        "INTERNAL_ERROR",
        "PostgreSQL config generation listener is unavailable.",
      );
    }
    const channel = postgresConfigGenerationChannel(this.database.schema);
    const quotedChannel = `"${channel.replaceAll('"', '""')}"`;
    const client = await connectPostgresListener(this.postgresListenerPool, signal);
    let listening = false;
    let notify: (() => void) | undefined;
    const notified = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const onNotification = (notification: PostgresNotification) => {
      if (notification.channel === channel) notify?.();
    };
    client.on("notification", onNotification);
    try {
      await client.query(`LISTEN ${quotedChannel}`);
      listening = true;
      const latest = await this.currentConfigGeneration();
      if (latest > afterGeneration) return latest;
      await waitForNotificationOrPoll(notified, pollIntervalMs, signal);
      return await this.currentConfigGeneration();
    } finally {
      client.removeListener("notification", onNotification);
      if (listening) {
        await client.query(`UNLISTEN ${quotedChannel}`).catch(() => undefined);
      }
      client.release();
    }
  }

  async acquireLease(input: AcquireLeaseInput): Promise<MaintenanceLease | undefined> {
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0)
      throw new CapletsError("REQUEST_INVALID", "Lease TTL must be positive.");
    return this.database.dialect === "sqlite"
      ? await acquireLeaseSqlite(this.database.db, input)
      : await acquireLeasePostgres(this.database.db, input);
  }

  async checkpointLease(input: {
    leaseName: string;
    ownerNodeId: string;
    fencingToken: number;
    cursor: string | null;
    now?: Date | undefined;
  }): Promise<void> {
    if (this.database.dialect === "sqlite") await checkpointSqlite(this.database.db, input);
    else await checkpointPostgres(this.database.db, input);
  }
}

async function connectPostgresListener(
  pool: PostgresListenerPool,
  signal: AbortSignal,
): Promise<PostgresListenerClient> {
  const connection = pool.connect();
  if (signal.aborted) {
    void connection.then(
      (client) => client.release(),
      () => undefined,
    );
    throw configGenerationWaitAborted();
  }
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(configGenerationWaitAborted());
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([connection, aborted]);
  } catch (error) {
    if (signal.aborted) {
      void connection.then(
        (client) => client.release(),
        () => undefined,
      );
    }
    throw error;
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

export async function advanceSqliteConfigGeneration(
  transaction: Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0],
  contentHash: string,
  createdBy: string,
  deduplicate = false,
): Promise<number> {
  const latest = await transaction
    .select({
      generation: sqlite.hostConfigGenerations.generation,
      contentHash: sqlite.hostConfigGenerations.contentHash,
    })
    .from(sqlite.hostConfigGenerations)
    .orderBy(desc(sqlite.hostConfigGenerations.generation))
    .get();
  if (deduplicate && latest?.contentHash === contentHash) return latest.generation;
  const generation = (latest?.generation ?? 0) + 1;
  await transaction
    .insert(sqlite.hostConfigGenerations)
    .values({
      generation,
      contentHash,
      createdAt: new Date().toISOString(),
      createdBy,
    })
    .run();
  return generation;
}

export async function advancePostgresConfigGeneration(
  transaction: Parameters<Parameters<PostgresHostDatabase["transaction"]>[0]>[0],
  contentHash: string,
  createdBy: string,
  deduplicate = false,
): Promise<number> {
  await transaction.execute(sql`select pg_advisory_xact_lock(1128352845)`);
  const [latest] = await transaction
    .select({
      generation: postgres.hostConfigGenerations.generation,
      contentHash: postgres.hostConfigGenerations.contentHash,
    })
    .from(postgres.hostConfigGenerations)
    .orderBy(desc(postgres.hostConfigGenerations.generation))
    .limit(1);
  if (deduplicate && latest?.contentHash === contentHash) return latest.generation;
  const generation = (latest?.generation ?? 0) + 1;
  await transaction.insert(postgres.hostConfigGenerations).values({
    generation,
    contentHash,
    createdAt: new Date().toISOString(),
    createdBy,
  });
  await transaction.execute(
    sql`select pg_notify(${postgresConfigGenerationChannelSql()}, ${String(generation)})`,
  );
  return generation;
}

/**
 * PostgreSQL notification channels are database-global, while HostStorage tables are isolated by
 * schema. Keep the legacy channel for the default schema and swap the two reserved names so this
 * remains a one-to-one mapping for every valid PostgreSQL schema without truncation or hashing.
 */
function postgresConfigGenerationChannel(schema: string): string {
  if (schema === "caplets") return CONFIG_GENERATION_CHANNEL;
  if (schema === CONFIG_GENERATION_CHANNEL) return "caplets";
  return schema;
}

function postgresConfigGenerationChannelSql() {
  return sql<string>`case current_schema()
    when 'caplets' then ${CONFIG_GENERATION_CHANNEL}
    when ${CONFIG_GENERATION_CHANNEL} then 'caplets'
    else current_schema()
  end`;
}

function waitForNotificationOrPoll(
  notification: Promise<void> | undefined,
  pollIntervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(configGenerationWaitAborted());
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(configGenerationWaitAborted());
    const timer = setTimeout(() => finish(), pollIntervalMs);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    void notification?.then(() => finish());
  });
}

function configGenerationWaitAborted(): Error {
  const error = new Error("Config generation wait was aborted.");
  error.name = "AbortError";
  return error;
}

async function registerSqlite(
  db: SqliteHostDatabase,
  input: RegisterNodeInput,
): Promise<HostNodeRegistration> {
  return await db.transaction(async (transaction) => {
    const now = input.now ?? new Date();
    const nowText = now.toISOString();
    const cutoff = new Date(now.getTime() - (input.heartbeatTtlMs ?? 15_000)).toISOString();
    let identity = await transaction
      .select()
      .from(sqlite.hostIdentity)
      .where(eq(sqlite.hostIdentity.singleton, 1))
      .get();
    if (!identity) {
      identity = { singleton: 1, hostId: randomUUID(), createdAt: nowText };
      await transaction.insert(sqlite.hostIdentity).values(identity).run();
    }
    const peers = await transaction
      .select()
      .from(sqlite.hostNodes)
      .where(
        and(ne(sqlite.hostNodes.nodeId, input.nodeId), gt(sqlite.hostNodes.heartbeatAt, cutoff)),
      )
      .all();
    const conflict = parityConflict(peers, input);
    await transaction
      .insert(sqlite.hostNodes)
      .values({
        nodeId: input.nodeId,
        startedAt: nowText,
        heartbeatAt: nowText,
        globalFileManifest: input.globalFileManifest,
        runtimeFingerprint: input.runtimeFingerprint,
        ready: conflict === null,
      })
      .onConflictDoUpdate({
        target: sqlite.hostNodes.nodeId,
        set: {
          heartbeatAt: nowText,
          globalFileManifest: input.globalFileManifest,
          runtimeFingerprint: input.runtimeFingerprint,
          ready: conflict === null,
        },
      })
      .run();
    return { hostId: identity.hostId, nodeId: input.nodeId, ready: conflict === null, conflict };
  });
}

async function registerPostgres(
  db: PostgresHostDatabase,
  input: RegisterNodeInput,
): Promise<HostNodeRegistration> {
  return await db.transaction(async (transaction) => {
    const clockResult = await transaction.execute<{ now: string }>(
      sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "now"`,
    );
    const nowText = clockResult.rows[0]?.now;
    if (!nowText) throw new CapletsError("INTERNAL_ERROR", "Host-node clock query failed.");
    await transaction
      .insert(postgres.hostIdentity)
      .values({ singleton: 1, hostId: randomUUID(), createdAt: nowText })
      .onConflictDoNothing();
    const [identity] = await transaction
      .select()
      .from(postgres.hostIdentity)
      .where(eq(postgres.hostIdentity.singleton, 1))
      .for("update")
      .limit(1);
    if (!identity) throw new CapletsError("INTERNAL_ERROR", "Host identity registration failed.");
    const peers = await transaction
      .select()
      .from(postgres.hostNodes)
      .where(
        and(
          ne(postgres.hostNodes.nodeId, input.nodeId),
          sql`${postgres.hostNodes.heartbeatAt} >= to_char(
            clock_timestamp() - (${input.heartbeatTtlMs ?? 15_000} * interval '1 millisecond'),
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )`,
        ),
      );
    const conflict = parityConflict(peers, input);
    await transaction
      .insert(postgres.hostNodes)
      .values({
        nodeId: input.nodeId,
        startedAt: nowText,
        heartbeatAt: nowText,
        globalFileManifest: input.globalFileManifest,
        runtimeFingerprint: input.runtimeFingerprint,
        ready: conflict === null,
      })
      .onConflictDoUpdate({
        target: postgres.hostNodes.nodeId,
        set: {
          heartbeatAt: nowText,
          globalFileManifest: input.globalFileManifest,
          runtimeFingerprint: input.runtimeFingerprint,
          ready: conflict === null,
        },
      });
    return { hostId: identity.hostId, nodeId: input.nodeId, ready: conflict === null, conflict };
  });
}

function parityConflict(
  peers: Array<{ globalFileManifest: string; runtimeFingerprint: string }>,
  input: RegisterNodeInput,
): HostNodeRegistration["conflict"] {
  if (peers.some((peer) => peer.globalFileManifest !== input.globalFileManifest))
    return "global_file_manifest";
  if (peers.some((peer) => peer.runtimeFingerprint !== input.runtimeFingerprint))
    return "runtime_fingerprint";
  return null;
}

async function acquireLeaseSqlite(
  db: SqliteHostDatabase,
  input: AcquireLeaseInput,
): Promise<MaintenanceLease | undefined> {
  return await db.transaction(
    async (transaction) => {
      const now = input.now ?? new Date();
      const existing = await transaction
        .select()
        .from(sqlite.maintenanceLeases)
        .where(eq(sqlite.maintenanceLeases.leaseName, input.leaseName))
        .get();
      if (
        existing &&
        existing.ownerNodeId !== input.ownerNodeId &&
        existing.expiresAt > now.toISOString()
      )
        return undefined;
      const lease = {
        leaseName: input.leaseName,
        ownerNodeId: input.ownerNodeId,
        fencingToken: (existing?.fencingToken ?? 0) + 1,
        expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
        updatedAt: now.toISOString(),
      };
      await transaction
        .insert(sqlite.maintenanceLeases)
        .values(lease)
        .onConflictDoUpdate({ target: sqlite.maintenanceLeases.leaseName, set: lease })
        .run();
      return lease;
    },
    { behavior: "exclusive" },
  );
}

async function acquireLeasePostgres(
  db: PostgresHostDatabase,
  input: AcquireLeaseInput,
): Promise<MaintenanceLease | undefined> {
  return await db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
        "maintenance-lease",
        input.leaseName,
      ])}, 0))`,
    );
    const [existing] = await transaction
      .select()
      .from(postgres.maintenanceLeases)
      .where(eq(postgres.maintenanceLeases.leaseName, input.leaseName))
      .for("update")
      .limit(1);
    const clockResult = await transaction.execute<{ acquiredAt: string; expiresAt: string }>(
      sql`select
        to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "acquiredAt",
        to_char((clock_timestamp() + (${input.ttlMs} * interval '1 millisecond')) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt"`,
    );
    const clock = clockResult.rows[0];
    if (!clock) throw new CapletsError("INTERNAL_ERROR", "Lease clock query failed.");
    if (
      existing &&
      existing.ownerNodeId !== input.ownerNodeId &&
      existing.expiresAt > clock.acquiredAt
    )
      return undefined;
    const lease = {
      leaseName: input.leaseName,
      ownerNodeId: input.ownerNodeId,
      fencingToken: (existing?.fencingToken ?? 0) + 1,
      expiresAt: clock.expiresAt,
      updatedAt: clock.acquiredAt,
    };
    await transaction
      .insert(postgres.maintenanceLeases)
      .values(lease)
      .onConflictDoUpdate({ target: postgres.maintenanceLeases.leaseName, set: lease });
    return lease;
  });
}

async function checkpointSqlite(
  db: SqliteHostDatabase,
  input: {
    leaseName: string;
    ownerNodeId: string;
    fencingToken: number;
    cursor: string | null;
    now?: Date | undefined;
  },
): Promise<void> {
  await db.transaction(async (transaction) => {
    const lease = await transaction
      .select()
      .from(sqlite.maintenanceLeases)
      .where(eq(sqlite.maintenanceLeases.leaseName, input.leaseName))
      .get();
    assertLease(lease, input);
    await transaction
      .insert(sqlite.maintenanceCursors)
      .values({
        jobName: input.leaseName,
        cursor: input.cursor,
        updatedAt: (input.now ?? new Date()).toISOString(),
      })
      .onConflictDoUpdate({
        target: sqlite.maintenanceCursors.jobName,
        set: { cursor: input.cursor, updatedAt: (input.now ?? new Date()).toISOString() },
      })
      .run();
  });
}

async function checkpointPostgres(
  db: PostgresHostDatabase,
  input: {
    leaseName: string;
    ownerNodeId: string;
    fencingToken: number;
    cursor: string | null;
    now?: Date | undefined;
  },
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [lease] = await transaction
      .select()
      .from(postgres.maintenanceLeases)
      .where(eq(postgres.maintenanceLeases.leaseName, input.leaseName))
      .for("update")
      .limit(1);
    const clockResult = await transaction.execute<{ authorityNow: string }>(
      sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "authorityNow"`,
    );
    const clock = clockResult.rows[0];
    if (!clock) throw new CapletsError("INTERNAL_ERROR", "Lease clock query failed.");
    assertLease(lease, { ...input, now: new Date(clock.authorityNow) });
    await transaction
      .insert(postgres.maintenanceCursors)
      .values({
        jobName: input.leaseName,
        cursor: input.cursor,
        updatedAt: clock.authorityNow,
      })
      .onConflictDoUpdate({
        target: postgres.maintenanceCursors.jobName,
        set: { cursor: input.cursor, updatedAt: clock.authorityNow },
      });
  });
}

function assertLease(
  lease: MaintenanceLease | undefined,
  input: { ownerNodeId: string; fencingToken: number; now?: Date | undefined },
): void {
  if (
    !lease ||
    lease.ownerNodeId !== input.ownerNodeId ||
    lease.fencingToken !== input.fencingToken ||
    lease.expiresAt <= (input.now ?? new Date()).toISOString()
  ) {
    throw new CapletsError("REQUEST_INVALID", "Maintenance lease is stale or no longer owned.", {
      kind: "stale_lease",
    });
  }
}

function validateNodeInput(input: RegisterNodeInput): void {
  if (!input.nodeId || !input.globalFileManifest || !input.runtimeFingerprint)
    throw new CapletsError(
      "REQUEST_INVALID",
      "Node registration requires identity and parity fingerprints.",
    );
}
