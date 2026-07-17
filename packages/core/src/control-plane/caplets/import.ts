import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  CurrentHostOperationBinding,
  CurrentHostOperationReceipt,
} from "../../current-host/operations";
import type { PortableArtifactReference } from "../../media/artifacts";
import { stableJsonStringify } from "../../stable-json";
import type { ControlPlaneSqlTransaction } from "../store";
import {
  type ArtifactFence,
  type ArtifactSessionManager,
  type ImportCollisionPolicy,
  type ImportProposal,
  type ImportProposalDifference,
  type ImportSetupDependency,
} from "../artifacts/sessions";
import {
  classifyCapletPlacement,
  type CanonicalCapletAggregate,
  type CanonicalCapletRelationalProjection,
  type PortableCaplet,
  type PortableJson,
} from "./model";
import { decodePortableCapletArtifact, portableBackendSourceDefinition } from "./portable-codec";

export type PortableImportTargetSnapshot = Readonly<{
  existingSql?:
    | Readonly<{
        aggregateVersion: number;
        portable: PortableCaplet;
      }>
    | undefined;
  filesystemOwned: boolean;
  fence: ArtifactFence;
}>;

export type PortableImportPreviewResult =
  | Readonly<{ status: "previewed"; proposal: ImportProposal; portable: PortableCaplet }>
  | Readonly<{
      status: "rejected";
      reason: "filesystem-owned" | "sql-collision" | "replacement-unconfirmed";
    }>;

export type PortableImportActivationResult =
  | Readonly<{
      status: "committed";
      receipt: CurrentHostOperationReceipt;
      aggregate: CanonicalCapletAggregate;
      projection: CanonicalCapletRelationalProjection;
    }>
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

export interface PortableCapletImportService {
  preview(
    input: Readonly<{
      actorId: string;
      binding: CurrentHostOperationBinding;
      artifactReference: PortableArtifactReference;
      collisionPolicy: ImportCollisionPolicy;
      replacementConfirmed: boolean;
      now?: Date | undefined;
    }>,
  ): Promise<PortableImportPreviewResult>;
  activate(
    input: Readonly<{
      actorId: string;
      binding: CurrentHostOperationBinding;
      proposalId: string;
      proposalHash: string;
      now?: Date | undefined;
    }>,
  ): Promise<PortableImportActivationResult>;
}

export type PortableCapletImportServiceOptions = Readonly<{
  sessions: ArtifactSessionManager;
  loadTarget(
    input: Readonly<{
      binding: CurrentHostOperationBinding;
      capletId: string;
    }>,
  ): Promise<PortableImportTargetSnapshot>;
  activate(
    transaction: ControlPlaneSqlTransaction,
    input: Readonly<{
      binding: CurrentHostOperationBinding;
      proposal: ImportProposal;
      aggregate: CanonicalCapletAggregate;
      projection: CanonicalCapletRelationalProjection;
      fence: ArtifactFence;
    }>,
  ): Promise<CurrentHostOperationReceipt>;
  applyCommitted?: (() => void | Promise<void>) | undefined;
}>;

