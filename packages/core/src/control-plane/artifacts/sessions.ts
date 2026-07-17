import { createHash, randomUUID } from "node:crypto";
import { CapletsError } from "../../errors";
import {
  createPortableArtifactReference,
  type PortableArtifactReference,
} from "../../media/artifacts";
import { stableJsonStringify } from "../../stable-json";
import type { ControlPlaneSqlTransaction, ControlPlaneTransactionalDialect } from "../store";
import type { ControlPlaneStoreIdentity } from "../types";
import {
  ARTIFACT_QUOTA_BYTES_PER_ACTOR_WINDOW,
  ARTIFACT_QUOTA_WINDOW_MS,
  ARTIFACT_REFERENCE_TTL_MS,
  ARTIFACT_UPLOAD_CHUNK_BYTES,
  MAX_ARTIFACT_PART_BYTES,
  MAX_PORTABLE_ARTIFACT_BYTES,
  sha256Hex,
  verifyArtifactProviderContinuity,
  type ArtifactProvider,
  type ArtifactProviderIdentity,
} from "./provider";

const SESSION_TTL_MS = 15 * 60 * 1000;
const PROPOSAL_TTL_MS = 15 * 60 * 1000;
const CLEANUP_CLAIM_TTL_MS = 60_000;
const MAX_CLEANUP_BATCH = 100;

export type ArtifactDirection = "upload" | "download";
export type ArtifactSessionState = "uploading" | "finalized" | "consumed" | "revoked" | "expired";
export type ArtifactManifestState = "staging" | "finalized" | "destruction-intended" | "destroyed";
export type ImportCollisionPolicy = "reject" | "replace";
export type ImportProposalState = "previewed" | "consumed" | "expired" | "rejected";

export type PortableArtifactDescriptor = Readonly<{
  reference: PortableArtifactReference;
  sha256: string;
  byteLength: number;
  mimeType: string;
}>;

export type ArtifactSession = Readonly<{
  sessionId: string;
  artifactId: string;
  actorId: string;
  operationId: string;
  direction: ArtifactDirection;
  state: ArtifactSessionState;
  nextOffset: number;
  expectedByteLength: number;
  expectedSha256: string;
  mimeType: string;
  providerIdentityId: string;
  expiresAt: string;
  finalizedAt?: string | undefined;
  revokedAt?: string | undefined;
}>;

export type ArtifactManifest = Readonly<{
  artifactId: string;
  providerIdentityId: string;
  logicalKey: string;
  direction: ArtifactDirection;
  actorId: string;
  operationId: string;
  byteLength: number;
  sha256: string;
  mimeType: string;
  partCount: number;
  state: ArtifactManifestState;
  expiresAt: string;
  finalizedAt?: string | undefined;
  destroyedAt?: string | undefined;
}>;

export type ArtifactPart = Readonly<{
  partId: string;
  artifactId: string;
  ordinal: number;
  objectKey: string;
  offset: number;
  byteLength: number;
  sha256: string;
  state: "published" | "destruction-intended" | "destroyed";
  absentVerifiedAt?: string | undefined;
}>;

export type ImportProposalDifference = Readonly<{
  field: string;
  beforeHash?: string | undefined;
  afterHash?: string | undefined;
  effect: "added" | "changed" | "removed" | "unchanged";
}>;

export type ImportSetupDependency = Readonly<{
  name: string;
  type: "local" | "external" | "unresolved-setup";
  status: "required" | "satisfied";
}>;

export type ImportProposal = Readonly<{
  proposalId: string;
  artifactId: string;
  actorId: string;
  operationId: string;
  capletId: string;
  proposalHash: string;
  expectedAuthorityGeneration: number;
  expectedEffectiveGeneration: number;
  expectedAggregateVersion: number;
  expectedSecurityEpoch: number;
  expectedRuntimeFingerprint: string;
  collisionPolicy: ImportCollisionPolicy;
  replacementConfirmed: boolean;
  consequence: "effective-runtime-changes" | "no-effective-change-while-shadowed";
  differences: readonly ImportProposalDifference[];
  setupDependencies: readonly ImportSetupDependency[];
  state: ImportProposalState;
  expiresAt: string;
  consumedAt?: string | undefined;
}>;

export type ArtifactFence = Readonly<{
  authorityGeneration: number;
  effectiveGeneration: number;
  securityEpoch: number;
  runtimeFingerprint: string;
  aggregateVersion: number;
}>;

export type CreateUploadSessionInput = Readonly<{
  actorId: string;
  operationId: string;
  expectedByteLength: number;
  expectedSha256: string;
  mimeType: string;
  now?: Date | undefined;
}>;

export type AppendArtifactChunkInput = Readonly<{
  actorId: string;
  operationId: string;
  sessionId: string;
  offset: number;
  chunkSha256: string;
  bytes: Uint8Array;
  now?: Date | undefined;
}>;

export type CreateImportProposalInput = Readonly<{
  actorId: string;
  operationId: string;
  artifactId: string;
  capletId: string;
  artifactSha256: string;
  fence: ArtifactFence;
  collisionPolicy: ImportCollisionPolicy;
  replacementConfirmed: boolean;
  consequence: ImportProposal["consequence"];
  differences: readonly ImportProposalDifference[];
  setupDependencies: readonly ImportSetupDependency[];
  now?: Date | undefined;
}>;

export type ConsumeImportProposalInput = Readonly<{
  actorId: string;
  operationId: string;
  proposalId: string;
  proposalHash: string;
  artifactSha256: string;
  fence: ArtifactFence;
  now?: Date | undefined;
}>;

export type ConsumeImportProposalResult<T> =
  | Readonly<{ status: "committed"; value: T; proposal: ImportProposal }>
  | Readonly<{
      status: "rejected";
      reason:
        | "not-found"
        | "wrong-actor"
        | "wrong-operation"
        | "proposal-mismatch"
        | "changed-bytes"
        | "stale-generation"
        | "consumed"
        | "expired";
    }>;

