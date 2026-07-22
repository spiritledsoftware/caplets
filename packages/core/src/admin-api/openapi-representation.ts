import { createStrongEtag } from "./conditional";
import { createRootOpenApiDocument } from "./openapi";

export type RootOpenApiRepresentation = {
  bytes: Uint8Array;
  etag: string;
};

let cachedRepresentation: RootOpenApiRepresentation | undefined;

export function rootOpenApiRepresentation(): RootOpenApiRepresentation {
  cachedRepresentation ??= createRepresentation();
  return cachedRepresentation;
}

export function canonicalRootOpenApiJson(): string {
  return `${JSON.stringify(createRootOpenApiDocument(), null, 2)}\n`;
}

export function ifNoneMatchIncludes(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (ifNoneMatch == null) return false;
  if (ifNoneMatch.trim() === "*") return true;
  return ifNoneMatch.split(",").some((candidate) => {
    const normalized = candidate.trim().replace(/^W\//u, "");
    return normalized === etag;
  });
}

function createRepresentation(): RootOpenApiRepresentation {
  const bytes = new TextEncoder().encode(canonicalRootOpenApiJson());
  return {
    bytes,
    etag: createStrongEtag("root-openapi", bytes),
  };
}
