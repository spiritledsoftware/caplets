import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  privateDecrypt,
  publicEncrypt,
  timingSafeEqual,
} from "node:crypto";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { CapletsError } from "../../errors";
import {
  assertSecureStateDirectory,
  createOrOpenSecureStateRoot,
  consumeSecureStateRootFreshness,
  ensureSecureStateDirectory,
  readBoundedSecureFile,
  syncSecureDirectory,
  type SecureFilesystemOptions,
  type SecureStateRoot,
  writeSecureFileExclusive,
  writeSecureJsonExclusive,
} from "../secure-state";
import {
  FILE_V1_PROFILE_CAPABILITIES,
  FILE_V1_RUNTIME_PURPOSES,
  FILE_V1_PURPOSES,
  FILE_V1_PURPOSE_SPECS,
  fileV1CompatibilityManifestCommitment,
  manifestForProfile,
  parseFileV1Manifest,
  type FileV1Manifest,
  type FileV1CompatibilityKey,
  type FileV1ManifestEntry,
  type FileV1Operation,
  type FileV1Profile,
  type FileV1Purpose,
} from "./manifest";

const MANIFEST_MAX_BYTES = 256 * 1024;
const PROFILE_NAMES = [
  "online",
  "migrator",
  "maintenance",
  "backup-writer",
  "offline-recovery",
  "transfer-source",
  "transfer-destination",
] as const satisfies ReadonlyArray<Exclude<FileV1Profile, "inventory">>;

export type SqliteFileV1Bootstrap = {
  inventoryManifestPath: string;
  profileManifestPaths: Record<(typeof PROFILE_NAMES)[number], string>;
};

export type BootstrapSqliteFileV1Options = {
  root: string;
  logicalHostId: string;
  storeId: string;
  secureRoot?: SecureStateRoot | undefined;
  faultAfterWrites?: number | undefined;
  filesystem?: SecureFilesystemOptions | undefined;
};

export type LoadFileV1KeyProviderOptions = {
  manifestPath: string;
  expectedLogicalHostId: string;
  expectedStoreId: string;
  expectedProfile: FileV1Profile;
  minimumGeneration?: number | undefined;
  expectedUid?: number | undefined;
  filesystem?: SecureFilesystemOptions | undefined;
};

export type FileV1VersionFloors = Record<
  FileV1CompatibilityKey["purpose"],
  {
    activeVersion: number;
    minimumLiveVersion: number;
    liveVersions: readonly number[];
  }
>;

export type FileV1Ciphertext = {
  keyVersion: number;
  ciphertext: Buffer;
  authenticationTag: Buffer;
};

export type FileV1VersionedBytes = {
  keyVersion: number;
  bytes: Buffer;
};

type LoadedKey = {
  keyId: string;
  keyVersion: number;
  purpose: FileV1Purpose;
  operations: readonly FileV1Operation[];
  material: Buffer;
};

const COMPATIBILITY_COMMITMENT = Symbol("file-v1-compatibility-commitment");

export class FileV1KeyProvider {
  readonly manifest: FileV1Manifest;
  readonly #keys: LoadedKey[];

  constructor(manifest: FileV1Manifest, keys: LoadedKey[]) {
    this.manifest = freezeManifest(manifest);
    this.#keys = keys
      .map((key) => ({
        ...key,
        operations: Object.freeze([...key.operations]),
      }))
      .sort(
        (left, right) =>
          left.purpose.localeCompare(right.purpose) || right.keyVersion - left.keyVersion,
      );
    for (const key of this.#keys) {
      const expected = manifest.compatibilityKeys.find(
        (candidate) =>
          candidate.keyId === key.keyId &&
          candidate.keyVersion === key.keyVersion &&
          candidate.purpose === key.purpose,
      );
      const actual = keyMaterialCompatibilityCommitment(key);
      if (!expected || !timingSafeEqual(Buffer.from(expected.commitment, "hex"), actual)) {
        throw new CapletsError("AUTH_FAILED", "file-v1 compatibility validation failed.");
      }
    }
    for (const key of this.#keys) {
      if (key.purpose !== "backup-wrap" && key.purpose !== "backup-recovery") continue;
      const actual = backupKeyPairCommitment(key.material, key.purpose);
      if (!timingSafeEqual(Buffer.from(manifest.backupKeyPairCommitment, "hex"), actual)) {
        throw new CapletsError("AUTH_FAILED", "file-v1 backup key-pair validation failed.");
      }
    }
  }

