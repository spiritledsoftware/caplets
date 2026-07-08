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
import {
  dispatchRemoteCliRequest,
  type RemoteControlDispatchContext,
} from "../remote-control/dispatch";

export type DashboardCatalogContext = {
  control?: RemoteControlDispatchContext | undefined;
};

export type DashboardInstalledCaplet = {
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
  setupActions: DashboardSetupAction[];
};

export type DashboardSetupAction = {
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

export type DashboardInstalledCatalogCaplet = {
  id: string;
  source: string;
  destination: string;
  kind: "file" | "directory";
  hash?: string | undefined;
  status?: "installed" | "restored" | "updated" | "noop" | undefined;
  lockfile?: string | undefined;
  catalogIndexing?: unknown;
};

export type DashboardCatalogInstallResult = {
  installed: DashboardInstalledCatalogCaplet[];
  setupActions: DashboardSetupAction[];
};

export function dashboardInstalledCaplets(
  caplets: CapletConfig[],
  context: DashboardCatalogContext,
): DashboardInstalledCaplet[] {
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

export function dashboardCatalogSearch(input: {
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

export function dashboardCatalogDetail(input: { source: string; capletId: string }): {
  entry: CatalogEntry;
  setupActions: DashboardSetupAction[];
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

export async function dashboardInstallCatalogCaplet(input: {
  source: string;
  capletId: string;
  force?: boolean | undefined;
  context: DashboardCatalogContext;
}): Promise<DashboardCatalogInstallResult> {
  const response = await dispatchRemoteCliRequest(
    {
      command: "install",
      arguments: {
        repo: installSourceFor(input.source),
        capletIds: [input.capletId],
        disableCatalogIndexing: true,
        ...(input.force === undefined ? {} : { force: input.force }),
      },
    },
    requiredControlContext(input.context),
  );
  if (!response.ok) throw new CapletsError(response.error.code, response.error.message);
  return {
    installed: installedFromDispatchResult(response.result),
    setupActions: setupActionsForInstalled(input.source, input.capletId),
  };
}

export async function dashboardUpdateCatalogCaplet(input: {
  capletId: string;
  force?: boolean | undefined;
  allowRiskIncrease?: boolean | undefined;
  context: DashboardCatalogContext;
}): Promise<DashboardCatalogInstallResult> {
  const response = await dispatchRemoteCliRequest(
    {
      command: "update",
      arguments: {
        capletIds: [input.capletId],
        disableCatalogIndexing: true,
        ...(input.force === undefined ? {} : { force: input.force }),
        ...(input.allowRiskIncrease === undefined
          ? {}
          : { allowRiskIncrease: input.allowRiskIncrease }),
      },
    },
    requiredControlContext(input.context),
  );
  if (!response.ok) throw new CapletsError(response.error.code, response.error.message);
  return { installed: installedFromDispatchResult(response.result), setupActions: [] };
}

export function dashboardUpdateReadiness(input: { context: DashboardCatalogContext }): {
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

const officialCatalogRepository = "spiritledsoftware/caplets";

type ResolvedDashboardCatalogSource = {
  root: string;
  source: CatalogSourceIdentity;
  trustLevel: "official" | "community";
};

function catalogEntriesFromSource(sourceInput: string): CatalogEntry[] {
  const resolved = resolveDashboardCatalogSource(sourceInput);
  const sourceRoot = join(resolved.root, "caplets");
  const files = discoverCapletFiles(sourceRoot);
  return files
    .map(({ id, path }) => {
      const contentMarkdown = readFileSync(path, "utf8");
      const frontmatter = readCatalogCapletFrontmatterFromMarkdown(contentMarkdown);
      const sourcePath = sourceRelativePath(resolved.root, path);
      return createCatalogEntry({
        id,
        name: catalogStringFromFrontmatter(frontmatter.name) ?? id,
        description:
          catalogStringFromFrontmatter(frontmatter.description) ?? `Catalog Caplet ${id}.`,
        source: resolved.source,
        sourcePath,
        trustLevel: resolved.trustLevel,
        contentMarkdown,
        icon: catalogIconFromFrontmatter(frontmatter, {
          id,
          source: resolved.source,
          sourcePath,
          trustLevel: resolved.trustLevel,
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

function resolveDashboardCatalogSource(sourceInput: string): ResolvedDashboardCatalogSource {
  const trimmed = sourceInput.trim();
  if (trimmed === "official") {
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

function installSourceFor(sourceInput: string): string {
  return sourceInput.trim() === "official" ? officialCatalogRepository : sourceInput;
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

function setupActionsForInstalled(source: string, capletId: string): DashboardSetupAction[] {
  try {
    return setupActionsForEntry(dashboardCatalogDetail({ source, capletId }).entry);
  } catch {
    return [];
  }
}

function setupActionsForEntry(entry: CatalogEntry): DashboardSetupAction[] {
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
}): DashboardSetupAction[] {
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

function lockfilePath(context: DashboardCatalogContext): string {
  return context.control?.globalLockfilePath ?? defaultCapletsLockfilePath();
}

type LockEntry = { id: string; source?: { type?: string; repository?: string }; risk?: unknown };

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

function requiredControlContext(context: DashboardCatalogContext): RemoteControlDispatchContext {
  if (!context.control) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Dashboard catalog actions require server control context.",
    );
  }
  return context.control;
}

function installedFromDispatchResult(result: unknown): DashboardInstalledCatalogCaplet[] {
  if (
    !result ||
    typeof result !== "object" ||
    !Array.isArray((result as { installed?: unknown }).installed)
  ) {
    return [];
  }
  return (result as { installed: unknown[] }).installed.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Partial<DashboardInstalledCatalogCaplet>;
    if (
      typeof value.id !== "string" ||
      typeof value.destination !== "string" ||
      typeof value.kind !== "string"
    ) {
      return [];
    }
    return [
      {
        id: value.id,
        source: typeof value.source === "string" ? value.source : "unknown",
        destination: value.destination,
        kind: value.kind === "directory" ? "directory" : "file",
        ...(typeof value.hash === "string" ? { hash: value.hash } : {}),
        ...(typeof value.status === "string" ? { status: value.status } : {}),
        ...(typeof value.lockfile === "string" ? { lockfile: value.lockfile } : {}),
        ...(value.catalogIndexing ? { catalogIndexing: value.catalogIndexing } : {}),
      },
    ];
  });
}

function authRequired(caplet: CapletConfig): boolean {
  const auth = "auth" in caplet ? caplet.auth : undefined;
  return Boolean(auth) && auth?.type !== "none";
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 50;
  return Math.min(100, Math.max(1, Math.trunc(limit)));
}
