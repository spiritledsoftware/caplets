import { isDeepStrictEqual } from "node:util";
import { CapletsError } from "../errors";

export type LocalAuthorityOwner = { kind: "posix"; uid: number } | { kind: "windows"; sid: string };

type LocalAuthorityDescriptorBase = {
  version: 1;
  logicalHostId: string;
  owner: LocalAuthorityOwner;
  authorityGeneration: number;
  authorityToken: string;
};

export type LocalAuthorityDescriptor =
  | (LocalAuthorityDescriptorBase & { state: "unbound" })
  | (LocalAuthorityDescriptorBase & {
      state: "bound";
      storeId: string;
      operationNamespace: string;
    })
  | (LocalAuthorityDescriptorBase & {
      state: "transfer-pending";
      transferId: string;
      sourceStoreId: string;
      sourceOperationNamespace: string;
      destinationStoreId: string;
      destinationOperationNamespace: string;
    });

export type LocalAuthorityDescriptorFile = {
  revision: string;
  kind: "regular" | "directory" | "other";
  followedSymlink: boolean;
  owner: LocalAuthorityOwner;
  posixMode?: number | undefined;
  windowsDaclRestricted?: boolean | undefined;
  contents: string;
};

/**
 * Platform adapters must open and identify the descriptor without following links, then perform
 * an owner-authorized atomic replacement only when the opaque revision still matches.
 */
export interface LocalAuthorityDescriptorPort {
  readNoFollow():
    | LocalAuthorityDescriptorFile
    | undefined
    | Promise<LocalAuthorityDescriptorFile | undefined>;
  compareAndSwap(
    expectedRevision: string,
    descriptor: LocalAuthorityDescriptor,
  ): boolean | Promise<boolean>;
}

export type LocalAuthorityTransition =
  | "bind"
  | "begin-transfer"
  | "activate-transfer-destination"
  | "abort-transfer";
type BoundLocalAuthorityDescriptor = Extract<LocalAuthorityDescriptor, { state: "bound" }>;
type PendingTransferLocalAuthorityDescriptor = Extract<
  LocalAuthorityDescriptor,
  { state: "transfer-pending" }
>;

/**
 * Builds U12's one-way transfer binding without changing the logical store or operation namespace.
 * The destination fields name the destination ledger's binding, not a new logical identity.
 */
export function createPendingOfflineTransferAuthority(
  current: BoundLocalAuthorityDescriptor,
  transferId: string,
): PendingTransferLocalAuthorityDescriptor {
  return parseLocalAuthorityDescriptor(
    JSON.stringify({
      version: current.version,
      state: "transfer-pending",
      logicalHostId: current.logicalHostId,
      owner: current.owner,
      authorityGeneration: current.authorityGeneration,
      authorityToken: current.authorityToken,
      transferId,
      sourceStoreId: current.storeId,
      sourceOperationNamespace: current.operationNamespace,
      destinationStoreId: current.storeId,
      destinationOperationNamespace: current.operationNamespace,
    }),
  ) as PendingTransferLocalAuthorityDescriptor;
}

export function createActivatedOfflineTransferAuthority(
  current: PendingTransferLocalAuthorityDescriptor,
  nextAuthority: Readonly<{ authorityGeneration: number; authorityToken: string }>,
): BoundLocalAuthorityDescriptor {
  return parseLocalAuthorityDescriptor(
    JSON.stringify({
      version: current.version,
      state: "bound",
      logicalHostId: current.logicalHostId,
      owner: current.owner,
      storeId: current.sourceStoreId,
      operationNamespace: current.sourceOperationNamespace,
      authorityGeneration: nextAuthority.authorityGeneration,
      authorityToken: nextAuthority.authorityToken,
    }),
  ) as BoundLocalAuthorityDescriptor;
}

export function createRolledBackOfflineTransferAuthority(
  current: PendingTransferLocalAuthorityDescriptor,
): BoundLocalAuthorityDescriptor {
  return parseLocalAuthorityDescriptor(
    JSON.stringify({
      version: current.version,
      state: "bound",
      logicalHostId: current.logicalHostId,
      owner: current.owner,
      storeId: current.sourceStoreId,
      operationNamespace: current.sourceOperationNamespace,
      authorityGeneration: current.authorityGeneration,
      authorityToken: current.authorityToken,
    }),
  ) as BoundLocalAuthorityDescriptor;
}

