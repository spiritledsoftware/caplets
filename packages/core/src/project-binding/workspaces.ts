import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import type {
  ProjectBindingLease,
  ProjectBindingSetupReceipt,
  ProjectBindingWorkspaceMetadata,
} from "./types";

const DEFAULT_STALE_LEASE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_INACTIVE_WORKSPACE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SOFT_DISK_CAP_BYTES = 10 * 1024 * 1024 * 1024;

type PathEnv = Partial<Record<"XDG_STATE_HOME" | "LOCALAPPDATA", string>>;

export type ProjectBindingWorkspaceRootOptions = {
  env?: PathEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  root?: string;
};

export type ProjectBindingWorkspacePaths = {
  projectFingerprint: string;
  root: string;
  project: string;
  metadata: string;
  leases: string;
  setup: string;
  setupReceipts: string;
  lease(bindingId: string): string;
};

export type ProjectBindingWorkspaceStoreOptions = ProjectBindingWorkspaceRootOptions & {
  now?: () => Date;
  staleLeaseTtlMs?: number;
  inactiveWorkspaceTtlMs?: number;
  softDiskCapBytes?: number;
  workspaceSizeBytes?: (paths: ProjectBindingWorkspacePaths) => number;
};

export type EnsureProjectBindingWorkspaceInput = {
  projectFingerprint: string;
  projectRoot: string;
  lastActiveAt?: string;
  createdAt?: string;
};

export type ProjectBindingCleanupResult = {
  expiredLeases: string[];
  deletedWorkspaces: string[];
  retainedWorkspaces: string[];
};

export function projectBindingWorkspaceRoot(
  options: ProjectBindingWorkspaceRootOptions = {},
): string {
  if (options.root) return options.root;

  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? homedir();
  const env = options.env ?? process.env;
  if (platform === "win32") {
    const base =
      env.LOCALAPPDATA && win32.isAbsolute(env.LOCALAPPDATA)
        ? env.LOCALAPPDATA
        : win32.join(home, "AppData", "Local");
    return win32.join(base, "Caplets", "State", "workspaces");
  }

  const base =
    env.XDG_STATE_HOME && posix.isAbsolute(env.XDG_STATE_HOME)
      ? env.XDG_STATE_HOME
      : posix.join(home, ".local", "state");
  return posix.join(base, "caplets", "workspaces");
}

export function projectBindingWorkspacePaths(
  projectFingerprint: string,
  options: ProjectBindingWorkspaceRootOptions = {},
): ProjectBindingWorkspacePaths {
  assertPathSegment(projectFingerprint, "project fingerprint");
  const pathJoin = pathJoinFor(options.platform);
  const root = pathJoin(projectBindingWorkspaceRoot(options), projectFingerprint);
  const leases = pathJoin(root, "leases");
  const setup = pathJoin(root, "setup");
  return {
    projectFingerprint,
    root,
    project: pathJoin(root, "project"),
    metadata: pathJoin(root, "metadata.json"),
    leases,
    setup,
    setupReceipts: pathJoin(setup, "receipts.json"),
    lease(bindingId: string) {
      assertPathSegment(bindingId, "binding ID");
      return pathJoin(leases, `${bindingId}.json`);
    },
  };
}

export class ProjectBindingWorkspaceStore {
  private readonly root: string;
  private readonly now: () => Date;
  private readonly staleLeaseTtlMs: number;
  private readonly inactiveWorkspaceTtlMs: number;
  private readonly softDiskCapBytes: number;
  private readonly workspaceSizeBytes: (paths: ProjectBindingWorkspacePaths) => number;

  constructor(private readonly options: ProjectBindingWorkspaceStoreOptions = {}) {
    this.root = projectBindingWorkspaceRoot(options);
    this.now = options.now ?? (() => new Date());
    this.staleLeaseTtlMs = options.staleLeaseTtlMs ?? DEFAULT_STALE_LEASE_TTL_MS;
    this.inactiveWorkspaceTtlMs =
      options.inactiveWorkspaceTtlMs ?? DEFAULT_INACTIVE_WORKSPACE_TTL_MS;
    this.softDiskCapBytes = options.softDiskCapBytes ?? DEFAULT_SOFT_DISK_CAP_BYTES;
    this.workspaceSizeBytes = options.workspaceSizeBytes ?? ((paths) => directorySize(paths.root));
  }

  paths(projectFingerprint: string): ProjectBindingWorkspacePaths {
    return projectBindingWorkspacePaths(projectFingerprint, { ...this.options, root: this.root });
  }

  async ensureWorkspace(
    input: EnsureProjectBindingWorkspaceInput,
  ): Promise<ProjectBindingWorkspacePaths> {
    const paths = this.paths(input.projectFingerprint);
    const now = this.now().toISOString();
    const existing = this.readMetadata(input.projectFingerprint);
    const metadata: ProjectBindingWorkspaceMetadata = {
      projectFingerprint: input.projectFingerprint,
      projectRoot: input.projectRoot,
      createdAt: input.createdAt ?? existing?.createdAt ?? now,
      lastActiveAt: input.lastActiveAt ?? now,
    };

    mkdirSync(paths.project, { recursive: true });
    mkdirSync(paths.leases, { recursive: true });
    mkdirSync(paths.setup, { recursive: true });
    writeJson(paths.metadata, metadata);
    return paths;
  }

  async writeLease(lease: ProjectBindingLease): Promise<void> {
    const paths = this.paths(lease.projectFingerprint);
    mkdirSync(paths.leases, { recursive: true });
    writeJson(paths.lease(lease.bindingId), lease);
    if (lease.active) {
      const metadata = this.readMetadata(lease.projectFingerprint);
      if (metadata) {
        writeJson(paths.metadata, { ...metadata, lastActiveAt: lease.updatedAt });
      }
    }
  }

