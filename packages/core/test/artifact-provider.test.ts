import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createArtifactProviderIdentity,
  type ArtifactProviderIdentity,
} from "../src/control-plane/artifacts/provider";
import { FilesystemArtifactProvider } from "../src/control-plane/artifacts/filesystem";
import { S3ArtifactProvider } from "../src/control-plane/artifacts/s3";

const logicalHostId = "host_01J00000000000000000000000";
const storeId = "store_01J00000000000000000000000";
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "caplets-artifacts-"));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

function identity(overrides: Partial<ArtifactProviderIdentity> = {}): ArtifactProviderIdentity {
  return createArtifactProviderIdentity({
    kind: "filesystem",
    provider: "local-owner-private",
    namespace: "control-plane",
    logicalHostId,
    storeId,
    ...overrides,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("artifact providers", () => {
  it("provides immutable cross-client put/head/range/delete on owner-private storage", async () => {
    const root = tempRoot();
    const first = new FilesystemArtifactProvider(root, identity());
    const second = new FilesystemArtifactProvider(root, identity());

    await first.verifyCanary("canary-v1");
    await second.verifyCanary("canary-v1");
    expect(await first.putImmutable("exports/caplet.bin", Buffer.from("0123456789"))).toEqual({
      created: true,
      size: 10,
    });
    expect(await second.head("exports/caplet.bin")).toMatchObject({ size: 10 });
    expect((await second.getRange("exports/caplet.bin", 2, 6)).toString()).toBe("2345");
    expect(await second.putImmutable("exports/caplet.bin", Buffer.from("0123456789"))).toEqual({
      created: false,
      size: 10,
    });
    await expect(
      second.putImmutable("exports/caplet.bin", Buffer.from("different")),
    ).rejects.toThrow(/immutable|conflict/i);
    await second.delete("exports/caplet.bin");
    await second.delete("exports/caplet.bin");
    expect(await first.head("exports/caplet.bin")).toBeUndefined();
  });

  it("rejects canary and identity drift before artifact access", async () => {
    const root = tempRoot();
    const first = new FilesystemArtifactProvider(root, identity());
    const second = new FilesystemArtifactProvider(root, identity());

    await first.verifyCanary("node-a-canary");
    await expect(second.verifyCanary("node-b-canary")).rejects.toThrow(/canary/i);

    const foreign = new FilesystemArtifactProvider(
      root,
      identity({ storeId: "store_01J11111111111111111111111" }),
    );
    await expect(foreign.head("exports/caplet.bin")).rejects.toThrow(/canary|verified/i);
  });

  it("proves two S3 clients share conditional put, head, range, delete, and canary", async () => {
    const service = new MemoryS3Service();
    const providerIdentity = createArtifactProviderIdentity({
      kind: "s3",
      provider: "https://objects.internal/caplets-control-plane",
      namespace: "hosts/current",
      logicalHostId,
      storeId,
    });
    expect(
      () =>
        new S3ArtifactProvider(service.client(), {
          bucket: "foreign-bucket",
          prefix: "hosts/current",
          identity: providerIdentity,
        }),
    ).toThrow(/configuration/i);
    expect(
      () =>
        new S3ArtifactProvider(service.client(), {
          bucket: "caplets-control-plane",
          prefix: "foreign-prefix",
          identity: providerIdentity,
        }),
    ).toThrow(/configuration/i);

    const first = new S3ArtifactProvider(service.client(), {
      bucket: "caplets-control-plane",
      prefix: "hosts/current",
      identity: providerIdentity,
    });
    const second = new S3ArtifactProvider(service.client(), {
      bucket: "caplets-control-plane",
      prefix: "hosts/current",
      identity: providerIdentity,
    });

    await first.verifyCanary("shared-canary");
    await second.verifyCanary("shared-canary");
    await first.putImmutable("bundle.bin", Buffer.from("abcdefgh"));
    expect(await second.head("bundle.bin")).toMatchObject({ size: 8 });
    expect((await second.getRange("bundle.bin", 1, 4)).toString()).toBe("bcd");
    const stored = [...service.objects.values()].find(
      (object) => Buffer.from(object.body).toString() === "abcdefgh",
    )!;
    stored.metadata["caplets-identity"] = "foreign";
    await expect(second.head("bundle.bin")).rejects.toThrow(/metadata/i);
    stored.metadata["caplets-identity"] = providerIdentity.identityId;
    service.malformedRange = true;
    await expect(second.getRange("bundle.bin", 1, 4)).rejects.toThrow(/range response/i);
    service.malformedRange = false;
    stored.body = Uint8Array.from(Buffer.from("forged!!"));
    await expect(second.putImmutable("bundle.bin", Buffer.from("abcdefgh"))).rejects.toThrow(
      /conflict/i,
    );
    await expect(second.getRange("bundle.bin", 0, 16 * 1024 * 1024 + 1)).rejects.toThrow(/limit/i);
    await second.delete("bundle.bin");
    await second.delete("bundle.bin");
    expect(await first.head("bundle.bin")).toBeUndefined();

    await expect(second.verifyCanary("different-canary")).rejects.toThrow(/canary/i);
  });
});

class MemoryS3Service {
  readonly objects = new Map<string, { body: Uint8Array; metadata: Record<string, string> }>();
  malformedRange = false;

  client() {
    return {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const input = command.input;
        const objectId = `${String(input.Bucket)}/${String(input.Key)}`;
        switch (command.constructor.name) {
          case "PutObjectCommand": {
            if (input.IfNoneMatch === "*" && this.objects.has(objectId)) {
              throw Object.assign(new Error("precondition"), {
                name: "PreconditionFailed",
                $metadata: { httpStatusCode: 412 },
              });
            }
            const body = input.Body as Uint8Array;
            this.objects.set(objectId, {
              body: Uint8Array.from(body),
              metadata: (input.Metadata as Record<string, string> | undefined) ?? {},
            });
            return { ETag: '"memory-etag"', $metadata: { httpStatusCode: 200 } };
          }
          case "HeadObjectCommand": {
            const object = this.objects.get(objectId);
            if (!object) throw notFound();
            return {
              ContentLength: object.body.byteLength,
              ETag: '"memory-etag"',
              Metadata: object.metadata,
              $metadata: { httpStatusCode: 200 },
            };
          }
          case "GetObjectCommand": {
            const object = this.objects.get(objectId);
            if (!object) throw notFound();
            const match = /^bytes=(\d+)-(\d+)$/u.exec(String(input.Range));
            const body = match
              ? object.body.slice(Number(match[1]), Number(match[2]) + 1)
              : object.body;
            return {
              Body: { transformToByteArray: async () => body },
              ContentLength: body.byteLength,
              ...(match
                ? {
                    ContentRange: this.malformedRange
                      ? `bytes 0-${match[2]}/${object.body.byteLength}`
                      : `bytes ${match[1]}-${match[2]}/${object.body.byteLength}`,
                    $metadata: { httpStatusCode: 206 },
                  }
                : { $metadata: { httpStatusCode: 200 } }),
            };
          }
          case "DeleteObjectCommand":
            this.objects.delete(objectId);
            return { $metadata: { httpStatusCode: 204 } };
          default:
            throw new Error(`Unexpected command ${command.constructor.name}`);
        }
      },
    };
  }
}

function notFound(): Error {
  return Object.assign(new Error("not found"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}
