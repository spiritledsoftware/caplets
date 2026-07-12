import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDomainCodec } from "../src/remote/authority-codec";
import { createFilesystemAuthority } from "../src/storage/filesystem-authority";
import type {
  AuthorityGeneration,
  AuthorityGenerationIdentity,
  AuthorityHead,
  SemanticCommandEnvelope,
  WritableAuthority,
} from "../src/storage/types";

type Snapshot = Record<string, unknown>;

type ReplaceSnapshotCommand = {
  kind: "replace_snapshot";
  snapshot: Snapshot;
};

function identityFromHead(head: AuthorityHead | null): AuthorityGenerationIdentity | null {
  return head
    ? {
        authorityId: head.authorityId,
        id: head.id,
        sequence: head.sequence,
        predecessorId: head.predecessorId,
      }
    : null;
}

async function commitSnapshot(
  authority: WritableAuthority<unknown, unknown>,
  snapshot: Snapshot,
  idempotencyKey: string,
): Promise<void> {
  const head = await authority.readHead();
  const result = await authority.commit<ReplaceSnapshotCommand>({
    authorityId: "authority-a",
    currentHostId: "test-host",
    principalId: "test",
    expectedGeneration: identityFromHead(head),
    idempotencyKey,
    requestDigest: idempotencyKey,
    command: { kind: "replace_snapshot", snapshot },
  } as SemanticCommandEnvelope<ReplaceSnapshotCommand>);
  expect(result.kind).toBe("committed");
}

function interleaveAfterGenerationRead(
  authority: WritableAuthority<unknown, unknown>,
  onRead: () => Promise<void>,
): WritableAuthority<unknown, unknown> {
  let interleaved = false;
  return new Proxy(authority, {
    get(target, property) {
      if (property === "readGeneration") {
        return async (id: string): Promise<AuthorityGeneration<unknown>> => {
          const generation = await target.readGeneration(id);
          if (!interleaved) {
            interleaved = true;
            await onRead();
          }
          return generation;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("AuthorityDomainCodec generation-bound commits", () => {
  it("conflicts when another writer commits after the supplied read", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-authority-codec-cas-"));
    const authority = await createFilesystemAuthority({ root, authorityId: "authority-a" });
    try {
      await commitSnapshot(authority, { caplets: {}, baseline: { keep: true } }, "seed");
      const codec = new AuthorityDomainCodec({
        authority: interleaveAfterGenerationRead(authority, async () => {
          const head = await authority.readHead();
          if (!head) throw new Error("expected seeded authority head");
          const generation = await authority.readGeneration(head.id);
          await commitSnapshot(
            authority,
            { ...(generation.snapshot as Snapshot), concurrent: { keep: true } },
            "concurrent",
          );
        }),
        authorityId: "authority-a",
        encryptionKey: Buffer.alloc(32),
      });

      const read = await codec.read();
      await expect(
        codec.commit({
          read,
          domain: "domain",
          command: { kind: "replace_snapshot" },
          snapshot: { ...read.snapshot, domain: { stale: true } },
          result: { ok: true },
          payload: { operation: "stale" },
          idempotencyKey: "stale",
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });

      const head = await authority.readHead();
      if (!head) throw new Error("expected concurrent authority head");
      const current = await authority.readGeneration(head.id);
      expect(current.snapshot).toMatchObject({
        baseline: { keep: true },
        concurrent: { keep: true },
      });
      expect(current.snapshot).not.toHaveProperty("domain");
    } finally {
      await authority.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
