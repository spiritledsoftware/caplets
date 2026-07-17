import { createHash } from "node:crypto";
import { CapletsError } from "../../errors";
export const MAX_PORTABLE_ARTIFACT_BYTES = 256 * 1024 * 1024;
export const MAX_ARTIFACT_PART_BYTES = 16 * 1024 * 1024;
export const ARTIFACT_UPLOAD_CHUNK_BYTES = 1024 * 1024;
export const ARTIFACT_QUOTA_BYTES_PER_ACTOR_WINDOW = 1024 * 1024 * 1024;
export const ARTIFACT_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ARTIFACT_REFERENCE_TTL_MS = 15 * 60 * 1000;

export type ArtifactProviderIdentity = {
  kind: "filesystem" | "s3";
  provider: string;
  namespace: string;
  logicalHostId: string;
  storeId: string;
  identityId: string;
};

export type ArtifactObjectHead = {
  size: number;
  sha256: string;
};

export type ArtifactPutResult = {
  created: boolean;
  size: number;
};

export interface ArtifactProvider {
  readonly identity: ArtifactProviderIdentity;
  verifyCanary(expectedCanary: string): Promise<void>;
  putImmutable(key: string, bytes: Uint8Array): Promise<ArtifactPutResult>;
  head(key: string): Promise<ArtifactObjectHead | undefined>;
  getRange(key: string, start: number, endExclusive: number): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
export async function verifyArtifactProviderContinuity(
  provider: ArtifactProvider,
  expectedIdentity: ArtifactProviderIdentity,
  expectedCanary: string,
): Promise<void> {
  if (
    provider.identity.identityId !== expectedIdentity.identityId ||
    provider.identity.kind !== expectedIdentity.kind ||
    provider.identity.provider !== expectedIdentity.provider ||
    provider.identity.namespace !== expectedIdentity.namespace ||
    provider.identity.logicalHostId !== expectedIdentity.logicalHostId ||
    provider.identity.storeId !== expectedIdentity.storeId
  ) {
    throw new CapletsError("AUTH_FAILED", "Artifact provider identity drift was detected.");
  }
  await provider.verifyCanary(expectedCanary);
}

export function createArtifactProviderIdentity(
  input: Omit<ArtifactProviderIdentity, "identityId">,
): ArtifactProviderIdentity {
  if (
    !/^host_[0-9A-HJKMNP-TV-Z]{26}$/u.test(input.logicalHostId) ||
    !/^store_[0-9A-HJKMNP-TV-Z]{26}$/u.test(input.storeId) ||
    input.provider.length === 0 ||
    !isCanonicalArtifactKey(input.namespace)
  ) {
    throw new CapletsError("REQUEST_INVALID", "Artifact provider identity is invalid.");
  }
  const canonical = JSON.stringify([
    1,
    input.kind,
    input.provider,
    input.namespace,
    input.logicalHostId,
    input.storeId,
  ]);
  return Object.freeze({
    ...input,
    identityId: createHash("sha256").update(canonical).digest("hex"),
  });
}

export function artifactProviderObjectKey(
  identity: ArtifactProviderIdentity,
  logicalKey: string,
): string {
  assertCanonicalArtifactKey(logicalKey);
  return [identity.namespace, identity.logicalHostId, identity.storeId, logicalKey].join("/");
}

export function artifactProviderCanaryKey(identity: ArtifactProviderIdentity): string {
  return [identity.namespace, identity.logicalHostId, identity.storeId, ".caplets-canary-v1"].join(
    "/",
  );
}

export function artifactCanaryPayload(
  identity: ArtifactProviderIdentity,
  expectedCanary: string,
): Buffer {
  if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(expectedCanary)) {
    throw new CapletsError("REQUEST_INVALID", "Artifact provider canary is invalid.");
  }
  return Buffer.from(
    JSON.stringify({ version: 1, identityId: identity.identityId, canary: expectedCanary }),
    "utf8",
  );
}

export function assertCanonicalArtifactKey(key: string): void {
  if (!isCanonicalArtifactKey(key)) {
    throw new CapletsError("REQUEST_INVALID", "Artifact object key is invalid.");
  }
}

export function validateArtifactRange(start: number, endExclusive: number): void {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(endExclusive) ||
    start < 0 ||
    endExclusive <= start
  ) {
    throw new CapletsError("REQUEST_INVALID", "Artifact byte range is invalid.");
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isCanonicalArtifactKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= 1024 &&
    !key.startsWith("/") &&
    !key.endsWith("/") &&
    !key.includes("\\") &&
    key.split("/").every((part) => /^[A-Za-z0-9._-]+$/u.test(part) && part !== "." && part !== "..")
  );
}
