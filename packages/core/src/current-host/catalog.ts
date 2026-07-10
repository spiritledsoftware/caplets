import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverCapletFiles } from "../caplet-files";
import type { CapletConfig } from "../config";
import { defaultCapletsLockfilePath } from "../config";
import { CapletsError } from "../errors";
import {
  catalogAuthRequiredFromFrontmatter,
  catalogIconFromFrontmatter,
  catalogMutatesExternalStateFromFrontmatter,
  catalogProjectBindingRequiredFromFrontmatter,
  catalogSetupRequiredFromFrontmatter,
  catalogStringArrayFromFrontmatter,
  catalogStringFromFrontmatter,
  catalogUsesLocalControlFromFrontmatter,
  catalogWorkflowSummaryFromFrontmatter,
  createCatalogEntry,
  normalizeCatalogSourceIdentity,
  readCatalogCapletFrontmatterFromMarkdown,
  type CatalogEntry,
  type CatalogSourceIdentity,
} from "../catalog";

export type CurrentHostCatalogContext = {
  globalLockfilePath?: string | undefined;
};

export type CurrentHostInstalledCapletProjection = {
  id: string;
  name: string;
  description: string;
  backend: string;
  exposure: CapletConfig["exposure"];
  setupRequired: boolean;
  authRequired: boolean;
  projectBindingRequired: boolean;
  source?: string | undefined;
  updateState: "unknown" | "locked";
  setupActions: CurrentHostSetupAction[];
};

export type CurrentHostSetupAction = {
  kind:
    | "auth"
    | "vault"
    | "project_binding"
    | "backend_check"
    | "exposure_validation"
    | "code_mode";
  label: string;
  required: boolean;
};

export type CurrentHostInstalledCatalogCaplet = {
  id: string;
  source: string;
  destination: string;
  kind: "file" | "directory";
  hash?: string | undefined;
  status?: "installed" | "restored" | "updated" | "noop" | undefined;
  lockfile?: string | undefined;
  catalogIndexing?: unknown;
};

export type CurrentHostCatalogInstallResult = {
  installed: CurrentHostInstalledCatalogCaplet[];
  setupActions: CurrentHostSetupAction[];
};