export function createPortableCapletImportService(
  options: PortableCapletImportServiceOptions,
): PortableCapletImportService {
  return {
    async preview(input) {
      assertArtifactBinding(
        options.sessions,
        input.binding,
        input.actorId,
        input.artifactReference,
      );
      const bytes = await options.sessions.readFinalizedArtifact(
        input.artifactReference.artifactId,
        input.actorId,
        input.binding.operationId,
      );
      if (sha256(bytes) !== input.artifactReference.sha256) {
        throw new Error("Portable artifact bytes changed before preview");
      }
      const portable = decodePortableCapletArtifact(bytes);
      const target = await options.loadTarget({ binding: input.binding, capletId: portable.id });
      const placement = classifyCapletPlacement({
        existingSql: target.existingSql !== undefined,
        filesystemOwned: target.filesystemOwned,
        replacingSql: input.collisionPolicy === "replace" && input.replacementConfirmed,
        setupComplete: setupDependencies(portable).every(
          (dependency) => dependency.status === "satisfied",
        ),
      });
      if (placement.state === "filesystem-ownership-rejected") {
        return { status: "rejected", reason: "filesystem-owned" };
      }
      if (placement.state === "default-sql-id-collision") {
        return { status: "rejected", reason: "sql-collision" };
      }
      if (
        target.existingSql &&
        input.collisionPolicy === "replace" &&
        !input.replacementConfirmed
      ) {
        return { status: "rejected", reason: "replacement-unconfirmed" };
      }
      const proposal = await options.sessions.createImportProposal({
        actorId: input.actorId,
        operationId: input.binding.operationId,
        artifactId: input.artifactReference.artifactId,
        capletId: portable.id,
        artifactSha256: input.artifactReference.sha256,
        fence: target.fence,
        collisionPolicy: input.collisionPolicy,
        replacementConfirmed: input.replacementConfirmed,
        consequence: "effective-runtime-changes",
        differences: portableDifferences(target.existingSql?.portable, portable),
        setupDependencies: setupDependencies(portable),
        now: input.now,
      });
      return { status: "previewed", proposal, portable };
    },

    async activate(input) {
      const proposal = await options.sessions.readImportProposal(input.proposalId);
      if (!proposal) return { status: "rejected", reason: "not-found" };
      const bytes = await options.sessions.readFinalizedArtifact(
        proposal.artifactId,
        input.actorId,
        input.binding.operationId,
      );
      const artifactSha256 = sha256(bytes);
      const portable = decodePortableCapletArtifact(bytes);
      const target = await options.loadTarget({
        binding: input.binding,
        capletId: proposal.capletId,
      });
      if (target.filesystemOwned) {
        return { status: "rejected", reason: "stale-generation" };
      }
      const setup = setupDependencies(portable);
      const activation = setup.some((dependency) => dependency.status === "required")
        ? "setup-required"
        : "active";
      const aggregateVersion = target.existingSql ? target.existingSql.aggregateVersion + 1 : 1;
      const aggregate: CanonicalCapletAggregate = {
        modelVersion: 1,
        id: portable.id,
        aggregateVersion,
        ownership: "sql",
        activation,
        effective: activation === "active",
        portable,
        updateState: "current",
      };
      const projection = relationalProjection(
        portable,
        aggregateVersion,
        target.fence,
        input.actorId,
        input.now ?? new Date(),
        target.existingSql !== undefined,
      );
      const consumed = await options.sessions.consumeImportProposal(
        {
          actorId: input.actorId,
          operationId: input.binding.operationId,
          proposalId: input.proposalId,
          proposalHash: input.proposalHash,
          artifactSha256,
          fence: target.fence,
          now: input.now,
        },
        async (transaction, storedProposal) =>
          options.activate(transaction, {
            binding: input.binding,
            proposal: storedProposal,
            aggregate,
            projection,
            fence: target.fence,
          }),
      );
      if (consumed.status === "rejected") return consumed;
      await options.applyCommitted?.();
      return { status: "committed", receipt: consumed.value, aggregate, projection };
    },
  };
}

export function relationalProjection(
  portable: PortableCaplet,
  aggregateVersion: number,
  fence: ArtifactFence,
  actorId: string,
  now: Date,
  replacing: boolean,
): CanonicalCapletRelationalProjection {
  return {
    capletId: portable.id,
    sourceFrontmatter: portable.frontmatter.source,
    body: portable.body,
    backends: portableBackendRows(portable),
    assets: portable.assets.map((asset, ordinal) => ({
      capletId: portable.id,
      ordinal,
      path: asset.path,
      role: asset.role,
      mediaType: asset.mediaType,
      content: Buffer.from(asset.content, "base64"),
      contentHash: asset.contentHash,
    })),
    references: portable.references.map((reference, ordinal) => ({
      capletId: portable.id,
      ordinal,
      reference,
    })),
    activationHistory: [
      {
        capletId: portable.id,
        sequence: aggregateVersion,
        from: replacing ? "active" : "absent",
        to: setupDependencies(portable).some((dependency) => dependency.status === "required")
          ? "setup-required"
          : "active",
        reason: replacing ? "sql-replaced" : "imported",
        actorId,
        aggregateVersion,
        authorityVersion: fence.authorityGeneration,
        effectiveVersion: fence.effectiveGeneration,
        occurredAt: now.toISOString(),
      },
    ],
  };
}

