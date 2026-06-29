import { generateCatalogInstallCommand } from "./install-command";
import { catalogEntryKey } from "./source";
import type {
  CatalogEntry,
  CatalogEntryInput,
  CatalogReadiness,
  CatalogWorkflowSummary,
} from "./types";
import { catalogWarningsForEntry } from "./warnings";

export function createCatalogEntry(input: CatalogEntryInput): CatalogEntry {
  return {
    entryKey: catalogEntryKey({
      source: input.source,
      sourcePath: input.sourcePath,
      capletId: input.id,
    }),
    id: input.id,
    name: input.name,
    description: input.description,
    source: input.source,
    sourcePath: input.sourcePath,
    trustLevel: input.trustLevel,
    ...(input.resolvedRevision ? { resolvedRevision: input.resolvedRevision } : {}),
    ...(input.indexedContentHash ? { indexedContentHash: input.indexedContentHash } : {}),
    ...(input.contentMarkdown ? { contentMarkdown: input.contentMarkdown } : {}),
    ...(input.icon ? { icon: input.icon } : {}),
    tags: stableTags(input.tags ?? []),
    intendedTask: input.useWhen?.trim() || "unknown",
    ...(input.avoidWhen?.trim() ? { avoidWhen: input.avoidWhen.trim() } : {}),
    setupReadiness: readiness(input.setupRequired),
    authReadiness: readiness(input.authRequired),
    projectBindingReadiness: readiness(input.projectBindingRequired),
    workflow: input.workflow ?? { kind: "unknown", label: "Unknown" },
    ...(input.children && input.children.length > 0 ? { children: input.children } : {}),
    installCommand: generateCatalogInstallCommand({
      source: input.source,
      capletId: input.id,
      resolvedRevision: input.resolvedRevision,
      requireRevisionBound: input.trustLevel === "community",
    }),
    warnings: catalogWarningsForEntry(input),
  };
}

export function formatCatalogInstallCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "<10";
  if (count < 10) return "<10";
  return Math.floor(count).toLocaleString("en-US");
}

export function catalogWorkflowSummaryForBackendFamily(
  family: string | undefined,
): CatalogWorkflowSummary | undefined {
  if (family === "mcp") return { kind: "mcp", label: "MCP server" };
  if (family === "openapi") return { kind: "openapi", label: "OpenAPI" };
  if (family === "googleDiscovery") {
    return { kind: "google_discovery", label: "Google Discovery API" };
  }
  if (family === "graphql") return { kind: "graphql", label: "GraphQL" };
  if (family === "http") return { kind: "http", label: "HTTP API" };
  if (family === "cli") return { kind: "cli", label: "CLI tools" };
  if (family === "caplets") return { kind: "set", label: "Caplet set" };
  return undefined;
}

function readiness(value: boolean | undefined): CatalogReadiness {
  if (value === undefined) return "unknown";
  return value ? "required" : "ready";
}

function stableTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}