export interface ArtifactSessionManager {
  readonly identity: ControlPlaneStoreIdentity;
  readonly providerIdentity: ArtifactProviderIdentity;
  createUploadSession(input: CreateUploadSessionInput): Promise<ArtifactSession>;
  status(
    sessionId: string,
    actorId: string,
    operationId: string,
  ): Promise<ArtifactSession | undefined>;
  append(input: AppendArtifactChunkInput): Promise<ArtifactSession>;
  finalize(
    sessionId: string,
    actorId: string,
    operationId: string,
    now?: Date,
  ): Promise<
    Readonly<{
      session: ArtifactSession;
      manifest: ArtifactManifest;
      artifact: PortableArtifactDescriptor;
    }>
  >;
  readFinalizedArtifact(
    artifactId: string,
    actorId: string,
    operationId: string,
  ): Promise<Uint8Array>;
  publishDownloadArtifact(
    actorId: string,
    operationId: string,
    bytes: Uint8Array,
    mimeType: string,
    now?: Date,
  ): Promise<
    Readonly<{
      session: ArtifactSession;
      manifest: ArtifactManifest;
      artifact: PortableArtifactDescriptor;
    }>
  >;
  readRange(
    artifactId: string,
    actorId: string,
    operationId: string,
    start: number,
    endExclusive: number,
  ): Promise<Buffer>;
  createImportProposal(input: CreateImportProposalInput): Promise<ImportProposal>;
  readImportProposal(proposalId: string): Promise<ImportProposal | undefined>;
  consumeImportProposal<T>(
    input: ConsumeImportProposalInput,
    action: (transaction: ControlPlaneSqlTransaction, proposal: ImportProposal) => Promise<T>,
  ): Promise<ConsumeImportProposalResult<T>>;
  expire(
    now?: Date,
  ): Promise<
    Readonly<{ expiredSessions: number; expiredProposals: number; cleanupIntents: number }>
  >;
  resumeCleanup(
    cleanupId: string,
    now?: Date,
  ): Promise<Readonly<{ status: "completed" | "busy"; removedParts: number }>>;
}

export type ArtifactSessionManagerOptions = Readonly<{
  identity: ControlPlaneStoreIdentity;
  dialect: ControlPlaneTransactionalDialect;
  provider: ArtifactProvider;
  expectedProviderIdentity: ArtifactProviderIdentity;
  expectedCanary: string;
  allocateId?:
    | ((kind: "artifact" | "session" | "proposal" | "cleanup" | "claim") => string)
    | undefined;
}>;