function portableBackendRows(
  portable: PortableCaplet,
): CanonicalCapletRelationalProjection["backends"] {
  const config = portable.frontmatter.backend.config;
  if (!isPortableObject(config)) throw new Error("Portable backend configuration is malformed");
  const rows: CanonicalCapletRelationalProjection["backends"] = [];
  for (const [sourceField, sourceConfig] of Object.entries(config)) {
    const definition = portableBackendSourceDefinition(sourceField);
    if (
      !definition ||
      (portable.frontmatter.backend.kind !== "mixed" &&
        definition.kind !== portable.frontmatter.backend.kind)
    ) {
      continue;
    }
    if (!isPortableObject(sourceConfig)) {
      throw new Error(`Portable ${sourceField} configuration is malformed`);
    }
    const singular =
      definition.cardinality === "singular" ||
      (definition.cardinality === "singular-or-plural" && Object.hasOwn(sourceConfig, "actions"));
    if (singular) {
      rows.push({
        capletId: portable.id,
        ordinal: rows.length,
        kind: definition.kind,
        config: sourceConfig,
      });
      continue;
    }
    for (const [childId, childConfig] of Object.entries(sourceConfig)) {
      if (!isPortableObject(childConfig))
        throw new Error(`Portable ${sourceField}.${childId} is malformed`);
      rows.push({
        capletId: portable.id,
        ordinal: rows.length,
        childId,
        kind: definition.kind,
        config: childConfig,
      });
    }
  }
  if (rows.length === 0) throw new Error("Portable Caplet has no supported backend projection");
  return rows;
}

function portableDifferences(
  before: PortableCaplet | undefined,
  after: PortableCaplet,
): ImportProposalDifference[] {
  const fields = ["name", "description", "frontmatter", "body", "assets", "references"] as const;
  return fields.map((field) => {
    const beforeValue = before?.[field];
    const afterValue = after[field];
    const unchanged = before !== undefined && isDeepStrictEqual(beforeValue, afterValue);
    return {
      field,
      ...(beforeValue === undefined ? {} : { beforeHash: hashCanonical(beforeValue) }),
      afterHash: hashCanonical(afterValue),
      effect: beforeValue === undefined ? "added" : unchanged ? "unchanged" : "changed",
    };
  });
}

function setupDependencies(portable: PortableCaplet): ImportSetupDependency[] {
  return portable.references
    .filter((reference) => reference.type === "unresolved-setup")
    .map((reference) => ({
      name: reference.name,
      type: "unresolved-setup" as const,
      status: "required" as const,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function assertArtifactBinding(
  sessions: ArtifactSessionManager,
  binding: CurrentHostOperationBinding,
  actorId: string,
  reference: PortableArtifactReference,
): void {
  if (
    actorId !== binding.actorId ||
    reference.actorId !== actorId ||
    reference.operationId !== binding.operationId ||
    reference.logicalHostId !== binding.logicalHostId ||
    reference.storeId !== binding.storeId ||
    reference.providerIdentityId !== sessions.providerIdentity.identityId ||
    reference.direction !== "upload" ||
    Date.parse(reference.expiresAt) <= Date.now()
  ) {
    throw new Error("Portable artifact reference binding is invalid");
  }
}

function isPortableObject(value: PortableJson): value is Record<string, PortableJson> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}
