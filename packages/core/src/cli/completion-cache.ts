import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type CompletionDiscoveryKind = "tools" | "prompts" | "resources" | "resourceTemplates";

export type CompletionCandidate = {
  value: string;
  label?: string | undefined;
  description?: string | undefined;
};

export type CompletionCacheKeyInput = {
  server: string;
  backend: string;
  kind: CompletionDiscoveryKind;
  fingerprint: string;
};

export type CompletionCacheEntry =
  | {
      status: "positive";
      fetchedAt: number;
      expiresAt: number;
      candidates: CompletionCandidate[];
    }
  | {
      status: "negative";
      fetchedAt: number;
      expiresAt: number;
      reason: "auth_required" | "timeout" | "unavailable" | "unsupported" | "error";
      candidates?: CompletionCandidate[];
    };

export type ReadCompletionCacheEntry = CompletionCacheEntry & { fresh: boolean };

export function completionCacheKey(input: CompletionCacheKeyInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function readCompletionCacheEntry(
  cacheDir: string,
  key: string,
  now = Date.now(),
): ReadCompletionCacheEntry | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(cachePath(cacheDir, key), "utf8"),
    ) as CompletionCacheEntry;
    if (parsed.status === "positive" && Array.isArray(parsed.candidates)) {
      return { ...parsed, fresh: now <= parsed.expiresAt };
    }
    if (parsed.status === "negative" && typeof parsed.reason === "string") {
      return { ...parsed, fresh: now <= parsed.expiresAt };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function writeCompletionCacheEntry(
  cacheDir: string,
  key: string,
  entry: CompletionCacheEntry,
): void {
  mkdirSync(cacheDir, { recursive: true });
  const path = cachePath(cacheDir, key);
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(entry), { mode: 0o600 });
  renameSync(tempPath, path);
}

function cachePath(cacheDir: string, key: string): string {
  return join(cacheDir, `${key}.json`);
}