export function createArtifactSessionManager(
  options: ArtifactSessionManagerOptions,
): ArtifactSessionManager {
  const allocateId = options.allocateId ?? ((kind) => `${kind}_${randomUUID()}`);
  const assertProvider = () =>
    verifyArtifactProviderContinuity(
      options.provider,
      options.expectedProviderIdentity,
      options.expectedCanary,
    );

  const createUploadSession = async (input: CreateUploadSessionInput): Promise<ArtifactSession> => {
    validateActorOperation(input.actorId, input.operationId);
    validateArtifactEnvelope(input.expectedByteLength, input.expectedSha256, input.mimeType);
    const now = input.now ?? new Date();
    const nowText = now.toISOString();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    const quotaWindowExpiresAt = new Date(now.getTime() + ARTIFACT_QUOTA_WINDOW_MS).toISOString();
    const artifactId = allocateId("artifact");
    const sessionId = allocateId("session");
    const reservationId = `quota_${sessionId}`;
    const logicalKey = artifactLogicalKey(artifactId);

    // Provider drift is rejected before SQL reserves quota or claims any artifact object.
    await assertProvider();
    return options.dialect.runtimeTransaction(async (transaction) => {
      await transaction.lock(quotaLock(options.identity, input.actorId));
      const reservations = await transaction.select<Record<string, unknown>>(
        "artifactQuotaReservations",
        {
          equals: { logicalHostId: options.identity.logicalHostId, actorId: input.actorId },
        },
      );
      const reserved = reservations.reduce(
        (sum, row) =>
          row.state === "released" ? sum : sum + safeInteger(row.reservedBytes, "reserved bytes"),
        0,
      );
      if (reserved + input.expectedByteLength > ARTIFACT_QUOTA_BYTES_PER_ACTOR_WINDOW) {
        throw new CapletsError("REQUEST_INVALID", "Portable artifact quota is exhausted.");
      }
      const common = commonValues(options.identity, nowText);
      await transaction.insert("artifactManifests", {
        ...common,
        id: artifactId,
        artifactId,
        providerIdentityId: options.expectedProviderIdentity.identityId,
        logicalKey,
        direction: "upload",
        actorId: input.actorId,
        operationId: input.operationId,
        byteLength: input.expectedByteLength,
        sha256: input.expectedSha256,
        mimeType: input.mimeType,
        partCount: 1,
        state: "staging",
        expiresAt,
      });
      await transaction.insert("artifactSessions", {
        ...common,
        id: sessionId,
        sessionId,
        artifactId,
        actorId: input.actorId,
        operationId: input.operationId,
        direction: "upload",
        state: "uploading",
        nextOffset: 0,
        expectedByteLength: input.expectedByteLength,
        expectedSha256: input.expectedSha256,
        mimeType: input.mimeType,
        providerIdentityId: options.expectedProviderIdentity.identityId,
        expiresAt,
      });
      await transaction.insert("artifactQuotaReservations", {
        ...common,
        id: reservationId,
        reservationId,
        actorId: input.actorId,
        sessionId,
        reservedBytes: input.expectedByteLength,
        state: "reserved",
        windowExpiresAt: quotaWindowExpiresAt,
      });
      return {
        sessionId,
        artifactId,
        actorId: input.actorId,
        operationId: input.operationId,
        direction: "upload",
        state: "uploading",
        nextOffset: 0,
        expectedByteLength: input.expectedByteLength,
        expectedSha256: input.expectedSha256,
        mimeType: input.mimeType,
        providerIdentityId: options.expectedProviderIdentity.identityId,
        expiresAt,
      };
    });
  };

  const status = async (sessionId: string, actorId: string, operationId: string) => {
    validateActorOperation(actorId, operationId);
    return options.dialect.snapshotTransaction(async (transaction) => {
      const row = await one(transaction, "artifactSessions", sessionId);
      if (!row) return undefined;
      const session = sessionFromRow(row);
      if (session.actorId !== actorId || session.operationId !== operationId) return undefined;
      return session;
    });
  };

  const append = async (input: AppendArtifactChunkInput): Promise<ArtifactSession> => {
    validateActorOperation(input.actorId, input.operationId);
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      input.bytes.byteLength === 0 ||
      input.bytes.byteLength > ARTIFACT_UPLOAD_CHUNK_BYTES ||
      input.bytes.byteLength > MAX_ARTIFACT_PART_BYTES ||
      !isSha256(input.chunkSha256) ||
      sha256Hex(input.bytes) !== input.chunkSha256
    ) {
      throw new CapletsError("REQUEST_INVALID", "Portable artifact chunk is invalid.");
    }
    const now = input.now ?? new Date();
    await assertProvider();
    const snapshot = await options.dialect.snapshotTransaction(async (transaction) => {
      const row = await one(transaction, "artifactSessions", input.sessionId);
      if (!row) return undefined;
      const session = sessionFromRow(row);
      const [latestPartRow] = await transaction.select<Record<string, unknown>>(
        "artifactParts",
        {
          equals: { logicalHostId: options.identity.logicalHostId, artifactId: session.artifactId },
        },
        [{ column: "ordinal", direction: "desc" }],
        1,
      );
      return { session, latestPart: latestPartRow ? partFromRow(latestPartRow) : undefined };
    });
    const session = snapshot?.session;
    requireLiveSession(session, input.actorId, input.operationId, now);
    if (session.nextOffset !== input.offset) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Portable artifact chunk offset does not match resumable status.",
      );
    }
    if (input.offset + input.bytes.byteLength > session.expectedByteLength) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Portable artifact chunk exceeds the declared envelope.",
      );
    }
    const latestPart = snapshot?.latestPart;
    if (
      latestPart
        ? latestPart.state !== "published" ||
          latestPart.offset + latestPart.byteLength !== session.nextOffset
        : session.nextOffset !== 0
    ) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Portable artifact part manifest does not match resumable status.",
      );
    }
    const ordinal = latestPart ? latestPart.ordinal + 1 : 0;
    const objectKey = artifactPartKey(session.artifactId, ordinal, input.chunkSha256);
    await options.provider.putImmutable(objectKey, input.bytes);
    return options.dialect.runtimeTransaction(async (transaction) => {
      await transaction.lock(sessionLock(options.identity, input.sessionId));
      const currentRow = await one(transaction, "artifactSessions", input.sessionId);
      const current = currentRow ? sessionFromRow(currentRow) : undefined;
      requireLiveSession(current, input.actorId, input.operationId, now);
      if (current.nextOffset !== input.offset) {
        if (current.nextOffset === input.offset + input.bytes.byteLength) return current;
        throw new CapletsError("REQUEST_INVALID", "Portable artifact upload offset became stale.");
      }
      const nowText = now.toISOString();
      const partId = `${session.artifactId}_${String(ordinal).padStart(3, "0")}`;
      await transaction.insert(
        "artifactParts",
        {
          ...commonValues(options.identity, nowText),
          id: partId,
          partId,
          artifactId: session.artifactId,
          ordinal,
          objectKey,
          offset: input.offset,
          byteLength: input.bytes.byteLength,
          sha256: input.chunkSha256,
          state: "published",
        },
        { target: ["logicalHostId", "artifactId", "ordinal"] },
      );
      const nextOffset = input.offset + input.bytes.byteLength;
      await transaction.update(
        "artifactSessions",
        { nextOffset, updatedAt: nowText },
        {
          equals: {
            logicalHostId: options.identity.logicalHostId,
            id: input.sessionId,
            state: "uploading",
            nextOffset: input.offset,
          },
        },
      );
      return { ...current, nextOffset };
    });
  };

  const finalize = async (
    sessionId: string,
    actorId: string,
    operationId: string,
    now = new Date(),
  ) => {
    validateActorOperation(actorId, operationId);
    await assertProvider();
    const snapshot = await loadSessionManifestParts(options, sessionId);
    requireLiveSession(snapshot?.session, actorId, operationId, now);
    if (!snapshot || snapshot.session.nextOffset !== snapshot.session.expectedByteLength) {
      throw new CapletsError("REQUEST_INVALID", "Portable artifact upload is incomplete.");
    }
    validateContiguousParts(snapshot.parts, snapshot.session.expectedByteLength);
    const digest = createHash("sha256");
    for (const part of snapshot.parts) {
      const head = await options.provider.head(part.objectKey);
      if (!head || head.size !== part.byteLength || head.sha256 !== part.sha256) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Portable artifact part continuity verification failed.",
        );
      }
      const bytes = await options.provider.getRange(part.objectKey, 0, part.byteLength);
      if (bytes.byteLength !== part.byteLength || sha256Hex(bytes) !== part.sha256) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Portable artifact part bytes changed before finalize.",
        );
      }
      digest.update(bytes);
    }
    if (digest.digest("hex") !== snapshot.session.expectedSha256) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Portable artifact envelope digest does not match.",
      );
    }
    const nowText = now.toISOString();
    const finalized = await options.dialect.runtimeTransaction(async (transaction) => {
      await transaction.lock(sessionLock(options.identity, sessionId));
      const row = await one(transaction, "artifactSessions", sessionId);
      const current = row ? sessionFromRow(row) : undefined;
      if (!current || current.actorId !== actorId || current.operationId !== operationId) {
        throw new CapletsError("AUTH_FAILED", "Portable artifact session binding is invalid.");
      }
      if (current.state === "finalized") return current;
      requireLiveSession(current, actorId, operationId, now);
      if (current.nextOffset !== current.expectedByteLength) {
        throw new CapletsError("REQUEST_INVALID", "Portable artifact upload is incomplete.");
      }
      await transaction.update(
        "artifactManifests",
        {
          state: "finalized",
          partCount: snapshot.parts.length,
          finalizedAt: nowText,
          updatedAt: nowText,
        },
        {
          equals: {
            logicalHostId: options.identity.logicalHostId,
            id: current.artifactId,
            state: "staging",
          },
        },
      );
      await transaction.update(
        "artifactSessions",
        {
          state: "finalized",
          finalizedAt: nowText,
          updatedAt: nowText,
        },
        {
          equals: {
            logicalHostId: options.identity.logicalHostId,
            id: sessionId,
            state: "uploading",
          },
        },
      );
      return { ...current, state: "finalized" as const, finalizedAt: nowText };
    });
    const manifest = {
      ...snapshot.manifest,
      state: "finalized" as const,
      partCount: snapshot.parts.length,
      finalizedAt: nowText,
    };
    return { session: finalized, manifest, artifact: descriptor(options, manifest, now) };
  };

  const readRange = async (
    artifactId: string,
    actorId: string,
    operationId: string,
    start: number,
    endExclusive: number,
  ): Promise<Buffer> => {
    validateActorOperation(actorId, operationId);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(endExclusive) ||
      start < 0 ||
      endExclusive <= start
    ) {
      throw new CapletsError("REQUEST_INVALID", "Portable artifact range is invalid.");
    }
    await assertProvider();
    const snapshot = await loadManifestParts(options, artifactId);
    if (
      !snapshot ||
      snapshot.manifest.state !== "finalized" ||
      snapshot.manifest.actorId !== actorId ||
      snapshot.manifest.operationId !== operationId ||
      endExclusive > snapshot.manifest.byteLength
    ) {
      throw new CapletsError("AUTH_FAILED", "Portable artifact reference is unavailable.");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (const part of snapshot.parts) {
      const partEnd = part.offset + part.byteLength;
      const overlapStart = Math.max(start, part.offset);
      const overlapEnd = Math.min(endExclusive, partEnd);
      if (overlapStart >= overlapEnd) continue;
      const chunk = await options.provider.getRange(
        part.objectKey,
        overlapStart - part.offset,
        overlapEnd - part.offset,
      );
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    if (total !== endExclusive - start) {
      throw new CapletsError("REQUEST_INVALID", "Portable artifact range is incomplete.");
    }
    return Buffer.concat(chunks, total);
  };

  const readFinalizedArtifact = async (
    artifactId: string,
    actorId: string,
    operationId: string,
  ) => {
    const manifest = await options.dialect.snapshotTransaction(async (transaction) => {
      const row = await one(transaction, "artifactManifests", artifactId);
      return row ? manifestFromRow(row) : undefined;
    });
    if (!manifest) throw new CapletsError("REQUEST_INVALID", "Portable artifact is absent.");
    return readRange(artifactId, actorId, operationId, 0, manifest.byteLength);
  };

  const publishDownloadArtifact = async (
    actorId: string,
    operationId: string,
    bytes: Uint8Array,
    mimeType: string,
    now = new Date(),
  ) => {
    const digest = sha256Hex(bytes);
    const created = await createUploadSession({
      actorId,
      operationId,
      expectedByteLength: bytes.byteLength,
      expectedSha256: digest,
      mimeType,
      now,
    });
    let offset = 0;
    while (offset < bytes.byteLength) {
      const end = Math.min(offset + ARTIFACT_UPLOAD_CHUNK_BYTES, bytes.byteLength);
      const chunk = bytes.subarray(offset, end);
      await append({
        actorId,
        operationId,
        sessionId: created.sessionId,
        offset,
        chunkSha256: sha256Hex(chunk),
        bytes: chunk,
        now,
      });
      offset = end;
    }
    const finalized = await finalize(created.sessionId, actorId, operationId, now);
    await options.dialect.runtimeTransaction(async (transaction) => {
      await transaction.lock(sessionLock(options.identity, created.sessionId));
      await transaction.update(
        "artifactSessions",
        { direction: "download", updatedAt: now.toISOString() },
        { equals: { logicalHostId: options.identity.logicalHostId, id: created.sessionId } },
      );
      await transaction.update(
        "artifactManifests",
        { direction: "download", updatedAt: now.toISOString() },
        { equals: { logicalHostId: options.identity.logicalHostId, id: created.artifactId } },
      );
    });
    const session = { ...finalized.session, direction: "download" as const };
    const manifest = { ...finalized.manifest, direction: "download" as const };
    return { session, manifest, artifact: descriptor(options, manifest, now) };
  };

  const createImportProposal = async (
    input: CreateImportProposalInput,
  ): Promise<ImportProposal> => {
    validateActorOperation(input.actorId, input.operationId);
    validateFence(input.fence);
    if (!isSha256(input.artifactSha256))
      throw new CapletsError("REQUEST_INVALID", "Artifact digest is invalid.");
    const now = input.now ?? new Date();
    await assertProvider();
    const snapshot = await loadManifestParts(options, input.artifactId);
    if (
      !snapshot ||
      snapshot.manifest.state !== "finalized" ||
      snapshot.manifest.actorId !== input.actorId ||
      snapshot.manifest.operationId !== input.operationId ||
      snapshot.manifest.sha256 !== input.artifactSha256
    ) {
      throw new CapletsError("AUTH_FAILED", "Finalized artifact binding is invalid.");
    }
    const expiresAt = new Date(now.getTime() + PROPOSAL_TTL_MS).toISOString();
    const quote = proposalQuote(input, snapshot.manifest, expiresAt);
    const proposalId = `proposal_${quote.proposalHash.slice(0, 32)}`;
    const proposal: ImportProposal = { proposalId, ...quote, state: "previewed", expiresAt };
    return options.dialect.runtimeTransaction(async (transaction) => {
      await transaction.lock(`import-proposal:${options.identity.logicalHostId}:${proposalId}`);
      const existing = await one(transaction, "importProposals", proposalId);
      if (existing) {
        const parsed = proposalFromRow(existing);
        if (parsed.proposalHash !== proposal.proposalHash) {
          throw new CapletsError("REQUEST_INVALID", "Import proposal identity conflicts.");
        }
        return parsed;
      }
      await transaction.insert("importProposals", {
        ...commonValues(options.identity, now.toISOString()),
        id: proposalId,
        ...proposal,
        replacementConfirmed:
          transaction.backend === "sqlite"
            ? Number(proposal.replacementConfirmed)
            : proposal.replacementConfirmed,
        differences: databaseJson(transaction, proposal.differences),
        setupDependencies: databaseJson(transaction, proposal.setupDependencies),
      });
      return proposal;
    });
  };

  const readImportProposal = async (proposalId: string) =>
    options.dialect.snapshotTransaction(async (transaction) => {
      const row = await one(transaction, "importProposals", proposalId);
      return row ? proposalFromRow(row) : undefined;
    });

  const consumeImportProposal = async <T>(
    input: ConsumeImportProposalInput,
    action: (transaction: ControlPlaneSqlTransaction, proposal: ImportProposal) => Promise<T>,
  ): Promise<ConsumeImportProposalResult<T>> => {
    validateActorOperation(input.actorId, input.operationId);
    validateFence(input.fence);
    const now = input.now ?? new Date();
    return options.dialect.runtimeTransaction(async (transaction) => {
      await transaction.lock(
        `import-proposal:${options.identity.logicalHostId}:${input.proposalId}`,
      );
      const row = await one(transaction, "importProposals", input.proposalId);
      if (!row) return { status: "rejected", reason: "not-found" };
      const proposal = proposalFromRow(row);
      if (proposal.actorId !== input.actorId) return { status: "rejected", reason: "wrong-actor" };
      if (proposal.operationId !== input.operationId)
        return { status: "rejected", reason: "wrong-operation" };
      if (proposal.state === "consumed") return { status: "rejected", reason: "consumed" };
      if (proposal.state !== "previewed" || Date.parse(proposal.expiresAt) <= now.getTime()) {
        return { status: "rejected", reason: "expired" };
      }
      if (proposal.proposalHash !== input.proposalHash)
        return { status: "rejected", reason: "proposal-mismatch" };
      const manifestRow = await one(transaction, "artifactManifests", proposal.artifactId);
      const manifest = manifestRow ? manifestFromRow(manifestRow) : undefined;
      if (!manifest || manifest.state !== "finalized" || manifest.sha256 !== input.artifactSha256) {
        return { status: "rejected", reason: "changed-bytes" };
      }
      if (!sameFence(proposal, input.fence))
        return { status: "rejected", reason: "stale-generation" };
      const value = await action(transaction, proposal);
      const consumedAt = now.toISOString();
      const changed = await transaction.update(
        "importProposals",
        {
          state: "consumed",
          consumedAt,
          updatedAt: consumedAt,
        },
        {
          equals: {
            logicalHostId: options.identity.logicalHostId,
            id: proposal.proposalId,
            state: "previewed",
          },
        },
      );
      if (changed !== 1)
        throw new CapletsError("REQUEST_INVALID", "Import proposal consumption lost its fence.");
      await markArtifactForCleanup(
        transaction,
        options.identity,
        proposal.artifactId,
        allocateId("cleanup"),
        consumedAt,
      );
      return {
        status: "committed",
        value,
        proposal: { ...proposal, state: "consumed", consumedAt },
      };
    });
  };

  const expire = async (now = new Date()) =>
    options.dialect.runtimeTransaction(async (transaction) => {
      const nowText = now.toISOString();
      let expiredSessions = 0;
      let expiredProposals = 0;
      let cleanupIntents = 0;
      const sessions = await transaction.select<Record<string, unknown>>(
        "artifactSessions",
        {
          equals: { logicalHostId: options.identity.logicalHostId },
        },
        [{ column: "expiresAt", direction: "asc" }],
        MAX_CLEANUP_BATCH,
      );
      for (const row of sessions) {
        const session = sessionFromRow(row);
        if (
          !(["uploading", "finalized"] as ArtifactSessionState[]).includes(session.state) ||
          Date.parse(session.expiresAt) > now.getTime()
        )
          continue;
        await transaction.lock(sessionLock(options.identity, session.sessionId));
        const changed = await transaction.update(
          "artifactSessions",
          { state: "expired", updatedAt: nowText },
          {
            equals: {
              logicalHostId: options.identity.logicalHostId,
              id: session.sessionId,
              state: session.state,
            },
          },
        );
        if (changed === 1) {
          expiredSessions += 1;
          cleanupIntents += await markArtifactForCleanup(
            transaction,
            options.identity,
            session.artifactId,
            allocateId("cleanup"),
            nowText,
          );
        }
      }
      const proposals = await transaction.select<Record<string, unknown>>(
        "importProposals",
        {
          equals: { logicalHostId: options.identity.logicalHostId, state: "previewed" },
        },
        [{ column: "expiresAt", direction: "asc" }],
        MAX_CLEANUP_BATCH,
      );
      for (const row of proposals) {
        const proposal = proposalFromRow(row);
        if (Date.parse(proposal.expiresAt) > now.getTime()) continue;
        const changed = await transaction.update(
          "importProposals",
          { state: "expired", updatedAt: nowText },
          {
            equals: {
              logicalHostId: options.identity.logicalHostId,
              id: proposal.proposalId,
              state: "previewed",
            },
          },
        );
        if (changed === 1) {
          expiredProposals += 1;
          cleanupIntents += await markArtifactForCleanup(
            transaction,
            options.identity,
            proposal.artifactId,
            allocateId("cleanup"),
            nowText,
          );
        }
      }
      return { expiredSessions, expiredProposals, cleanupIntents };
    });

  const resumeCleanup = async (cleanupId: string, now = new Date()) => {
    await assertProvider();
    const claimId = allocateId("claim");
    const claim = await options.dialect.runtimeTransaction(async (transaction) => {
      await transaction.lock(`artifact-cleanup:${options.identity.logicalHostId}:${cleanupId}`);
      const row = await one(transaction, "artifactCleanupIntents", cleanupId);
      if (!row) throw new CapletsError("REQUEST_INVALID", "Artifact cleanup intent is absent.");
      if (row.state === "completed") return undefined;
      if (row.providerIdentityId !== options.expectedProviderIdentity.identityId) {
        throw new CapletsError("AUTH_FAILED", "Artifact cleanup provider identity drifted.");
      }
      const expires = typeof row.claimExpiresAt === "string" ? Date.parse(row.claimExpiresAt) : 0;
      if (row.state === "claimed" && expires > now.getTime()) return null;
      const claimExpiresAt = new Date(now.getTime() + CLEANUP_CLAIM_TTL_MS).toISOString();
      await transaction.update(
        "artifactCleanupIntents",
        {
          state: "claimed",
          claimId,
          claimExpiresAt,
          updatedAt: now.toISOString(),
        },
        { equals: { logicalHostId: options.identity.logicalHostId, id: cleanupId } },
      );
      return { artifactId: requiredString(row.artifactId, "cleanup artifact"), claimExpiresAt };
    });
    if (claim === null) return { status: "busy" as const, removedParts: 0 };
    if (claim === undefined) return { status: "completed" as const, removedParts: 0 };
    const snapshot = await loadManifestParts(options, claim.artifactId);
    if (!snapshot)
      throw new CapletsError("REQUEST_INVALID", "Artifact cleanup manifest is absent.");
    let removedParts = 0;
    for (const part of snapshot.parts) {
      await options.provider.delete(part.objectKey);
      const head = await options.provider.head(part.objectKey);
      if (head)
        throw new CapletsError(
          "REQUEST_INVALID",
          "Artifact cleanup could not verify object absence.",
        );
      removedParts += 1;
    }
    const completedAt = now.toISOString();
    await options.dialect.runtimeTransaction(async (transaction) => {
      await transaction.lock(`artifact-cleanup:${options.identity.logicalHostId}:${cleanupId}`);
      const row = await one(transaction, "artifactCleanupIntents", cleanupId);
      if (!row || row.state !== "claimed" || row.claimId !== claimId) {
        throw new CapletsError("REQUEST_INVALID", "Artifact cleanup claim became stale.");
      }
      for (const part of snapshot.parts) {
        await transaction.update(
          "artifactParts",
          {
            state: "destroyed",
            absentVerifiedAt: completedAt,
            updatedAt: completedAt,
          },
          { equals: { logicalHostId: options.identity.logicalHostId, id: part.partId } },
        );
      }
      await transaction.update(
        "artifactManifests",
        {
          state: "destroyed",
          destroyedAt: completedAt,
          updatedAt: completedAt,
        },
        {
          equals: {
            logicalHostId: options.identity.logicalHostId,
            id: snapshot.manifest.artifactId,
          },
        },
      );
      const artifactSessions = await transaction.select<Record<string, unknown>>(
        "artifactSessions",
        {
          equals: {
            logicalHostId: options.identity.logicalHostId,
            artifactId: snapshot.manifest.artifactId,
          },
        },
      );
      for (const session of artifactSessions) {
        await transaction.update(
          "artifactQuotaReservations",
          { state: "released", releasedAt: completedAt, updatedAt: completedAt },
          {
            equals: {
              logicalHostId: options.identity.logicalHostId,
              sessionId: session.sessionId,
            },
          },
        );
      }
      await transaction.update(
        "artifactCleanupIntents",
        {
          state: "completed",
          completedAt,
          receipt: databaseJson(transaction, { removedParts, verifiedAbsent: true, completedAt }),
          updatedAt: completedAt,
        },
        { equals: { logicalHostId: options.identity.logicalHostId, id: cleanupId, claimId } },
      );
    });
    return { status: "completed" as const, removedParts };
  };

  return {
    identity: options.identity,
    providerIdentity: options.expectedProviderIdentity,
    createUploadSession,
    status,
    append,
    finalize,
    readFinalizedArtifact,
    publishDownloadArtifact,
    readRange,
    createImportProposal,
    readImportProposal,
    consumeImportProposal,
    expire,
    resumeCleanup,
  };
}

