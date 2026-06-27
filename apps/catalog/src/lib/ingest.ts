import {
  catalogAuthRequiredFromFrontmatter,
  type CatalogEntry,
  catalogEntryKey,
  catalogMutatesExternalStateFromFrontmatter,
  catalogProjectBindingRequiredFromFrontmatter,
  catalogSetupRequiredFromFrontmatter,
  catalogStringArrayFromFrontmatter,
  catalogStringFromFrontmatter,
  catalogUsesLocalControlFromFrontmatter,
  catalogWorkflowSummaryFromFrontmatter,
  createCatalogEntry,
  readCatalogCapletFrontmatterFromMarkdown,
  type CatalogIndexingStatus,
  type CatalogSourceIdentity,
} from "@caplets/core/catalog";
import type { D1Database } from "@cloudflare/workers-types";
import { publicCatalogSourceEligibility } from "./public-source";
import { refractoryWindowAllows } from "./rate-limit";
import { isSuppressed } from "./suppression";

const maxBodyBytes = 16 * 1024;
const maxFetchedCapletBytes = 128 * 1024;
const refractoryWindowMs = 60 * 60 * 1000;
const maxRepositorySignalsPerWindow = 250;
const officialRepository = "spiritledsoftware/caplets";

export type CatalogInstallSignal = {
  source: string;
  capletId: string;
  sourcePath: string;
  resolvedRevision?: string | undefined;
  contentHash?: string | undefined;
  entry?: CatalogEntry | undefined;
};

export type CatalogInstallSignalResult = {
  status: CatalogIndexingStatus;
  entryKey?: string | undefined;
};

export async function parseInstallSignalRequest(request: Request): Promise<CatalogInstallSignal> {
  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
  if (
    contentLength !== undefined &&
    (!Number.isSafeInteger(contentLength) || contentLength > maxBodyBytes)
  ) {
    throw new Error("request_body_too_large");
  }
  const body = JSON.parse(await readLimitedRequestText(request));
  if (!isInstallSignal(body)) {
    throw new Error("invalid_install_signal");
  }
  return body;
}

export async function acceptInstallSignal(input: {
  signal: CatalogInstallSignal;
  db?: D1Database | undefined;
  fetch?: typeof fetch | undefined;
  now?: Date | undefined;
}): Promise<CatalogInstallSignalResult> {
  const eligibility = publicCatalogSourceEligibility(input.signal.source);
  if (!eligibility.eligible) {
    return { status: "ineligible" };
  }
  if (!input.signal.resolvedRevision && !input.signal.contentHash) {
    return { status: "revision_unavailable" };
  }

  const entryKey = catalogEntryKey({
    source: eligibility.source,
    sourcePath: input.signal.sourcePath,
    capletId: input.signal.capletId,
  });
  if (eligibility.source.repository === officialRepository) {
    return { status: "already_current", entryKey };
  }
  if (!input.db) {
    return { status: "unavailable", entryKey };
  }
  if (await isSuppressed(input.db, entryKey)) {
    return { status: "ineligible" };
  }

  const previous = await input.db
    .prepare("select accepted_at_ms from catalog_signal_dedupe where entry_key = ? limit 1")
    .bind(entryKey)
    .first<{ accepted_at_ms: number }>();
  const nowMs = input.now?.getTime() ?? Date.now();
  const decision = refractoryWindowAllows({
    nowMs,
    previousAcceptedAtMs: previous?.accepted_at_ms,
    windowMs: refractoryWindowMs,
  });
  if (!decision.allowed) {
    return { status: "rate_limited", entryKey };
  }
  if (!(await repositoryWindowAllows(input.db, eligibility.source, nowMs))) {
    return { status: "rate_limited", entryKey };
  }

  await recordAcceptedSignal(input.db, {
    entry: await canonicalEntryForAcceptedSignal(
      input.signal,
      eligibility.source,
      entryKey,
      input.fetch ?? globalThis.fetch,
    ),
    entryKey,
    source: eligibility.source,
    nowMs,
    signal: input.signal,
  });
  return { status: previous ? "counted" : "accepted", entryKey };
}

async function readLimitedRequestText(request: Request): Promise<string> {
  if (!request.body) {
    throw new Error("invalid_install_signal");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBodyBytes) {
        throw new Error("request_body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concatChunks(chunks, totalBytes));
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function repositoryWindowAllows(
  db: D1Database,
  source: CatalogSourceIdentity,
  nowMs: number,
): Promise<boolean> {
  const windowStartMs = Math.floor(nowMs / refractoryWindowMs) * refractoryWindowMs;
  const existing = await db
    .prepare(
      `select accepted_count as acceptedCount
       from catalog_signal_repository_windows
       where provider = ? and repository = ? and window_start_ms = ?
       limit 1`,
    )
    .bind(source.provider, source.repository, windowStartMs)
    .first<{ acceptedCount: number }>();
  return (existing?.acceptedCount ?? 0) < maxRepositorySignalsPerWindow;
}

function isInstallSignal(value: unknown): value is CatalogInstallSignal {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.source === "string" &&
    typeof candidate.capletId === "string" &&
    typeof candidate.sourcePath === "string" &&
    (candidate.resolvedRevision === undefined || typeof candidate.resolvedRevision === "string") &&
    (candidate.contentHash === undefined || typeof candidate.contentHash === "string") &&
    (candidate.entry === undefined || isCatalogEntry(candidate.entry))
  );
}

function isCatalogEntry(value: unknown): value is CatalogEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.entryKey === "string" &&
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.description === "string" &&
    candidate.trustLevel === "community" &&
    typeof candidate.sourcePath === "string" &&
    typeof candidate.installCommand === "object"
  );
}