export function currentHostInstalledCaplets(
  caplets: CapletConfig[],
  context: CurrentHostCatalogContext,
): CurrentHostInstalledCapletProjection[] {
  const lockEntries = safeLockEntries(lockfilePath(context));
  return caplets
    .map((caplet) => {
      const lock = lockEntries.get(caplet.server);
      return {
        id: caplet.server,
        name: caplet.name,
        description: caplet.description,
        backend: caplet.backend,
        exposure: caplet.exposure,
        setupRequired: Boolean(caplet.setup),
        authRequired: authRequired(caplet),
        projectBindingRequired: Boolean(caplet.projectBinding),
        ...(lock
          ? {
              source:
                lock.source?.type === "git" && lock.source.repository
                  ? lock.source.repository
                  : "local",
            }
          : {}),
        updateState: lock ? ("locked" as const) : ("unknown" as const),
        setupActions: setupActionsForFlags({
          setupRequired: Boolean(caplet.setup),
          authRequired: authRequired(caplet),
          projectBindingRequired: Boolean(caplet.projectBinding),
        }),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function currentHostCatalogSearch(input: {
  source: string;
  query?: string | undefined;
  limit?: number | undefined;
}): { entries: CatalogEntry[] } {
  const entries = catalogEntriesFromSource(input.source);
  const query = input.query?.trim().toLowerCase();
  const filtered = query
    ? entries.filter((entry) =>
        [entry.id, entry.name, entry.description, ...entry.tags]
          .join("\n")
          .toLowerCase()
          .includes(query),
      )
    : entries;
  return { entries: filtered.slice(0, boundedLimit(input.limit)) };
}

export function currentHostCatalogDetail(input: { source: string; capletId: string }): {
  entry: CatalogEntry;
  setupActions: CurrentHostSetupAction[];
  projectScopedInstallAvailable: false;
} {
  const entry = catalogEntriesFromSource(input.source).find(
    (candidate) => candidate.id === input.capletId,
  );
  if (!entry)
    throw new CapletsError("CONFIG_NOT_FOUND", `Catalog Caplet ${input.capletId} not found.`);
  return {
    entry,
    setupActions: setupActionsForEntry(entry),
    projectScopedInstallAvailable: false,
  };
}

export function currentHostCatalogUpdateReadiness(input: { context: CurrentHostCatalogContext }): {
  updates: Array<{ id: string; status: "locked"; risk: unknown }>;
} {
  return {
    updates: [...safeLockEntries(lockfilePath(input.context)).values()].map((entry) => ({
      id: entry.id,
      status: "locked" as const,
      risk: entry.risk,
    })),
  };
}

export function currentHostSetupActionsForInstalled(
  source: string,
  capletId: string,
): CurrentHostSetupAction[] {
  try {
    return setupActionsForEntry(currentHostCatalogDetail({ source, capletId }).entry);
  } catch {
    return [];
  }
}

const officialCatalogRepository = "spiritledsoftware/caplets";

export function currentHostCatalogInstallSource(source: string): string {
  return source.trim() === "official" ? officialCatalogRepository : source;
}

type ResolvedCurrentHostCatalogSource = {
  root: string;
  source: CatalogSourceIdentity;
  trustLevel: "official" | "community";
};

type LockEntry = { id: string; source?: { type?: string; repository?: string }; risk?: unknown };

function catalogEntriesFromSource(sourceInput: string): CatalogEntry[] {
  const resolvedSource = resolveCurrentHostCatalogSource(sourceInput);
  const sourceRoot = join(resolvedSource.root, "caplets");
  const files = discoverCapletFiles(sourceRoot);
  return files
    .map(({ id, path }) => {
      const contentMarkdown = readFileSync(path, "utf8");
      const frontmatter = readCatalogCapletFrontmatterFromMarkdown(contentMarkdown);
      const sourcePath = sourceRelativePath(resolvedSource.root, path);
      return createCatalogEntry({
        id,
        name: catalogStringFromFrontmatter(frontmatter.name) ?? id,
        description:
          catalogStringFromFrontmatter(frontmatter.description) ?? `Catalog Caplet ${id}.`,
        source: resolvedSource.source,
        sourcePath,
        trustLevel: resolvedSource.trustLevel,
        contentMarkdown,
        icon: catalogIconFromFrontmatter(frontmatter, {
          id,
          source: resolvedSource.source,
          sourcePath,
          trustLevel: resolvedSource.trustLevel,
        }),
        tags: catalogStringArrayFromFrontmatter(frontmatter.tags),
        useWhen: catalogStringFromFrontmatter(frontmatter.useWhen),
        avoidWhen: catalogStringFromFrontmatter(frontmatter.avoidWhen),
        setupRequired: catalogSetupRequiredFromFrontmatter(frontmatter),
        authRequired: catalogAuthRequiredFromFrontmatter(frontmatter),
        projectBindingRequired: catalogProjectBindingRequiredFromFrontmatter(frontmatter),
        workflow: catalogWorkflowSummaryFromFrontmatter(frontmatter, {
          kind: "code_mode",
          label: "Code Mode",
        }),
        mutatesExternalState: catalogMutatesExternalStateFromFrontmatter(frontmatter),
        localControl: catalogUsesLocalControlFromFrontmatter(frontmatter),
      });
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function resolveCurrentHostCatalogSource(sourceInput: string): ResolvedCurrentHostCatalogSource {
  if (sourceInput.trim() === "official") {
    const source = normalizeCatalogSourceIdentity(officialCatalogRepository);
    if (!source.eligible) {
      throw new CapletsError("CONFIG_INVALID", "Official catalog source is invalid.");
    }
    return { root: officialCatalogRoot(), source: source.source, trustLevel: "official" };
  }

  const source = normalizeCatalogSourceIdentity(sourceInput);
  return {
    root: sourceInput,
    source: source.eligible ? source.source : localCatalogSource(),
    trustLevel:
      source.eligible && source.source.repository === officialCatalogRepository
        ? "official"
        : "community",
  };
}

function officialCatalogRoot(): string {
  for (const start of [process.cwd(), dirname(fileURLToPath(import.meta.url))]) {
    const found = findRepoRootWithCaplets(start);
    if (found) return found;
  }
  return process.cwd();
}

function findRepoRootWithCaplets(start: string): string | undefined {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, "caplets")) && existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function localCatalogSource(): CatalogSourceIdentity {
  return {
    provider: "github",
    owner: "local",
    repo: "source",
    repository: "local/source",
    canonicalUrl: "https://github.com/local/source",
  };
}

function sourceRelativePath(source: string, path: string): string {
  const capletsRoot = join(source, "caplets");
  return path.startsWith(capletsRoot)
    ? path.slice(capletsRoot.length + 1).replace(/\\/gu, "/")
    : path;
}

function setupActionsForEntry(entry: CatalogEntry): CurrentHostSetupAction[] {
  return setupActionsForFlags({
    setupRequired: entry.setupReadiness === "required",
    authRequired: entry.authReadiness === "required",
    projectBindingRequired: entry.projectBindingReadiness === "required",
  });
}

function setupActionsForFlags(input: {
  setupRequired: boolean;
  authRequired: boolean;
  projectBindingRequired: boolean;
}): CurrentHostSetupAction[] {
  return [
    ...(input.authRequired
      ? [{ kind: "auth" as const, label: "Connect required auth", required: true }]
      : []),
    ...(input.setupRequired
      ? [{ kind: "backend_check" as const, label: "Run setup and backend checks", required: true }]
      : []),
    ...(input.projectBindingRequired
      ? [{ kind: "project_binding" as const, label: "Attach a Project Binding", required: true }]
      : []),
    { kind: "code_mode", label: "Review Code Mode workflow", required: false },
    { kind: "exposure_validation", label: "Validate exposed tools", required: false },
  ];
}

function authRequired(caplet: CapletConfig): boolean {
  const auth = "auth" in caplet ? caplet.auth : undefined;
  return Boolean(auth) && auth?.type !== "none";
}

function lockfilePath(context: CurrentHostCatalogContext): string {
  return context.globalLockfilePath ?? defaultCapletsLockfilePath();
}

function safeLockEntries(path: string): Map<string, LockEntry> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries?: LockEntry[] };
    return new Map(
      (parsed.entries ?? [])
        .filter((entry) => typeof entry.id === "string")
        .map((entry) => [entry.id, entry]),
    );
  } catch {
    return new Map();
  }
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 50;
  return Math.min(100, Math.max(1, Math.trunc(limit)));
}