async function loadSessionManifestParts(options: ArtifactSessionManagerOptions, sessionId: string) {
  return options.dialect.snapshotTransaction(async (transaction) => {
    const sessionRow = await one(transaction, "artifactSessions", sessionId);
    if (!sessionRow) return undefined;
    const session = sessionFromRow(sessionRow);
    const manifestRow = await one(transaction, "artifactManifests", session.artifactId);
    if (!manifestRow) return undefined;
    const parts = await transaction.select<Record<string, unknown>>(
      "artifactParts",
      {
        equals: { logicalHostId: options.identity.logicalHostId, artifactId: session.artifactId },
      },
      [{ column: "ordinal", direction: "asc" }],
    );
    return { session, manifest: manifestFromRow(manifestRow), parts: parts.map(partFromRow) };
  });
}

async function loadManifestParts(options: ArtifactSessionManagerOptions, artifactId: string) {
  return options.dialect.snapshotTransaction(async (transaction) => {
    const manifestRow = await one(transaction, "artifactManifests", artifactId);
    if (!manifestRow) return undefined;
    const parts = await transaction.select<Record<string, unknown>>(
      "artifactParts",
      {
        equals: { logicalHostId: options.identity.logicalHostId, artifactId },
      },
      [{ column: "ordinal", direction: "asc" }],
    );
    return { manifest: manifestFromRow(manifestRow), parts: parts.map(partFromRow) };
  });
}

