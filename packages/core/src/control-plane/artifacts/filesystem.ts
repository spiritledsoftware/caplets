import { lstat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { CapletsError } from "../../errors";
import {
  assertSecureStateDirectory,
  ensureSecureStateDirectory,
  deleteSecureRegularFile,
  readBoundedSecureFile,
  readSecureFileRange,
  writeSecureFileExclusive,
} from "../secure-state";
import {
  artifactCanaryPayload,
  artifactProviderCanaryKey,
  artifactProviderObjectKey,
  sha256Hex,
  validateArtifactRange,
  MAX_ARTIFACT_PART_BYTES,
  type ArtifactObjectHead,
  type ArtifactProvider,
  type ArtifactProviderIdentity,
  type ArtifactPutResult,
} from "./provider";

export class FilesystemArtifactProvider implements ArtifactProvider {
  readonly identity: ArtifactProviderIdentity;
  readonly #root: string;
  #verified = false;

  constructor(root: string, identity: ArtifactProviderIdentity) {
    if (identity.kind !== "filesystem") {
      throw new CapletsError("REQUEST_INVALID", "Filesystem artifact identity kind is invalid.");
    }
    this.#root = resolve(root);
    this.identity = identity;
  }

  async verifyCanary(expectedCanary: string): Promise<void> {
    await assertSecureStateDirectory(this.#root);
    const path = this.#objectPath(artifactProviderCanaryKey(this.identity));
    await this.#ensureObjectParent(path);
    const payload = artifactCanaryPayload(this.identity, expectedCanary);
    try {
      await writeSecureFileExclusive(path, payload);
    } catch (error) {
      if (!(await fileExists(path))) throw error;
      const existing = await readBoundedSecureFile(path, { maxBytes: 4096 });
      if (existing.byteLength !== payload.byteLength || !timingSafeEqual(existing, payload)) {
        throw new CapletsError("AUTH_FAILED", "Artifact provider canary does not match.");
      }
    }
    this.#verified = true;
  }

  async putImmutable(key: string, bytes: Uint8Array): Promise<ArtifactPutResult> {
    this.#assertVerified();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARTIFACT_PART_BYTES) {
      throw new CapletsError("REQUEST_INVALID", "Immutable artifact part size is invalid.");
    }
    const path = this.#objectPath(artifactProviderObjectKey(this.identity, key));
    await this.#ensureObjectParent(path);
    try {
      await writeSecureFileExclusive(path, bytes);
      return { created: true, size: bytes.byteLength };
    } catch (error) {
      if (!(await fileExists(path))) throw error;
      const existing = await readBoundedSecureFile(path, { maxBytes: MAX_ARTIFACT_PART_BYTES });
      if (sha256Hex(existing) !== sha256Hex(bytes)) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Immutable artifact object conflicts with existing bytes.",
        );
      }
      return { created: false, size: existing.byteLength };
    }
  }

  async head(key: string): Promise<ArtifactObjectHead | undefined> {
    this.#assertVerified();
    const path = this.#objectPath(artifactProviderObjectKey(this.identity, key));
    if (!(await fileExists(path))) return undefined;
    const bytes = await readBoundedSecureFile(path, { maxBytes: MAX_ARTIFACT_PART_BYTES });
    return { size: bytes.byteLength, sha256: sha256Hex(bytes) };
  }

  async getRange(key: string, start: number, endExclusive: number): Promise<Buffer> {
    this.#assertVerified();
    validateArtifactRange(start, endExclusive);
    const path = this.#objectPath(artifactProviderObjectKey(this.identity, key));
    return readSecureFileRange(path, start, endExclusive, { maxBytes: MAX_ARTIFACT_PART_BYTES });
  }

  async delete(key: string): Promise<void> {
    this.#assertVerified();
    await deleteSecureRegularFile(this.#objectPath(artifactProviderObjectKey(this.identity, key)));
  }

  #objectPath(objectKey: string): string {
    const path = resolve(this.#root, ...objectKey.split("/"));
    const pathRelativeToRoot = relative(this.#root, path);
    if (pathRelativeToRoot.startsWith("..") || pathRelativeToRoot === "") {
      throw new CapletsError("REQUEST_INVALID", "Artifact object escapes its provider root.");
    }
    return path;
  }

  async #ensureObjectParent(path: string): Promise<void> {
    const parent = dirname(path);
    const relativeParent = relative(this.#root, parent);
    let current = this.#root;
    for (const component of relativeParent.split(/[\\/]/u).filter(Boolean)) {
      current = join(current, component);
      await ensureSecureStateDirectory(current);
    }
  }

  #assertVerified(): void {
    if (!this.#verified) {
      throw new CapletsError("AUTH_FAILED", "Artifact provider canary has not been verified.");
    }
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