  hasCapability(purpose: FileV1Purpose, operation: FileV1Operation): boolean {
    return this.#keys.some((key) => key.purpose === purpose && key.operations.includes(operation));
  }

  encrypt(
    purpose: FileV1Purpose,
    plaintext: Uint8Array,
    iv: Uint8Array,
    associatedData?: Uint8Array,
  ): FileV1Ciphertext {
    if (iv.byteLength !== 12) throw keyOperationError();
    const key = this.#activeKey(purpose, "encrypt");
    const cipher = createCipheriv("aes-256-gcm", key.material, iv);
    if (associatedData !== undefined) cipher.setAAD(associatedData);
    return {
      keyVersion: key.keyVersion,
      ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]),
      authenticationTag: cipher.getAuthTag(),
    };
  }

  decrypt(
    purpose: FileV1Purpose,
    keyVersion: number,
    ciphertext: Uint8Array,
    iv: Uint8Array,
    authenticationTag: Uint8Array,
    associatedData?: Uint8Array,
  ): Buffer {
    if (iv.byteLength !== 12 || authenticationTag.byteLength !== 16) throw keyOperationError();
    const key = this.#versionedKey(purpose, "decrypt", keyVersion);
    const decipher = createDecipheriv("aes-256-gcm", key.material, iv);
    if (associatedData !== undefined) decipher.setAAD(associatedData);
    decipher.setAuthTag(authenticationTag);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw keyOperationError();
    }
  }

  compute(purpose: FileV1Purpose, value: Uint8Array): FileV1VersionedBytes {
    const key = this.#activeKey(purpose, "compute");
    return {
      keyVersion: key.keyVersion,
      bytes: createHmac("sha256", key.material).update(value).digest(),
    };
  }

  verify(
    purpose: FileV1Purpose,
    keyVersion: number,
    value: Uint8Array,
    expected: Uint8Array,
  ): boolean {
    const key = this.#versionedKey(purpose, "verify", keyVersion);
    const actual = createHmac("sha256", key.material).update(value).digest();
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  }

  wrap(purpose: FileV1Purpose, plaintext: Uint8Array): FileV1VersionedBytes {
    const key = this.#activeKey(purpose, "wrap");
    return {
      keyVersion: key.keyVersion,
      bytes: publicEncrypt(
        {
          key: key.material,
          oaepHash: "sha256",
          padding: constants.RSA_PKCS1_OAEP_PADDING,
        },
        plaintext,
      ),
    };
  }

  unwrap(purpose: FileV1Purpose, keyVersion: number, wrapped: Uint8Array): Buffer {
    const key = this.#versionedKey(purpose, "unwrap", keyVersion);
    try {
      return privateDecrypt(
        {
          key: key.material,
          oaepHash: "sha256",
          padding: constants.RSA_PKCS1_OAEP_PADDING,
        },
        wrapped,
      );
    } catch {
      throw keyOperationError();
    }
  }

  [COMPATIBILITY_COMMITMENT](): Buffer {
    return Buffer.from(this.manifest.compatibilityCommitment, "hex");
  }

  #activeKey(purpose: FileV1Purpose, operation: FileV1Operation): LoadedKey {
    const key = this.#keys.find(
      (candidate) => candidate.purpose === purpose && candidate.operations.includes(operation),
    );
    if (!key) throw keyOperationError();
    return key;
  }

  #versionedKey(purpose: FileV1Purpose, operation: FileV1Operation, keyVersion: number): LoadedKey {
    const key = this.#keys.find(
      (candidate) =>
        candidate.purpose === purpose &&
        candidate.keyVersion === keyVersion &&
        candidate.operations.includes(operation),
    );
    if (!key) throw keyOperationError();
    return key;
  }
}