async function one(
  transaction: ControlPlaneSqlTransaction,
  table: Parameters<ControlPlaneSqlTransaction["select"]>[0],
  id: string,
) {
  const rows = await transaction.select<Record<string, unknown>>(
    table,
    { equals: { id } },
    undefined,
    1,
  );
  return rows[0];
}

async function markArtifactForCleanup(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  artifactId: string,
  cleanupId: string,
  now: string,
): Promise<number> {
  await transaction.lock(`artifact-cleanup-by-artifact:${identity.logicalHostId}:${artifactId}`);
  const existing = await transaction.select<Record<string, unknown>>(
    "artifactCleanupIntents",
    {
      equals: { logicalHostId: identity.logicalHostId, artifactId },
    },
    undefined,
    1,
  );
  if (existing.length > 0) return 0;
  const manifestRows = await transaction.select<Record<string, unknown>>(
    "artifactManifests",
    {
      equals: { logicalHostId: identity.logicalHostId, id: artifactId },
    },
    undefined,
    1,
  );
  const manifest = manifestRows[0];
  if (!manifest || manifest.state === "destroyed") return 0;
  const parts = await transaction.select<Record<string, unknown>>(
    "artifactParts",
    {
      equals: { logicalHostId: identity.logicalHostId, artifactId },
    },
    [{ column: "ordinal", direction: "asc" }],
  );
  const inventoryHash = hashCanonical(
    parts.map((part) => ({
      objectKey: part.objectKey,
      byteLength: part.byteLength,
      sha256: part.sha256,
    })),
  );
  await transaction.insert("artifactCleanupIntents", {
    ...commonValues(identity, now),
    id: cleanupId,
    cleanupId,
    artifactId,
    providerIdentityId: manifest.providerIdentityId,
    inventoryHash,
    state: "intended",
  });
  await transaction.update(
    "artifactManifests",
    { state: "destruction-intended", updatedAt: now },
    {
      equals: { logicalHostId: identity.logicalHostId, id: artifactId },
    },
  );
  await transaction.update(
    "artifactParts",
    { state: "destruction-intended", updatedAt: now },
    {
      equals: { logicalHostId: identity.logicalHostId, artifactId },
    },
  );
  const sessions = await transaction.select<Record<string, unknown>>("artifactSessions", {
    equals: { logicalHostId: identity.logicalHostId, artifactId },
  });
  for (const session of sessions) {
    await transaction.update(
      "artifactQuotaReservations",
      { state: "destruction-intended", updatedAt: now },
      {
        equals: {
          logicalHostId: identity.logicalHostId,
          sessionId: session.sessionId,
          state: "reserved",
        },
      },
    );
  }
  return 1;
}