  async listLeases(projectFingerprint: string): Promise<ProjectBindingLease[]> {
    return this.leasesFor(this.paths(projectFingerprint)).map((entry) => entry.lease);
  }

  async writeSetupReceipts(
    projectFingerprint: string,
    receipts: ProjectBindingSetupReceipt[],
  ): Promise<void> {
    const paths = this.paths(projectFingerprint);
    mkdirSync(paths.setup, { recursive: true });
    writeJson(paths.setupReceipts, receipts);
  }

  async cleanup(): Promise<ProjectBindingCleanupResult> {
    const expiredLeases: string[] = [];
    const deletedWorkspaces: string[] = [];
    const retainedWorkspaces: string[] = [];
    const candidates: WorkspaceCandidate[] = [];

    for (const paths of this.workspacePaths()) {
      const leases = this.leasesFor(paths);
      for (const entry of leases) {
        if (
          this.isStaleLease(entry.lease) &&
          (!entry.lease.active || entry.lease.expiresAt !== undefined)
        ) {
          rmSync(entry.path, { force: true });
          expiredLeases.push(entry.path);
        }
      }

      const active = this.leasesFor(paths).some((entry) => entry.lease.active);
      if (active) {
        retainedWorkspaces.push(paths.root);
        continue;
      }

      const metadata = this.readMetadata(paths.projectFingerprint);
      const lastActiveMs = metadata
        ? Date.parse(metadata.lastActiveAt)
        : workspaceMtime(paths.root);
      const sizeBytes = this.workspaceSizeBytes(paths);
      candidates.push({ paths, lastActiveMs, sizeBytes });
    }

    for (const candidate of candidates) {
      if (this.isInactiveWorkspace(candidate.lastActiveMs)) {
        rmSync(candidate.paths.root, { recursive: true, force: true });
        deletedWorkspaces.push(candidate.paths.root);
      }
    }

    const remaining = candidates
      .filter((candidate) => !deletedWorkspaces.includes(candidate.paths.root))
      .sort((first, second) => first.lastActiveMs - second.lastActiveMs);
    let totalBytes = remaining.reduce((sum, candidate) => sum + candidate.sizeBytes, 0);
    for (const candidate of remaining) {
      if (totalBytes <= this.softDiskCapBytes) {
        retainedWorkspaces.push(candidate.paths.root);
        continue;
      }
      rmSync(candidate.paths.root, { recursive: true, force: true });
      deletedWorkspaces.push(candidate.paths.root);
      totalBytes -= candidate.sizeBytes;
    }

    return { expiredLeases, deletedWorkspaces, retainedWorkspaces };
  }

  private readMetadata(projectFingerprint: string): ProjectBindingWorkspaceMetadata | undefined {
    const path = this.paths(projectFingerprint).metadata;
    if (!existsSync(path)) return undefined;
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      return isWorkspaceMetadata(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private workspacePaths(): ProjectBindingWorkspacePaths[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.paths(entry.name));
  }

  private leasesFor(
    paths: ProjectBindingWorkspacePaths,
  ): { path: string; lease: ProjectBindingLease }[] {
    if (!existsSync(paths.leases)) return [];
    const leases: { path: string; lease: ProjectBindingLease }[] = [];
    for (const entry of readdirSync(paths.leases, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(paths.leases, entry.name);
      try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (isProjectBindingLease(value)) leases.push({ path, lease: value });
      } catch {
        // Ignore a torn or corrupt managed lease; valid leases remain reclaimable.
      }
    }
    return leases;
  }

  private isStaleLease(lease: ProjectBindingLease): boolean {
    const parsedExpiresAt = lease.expiresAt ? Date.parse(lease.expiresAt) : Number.NaN;
    const staleAt = Number.isFinite(parsedExpiresAt)
      ? parsedExpiresAt
      : Date.parse(lease.updatedAt) + this.staleLeaseTtlMs;
    return staleAt <= this.now().getTime();
  }

  private isInactiveWorkspace(lastActiveMs: number): boolean {
    return lastActiveMs + this.inactiveWorkspaceTtlMs <= this.now().getTime();
  }
}

type WorkspaceCandidate = {
  paths: ProjectBindingWorkspacePaths;
  lastActiveMs: number;
  sizeBytes: number;
};

function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function isWorkspaceMetadata(value: unknown): value is ProjectBindingWorkspaceMetadata {
  return (
    isRecord(value) &&
    typeof value.projectFingerprint === "string" &&
    typeof value.projectRoot === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.lastActiveAt === "string"
  );
}

function isProjectBindingLease(value: unknown): value is ProjectBindingLease {
  return (
    isRecord(value) &&
    typeof value.bindingId === "string" &&
    typeof value.projectFingerprint === "string" &&
    typeof value.state === "string" &&
    typeof value.active === "boolean" &&
    typeof value.updatedAt === "string" &&
    (value.expiresAt === undefined || typeof value.expiresAt === "string") &&
    (value.diagnosticCode === undefined || typeof value.diagnosticCode === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function directorySize(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  return readdirSync(path).reduce((sum, entry) => sum + directorySize(join(path, entry)), 0);
}

function workspaceMtime(path: string): number {
  return existsSync(path) ? statSync(path).mtimeMs : 0;
}

function pathJoinFor(platform = process.platform): typeof join {
  return platform === "win32" ? win32.join : join;
}

function assertPathSegment(value: string, label: string): void {
  if (
    !value ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}