function keyMaterialCompatibilityCommitment(key: LoadedKey): Buffer {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify([
      key.keyId,
      key.keyVersion,
      key.purpose,
      FILE_V1_PURPOSE_SPECS[key.purpose].operations,
      key.material.byteLength,
    ]),
  );
  hash.update("\0");
  hash.update(key.material);
  return hash.digest();
}

function backupKeyPairCommitment(
  material: Buffer,
  purpose: "backup-wrap" | "backup-recovery",
): Buffer {
  const publicKey =
    purpose === "backup-recovery"
      ? createPublicKey(createPrivateKey(material))
      : createPublicKey(material);
  return createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest();
}

function freezeManifest(manifest: FileV1Manifest): FileV1Manifest {
  return Object.freeze({
    ...manifest,
    compatibilityKeys: Object.freeze(
      manifest.compatibilityKeys.map((key) => Object.freeze({ ...key })),
    ),
    entries: Object.freeze(
      manifest.entries.map((entry) =>
        Object.freeze({
          ...entry,
          operations: Object.freeze([...entry.operations]),
        }),
      ),
    ),
  }) as FileV1Manifest;
}

function keyOperationError(): CapletsError {
  return new CapletsError(
    "AUTH_FAILED",
    "The file-v1 process profile does not grant the requested key operation.",
  );
}

export function fileV1CompatibilityCommitment(provider: FileV1KeyProvider): Buffer {
  return provider[COMPATIBILITY_COMMITMENT]();
}

export function fileV1VersionFloors(provider: FileV1KeyProvider): FileV1VersionFloors {
  return Object.freeze(
    Object.fromEntries(
      FILE_V1_RUNTIME_PURPOSES.map((purpose) => {
        const liveVersions = Object.freeze(
          provider.manifest.compatibilityKeys
            .filter((key) => key.purpose === purpose)
            .map((key) => key.keyVersion)
            .sort((left, right) => left - right),
        );
        return [
          purpose,
          Object.freeze({
            activeVersion: liveVersions.at(-1)!,
            minimumLiveVersion: liveVersions[0]!,
            liveVersions,
          }),
        ];
      }),
    ) as FileV1VersionFloors,
  );
}

