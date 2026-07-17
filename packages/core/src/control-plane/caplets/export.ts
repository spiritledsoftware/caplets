import { createHash } from "node:crypto";
import type { CurrentHostOperationBinding } from "../../current-host/operations";
import type { ArtifactSessionManager, PortableArtifactDescriptor } from "../artifacts/sessions";
import {
  type CanonicalCapletAggregate,
  type CanonicalCapletRelationalProjection,
  validateCapletRelationalProjection,
} from "./model";
import { encodePortableCapletArtifact } from "./portable-codec";

export type DeterministicPortableExport = Readonly<{
  bytes: Uint8Array;
  sha256: string;
  byteLength: number;
  mimeType: "text/markdown; charset=utf-8" | "application/zip";
  artifactType: "file" | "bundle";
  suggestedName: string;
}>;

export type PortableExportSource = Readonly<{
  aggregate: CanonicalCapletAggregate;
  projection: CanonicalCapletRelationalProjection;
}>;

export type PortableExportResult = Readonly<{
  artifact: PortableArtifactDescriptor;
  artifactType: "file" | "bundle";
  suggestedName: string;
}>;

export interface PortableCapletExportService {
  create(
    input: Readonly<{
      actorId: string;
      binding: CurrentHostOperationBinding;
      capletId: string;
      selector: "effective" | "underlying-sql";
      now?: Date | undefined;
    }>,
  ): Promise<PortableExportResult>;
}

export type PortableCapletExportServiceOptions = Readonly<{
  sessions: ArtifactSessionManager;
  loadCaplet(
    input: Readonly<{
      binding: CurrentHostOperationBinding;
      capletId: string;
      selector: "effective" | "underlying-sql";
    }>,
  ): Promise<PortableExportSource>;
}>;

/** Reconstructs a portable Caplet file or directory ZIP from secret-free relational SQL state. */
export function deterministicPortableExport(
  source: PortableExportSource,
): DeterministicPortableExport {
  if (source.aggregate.ownership !== "sql") {
    throw new Error("Only SQL-owned Caplets can be exported as portable artifacts");
  }
  validateCapletRelationalProjection(source.aggregate, source.projection);
  const artifact = encodePortableCapletArtifact(source.aggregate.portable);
  return {
    ...artifact,
    sha256: createHash("sha256").update(artifact.bytes).digest("hex"),
    byteLength: artifact.bytes.byteLength,
  };
}

export function createPortableCapletExportService(
  options: PortableCapletExportServiceOptions,
): PortableCapletExportService {
  return {
    async create(input) {
      if (input.actorId !== input.binding.actorId) {
        throw new Error("Portable export actor binding is invalid");
      }
      const source = await options.loadCaplet({
        binding: input.binding,
        capletId: input.capletId,
        selector: input.selector,
      });
      const exported = deterministicPortableExport(source);
      const published = await options.sessions.publishDownloadArtifact(
        input.actorId,
        input.binding.operationId,
        exported.bytes,
        exported.mimeType,
        input.now,
      );
      return {
        artifact: published.artifact,
        artifactType: exported.artifactType,
        suggestedName: exported.suggestedName,
      };
    },
  };
}
