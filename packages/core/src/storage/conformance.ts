import { CapletsError } from "../errors";
import type {
  AuthorityGeneration,
  AuthorityGenerationIdentity,
  AuthorityHead,
  AuthorityHealth,
} from "./types";
import { MAX_AUTHORITY_GENERATION_BYTES } from "./types";

export type GenerationObservation =
  | { kind: "initial" | "advanced"; generation: AuthorityGenerationIdentity }
  | { kind: "unchanged"; generation: AuthorityGenerationIdentity }
  | { kind: "regression"; reason: "authority" | "sequence" | "identity" };

export function classifyGeneration(
  active: AuthorityGenerationIdentity | null,
  head: AuthorityHead,
): GenerationObservation {
  if (active === null) return { kind: "initial", generation: head };
  if (head.authorityId !== active.authorityId) return { kind: "regression", reason: "authority" };
  if (head.sequence < active.sequence) return { kind: "regression", reason: "sequence" };
  if (head.sequence === active.sequence) {
    return head.id === active.id
      ? { kind: "unchanged", generation: active }
      : { kind: "regression", reason: "identity" };
  }
  return { kind: "advanced", generation: head };
}

export function validateAuthorityGeneration(
  head: AuthorityHead,
  generation: AuthorityGeneration,
  encodedBytes: number,
): void {
  if (encodedBytes > MAX_AUTHORITY_GENERATION_BYTES) {
    throw new CapletsError("CONFIG_INVALID", "Authority generation exceeds the 64 MiB limit");
  }
  if (
    generation.authorityId !== head.authorityId ||
    generation.id !== head.id ||
    generation.sequence !== head.sequence ||
    generation.digest !== head.digest
  ) {
    throw new CapletsError("CONFIG_INVALID", "Authority generation does not match its head");
  }
  if (!Number.isSafeInteger(generation.sequence) || generation.sequence < 1) {
    throw new CapletsError("CONFIG_INVALID", "Authority generation sequence is invalid");
  }
}

const SENSITIVE_KEY = /credential|secret|token|password|dsn|url|path|key|payload|vault/i;

export function redactAuthorityDiagnostic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuthorityDiagnostic);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactAuthorityDiagnostic(nested),
      ]),
    );
  }
  return value;
}

export function safeAuthorityHealth(health: AuthorityHealth): AuthorityHealth {
  return {
    provider: health.provider,
    authorityId: health.authorityId,
    connectivity: health.connectivity,
    writable: health.writable,
    activeGeneration: health.activeGeneration,
    refresh: health.refresh,
    ...(health.code ? { code: health.code } : {}),
  };
}