export async function bootstrapSqliteFileV1(
  options: BootstrapSqliteFileV1Options,
): Promise<SqliteFileV1Bootstrap> {
  const filesystem = options.filesystem ?? {};
  const secureRoot =
    options.secureRoot ?? (await createOrOpenSecureStateRoot(options.root, filesystem));
  if (!consumeSecureStateRootFreshness(secureRoot, options.root)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "SQLite key bootstrap requires a provably fresh secure state root; partial state needs recovery.",
    );
  }
  await assertSecureStateDirectory(options.root, filesystem);
  const rootEntries = await readdir(options.root);
  if (rootEntries.some((entry) => entry !== "authority.json")) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "SQLite key bootstrap found foreign or partial state and will not replace it.",
    );
  }
  const finalRoot = join(options.root, "key-provider");
  if (await pathExists(finalRoot)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "SQLite key-provider state already exists and will not be replaced.",
    );
  }
  const temporaryRoot = join(options.root, `.key-provider.tmp-${randomBytes(12).toString("hex")}`);
  const manifestsRoot = join(temporaryRoot, "manifests");
  const keysRoot = join(manifestsRoot, "keys");
  let writes = 0;
  const afterWrite = (): void => {
    writes += 1;
    if (options.faultAfterWrites !== undefined && writes >= options.faultAfterWrites) {
      throw new CapletsError("REQUEST_INVALID", "Injected file-v1 bootstrap fault.");
    }
  };

  try {
    await mkdir(temporaryRoot, { mode: 0o700 });
    await ensureSecureStateDirectory(temporaryRoot, filesystem);
    await mkdir(manifestsRoot, { mode: 0o700 });
    await ensureSecureStateDirectory(manifestsRoot, filesystem);
    await mkdir(keysRoot, { mode: 0o700 });
    await ensureSecureStateDirectory(keysRoot, filesystem);

    const rsa = generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const materials: Record<FileV1Purpose, Buffer> = {
      "active-record": randomBytes(32),
      "vault-record": randomBytes(32),
      "credential-verifier": randomBytes(32),
      "bootstrap-attestation": randomBytes(32),
      "node-canary": randomBytes(32),
      "backup-wrap": Buffer.from(rsa.publicKey, "utf8"),
      "backup-recovery": Buffer.from(rsa.privateKey, "utf8"),
      "recovery-checkpoint": randomBytes(32),
      transfer: randomBytes(32),
    };
    const entries: FileV1ManifestEntry[] = [];
    for (const purpose of FILE_V1_PURPOSES) {
      const extension = purpose === "backup-wrap" || purpose === "backup-recovery" ? "pem" : "key";
      const file = `keys/${purpose}.v1.${extension}`;
      await writeSecureFileExclusive(join(manifestsRoot, file), materials[purpose], filesystem);
      afterWrite();
      const spec = FILE_V1_PURPOSE_SPECS[purpose];
      entries.push({
        keyId: generateCrockfordIdentifier("key"),
        keyVersion: 1,
        algorithm: spec.algorithm,
        purpose,
        operations: [...spec.operations],
        file,
      });
    }
    const compatibilityKeys: FileV1CompatibilityKey[] = entries.map((entry) => ({
      keyId: entry.keyId,
      keyVersion: entry.keyVersion,
      purpose: entry.purpose,
      commitment: keyMaterialCompatibilityCommitment({
        ...entry,
        material: materials[entry.purpose],
      }).toString("hex"),
    }));
    const compatibilityCommitment = fileV1CompatibilityManifestCommitment(compatibilityKeys);
    const backupPairCommitment = backupKeyPairCommitment(
      materials["backup-wrap"],
      "backup-wrap",
    ).toString("hex");
    const inventory = parseFileV1Manifest(
      JSON.stringify({
        version: 1,
        provider: "file-v1",
        generation: 1,
        compatibilityCommitment,
        compatibilityKeys,
        backupKeyPairCommitment: backupPairCommitment,
        profile: "inventory",
        logicalHostId: options.logicalHostId,
        storeId: options.storeId,
        entries,
      }),
    );
    await writeSecureJsonExclusive(join(manifestsRoot, "inventory.json"), inventory, filesystem);
    afterWrite();
    for (const profile of PROFILE_NAMES) {
      await writeSecureJsonExclusive(
        join(manifestsRoot, `${profile}.json`),
        manifestForProfile(inventory, profile),
        filesystem,
      );
      afterWrite();
    }
    await mkdir(finalRoot, { mode: 0o700 });
    await rename(manifestsRoot, join(finalRoot, "manifests"));
    await syncSecureDirectory(finalRoot);
    await syncSecureDirectory(options.root);
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof CapletsError) throw error;
    throw new CapletsError(
      "REQUEST_INVALID",
      "SQLite file-v1 bootstrap failed without publishing state.",
    );
  }

  return {
    inventoryManifestPath: join(finalRoot, "manifests", "inventory.json"),
    profileManifestPaths: Object.fromEntries(
      PROFILE_NAMES.map((profile) => [profile, join(finalRoot, "manifests", `${profile}.json`)]),
    ) as Record<(typeof PROFILE_NAMES)[number], string>,
  };
}

