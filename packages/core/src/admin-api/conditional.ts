import { createHash } from "node:crypto";

export type EtagVersionMaterial = string | number | bigint | Uint8Array;

export type ConditionalRequestResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: 428;
      readonly code: "PRECONDITION_REQUIRED";
    }
  | {
      readonly ok: false;
      readonly status: 412;
      readonly code: "PRECONDITION_FAILED";
    };

const PRECONDITION_SATISFIED = { ok: true } as const;
const PRECONDITION_REQUIRED = {
  ok: false,
  status: 428,
  code: "PRECONDITION_REQUIRED",
} as const;
const PRECONDITION_FAILED = {
  ok: false,
  status: 412,
  code: "PRECONDITION_FAILED",
} as const;

export function createStrongEtag(
  resourceNamespace: string,
  versionMaterial: EtagVersionMaterial,
): string {
  const hash = createHash("sha256");
  const namespaceBytes = Buffer.from(resourceNamespace, "utf8");
  const materialBytes = toVersionBytes(versionMaterial);

  hash.update("caplets-admin-etag-v1\0");
  hash.update(String(namespaceBytes.byteLength));
  hash.update(":");
  hash.update(namespaceBytes);
  hash.update("\0");
  hash.update(String(materialBytes.byteLength));
  hash.update(":");
  hash.update(materialBytes);

  return `"${hash.digest("base64url")}"`;
}

export function checkCreationPrecondition(
  ifNoneMatch: string | null | undefined,
): ConditionalRequestResult {
  if (ifNoneMatch == null) {
    return PRECONDITION_REQUIRED;
  }

  return ifNoneMatch.trim() === "*" ? PRECONDITION_SATISFIED : PRECONDITION_FAILED;
}

export function checkMutationPrecondition(
  ifMatch: string | null | undefined,
  currentEtag: string,
): ConditionalRequestResult {
  if (ifMatch == null) {
    return PRECONDITION_REQUIRED;
  }

  const value = ifMatch.trim();
  if (value === "*") {
    return PRECONDITION_SATISFIED;
  }

  return strongValidatorListMatches(value, currentEtag)
    ? PRECONDITION_SATISFIED
    : PRECONDITION_FAILED;
}

function strongValidatorListMatches(value: string, currentEtag: string): boolean {
  let index = 0;
  let matched = false;

  while (index < value.length) {
    while (value[index] === " " || value[index] === "\t") {
      index += 1;
    }

    const weak = value.startsWith("W/", index);
    if (weak) {
      index += 2;
    }

    const validatorStart = index;
    if (value[index] !== '"') {
      return false;
    }
    index += 1;

    while (index < value.length && value[index] !== '"') {
      const codePoint = value.charCodeAt(index);
      const isEtagCharacter =
        codePoint === 0x21 ||
        (codePoint >= 0x23 && codePoint <= 0x7e) ||
        (codePoint >= 0x80 && codePoint <= 0xff);
      if (!isEtagCharacter) {
        return false;
      }
      index += 1;
    }

    if (value[index] !== '"') {
      return false;
    }
    index += 1;

    if (
      !weak &&
      currentEtag.length === index - validatorStart &&
      value.startsWith(currentEtag, validatorStart)
    ) {
      matched = true;
    }

    while (value[index] === " " || value[index] === "\t") {
      index += 1;
    }
    if (index === value.length) {
      return matched;
    }
    if (value[index] !== ",") {
      return false;
    }
    index += 1;
  }

  return false;
}

function toVersionBytes(versionMaterial: EtagVersionMaterial): Uint8Array {
  if (versionMaterial instanceof Uint8Array) {
    return versionMaterial;
  }

  return Buffer.from(String(versionMaterial), "utf8");
}