export async function readAuthorizedLocalAuthorityDescriptor(
  port: LocalAuthorityDescriptorPort,
  expectedOwner: LocalAuthorityOwner,
): Promise<LocalAuthorityDescriptor | undefined> {
  const file = await port.readNoFollow();
  if (file === undefined) return undefined;
  validateAuthorityDescriptorFile(file, expectedOwner);
  const descriptor = parseLocalAuthorityDescriptor(file.contents);
  assertDescriptorOwner(descriptor, expectedOwner);
  return descriptor;
}

export async function transitionLocalAuthorityDescriptor(
  port: LocalAuthorityDescriptorPort,
  expectedOwner: LocalAuthorityOwner,
  expected: LocalAuthorityDescriptor,
  next: LocalAuthorityDescriptor,
  transition: LocalAuthorityTransition,
): Promise<boolean> {
  const file = await port.readNoFollow();
  if (file === undefined) {
    throw new CapletsError("REQUEST_INVALID", "Current Host authority descriptor is absent.");
  }
  validateAuthorityDescriptorFile(file, expectedOwner);
  const current = parseLocalAuthorityDescriptor(file.contents);
  assertDescriptorOwner(current, expectedOwner);
  if (!isDeepStrictEqual(current, expected)) {
    throw new CapletsError("REQUEST_INVALID", "Current Host authority descriptor changed.");
  }
  const validatedNext = parseLocalAuthorityDescriptor(JSON.stringify(next));
  validateLocalAuthorityTransition(current, validatedNext, transition);
  return await port.compareAndSwap(file.revision, validatedNext);
}

export function parseLocalAuthorityDescriptor(contents: string): LocalAuthorityDescriptor {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new CapletsError("REQUEST_INVALID", "Current Host authority descriptor is malformed.");
  }
  const descriptor = requireRecord(value, "Current Host authority descriptor");
  if (descriptor.version !== 1) {
    throw new CapletsError("REQUEST_INVALID", "Unsupported Current Host authority version.");
  }
  const state = requireString(descriptor.state, "state");
  const base = {
    version: 1 as const,
    logicalHostId: requireIdentifier(descriptor.logicalHostId, "logicalHostId", "host"),
    owner: parseOwner(descriptor.owner),
    authorityGeneration: requireNonNegativeInteger(
      descriptor.authorityGeneration,
      "authorityGeneration",
    ),
    authorityToken: requireIdentifier(descriptor.authorityToken, "authorityToken", "authority"),
  };
  if (state === "unbound") {
    requireExactKeys(descriptor, [
      "version",
      "state",
      "logicalHostId",
      "owner",
      "authorityGeneration",
      "authorityToken",
    ]);
    return { ...base, state };
  }
  if (state === "bound") {
    requireExactKeys(descriptor, [
      "version",
      "state",
      "logicalHostId",
      "owner",
      "authorityGeneration",
      "authorityToken",
      "storeId",
      "operationNamespace",
    ]);
    return {
      ...base,
      state,
      storeId: requireIdentifier(descriptor.storeId, "storeId", "store"),
      operationNamespace: requireIdentifier(
        descriptor.operationNamespace,
        "operationNamespace",
        "operations",
      ),
    };
  }
  if (state === "transfer-pending") {
    requireExactKeys(descriptor, [
      "version",
      "state",
      "logicalHostId",
      "owner",
      "authorityGeneration",
      "authorityToken",
      "transferId",
      "sourceStoreId",
      "sourceOperationNamespace",
      "destinationStoreId",
      "destinationOperationNamespace",
    ]);
    const parsed = {
      ...base,
      state: "transfer-pending" as const,
      transferId: requireIdentifier(descriptor.transferId, "transferId", "transfer"),
      sourceStoreId: requireIdentifier(descriptor.sourceStoreId, "sourceStoreId", "store"),
      sourceOperationNamespace: requireIdentifier(
        descriptor.sourceOperationNamespace,
        "sourceOperationNamespace",
        "operations",
      ),
      destinationStoreId: requireIdentifier(
        descriptor.destinationStoreId,
        "destinationStoreId",
        "store",
      ),
      destinationOperationNamespace: requireIdentifier(
        descriptor.destinationOperationNamespace,
        "destinationOperationNamespace",
        "operations",
      ),
    };
    const storeIdentityPreserved = parsed.sourceStoreId === parsed.destinationStoreId;
    const operationNamespacePreserved =
      parsed.sourceOperationNamespace === parsed.destinationOperationNamespace;
    if (storeIdentityPreserved !== operationNamespacePreserved) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Transfer authority must preserve or rebind store and operation identities together.",
      );
    }
    return parsed;
  }
  throw new CapletsError("REQUEST_INVALID", "Unknown Current Host authority state.");
}

