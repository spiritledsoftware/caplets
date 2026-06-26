import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CapletsError, toSafeError } from "../errors";

export const CAPLETS_LOCKFILE_VERSION = 1;

export type CapletsLockSource =
  | {
      type: "git";
      repository: string;
      path: string;
      trackedRef?: string | undefined;
      resolvedRevision?: string | undefined;
      portability: "portable" | "non_portable";
    }
  | {
      type: "local";
      path: string;
      gitRepository?: string | undefined;
      gitRevision?: string | undefined;
      dirty?: boolean | undefined;
      portability: "portable" | "non_portable";
    };

export type CapletsLockRiskSummary = {
  backendFamilies: string[];
  safety: "standard" | "mutating_saas" | "local_control" | "unknown";
  projectBindingRequired: boolean;
  authScopes?: string[] | undefined;
  runtimeFeatures?: string[] | undefined;
  mutating: boolean;
  destructive: boolean;
  bodyHash?: string | undefined;
  referenceHash?: string | undefined;
};

export type CapletsLockEntry = {
  id: string;
  destination: string;
  kind: "file" | "directory";
  source: CapletsLockSource;
  installedHash: string;
  installedAt: string;
  updatedAt: string;
  risk: CapletsLockRiskSummary;
};

export type CapletsLockfile = {
  version: typeof CAPLETS_LOCKFILE_VERSION;
  entries: CapletsLockEntry[];
};

export function readCapletsLockfile(path: string): CapletsLockfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CapletsError("CONFIG_INVALID", `Caplets lockfile at ${path} is not valid JSON`, {
      cause: toSafeError(error),
    });
  }
  return parseCapletsLockfile(parsed, path);
}

export function writeCapletsLockfile(path: string, lockfile: CapletsLockfile): void {
  const validated = parseCapletsLockfile(lockfile, path);
  const stable: CapletsLockfile = {
    version: CAPLETS_LOCKFILE_VERSION,
    entries: [...validated.entries].sort((left, right) => left.id.localeCompare(right.id)),
  };
  const parent = dirname(path);
  const temporary = join(parent, `${path.split(/[\\/]/).at(-1) ?? "caplets.lock.json"}.tmp`);
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(stable, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup; the final lockfile is protected by rename.
    }
    throw new CapletsError("CONFIG_INVALID", `Could not write Caplets lockfile at ${path}`, {
      cause: toSafeError(error),
    });
  }
}

export function parseCapletsLockfile(value: unknown, path = "Caplets lockfile"): CapletsLockfile {
  if (!isRecord(value)) {
    throw new CapletsError("CONFIG_INVALID", `${path} must be a JSON object`);
  }
  if (value.version !== CAPLETS_LOCKFILE_VERSION) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `${path} uses unsupported Caplets lockfile version ${String(value.version)}`,
    );
  }
  if (!Array.isArray(value.entries)) {
    throw new CapletsError("CONFIG_INVALID", `${path} entries must be an array`);
  }

  const seen = new Set<string>();
  const entries = value.entries.map((entry, index) =>
    parseLockEntry(entry, `${path} entry ${index}`),
  );
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      throw new CapletsError("CONFIG_EXISTS", `${path} contains duplicate Caplet ID ${entry.id}`);
    }
    seen.add(entry.id);
  }

  return { version: CAPLETS_LOCKFILE_VERSION, entries };
}

export function validateLockfileDestination(capletsRoot: string, destination: string): string {
  if (isAbsolute(destination)) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Lockfile destination ${destination} must be relative to the selected Caplets root`,
    );
  }
  const normalizedRoot = resolve(capletsRoot);
  const resolved = resolve(normalizedRoot, destination);
  const relativeDestination = relative(normalizedRoot, resolved);
  if (
    relativeDestination === "" ||
    relativeDestination.startsWith("..") ||
    isAbsolute(relativeDestination)
  ) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Lockfile destination ${destination} escapes the selected Caplets root`,
    );
  }
  rejectSymlinkedExistingPath(normalizedRoot, resolved);
  return resolved;
}

function parseLockEntry(value: unknown, label: string): CapletsLockEntry {
  if (!isRecord(value)) throw new CapletsError("CONFIG_INVALID", `${label} must be an object`);
  const id = requireString(value.id, `${label}.id`);
  const destination = requireString(value.destination, `${label}.destination`);
  const kind = parseEnum(value.kind, ["file", "directory"], `${label}.kind`);
  const source = parseLockSource(value.source, `${label}.source`);
  const installedHash = requireString(value.installedHash, `${label}.installedHash`);
  const installedAt = requireString(value.installedAt, `${label}.installedAt`);
  const updatedAt = requireString(value.updatedAt, `${label}.updatedAt`);
  const risk = parseRiskSummary(value.risk, `${label}.risk`);
  if (isAbsolute(destination) || destination.split(/[\\/]/).includes("..")) {
    throw new CapletsError("CONFIG_INVALID", `${label}.destination must be a safe relative path`);
  }
  return { id, destination, kind, source, installedHash, installedAt, updatedAt, risk };
}