export async function loadFileV1KeyProvider(
  options: LoadFileV1KeyProviderOptions,
): Promise<FileV1KeyProvider> {
  const filesystem =
    options.expectedUid === undefined
      ? { ...options.filesystem }
      : { ...options.filesystem, expectedUid: options.expectedUid };
  const manifestBytes = await readBoundedSecureFile(options.manifestPath, {
    ...filesystem,
    maxBytes: MANIFEST_MAX_BYTES,
  });
  const manifest = parseFileV1Manifest(manifestBytes.toString("utf8"));
  if (
    manifest.logicalHostId !== options.expectedLogicalHostId ||
    manifest.storeId !== options.expectedStoreId
  ) {
    throw new CapletsError("AUTH_FAILED", "file-v1 manifest identity binding does not match.");
  }
  if (manifest.profile !== options.expectedProfile) {
    throw new CapletsError("AUTH_FAILED", "file-v1 manifest process profile does not match.");
  }
  if (options.minimumGeneration !== undefined && manifest.generation < options.minimumGeneration) {
    throw new CapletsError("AUTH_FAILED", "file-v1 manifest generation rollback was rejected.");
  }

  const manifestRoot = dirname(options.manifestPath);
  const keys: LoadedKey[] = [];
  for (const entry of manifest.entries) {
    const keyPath = resolve(manifestRoot, entry.file);
    const relativeKeyPath = relative(manifestRoot, keyPath);
    if (relativeKeyPath.startsWith("..") || resolve(keyPath) === resolve(manifestRoot)) {
      throw new CapletsError("AUTH_FAILED", "file-v1 key reference escapes its manifest root.");
    }
    const spec = FILE_V1_PURPOSE_SPECS[entry.purpose];
    const material = await readBoundedSecureFile(keyPath, {
      ...filesystem,
      maxBytes: spec.bytes ?? 16 * 1024,
    });
    validateKeyMaterial(entry.purpose, material);
    keys.push({
      keyId: entry.keyId,
      keyVersion: entry.keyVersion,
      purpose: entry.purpose,
      operations: entry.operations,
      material,
    });
  }
  const materialCommitments = new Set<string>();
  for (const key of keys) {
    const commitment = createHash("sha256").update(key.material).digest("hex");
    if (materialCommitments.has(commitment)) {
      throw new CapletsError("AUTH_FAILED", "file-v1 key material is reused across bindings.");
    }
    materialCommitments.add(commitment);
  }
  return new FileV1KeyProvider(manifest, keys);
}

function validateKeyMaterial(purpose: FileV1Purpose, material: Buffer): void {
  const spec = FILE_V1_PURPOSE_SPECS[purpose];
  if (spec.bytes !== undefined) {
    if (material.byteLength !== spec.bytes) {
      throw new CapletsError("AUTH_FAILED", "file-v1 key material has the wrong size.");
    }
    return;
  }
  if (spec.material === "public-key") {
    let containsPrivateMaterial = false;
    try {
      createPrivateKey(material);
      containsPrivateMaterial = true;
    } catch {
      // Public-only key material is expected to fail private-key parsing.
    }
    if (containsPrivateMaterial) {
      throw new CapletsError("AUTH_FAILED", "file-v1 public key material contains private data.");
    }
  }
  try {
    const key =
      spec.material === "public-key" ? createPublicKey(material) : createPrivateKey(material);
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new Error("unsupported key");
    }
  } catch {
    throw new CapletsError("AUTH_FAILED", "file-v1 RSA key material is invalid.");
  }
}

function generateCrockfordIdentifier(prefix: "key"): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(26);
  let identifier = "";
  for (const byte of bytes) identifier += alphabet[byte % alphabet.length];
  return `${prefix}_${identifier}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function assertFileV1ProfileCapability(
  profile: FileV1Profile,
  purpose: FileV1Purpose,
  operation: FileV1Operation,
): void {
  const capability = FILE_V1_PROFILE_CAPABILITIES[profile].find(
    (candidate) => candidate.purpose === purpose,
  );
  if (!capability?.operations.includes(operation)) {
    throw new CapletsError(
      "AUTH_FAILED",
      "file-v1 process profile denies the requested capability.",
    );
  }
}