function descriptor(
  options: ArtifactSessionManagerOptions,
  manifest: ArtifactManifest,
  now: Date,
): PortableArtifactDescriptor {
  return {
    reference: createPortableArtifactReference({
      artifactId: manifest.artifactId,
      logicalHostId: options.identity.logicalHostId,
      storeId: options.identity.storeId,
      providerIdentityId: manifest.providerIdentityId,
      actorId: manifest.actorId,
      operationId: manifest.operationId,
      direction: manifest.direction,
      byteLength: manifest.byteLength,
      sha256: manifest.sha256,
      mimeType: manifest.mimeType,
      expiresAt: new Date(now.getTime() + ARTIFACT_REFERENCE_TTL_MS).toISOString(),
    }),
    sha256: manifest.sha256,
    byteLength: manifest.byteLength,
    mimeType: manifest.mimeType,
  };
}

function proposalQuote(
  input: CreateImportProposalInput,
  manifest: ArtifactManifest,
  expiresAt: string,
): Omit<ImportProposal, "proposalId" | "state" | "expiresAt" | "consumedAt"> {
  const quoted = {
    artifactId: input.artifactId,
    artifactSha256: manifest.sha256,
    actorId: input.actorId,
    operationId: input.operationId,
    capletId: input.capletId,
    expectedAuthorityGeneration: input.fence.authorityGeneration,
    expectedEffectiveGeneration: input.fence.effectiveGeneration,
    expectedAggregateVersion: input.fence.aggregateVersion,
    expectedSecurityEpoch: input.fence.securityEpoch,
    expectedRuntimeFingerprint: input.fence.runtimeFingerprint,
    collisionPolicy: input.collisionPolicy,
    replacementConfirmed: input.replacementConfirmed,
    consequence: input.consequence,
    differences: [...input.differences].sort((left, right) =>
      left.field.localeCompare(right.field),
    ),
    setupDependencies: [...input.setupDependencies].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    expiresAt,
  } as const;
  return {
    ...quoted,
    proposalHash: hashCanonical({ domain: "caplets/import-proposal/v1", ...quoted }),
  };
}