async function recordAcceptedSignal(
  db: D1Database,
  input: {
    entry?: CatalogEntry | undefined;
    entryKey: string;
    source: CatalogSourceIdentity;
    nowMs: number;
    signal: CatalogInstallSignal;
  },
): Promise<void> {
  const statements = [
    db
      .prepare(
        `insert into catalog_counts (entry_key, install_count, updated_at_ms)
         values (?, 1, ?)
         on conflict(entry_key) do update set
           install_count = install_count + 1,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .bind(input.entryKey, input.nowMs),
    db
      .prepare(
        `insert into catalog_signal_dedupe (entry_key, provider, repository, accepted_at_ms)
         values (?, ?, ?, ?)
         on conflict(entry_key) do update set accepted_at_ms = excluded.accepted_at_ms`,
      )
      .bind(input.entryKey, input.source.provider, input.source.repository, input.nowMs),
    db
      .prepare(
        `insert into catalog_signal_repository_windows (provider, repository, window_start_ms, accepted_count)
         values (?, ?, ?, 1)
         on conflict(provider, repository, window_start_ms) do update set
           accepted_count = accepted_count + 1`,
      )
      .bind(
        input.source.provider,
        input.source.repository,
        Math.floor(input.nowMs / refractoryWindowMs) * refractoryWindowMs,
      ),
  ];
  if (input.entry) {
    statements.push(
      db
        .prepare(
          `insert into catalog_entries (
             entry_key, provider, repository, source_path, caplet_id,
             resolved_revision, content_hash, entry_json, updated_at_ms
           )
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(entry_key) do update set
             resolved_revision = excluded.resolved_revision,
             content_hash = excluded.content_hash,
             entry_json = excluded.entry_json,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .bind(
          input.entryKey,
          input.source.provider,
          input.source.repository,
          input.signal.sourcePath,
          input.signal.capletId,
          input.signal.resolvedRevision,
          input.signal.contentHash,
          JSON.stringify(input.entry),
          input.nowMs,
        ),
    );
  }
  await db.batch(statements);
}

async function canonicalEntryForAcceptedSignal(
  signal: CatalogInstallSignal,
  source: CatalogSourceIdentity,
  entryKey: string,
  fetchImpl: typeof fetch | undefined,
): Promise<CatalogEntry | undefined> {
  const entry = signal.entry;
  if (!entry || entry.entryKey !== entryKey) return undefined;
  const contentMarkdown = await fetchPublicCapletMarkdown(signal, source, fetchImpl);
  if (!contentMarkdown) return undefined;
  const frontmatter = readCatalogCapletFrontmatterFromMarkdown(contentMarkdown);
  return createCatalogEntry({
    id: signal.capletId,
    name: catalogStringFromFrontmatter(frontmatter.name) ?? signal.capletId,
    description:
      catalogStringFromFrontmatter(frontmatter.description) ??
      `Community Caplet ${signal.capletId}.`,
    source,
    sourcePath: signal.sourcePath,
    trustLevel: "community",
    resolvedRevision: signal.resolvedRevision,
    indexedContentHash: signal.contentHash,
    contentMarkdown,
    tags: catalogStringArrayFromFrontmatter(frontmatter.tags),
    useWhen: catalogStringFromFrontmatter(frontmatter.useWhen),
    avoidWhen: catalogStringFromFrontmatter(frontmatter.avoidWhen),
    setupRequired: catalogSetupRequiredFromFrontmatter(frontmatter),
    authRequired: catalogAuthRequiredFromFrontmatter(frontmatter),
    projectBindingRequired: catalogProjectBindingRequiredFromFrontmatter(frontmatter),
    workflow: catalogWorkflowSummaryFromFrontmatter(frontmatter, {
      kind: "set",
      label: "Caplet",
    }),
    mutatesExternalState: catalogMutatesExternalStateFromFrontmatter(frontmatter),
    localControl: catalogUsesLocalControlFromFrontmatter(frontmatter),
  });
}

async function fetchPublicCapletMarkdown(
  signal: CatalogInstallSignal,
  source: CatalogSourceIdentity,
  fetchImpl: typeof fetch | undefined,
): Promise<string | undefined> {
  if (!fetchImpl || !signal.resolvedRevision) return undefined;
  for (const path of candidateRawCapletPaths(signal.sourcePath)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await fetchImpl(rawGithubUrl(source, signal.resolvedRevision, path), {
        headers: { accept: "text/plain" },
        signal: controller.signal,
      });
      if (!response.ok) continue;
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength <= maxFetchedCapletBytes) {
        return text;
      }
    } catch {
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }
  return undefined;
}

function candidateRawCapletPaths(sourcePath: string): string[] {
  const cleaned = sourcePath.trim().replace(/\\/g, "/").replace(/^\.\//u, "");
  const segments = cleaned.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) return [];
  const normalized = segments.join("/");
  if (!normalized) return [];
  if (/\.md$/iu.test(normalized)) return [normalized];
  return [`${normalized}/CAPLET.md`];
}

function rawGithubUrl(
  source: CatalogSourceIdentity,
  resolvedRevision: string,
  sourcePath: string,
): string {
  const path = sourcePath.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${encodeURIComponent(
    resolvedRevision,
  )}/${path}`;
}
