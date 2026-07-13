import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  catalogIconReferenceFromValue,
  createCatalogEntry,
  generateCatalogInstallCommand,
  normalizeCatalogSourceIdentity,
  readCatalogCapletFrontmatterFromMarkdown,
  type CatalogEntry,
  type CatalogCompactEntry,
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
  status?: "installed" | "restored" | "updated" | "content_updated" | "noop" | undefined;
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

export async function currentHostCatalogSearch(input: {
  source: string;
  query?: string | undefined;
  limit?: number | undefined;
}): Promise<{ entries: CatalogEntry[] }> {
  const entries = await catalogEntriesFromSource(input.source);
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

export async function currentHostCatalogDetail(input: {
  source: string;
  entryKey: string;
}): Promise<{
  entry: CatalogEntry;
  setupActions: CurrentHostSetupAction[];
  projectScopedInstallAvailable: false;
}> {
  let entry: CatalogEntry | undefined;
  try {
    entry =
      input.source.trim() === "official"
        ? await fetchOfficialCatalogDetail(input.entryKey)
        : (await catalogEntriesFromSource(input.source)).find(
            (candidate) => candidate.entryKey === input.entryKey,
          );
  } catch (error) {
    if (error instanceof CapletsError) throw error;
    throw new CapletsError("CONFIG_NOT_FOUND", `Catalog entry ${input.entryKey} not found.`);
  }
  if (!entry)
    throw new CapletsError("CONFIG_NOT_FOUND", `Catalog entry ${input.entryKey} not found.`);
  return {
    entry,
    setupActions: setupActionsForEntry(entry),
    projectScopedInstallAvailable: false,
  };
}

export async function currentHostCatalogIndex(input: {
  source: string;
}): Promise<{ entries: CatalogCompactEntry[] }> {
  if (input.source.trim() === "official") return { entries: await fetchOfficialCatalogIndex() };
  const entries = await catalogEntriesFromSource(input.source);
  return {
    entries: entries.map(({ contentMarkdown: _contentMarkdown, ...entry }) => ({
      ...entry,
      installCount: 0,
      installCountDisplay: "<10",
      rankScore: 0,
    })),
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

const officialCatalogRepository = "spiritledsoftware/caplets";
const officialCatalogApiUrl = "https://catalog.caplets.dev/api/v1/catalog";
const maxCatalogEntries = 10_000;
const maxCatalogIndexBytes = 32 * 1024 * 1024;
const maxCatalogEntryBytes = 2 * 1024 * 1024;

export function currentHostCatalogInstallSource(source: string, resolvedRevision?: string): string {
  const repository = source.trim() === "official" ? officialCatalogRepository : source;
  return resolvedRevision ? `${repository}#${resolvedRevision}` : repository;
}

type ResolvedCurrentHostCatalogSource = {
  root: string;
  source: CatalogSourceIdentity;
  trustLevel: "official" | "community";
};

type LockEntry = { id: string; source?: { type?: string; repository?: string }; risk?: unknown };

async function catalogEntriesFromSource(sourceInput: string): Promise<CatalogEntry[]> {
  if (sourceInput.trim() === "official") return await fetchOfficialCatalogEntries();
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

async function fetchOfficialCatalogEntries(): Promise<CatalogEntry[]> {
  const payload = await fetchOfficialJson(officialCatalogApiUrl, maxCatalogIndexBytes);
  if (
    !isRecord(payload) ||
    payload.version !== 1 ||
    !Array.isArray(payload.entries) ||
    payload.entries.length > maxCatalogEntries ||
    !payload.entries.every(isCatalogEntry)
  ) {
    throw invalidCatalogResponse();
  }
  return payload.entries;
}

async function fetchOfficialCatalogIndex(): Promise<CatalogCompactEntry[]> {
  const payload = await fetchOfficialJson(
    `${officialCatalogApiUrl}?view=compact`,
    maxCatalogIndexBytes,
  );
  if (
    !isRecord(payload) ||
    payload.version !== 1 ||
    payload.view !== "compact" ||
    !Array.isArray(payload.entries) ||
    payload.entries.length > maxCatalogEntries ||
    !payload.entries.every(isCompactCatalogEntry)
  ) {
    throw invalidCatalogResponse();
  }
  return payload.entries;
}

async function fetchOfficialCatalogDetail(entryKey: string): Promise<CatalogEntry | undefined> {
  const payload = await fetchOfficialJson(
    `${officialCatalogApiUrl}/entries/${encodeURIComponent(entryKey)}`,
    maxCatalogEntryBytes,
    true,
  );
  if (payload === undefined) return undefined;
  if (
    !isRecord(payload) ||
    payload.version !== 1 ||
    !isCatalogEntry(payload.entry) ||
    payload.entry.entryKey !== entryKey
  ) {
    throw invalidCatalogResponse();
  }
  return payload.entry;
}

async function fetchOfficialJson(
  url: string,
  maxBytes: number,
  missingAllowed = false,
): Promise<unknown | undefined> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new CapletsError("SERVER_UNAVAILABLE", "Official catalog service is unavailable.");
  }
  if (missingAllowed && response.status === 404) return undefined;
  if (!response.ok) {
    throw new CapletsError("SERVER_UNAVAILABLE", "Official catalog service is unavailable.");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw invalidCatalogResponse();
  let text: string;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing body");
    const decoder = new TextDecoder();
    let bytes = 0;
    const chunks: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw invalidCatalogResponse();
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    text = chunks.join("");
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof CapletsError) throw error;
    throw invalidCatalogResponse();
  }
}

function invalidCatalogResponse(): CapletsError {
  return new CapletsError(
    "DOWNSTREAM_PROTOCOL_ERROR",
    "Official catalog service returned an invalid response.",
  );
}

function isCatalogEntry(value: unknown): value is CatalogEntry {
  return (
    isCatalogEntryBase(value) &&
    typeof value.contentMarkdown === "string" &&
    value.contentMarkdown.length <= maxCatalogEntryBytes
  );
}

function isCompactCatalogEntry(value: unknown): value is CatalogCompactEntry {
  if (!isRecord(value) || !isCatalogEntryBase(value) || "contentMarkdown" in value) return false;
  const compact = value as unknown as Record<string, unknown>;
  return (
    Number.isSafeInteger(compact.installCount) &&
    (compact.installCount as number) >= 0 &&
    boundedString(compact.installCountDisplay, 64) &&
    typeof compact.rankScore === "number" &&
    Number.isFinite(compact.rankScore)
  );
}

const readinessValues: Record<string, true> = { ready: true, required: true, unknown: true };
const workflowKinds: Record<string, true> = {
  code_mode: true,
  mcp: true,
  openapi: true,
  google_discovery: true,
  graphql: true,
  http: true,
  cli: true,
  set: true,
  unknown: true,
};
const warningCodes: Record<string, true> = {
  unverified_community: true,
  local_control: true,
  mutating_saas: true,
  auth_required: true,
  setup_required: true,
  project_binding_required: true,
  readiness_unknown: true,
};
const warningSeverities: Record<string, true> = { info: true, caution: true, danger: true };

function isCatalogEntryBase(value: unknown): value is CatalogEntry {
  if (!isRecord(value)) return false;
  return (
    boundedString(value.entryKey, 2048) &&
    boundedString(value.id, 256) &&
    boundedString(value.name, 1024) &&
    boundedString(value.description, 16_384) &&
    boundedString(value.sourcePath, 4096) &&
    isOfficialSource(value.source) &&
    value.trustLevel === "official" &&
    optionalBoundedString(value.resolvedRevision, 256) &&
    optionalBoundedString(value.indexedContentHash, 256) &&
    Array.isArray(value.tags) &&
    value.tags.length <= 100 &&
    value.tags.every((tag) => boundedString(tag, 256)) &&
    boundedString(value.intendedTask, 4096) &&
    optionalBoundedString(value.avoidWhen, 4096) &&
    typeof value.setupReadiness === "string" &&
    value.setupReadiness in readinessValues &&
    typeof value.authReadiness === "string" &&
    value.authReadiness in readinessValues &&
    typeof value.projectBindingReadiness === "string" &&
    value.projectBindingReadiness in readinessValues &&
    isWorkflow(value.workflow) &&
    isChildren(value.children) &&
    isInstallCommand(value.installCommand, value) &&
    Array.isArray(value.warnings) &&
    value.warnings.length <= 100 &&
    value.warnings.every(isWarning) &&
    isIcon(value.icon)
  );
}

function isOfficialSource(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.provider === "github" &&
    value.owner === "spiritledsoftware" &&
    value.repo === "caplets" &&
    value.repository === officialCatalogRepository &&
    value.canonicalUrl === "https://github.com/spiritledsoftware/caplets"
  );
}

