import { describe, expect, it } from "vitest";
import {
  readAuthorizedLocalAuthorityDescriptor,
  transitionLocalAuthorityDescriptor,
  type LocalAuthorityDescriptor,
  type LocalAuthorityDescriptorFile,
  type LocalAuthorityDescriptorPort,
  type LocalAuthorityOwner,
} from "../src/current-host/authority";

const owner: LocalAuthorityOwner = { kind: "posix", uid: 1000 };
const base = {
  version: 1 as const,
  logicalHostId: "host_01J00000000000000000000000",
  owner,
  authorityGeneration: 1,
  authorityToken: "authority_01J00000000000000000000000",
};

function file(descriptor: unknown, overrides: Partial<LocalAuthorityDescriptorFile> = {}) {
  return {
    revision: "rev-1",
    kind: "regular" as const,
    followedSymlink: false,
    owner,
    posixMode: 0o600,
    contents: JSON.stringify(descriptor),
    ...overrides,
  };
}

class MemoryAuthorityPort implements LocalAuthorityDescriptorPort {
  writes: Array<{ expectedRevision: string; descriptor: LocalAuthorityDescriptor }> = [];

  constructor(public current: LocalAuthorityDescriptorFile | undefined) {}

  readNoFollow() {
    return this.current;
  }

  compareAndSwap(expectedRevision: string, descriptor: LocalAuthorityDescriptor) {
    this.writes.push({ expectedRevision, descriptor });
    if (!this.current || this.current.revision !== expectedRevision) return false;
    this.current = file(descriptor, { revision: "rev-2" });
    return true;
  }
}

describe("local Current Host authority contract", () => {
  it("preserves descriptor absence for legacy non-SQL entrypoints", async () => {
    await expect(
      readAuthorizedLocalAuthorityDescriptor(new MemoryAuthorityPort(undefined), owner),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["symlink", { followedSymlink: true }],
    ["non-regular", { kind: "directory" as const }],
    ["foreign owner", { owner: { kind: "posix" as const, uid: 1001 } }],
    ["group-readable", { posixMode: 0o640 }],
  ])("rejects an insecure %s before descriptor parsing", async (_label, overrides) => {
    const port = new MemoryAuthorityPort(file("not-json", overrides));
    await expect(readAuthorizedLocalAuthorityDescriptor(port, owner)).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });

  it("rejects a descriptor whose owner binding disagrees with its authorized file owner", async () => {
    const descriptor = {
      ...base,
      owner: { kind: "posix" as const, uid: 1001 },
      state: "unbound" as const,
    };
    await expect(
      readAuthorizedLocalAuthorityDescriptor(new MemoryAuthorityPort(file(descriptor)), owner),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("parses every versioned authority state and rejects malformed bindings", async () => {
    const descriptors: LocalAuthorityDescriptor[] = [
      { ...base, state: "unbound" },
      {
        ...base,
        state: "bound",
        storeId: "store_01J00000000000000000000000",
        operationNamespace: "operations_01J00000000000000000000000",
      },
      {
        ...base,
        state: "transfer-pending",
        transferId: "transfer_01J00000000000000000000000",
        sourceStoreId: "store_01J00000000000000000000000",
        sourceOperationNamespace: "operations_01J00000000000000000000000",
        destinationStoreId: "store_01J11111111111111111111111",
        destinationOperationNamespace: "operations_01J11111111111111111111111",
      },
    ];

    for (const descriptor of descriptors) {
      await expect(
        readAuthorizedLocalAuthorityDescriptor(new MemoryAuthorityPort(file(descriptor)), owner),
      ).resolves.toEqual(descriptor);
    }
    await expect(
      readAuthorizedLocalAuthorityDescriptor(
        new MemoryAuthorityPort(file({ ...base, state: "bound", storeId: "store_bad" })),
        owner,
      ),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("allows only owner-authorized legal CAS transitions", async () => {
    const unbound: LocalAuthorityDescriptor = { ...base, state: "unbound" };
    const bound: LocalAuthorityDescriptor = {
      ...base,
      state: "bound",
      storeId: "store_01J00000000000000000000000",
      operationNamespace: "operations_01J00000000000000000000000",
    };
    const transfer: LocalAuthorityDescriptor = {
      ...base,
      state: "transfer-pending",
      transferId: "transfer_01J00000000000000000000000",
      sourceStoreId: bound.storeId,
      sourceOperationNamespace: bound.operationNamespace,
      destinationStoreId: "store_01J11111111111111111111111",
      destinationOperationNamespace: "operations_01J11111111111111111111111",
    };
    const port = new MemoryAuthorityPort(file(unbound));

    await expect(
      transitionLocalAuthorityDescriptor(port, owner, unbound, bound, "bind"),
    ).resolves.toBe(true);
    await expect(
      transitionLocalAuthorityDescriptor(port, owner, bound, transfer, "begin-transfer"),
    ).resolves.toBe(true);
    expect(port.writes).toHaveLength(2);

    await expect(
      transitionLocalAuthorityDescriptor(
        port,
        owner,
        transfer,
        { ...unbound, authorityGeneration: 2 },
        "bind",
      ),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    expect(port.writes).toHaveLength(2);
  });

  it("fails a stale compare-and-swap without writing a different descriptor", async () => {
    const expected: LocalAuthorityDescriptor = { ...base, state: "unbound" };
    const actual: LocalAuthorityDescriptor = { ...base, authorityGeneration: 2, state: "unbound" };
    const next: LocalAuthorityDescriptor = {
      ...base,
      state: "bound",
      storeId: "store_01J00000000000000000000000",
      operationNamespace: "operations_01J00000000000000000000000",
    };
    const port = new MemoryAuthorityPort(file(actual));

    await expect(
      transitionLocalAuthorityDescriptor(port, owner, expected, next, "bind"),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    expect(port.writes).toEqual([]);
  });
});