function assertDescriptorOwner(
  descriptor: LocalAuthorityDescriptor,
  expectedOwner: LocalAuthorityOwner,
): void {
  if (!isDeepStrictEqual(descriptor.owner, expectedOwner)) {
    throw new CapletsError("AUTH_FAILED", "Current Host authority binding has a foreign owner.");
  }
}

function validateAuthorityDescriptorFile(
  file: LocalAuthorityDescriptorFile,
  expectedOwner: LocalAuthorityOwner,
): void {
  if (file.followedSymlink || file.kind !== "regular") {
    throw new CapletsError(
      "AUTH_FAILED",
      "Current Host authority must be a no-follow regular file.",
    );
  }
  if (!isDeepStrictEqual(file.owner, expectedOwner)) {
    throw new CapletsError("AUTH_FAILED", "Current Host authority is foreign-owned.");
  }
  if (expectedOwner.kind === "posix") {
    if (file.posixMode === undefined || (file.posixMode & 0o077) !== 0) {
      throw new CapletsError("AUTH_FAILED", "Current Host authority permissions are insecure.");
    }
    return;
  }
  if (file.windowsDaclRestricted !== true) {
    throw new CapletsError("AUTH_FAILED", "Current Host authority ACL is insecure.");
  }
}

function validateLocalAuthorityTransition(
  current: LocalAuthorityDescriptor,
  next: LocalAuthorityDescriptor,
  transition: LocalAuthorityTransition,
): void {
  if (
    current.logicalHostId !== next.logicalHostId ||
    !isDeepStrictEqual(current.owner, next.owner)
  ) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Authority transition changes host or owner identity.",
    );
  }
  const sameAuthority =
    current.authorityGeneration === next.authorityGeneration &&
    current.authorityToken === next.authorityToken;
  switch (transition) {
    case "bind":
      if (current.state === "unbound" && next.state === "bound" && sameAuthority) return;
      break;
    case "begin-transfer":
      if (
        current.state === "bound" &&
        next.state === "transfer-pending" &&
        next.sourceStoreId === current.storeId &&
        next.sourceOperationNamespace === current.operationNamespace &&
        sameAuthority
      ) {
        return;
      }
      break;
    case "activate-transfer-destination":
      if (
        current.state === "transfer-pending" &&
        next.state === "bound" &&
        next.storeId === current.destinationStoreId &&
        next.operationNamespace === current.destinationOperationNamespace &&
        next.authorityGeneration === current.authorityGeneration + 1 &&
        next.authorityToken !== current.authorityToken
      ) {
        return;
      }
      break;
    case "abort-transfer":
      if (
        current.state === "transfer-pending" &&
        next.state === "bound" &&
        next.storeId === current.sourceStoreId &&
        next.operationNamespace === current.sourceOperationNamespace &&
        sameAuthority
      ) {
        return;
      }
      break;
  }
  throw new CapletsError("REQUEST_INVALID", "Illegal Current Host authority transition.");
}

function parseOwner(value: unknown): LocalAuthorityOwner {
  const owner = requireRecord(value, "owner");
  const kind = requireString(owner.kind, "owner.kind");
  if (kind === "posix") {
    requireExactKeys(owner, ["kind", "uid"]);
    return { kind, uid: requireNonNegativeInteger(owner.uid, "owner.uid") };
  }
  if (kind === "windows") {
    requireExactKeys(owner, ["kind", "sid"]);
    const sid = requireString(owner.sid, "owner.sid");
    if (!/^S-\d(?:-\d+)+$/u.test(sid)) {
      throw new CapletsError("REQUEST_INVALID", "owner.sid is invalid.");
    }
    return { kind, sid };
  }
  throw new CapletsError("REQUEST_INVALID", "owner.kind is invalid.");
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CapletsError("REQUEST_INVALID", `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CapletsError("REQUEST_INVALID", `${field} must be a non-empty string.`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CapletsError("REQUEST_INVALID", `${field} must be a non-negative integer.`);
  }
  return value as number;
}

function requireIdentifier(value: unknown, field: string, prefix: string): string {
  const identifier = requireString(value, field);
  if (!new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`, "u").test(identifier)) {
    throw new CapletsError("REQUEST_INVALID", `${field} is invalid.`);
  }
  return identifier;
}

function requireExactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (!isDeepStrictEqual(actual, wanted)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Current Host authority has unknown or missing fields.",
    );
  }
}