function validateContiguousParts(parts: readonly ArtifactPart[], byteLength: number): void {
  let offset = 0;
  for (const [ordinal, part] of parts.entries()) {
    if (part.ordinal !== ordinal || part.offset !== offset || part.state !== "published") {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Portable artifact part manifest is not contiguous.",
      );
    }
    offset += part.byteLength;
  }
  if (offset !== byteLength || parts.length === 0 || parts.length > 256) {
    throw new CapletsError("REQUEST_INVALID", "Portable artifact part manifest is incomplete.");
  }
}

function requireLiveSession(
  session: ArtifactSession | undefined,
  actorId: string,
  operationId: string,
  now: Date,
): asserts session is ArtifactSession {
  if (!session || session.actorId !== actorId || session.operationId !== operationId) {
    throw new CapletsError("AUTH_FAILED", "Portable artifact session binding is invalid.");
  }
  if (session.state !== "uploading")
    throw new CapletsError("REQUEST_INVALID", "Portable artifact session is not writable.");
  if (Date.parse(session.expiresAt) <= now.getTime())
    throw new CapletsError("REQUEST_INVALID", "Portable artifact session expired.");
}

function validateArtifactEnvelope(byteLength: number, sha256: string, mimeType: string): void {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength <= 0 ||
    byteLength > MAX_PORTABLE_ARTIFACT_BYTES ||
    !isSha256(sha256) ||
    typeof mimeType !== "string" ||
    !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/iu.test(mimeType)
  ) {
    throw new CapletsError("REQUEST_INVALID", "Portable artifact envelope declaration is invalid.");
  }
}

function validateActorOperation(actorId: string, operationId: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(actorId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(operationId)
  ) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Portable artifact actor or operation binding is invalid.",
    );
  }
}