function parseLockSource(value: unknown, label: string): CapletsLockSource {
  if (!isRecord(value)) throw new CapletsError("CONFIG_INVALID", `${label} must be an object`);
  const type = parseEnum(value.type, ["git", "local"], `${label}.type`);
  if (type === "git") {
    const repository = requireCredentialFreeSource(
      requireString(value.repository, `${label}.repository`),
      label,
    );
    return {
      type,
      repository,
      path: requireString(value.path, `${label}.path`),
      trackedRef: optionalString(value.trackedRef, `${label}.trackedRef`),
      resolvedRevision: optionalString(value.resolvedRevision, `${label}.resolvedRevision`),
      portability: parseEnum(
        value.portability,
        ["portable", "non_portable"],
        `${label}.portability`,
      ),
    };
  }
  return {
    type,
    path: requireString(value.path, `${label}.path`),
    gitRepository:
      value.gitRepository === undefined
        ? undefined
        : requireCredentialFreeSource(
            requireString(value.gitRepository, `${label}.gitRepository`),
            label,
          ),
    gitRevision: optionalString(value.gitRevision, `${label}.gitRevision`),
    dirty: value.dirty === undefined ? undefined : requireBoolean(value.dirty, `${label}.dirty`),
    portability: parseEnum(value.portability, ["portable", "non_portable"], `${label}.portability`),
  };
}

function parseRiskSummary(value: unknown, label: string): CapletsLockRiskSummary {
  if (!isRecord(value)) throw new CapletsError("CONFIG_INVALID", `${label} must be an object`);
  return {
    backendFamilies: requireStringArray(value.backendFamilies, `${label}.backendFamilies`),
    safety: parseEnum(
      value.safety,
      ["standard", "mutating_saas", "local_control", "unknown"],
      `${label}.safety`,
    ),
    projectBindingRequired: requireBoolean(
      value.projectBindingRequired,
      `${label}.projectBindingRequired`,
    ),
    authScopes:
      value.authScopes === undefined
        ? undefined
        : requireStringArray(value.authScopes, `${label}.authScopes`),
    runtimeFeatures:
      value.runtimeFeatures === undefined
        ? undefined
        : requireStringArray(value.runtimeFeatures, `${label}.runtimeFeatures`),
    mutating: requireBoolean(value.mutating, `${label}.mutating`),
    destructive: requireBoolean(value.destructive, `${label}.destructive`),
    bodyHash: optionalString(value.bodyHash, `${label}.bodyHash`),
    referenceHash: optionalString(value.referenceHash, `${label}.referenceHash`),
  };
}

function requireCredentialFreeSource(source: string, label: string): string {
  try {
    const url = new URL(source);
    if (url.username || url.password) {
      throw new CapletsError("CONFIG_INVALID", `${label} must not contain credentials`);
    }
  } catch (error) {
    if (error instanceof CapletsError) throw error;
    // Local scp-like Git syntax is allowed, but credential-shaped URLs are not.
    if (/^[^@\s]+:[^@\s]+@/.test(source) || /^[a-z][a-z0-9+.-]*:\/\/[^/\s]+@/i.test(source)) {
      throw new CapletsError("CONFIG_INVALID", `${label} must not contain credentials`);
    }
  }
  return source;
}

function rejectSymlinkedExistingPath(root: string, destination: string): void {
  let current = root;
  const relativePath = relative(root, destination);
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) return;
    const stats = lstatSync(current);
    if (stats.isSymbolicLink()) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Lockfile destination ${destination} resolves through symlink ${current}`,
      );
    }
    const real = realpathSync(current);
    if (real !== root && !real.startsWith(`${root}${sep}`)) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Lockfile destination ${destination} resolves outside the selected Caplets root`,
      );
    }
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CapletsError("CONFIG_INVALID", `${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireString(value, label);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new CapletsError("CONFIG_INVALID", `${label} must be a boolean`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new CapletsError("CONFIG_INVALID", `${label} must be an array of strings`);
  }
  return value;
}

function parseEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new CapletsError("CONFIG_INVALID", `${label} must be one of ${allowed.join(", ")}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
