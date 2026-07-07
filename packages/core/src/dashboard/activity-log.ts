import { Buffer } from "node:buffer";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomToken } from "../remote/pairing";
import type { RemoteClientRole } from "../remote/server-credentials";

export type DashboardActivityAction =
  | "dashboard_login_completed"
  | "dashboard_logout"
  | "pending_login_approved"
  | "pending_login_denied"
  | "remote_client_revoked"
  | "remote_client_role_changed"
  | "catalog_installed"
  | "catalog_updated"
  | "vault_set"
  | "vault_deleted"
  | "vault_grant_added"
  | "vault_grant_revoked"
  | "vault_value_revealed"
  | "runtime_restart_requested";

export type DashboardActivityOutcome = "success" | "failure";

export type DashboardActivityTarget = {
  type: "dashboard_session" | "pending_login" | "remote_client" | "catalog" | "vault" | "runtime";
  id: string;
  label?: string | undefined;
};

export type DashboardActivityMetadata = Record<string, string | number | boolean | null>;

export type DashboardActivityEntry = {
  id: string;
  createdAt: string;
  actorClientId: string;
  action: DashboardActivityAction;
  outcome: DashboardActivityOutcome;
  target: DashboardActivityTarget;
  metadata?: DashboardActivityMetadata | undefined;
};

export type AppendDashboardActivityInput = {
  actorClientId: string;
  action: DashboardActivityAction;
  outcome?: DashboardActivityOutcome | undefined;
  target: DashboardActivityTarget;
  metadata?: DashboardActivityMetadata | undefined;
  now?: Date | undefined;
};

export type ListDashboardActivityInput = {
  limit?: number | undefined;
  after?: string | undefined;
  action?: DashboardActivityAction | undefined;
};

const ACTIVITY_FILE = "dashboard-activity.jsonl";
const MAX_ACTIVITY_ENTRIES = 10_000;
const MAX_ACTIVITY_BYTES = 10 * 1024 * 1024;
const DEFAULT_ACTIVITY_LIMIT = 100;
const MAX_ACTIVITY_LIMIT = 500;

export class DashboardActivityLog {
  readonly dir: string;

  constructor(options: { dir: string }) {
    this.dir = options.dir;
  }

  append(input: AppendDashboardActivityInput): DashboardActivityEntry {
    const entry = sanitizeActivityEntry({
      id: `act_${randomToken(12)}`,
      createdAt: (input.now ?? new Date()).toISOString(),
      actorClientId: input.actorClientId,
      action: input.action,
      outcome: input.outcome ?? "success",
      target: input.target,
      ...(input.metadata ? { metadata: sanitizeMetadata(input.metadata) } : {}),
    });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(this.path(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    const entries = this.readEntries();
    const retained = retainBoundedEntries(entries);
    if (retained.length !== entries.length) this.writeEntries(retained);
    return entry;
  }

  list(input: ListDashboardActivityInput = {}): {
    entries: DashboardActivityEntry[];
    nextCursor?: string | undefined;
  } {
    const limit = boundedLimit(input.limit);
    let entries = this.readEntries();
    if (input.after) {
      const index = entries.findIndex((entry) => entry.id === input.after);
      if (index >= 0) entries = entries.slice(0, index);
    }
    if (input.action) entries = entries.filter((entry) => entry.action === input.action);
    const newest = entries.slice().reverse();
    const page = newest.slice(0, limit);
    const nextCursor = newest.length > limit ? page.at(-1)?.id : undefined;
    return { entries: page, ...(nextCursor ? { nextCursor } : {}) };
  }

  private readEntries(): DashboardActivityEntry[] {
    const path = this.path();
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return [];
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => parseActivityEntry(line));
  }

  private writeEntries(entries: DashboardActivityEntry[]): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = this.path();
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", {
      mode: 0o600,
    });
    renameSync(tempPath, path);
  }

  private path(): string {
    return join(this.dir, ACTIVITY_FILE);
  }
}

export function roleChangeMetadata(
  fromRole: RemoteClientRole,
  toRole: RemoteClientRole,
): DashboardActivityMetadata {
  return { fromRole, toRole };
}

function retainBoundedEntries(entries: DashboardActivityEntry[]): DashboardActivityEntry[] {
  let retained = entries.slice(-MAX_ACTIVITY_ENTRIES);
  while (serializedSize(retained) > MAX_ACTIVITY_BYTES && retained.length > 0) {
    retained = retained.slice(Math.max(1, Math.ceil(retained.length * 0.1)));
  }
  return retained;
}

function serializedSize(entries: DashboardActivityEntry[]): number {
  return Buffer.byteLength(entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

function boundedLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined) return DEFAULT_ACTIVITY_LIMIT;
  return Math.min(MAX_ACTIVITY_LIMIT, Math.max(1, Math.trunc(limit)));
}

function parseActivityEntry(line: string): DashboardActivityEntry[] {
  try {
    return [sanitizeActivityEntry(JSON.parse(line) as Partial<DashboardActivityEntry>)];
  } catch {
    return [];
  }
}

function sanitizeActivityEntry(entry: Partial<DashboardActivityEntry>): DashboardActivityEntry {
  if (
    typeof entry.id !== "string" ||
    typeof entry.createdAt !== "string" ||
    typeof entry.actorClientId !== "string" ||
    !isActivityAction(entry.action) ||
    !isActivityOutcome(entry.outcome) ||
    !isActivityTarget(entry.target)
  ) {
    throw new Error("Invalid dashboard activity entry.");
  }
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    actorClientId: entry.actorClientId,
    action: entry.action,
    outcome: entry.outcome,
    target: entry.target,
    ...(entry.metadata ? { metadata: sanitizeMetadata(entry.metadata) } : {}),
  };
}

function sanitizeMetadata(metadata: DashboardActivityMetadata): DashboardActivityMetadata {
  return Object.fromEntries(
    Object.entries(metadata).filter(
      ([key, value]) => isSafeMetadataKey(key) && isSafeMetadataValue(value),
    ),
  );
}

function isSafeMetadataValue(value: unknown): value is string | number | boolean | null {
  if (value === null || typeof value === "number" || typeof value === "boolean") return true;
  if (typeof value !== "string") return false;
  if (/(cap_remote_access_|cap_remote_refresh_|cap_pending_|cap_login_)/u.test(value)) return false;
  return value.length <= 256;
}

function isActivityAction(value: unknown): value is DashboardActivityAction {
  return (
    value === "dashboard_login_completed" ||
    value === "dashboard_logout" ||
    value === "pending_login_approved" ||
    value === "pending_login_denied" ||
    value === "remote_client_revoked" ||
    value === "remote_client_role_changed" ||
    value === "catalog_installed" ||
    value === "catalog_updated" ||
    value === "vault_set" ||
    value === "vault_deleted" ||
    value === "vault_grant_added" ||
    value === "vault_grant_revoked" ||
    value === "vault_value_revealed" ||
    value === "runtime_restart_requested"
  );
}

function isActivityOutcome(value: unknown): value is DashboardActivityOutcome {
  return value === "success" || value === "failure";
}

function isActivityTarget(value: unknown): value is DashboardActivityTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<DashboardActivityTarget>;
  return (
    (target.type === "dashboard_session" ||
      target.type === "pending_login" ||
      target.type === "remote_client" ||
      target.type === "catalog" ||
      target.type === "vault" ||
      target.type === "runtime") &&
    typeof target.id === "string" &&
    (target.label === undefined || typeof target.label === "string")
  );
}

function isSafeMetadataKey(key: string): boolean {
  return !/(secret|token|credential|bearer|refresh|value|payload|argument|output|path)/iu.test(key);
}