function validateFence(fence: ArtifactFence): void {
  for (const value of [
    fence.authorityGeneration,
    fence.effectiveGeneration,
    fence.securityEpoch,
    fence.aggregateVersion,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new CapletsError("REQUEST_INVALID", "Portable import fence is invalid.");
  }
  if (!isSha256(fence.runtimeFingerprint))
    throw new CapletsError("REQUEST_INVALID", "Portable import runtime fingerprint is invalid.");
}

function sameFence(proposal: ImportProposal, fence: ArtifactFence): boolean {
  return (
    proposal.expectedAuthorityGeneration === fence.authorityGeneration &&
    proposal.expectedEffectiveGeneration === fence.effectiveGeneration &&
    proposal.expectedSecurityEpoch === fence.securityEpoch &&
    proposal.expectedAggregateVersion === fence.aggregateVersion &&
    proposal.expectedRuntimeFingerprint === fence.runtimeFingerprint
  );
}

function commonValues(identity: ControlPlaneStoreIdentity, now: string) {
  return {
    modelVersion: 1,
    logicalHostId: identity.logicalHostId,
    storeId: identity.storeId,
    createdAt: now,
    updatedAt: now,
    aggregateVersion: 0,
    authorityVersion: 0,
    effectiveVersion: 0,
    securityVersion: 0,
  } as const;
}

function sessionFromRow(row: Record<string, unknown>): ArtifactSession {
  return {
    sessionId: requiredString(row.sessionId, "session ID"),
    artifactId: requiredString(row.artifactId, "artifact ID"),
    actorId: requiredString(row.actorId, "actor ID"),
    operationId: requiredString(row.operationId, "operation ID"),
    direction: enumValue(row.direction, ["upload", "download"], "artifact direction"),
    state: enumValue(
      row.state,
      ["uploading", "finalized", "consumed", "revoked", "expired"],
      "session state",
    ),
    nextOffset: safeInteger(row.nextOffset, "next offset"),
    expectedByteLength: safeInteger(row.expectedByteLength, "expected byte length"),
    expectedSha256: requiredString(row.expectedSha256, "expected digest"),
    mimeType: requiredString(row.mimeType, "MIME type"),
    providerIdentityId: requiredString(row.providerIdentityId, "provider identity"),
    expiresAt: requiredString(row.expiresAt, "session expiry"),
    ...(typeof row.finalizedAt === "string" ? { finalizedAt: row.finalizedAt } : {}),
    ...(typeof row.revokedAt === "string" ? { revokedAt: row.revokedAt } : {}),
  };
}

function manifestFromRow(row: Record<string, unknown>): ArtifactManifest {
  return {
    artifactId: requiredString(row.artifactId, "artifact ID"),
    providerIdentityId: requiredString(row.providerIdentityId, "provider identity"),
    logicalKey: requiredString(row.logicalKey, "artifact logical key"),
    direction: enumValue(row.direction, ["upload", "download"], "artifact direction"),
    actorId: requiredString(row.actorId, "actor ID"),
    operationId: requiredString(row.operationId, "operation ID"),
    byteLength: safeInteger(row.byteLength, "artifact byte length"),
    sha256: requiredString(row.sha256, "artifact digest"),
    mimeType: requiredString(row.mimeType, "MIME type"),
    partCount: safeInteger(row.partCount, "artifact part count"),
    state: enumValue(
      row.state,
      ["staging", "finalized", "destruction-intended", "destroyed"],
      "manifest state",
    ),
    expiresAt: requiredString(row.expiresAt, "manifest expiry"),
    ...(typeof row.finalizedAt === "string" ? { finalizedAt: row.finalizedAt } : {}),
    ...(typeof row.destroyedAt === "string" ? { destroyedAt: row.destroyedAt } : {}),
  };
}

function partFromRow(row: Record<string, unknown>): ArtifactPart {
  return {
    partId: requiredString(row.partId, "part ID"),
    artifactId: requiredString(row.artifactId, "artifact ID"),
    ordinal: safeInteger(row.ordinal, "part ordinal"),
    objectKey: requiredString(row.objectKey, "part object key"),
    offset: safeInteger(row.offset, "part offset"),
    byteLength: safeInteger(row.byteLength, "part byte length"),
    sha256: requiredString(row.sha256, "part digest"),
    state: enumValue(row.state, ["published", "destruction-intended", "destroyed"], "part state"),
    ...(typeof row.absentVerifiedAt === "string" ? { absentVerifiedAt: row.absentVerifiedAt } : {}),
  };
}

function proposalFromRow(row: Record<string, unknown>): ImportProposal {
  return {
    proposalId: requiredString(row.proposalId, "proposal ID"),
    artifactId: requiredString(row.artifactId, "artifact ID"),
    actorId: requiredString(row.actorId, "actor ID"),
    operationId: requiredString(row.operationId, "operation ID"),
    capletId: requiredString(row.capletId, "Caplet ID"),
    proposalHash: requiredString(row.proposalHash, "proposal hash"),
    expectedAuthorityGeneration: safeInteger(
      row.expectedAuthorityGeneration,
      "authority generation",
    ),
    expectedEffectiveGeneration: safeInteger(
      row.expectedEffectiveGeneration,
      "effective generation",
    ),
    expectedAggregateVersion: safeInteger(row.expectedAggregateVersion, "aggregate version"),
    expectedSecurityEpoch: safeInteger(row.expectedSecurityEpoch, "security epoch"),
    expectedRuntimeFingerprint: requiredString(
      row.expectedRuntimeFingerprint,
      "runtime fingerprint",
    ),
    collisionPolicy: enumValue(row.collisionPolicy, ["reject", "replace"], "collision policy"),
    replacementConfirmed: row.replacementConfirmed === true || row.replacementConfirmed === 1,
    consequence: enumValue(
      row.consequence,
      ["effective-runtime-changes", "no-effective-change-while-shadowed"],
      "proposal consequence",
    ),
    differences: jsonValue(row.differences) as ImportProposalDifference[],
    setupDependencies: jsonValue(row.setupDependencies) as ImportSetupDependency[],
    state: enumValue(row.state, ["previewed", "consumed", "expired", "rejected"], "proposal state"),
    expiresAt: requiredString(row.expiresAt, "proposal expiry"),
    ...(typeof row.consumedAt === "string" ? { consumedAt: row.consumedAt } : {}),
  };
}

function databaseJson(transaction: ControlPlaneSqlTransaction, value: unknown): unknown {
  const canonical = JSON.parse(stableJsonStringify(value));
  return transaction.backend === "sqlite" ? stableJsonStringify(canonical) : canonical;
}

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function artifactLogicalKey(artifactId: string): string {
  return `portable/${artifactId}`;
}

function artifactPartKey(artifactId: string, ordinal: number, digest: string): string {
  return `portable/${artifactId}/parts/${String(ordinal).padStart(3, "0")}-${digest}.bin`;
}

function quotaLock(identity: ControlPlaneStoreIdentity, actorId: string): string {
  return `artifact-quota:${identity.logicalHostId}:${identity.storeId}:${actorId}`;
}

function sessionLock(identity: ControlPlaneStoreIdentity, sessionId: string): string {
  return `artifact-session:${identity.logicalHostId}:${identity.storeId}:${sessionId}`;
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${label}`);
  return value;
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid ${label}`);
  return value;
}

function enumValue<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new Error(`Invalid ${label}`);
  return value as T;
}
