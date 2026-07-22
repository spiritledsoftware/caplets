import { randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { CapletsError } from "../errors";
import { projectBindingError } from "../project-binding/errors";
import {
  isProjectBindingReadiness,
  isProjectBindingState,
  isProjectBindingSyncState,
  type ProjectBindingAuthoritativeView,
  type ProjectBindingState,
  type ProjectBindingSyncState,
} from "../project-binding/types";
import * as postgres from "./schema/postgres";
import * as sqlite from "./schema/sqlite";
import type { HostDatabase, PostgresHostDatabase, SqliteHostDatabase } from "./types";

export const PROJECT_BINDINGS_NAMESPACE = "project-bindings";

const DEFAULT_LEASE_TTL_MS = 60_000;

export type ProjectBindingStoreOptions = {
  now?: () => Date;
  leaseTtlMs?: number;
};

export type CreateProjectBindingInput = {
  bindingId: string;
  sessionId: string;
  projectFingerprint: string;
  projectRoot: string;
  serverProjectRoot: string;
  ownerNodeId: string;
  state?: ProjectBindingState | undefined;
  syncState?: ProjectBindingSyncState | undefined;
  leaseTtlMs?: number | undefined;
};

export type HeartbeatProjectBindingInput = {
  bindingId: string;
  ownerNodeId: string;
  sessionId?: string | undefined;
  expectedGeneration: number;
  state: ProjectBindingState;
  syncState: ProjectBindingSyncState;
  leaseTtlMs?: number | undefined;
};

export type QuarantineProjectBindingOwnerLossInput = {
  bindingId: string;
  ownerNodeId: string;
  expectedGeneration: number;
};

export type RebindProjectBindingInput = {
  bindingId: string;
  expectedGeneration: number;
  newOwnerNodeId: string;
  sessionId?: string | undefined;
  leaseTtlMs?: number | undefined;
  operatorClientId: string;
};

export type EndProjectBindingInput = {
  bindingId: string;
  ownerNodeId: string;
  expectedGeneration: number;
};

type BindingActivity = {
  operatorClientId: string;
  action: string;
  targetKind: string;
  targetKey: string;
  metadata: Record<string, unknown>;
};

type BindingMutation<R> = {
  value: R;
  next?: ProjectBindingAuthoritativeView | undefined;
  expectedGeneration?: number | undefined;
  activity?: BindingActivity | undefined;
};

export class ProjectBindingStore {
  private readonly now: () => Date;
  private readonly leaseTtlMs: number;

  constructor(
    private readonly database: HostDatabase,
    options: ProjectBindingStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.leaseTtlMs = checkedLeaseTtl(options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
  }

  async create(input: CreateProjectBindingInput): Promise<ProjectBindingAuthoritativeView> {
    requireIdentity(input.bindingId, "bindingId");
    requireIdentity(input.sessionId, "sessionId");
    requireIdentity(input.projectFingerprint, "projectFingerprint");
    requireIdentity(input.projectRoot, "projectRoot");
    requireIdentity(input.serverProjectRoot, "serverProjectRoot");
    requireIdentity(input.ownerNodeId, "ownerNodeId");
    const state = input.state ?? "attaching";
    const syncState = input.syncState ?? "pending";
    if (!isProjectBindingState(state) || !isProjectBindingSyncState(syncState)) {
      throw new CapletsError("REQUEST_INVALID", "Project Binding state is invalid.");
    }
    const ttlMs = checkedLeaseTtl(input.leaseTtlMs ?? this.leaseTtlMs);
    return await this.mutate(input.bindingId, (current) => {
      if (current) {
        throw new CapletsError(
          "CONFIG_EXISTS",
          `Project Binding ${input.bindingId} already exists.`,
        );
      }
      const now = this.now();
      const timestamp = now.toISOString();
      const next: ProjectBindingAuthoritativeView = {
        bindingId: input.bindingId,
        sessionId: input.sessionId,
        projectFingerprint: input.projectFingerprint,
        projectRoot: input.projectRoot,
        serverProjectRoot: input.serverProjectRoot,
        ownerNodeId: input.ownerNodeId,
        generation: 1,
        revision: 1,
        state,
        syncState,
        readiness: readinessFor(state, syncState),
        active: true,
        lastHeartbeatAt: timestamp,
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return { value: next, next };
    });
  }

  async get(bindingId: string): Promise<ProjectBindingAuthoritativeView | undefined> {
    const row =
      this.database.dialect === "sqlite"
        ? this.database.db
            .select()
            .from(sqlite.projectBindings)
            .where(eq(sqlite.projectBindings.bindingId, bindingId))
            .get()
        : (
            await this.database.db
              .select()
              .from(postgres.projectBindings)
              .where(eq(postgres.projectBindings.bindingId, bindingId))
              .limit(1)
          )[0];
    return row ? bindingView(row) : undefined;
  }

  async list(): Promise<ProjectBindingAuthoritativeView[]> {
    const rows =
      this.database.dialect === "sqlite"
        ? this.database.db.select().from(sqlite.projectBindings).all()
        : await this.database.db.select().from(postgres.projectBindings);
    return rows.map(bindingView);
  }
  async existsActive(now: Date): Promise<boolean> {
    const expiresAfter = now.toISOString();
    const row =
      this.database.dialect === "sqlite"
        ? this.database.db
            .select({ bindingId: sqlite.projectBindings.bindingId })
            .from(sqlite.projectBindings)
            .where(
              and(
                eq(sqlite.projectBindings.active, true),
                gt(sqlite.projectBindings.expiresAt, expiresAfter),
              ),
            )
            .limit(1)
            .get()
        : (
            await this.database.db
              .select({ bindingId: postgres.projectBindings.bindingId })
              .from(postgres.projectBindings)
              .where(
                and(
                  eq(postgres.projectBindings.active, true),
                  gt(postgres.projectBindings.expiresAt, expiresAfter),
                ),
              )
              .limit(1)
          )[0];
    return row !== undefined;
  }

  async heartbeat(input: HeartbeatProjectBindingInput): Promise<ProjectBindingAuthoritativeView> {
    if (!isProjectBindingState(input.state) || !isProjectBindingSyncState(input.syncState)) {
      throw new CapletsError("REQUEST_INVALID", "Project Binding state is invalid.");
    }
    const ttlMs = checkedLeaseTtl(input.leaseTtlMs ?? this.leaseTtlMs);
    return await this.mutate(input.bindingId, (current) => {
      const view = requiredBindingView(current, input.bindingId);
      assertCurrentOwner(view, input.ownerNodeId);
      if (input.sessionId !== undefined && input.sessionId !== view.sessionId) {
        throw new CapletsError("AUTH_FAILED", "Project Binding session owner does not match.");
      }
      if (!view.active || view.readiness === "quarantined") {
        throw projectBindingError("lease_expired");
      }
      const now = this.now();
      if (Date.parse(view.expiresAt) <= now.getTime()) {
        throw projectBindingError("lease_expired");
      }
      const timestamp = now.toISOString();
      const next: ProjectBindingAuthoritativeView = {
        ...view,
        generation: view.generation + 1,
        revision: view.revision + 1,
        state: input.state,
        syncState: input.syncState,
        readiness: readinessFor(input.state, input.syncState),
        lastHeartbeatAt: timestamp,
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        updatedAt: timestamp,
      };
      return { value: next, next, expectedGeneration: input.expectedGeneration };
    });
  }

  async quarantineOwnerLoss(
    input: QuarantineProjectBindingOwnerLossInput,
  ): Promise<ProjectBindingAuthoritativeView> {
    return await this.mutate(input.bindingId, (current) => {
      const view = requiredBindingView(current, input.bindingId);
      assertCurrentOwner(view, input.ownerNodeId);
      const timestamp = this.now().toISOString();
      const next: ProjectBindingAuthoritativeView = {
        ...view,
        generation: view.generation + 1,
        revision: view.revision + 1,
        state: "offline",
        readiness: "quarantined",
        active: false,
        expiresAt: timestamp,
        updatedAt: timestamp,
        quarantinedAt: timestamp,
        quarantineReason: "owner_lost",
      };
      return { value: next, next, expectedGeneration: input.expectedGeneration };
    });
  }

  async rebind(input: RebindProjectBindingInput): Promise<ProjectBindingAuthoritativeView> {
    requireIdentity(input.newOwnerNodeId, "newOwnerNodeId");
    const operatorClientId = requireIdentity(input.operatorClientId, "operatorClientId");
    const ttlMs = checkedLeaseTtl(input.leaseTtlMs ?? this.leaseTtlMs);
    return await this.mutate(input.bindingId, (current) => {
      const view = requiredBindingView(current, input.bindingId);
      if (view.readiness !== "quarantined") {
        throw new CapletsError(
          "REQUEST_INVALID",
          `Project Binding ${input.bindingId} is not quarantined.`,
        );
      }
      if (input.sessionId !== undefined) requireIdentity(input.sessionId, "sessionId");
      const now = this.now();
      const timestamp = now.toISOString();
      const next: ProjectBindingAuthoritativeView = {
        ...view,
        ownerNodeId: input.newOwnerNodeId,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        generation: view.generation + 1,
        revision: view.revision + 1,
        state: "attaching",
        syncState: "pending",
        readiness: "not_ready",
        active: true,
        lastHeartbeatAt: timestamp,
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        updatedAt: timestamp,
      };
      delete next.quarantinedAt;
      delete next.quarantineReason;
      return {
        value: next,
        next,
        expectedGeneration: input.expectedGeneration,
        activity: {
          operatorClientId,
          action: "project_binding.rebind",
          targetKind: "project_binding",
          targetKey: input.bindingId,
          metadata: {
            previousOwnerNodeId: view.ownerNodeId,
            ownerNodeId: input.newOwnerNodeId,
            previousGeneration: view.generation,
          },
        },
      };
    });
  }

  async end(input: EndProjectBindingInput): Promise<ProjectBindingAuthoritativeView> {
    return await this.mutate(input.bindingId, (current) => {
      const view = requiredBindingView(current, input.bindingId);
      assertCurrentOwner(view, input.ownerNodeId);
      const timestamp = this.now().toISOString();
      const next: ProjectBindingAuthoritativeView = {
        ...view,
        generation: view.generation + 1,
        revision: view.revision + 1,
        state: "ended",
        readiness: "not_ready",
        active: false,
        expiresAt: timestamp,
        updatedAt: timestamp,
      };
      return { value: next, next, expectedGeneration: input.expectedGeneration };
    });
  }

  private async mutate<R>(
    bindingId: string,
    transition: (current: ProjectBindingAuthoritativeView | undefined) => BindingMutation<R>,
  ): Promise<R> {
    return this.database.dialect === "sqlite"
      ? mutateBindingSqlite(this.database.db, bindingId, transition)
      : await mutateBindingPostgres(this.database.db, bindingId, transition);
  }
}

function mutateBindingSqlite<R>(
  db: SqliteHostDatabase,
  bindingId: string,
  transition: (current: ProjectBindingAuthoritativeView | undefined) => BindingMutation<R>,
): R {
  return db.transaction((transaction) => {
    const row = transaction
      .select()
      .from(sqlite.projectBindings)
      .where(eq(sqlite.projectBindings.bindingId, bindingId))
      .get();
    const current = row ? bindingView(row) : undefined;
    const mutation = transition(current);
    assertExpectedGeneration(current?.generation, mutation.expectedGeneration);
    if (mutation.next) {
      if (current) {
        transaction
          .update(sqlite.projectBindings)
          .set(bindingRow(mutation.next))
          .where(
            and(
              eq(sqlite.projectBindings.bindingId, bindingId),
              eq(sqlite.projectBindings.generation, current.generation),
            ),
          )
          .run();
      } else {
        transaction.insert(sqlite.projectBindings).values(bindingRow(mutation.next)).run();
      }
    }
    if (mutation.activity) {
      transaction
        .insert(sqlite.operatorActivity)
        .values(
          activityValues(mutation.activity, mutation.next?.updatedAt ?? new Date().toISOString()),
        )
        .run();
    }
    return mutation.value;
  });
}

async function mutateBindingPostgres<R>(
  db: PostgresHostDatabase,
  bindingId: string,
  transition: (current: ProjectBindingAuthoritativeView | undefined) => BindingMutation<R>,
): Promise<R> {
  return await db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["project-binding", bindingId])}, 0))`,
    );
    const [row] = await transaction
      .select()
      .from(postgres.projectBindings)
      .where(eq(postgres.projectBindings.bindingId, bindingId))
      .for("update")
      .limit(1);
    const current = row ? bindingView(row) : undefined;
    const mutation = transition(current);
    assertExpectedGeneration(current?.generation, mutation.expectedGeneration);
    if (mutation.next) {
      if (current) {
        await transaction
          .update(postgres.projectBindings)
          .set(bindingRow(mutation.next))
          .where(
            and(
              eq(postgres.projectBindings.bindingId, bindingId),
              eq(postgres.projectBindings.generation, current.generation),
            ),
          );
      } else {
        await transaction.insert(postgres.projectBindings).values(bindingRow(mutation.next));
      }
    }
    if (mutation.activity) {
      await transaction
        .insert(postgres.operatorActivity)
        .values(
          activityValues(mutation.activity, mutation.next?.updatedAt ?? new Date().toISOString()),
        );
    }
    return mutation.value;
  });
}

function bindingRow(view: ProjectBindingAuthoritativeView) {
  return {
    bindingId: view.bindingId,
    sessionId: view.sessionId,
    projectFingerprint: view.projectFingerprint,
    projectRoot: view.projectRoot,
    serverProjectRoot: view.serverProjectRoot,
    ownerNodeId: view.ownerNodeId,
    generation: view.generation,
    revision: view.revision,
    state: view.state,
    syncState: view.syncState,
    readiness: view.readiness,
    active: view.active,
    lastHeartbeatAt: view.lastHeartbeatAt,
    expiresAt: view.expiresAt,
    quarantinedAt: view.quarantinedAt ?? null,
    quarantineReason: view.quarantineReason ?? null,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

function bindingView(value: unknown): ProjectBindingAuthoritativeView {
  if (
    !isRecord(value) ||
    !hasBindingStringFields(value) ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision !== value.generation ||
    !isProjectBindingState(value.state) ||
    !isProjectBindingSyncState(value.syncState) ||
    !isProjectBindingReadiness(value.readiness) ||
    typeof value.active !== "boolean" ||
    (value.quarantinedAt !== undefined &&
      value.quarantinedAt !== null &&
      typeof value.quarantinedAt !== "string") ||
    (value.quarantineReason !== undefined &&
      value.quarantineReason !== null &&
      value.quarantineReason !== "owner_lost")
  ) {
    throw new CapletsError("INTERNAL_ERROR", "Persisted Project Binding metadata is invalid.");
  }
  const view: ProjectBindingAuthoritativeView = {
    bindingId: value.bindingId,
    sessionId: value.sessionId,
    projectFingerprint: value.projectFingerprint,
    projectRoot: value.projectRoot,
    serverProjectRoot: value.serverProjectRoot,
    ownerNodeId: value.ownerNodeId,
    generation: value.generation,
    revision: value.revision,
    state: value.state,
    syncState: value.syncState,
    readiness: value.readiness,
    active: value.active,
    lastHeartbeatAt: value.lastHeartbeatAt,
    expiresAt: value.expiresAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (typeof value.quarantinedAt === "string") view.quarantinedAt = value.quarantinedAt;
  if (value.quarantineReason === "owner_lost") view.quarantineReason = value.quarantineReason;
  return view;
}

function requiredBindingView(
  view: ProjectBindingAuthoritativeView | undefined,
  bindingId: string,
): ProjectBindingAuthoritativeView {
  if (!view) {
    throw new CapletsError("CONFIG_NOT_FOUND", `Project Binding ${bindingId} was not found.`);
  }
  return view;
}

function readinessFor(
  state: ProjectBindingState,
  syncState: ProjectBindingSyncState,
): "not_ready" | "ready" {
  return state === "ready" && syncState === "idle" ? "ready" : "not_ready";
}

function assertCurrentOwner(view: ProjectBindingAuthoritativeView, ownerNodeId: string): void {
  if (view.ownerNodeId !== ownerNodeId) {
    throw new CapletsError("AUTH_FAILED", "Project Binding lease belongs to another host node.");
  }
}

function assertExpectedGeneration(
  currentGeneration: number | undefined,
  expectedGeneration: number | undefined,
): void {
  if (expectedGeneration === undefined || currentGeneration === expectedGeneration) return;
  throw new CapletsError(
    "REQUEST_INVALID",
    "Authoritative Project Binding changed after it was read; reload and retry.",
    {
      kind: "stale_generation",
      expectedGeneration,
      currentGeneration: currentGeneration ?? 0,
    },
  );
}

function checkedLeaseTtl(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new CapletsError("REQUEST_INVALID", "Project Binding lease TTL must be positive.");
  }
  return value;
}

function requireIdentity(value: string, field: string): string {
  if (!value.trim()) {
    throw new CapletsError("REQUEST_INVALID", `${field} must be a non-empty string.`);
  }
  return value;
}

function activityValues(activity: BindingActivity, timestamp: string) {
  return {
    activityKey: randomUUID(),
    operatorClientId: activity.operatorClientId,
    action: activity.action,
    targetKind: activity.targetKind,
    targetKey: activity.targetKey,
    outcome: "succeeded",
    metadata: activity.metadata,
    createdAt: timestamp,
  };
}

function hasBindingStringFields(value: Record<string, unknown>): value is Record<
  string,
  unknown
> & {
  bindingId: string;
  sessionId: string;
  projectFingerprint: string;
  projectRoot: string;
  serverProjectRoot: string;
  ownerNodeId: string;
  lastHeartbeatAt: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
} {
  return [
    "bindingId",
    "sessionId",
    "projectFingerprint",
    "projectRoot",
    "serverProjectRoot",
    "ownerNodeId",
    "lastHeartbeatAt",
    "expiresAt",
    "createdAt",
    "updatedAt",
  ].every((field) => typeof value[field] === "string" && value[field].length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