function isWorkflow(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    value.kind in workflowKinds &&
    boundedString(value.label, 256)
  );
}

function isChildren(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= 1_000 &&
      value.every(
        (child) =>
          isRecord(child) &&
          boundedString(child.id, 256) &&
          optionalBoundedString(child.childId, 256) &&
          boundedString(child.name, 1024) &&
          boundedString(child.backend, 256) &&
          isWorkflow(child.workflow),
      ))
  );
}

function isInstallCommand(value: unknown, entry: Record<string, unknown>): boolean {
  if (
    !isRecord(value) ||
    typeof value.copyable !== "boolean" ||
    typeof value.revisionBound !== "boolean" ||
    !boundedString(value.text, 16_384) ||
    !optionalBoundedString(value.reason, 64)
  )
    return false;
  const expected = generateCatalogInstallCommand({
    source: {
      provider: "github",
      owner: "spiritledsoftware",
      repo: "caplets",
      repository: officialCatalogRepository,
      canonicalUrl: "https://github.com/spiritledsoftware/caplets",
    },
    capletId: entry.id as string,
    ...(typeof entry.resolvedRevision === "string"
      ? { resolvedRevision: entry.resolvedRevision }
      : {}),
  });
  return (
    value.text === expected.text &&
    value.copyable === expected.copyable &&
    value.revisionBound === expected.revisionBound &&
    value.reason === expected.reason
  );
}

function isWarning(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    value.code in warningCodes &&
    typeof value.severity === "string" &&
    value.severity in warningSeverities &&
    boundedString(value.label, 256) &&
    boundedString(value.message, 4096)
  );
}

function isIcon(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (value.type === "url") {
    const reference = catalogIconReferenceFromValue(value.url);
    return reference?.type === "url";
  }
  if (
    value.type !== "bundled" ||
    !boundedString(value.path, 4096) ||
    !boundedString(value.url, 4096)
  ) {
    return false;
  }
  const reference = catalogIconReferenceFromValue(value.path);
  return (
    reference?.type === "bundled" &&
    value.url.startsWith("/catalog-icons/official/") &&
    !value.url.includes("\\")
  );
}

function optionalBoundedString(value: unknown, max: number): boolean {
  return value === undefined || boundedString(value, max);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
