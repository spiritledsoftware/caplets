import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";
import type {
  OfflineSqlTransferGuidance,
  OfflineSqlTransferOperations,
  OfflineSqlTransferReceipt,
} from "../src/control-plane/operations";
import type { SqlTransferPhase } from "../src/control-plane/migration/transfer";
import {
  createCurrentHostOfflineTransferClient,
  type CurrentHostOfflineTransferClient,
} from "../src/current-host/operations";
import {
  createActivatedOfflineTransferAuthority,
  createPendingOfflineTransferAuthority,
  createRolledBackOfflineTransferAuthority,
  type LocalAuthorityDescriptor,
} from "../src/current-host/authority";
import type { CapletsError } from "../src/errors";

const startRequest = {
  transferId: "transfer_u12",
  identity: {
    logicalHostId: "host_u12",
    storeId: "store_u12",
    operationNamespace: "operations_u12",
  },
  sourceDescriptorDigest: "a".repeat(64),
  destinationDescriptorDigest: "b".repeat(64),
  sourceKeyProviderIdentity: "source-key-provider-u12",
  destinationKeyProviderIdentity: "destination-key-provider-u12",
  maxChunkBytes: 1024,
} as const;

const cutoverConfirmation = {
  action: "cutover",
  transferId: startRequest.transferId,
  token: "confirmation_cutover_u12",
  manifestDigest: "c".repeat(64),
  authorityGeneration: 1,
  expiresAt: "2999-07-17T12:00:00.000Z",
  consequencesDigest: "d".repeat(64),
} as const;

const finalizeConfirmation = {
  ...cutoverConfirmation,
  action: "finalize",
  token: "confirmation_finalize_u12",
} as const;

function receipt(
  action: OfflineSqlTransferReceipt["action"],
  phase: SqlTransferPhase,
  guidance: OfflineSqlTransferGuidance,
): OfflineSqlTransferReceipt {
  return {
    status: "accepted",
    action,
    target: "global",
    mode: "offline",
    transport: "local",
    transferId: startRequest.transferId,
    phase,
    guidance,
  };
}

function clientFixture() {
  const calls = {
    start: vi.fn<CurrentHostOfflineTransferClient["start"]>(async () =>
      receipt("start", "destination-verified", "confirm-cutover"),
    ),
    previewCutover: vi.fn<CurrentHostOfflineTransferClient["previewCutover"]>(async () => ({
      status: "confirmation-required",
      action: "cutover",
      target: "global",
      mode: "offline",
      transport: "local",
      transferId: startRequest.transferId,
      confirmation: cutoverConfirmation,
    })),
    cutover: vi.fn<CurrentHostOfflineTransferClient["cutover"]>(async () =>
      receipt("cutover", "destination-activated", "roll-forward-only"),
    ),
    rollback: vi.fn<CurrentHostOfflineTransferClient["rollback"]>(async () =>
      receipt("rollback", "rolled-back", "complete"),
    ),
    previewFinalize: vi.fn<CurrentHostOfflineTransferClient["previewFinalize"]>(async () => ({
      status: "confirmation-required",
      action: "finalize",
      target: "global",
      mode: "offline",
      transport: "local",
      transferId: startRequest.transferId,
      confirmation: finalizeConfirmation,
    })),
    finalize: vi.fn<CurrentHostOfflineTransferClient["finalize"]>(async () =>
      receipt("finalize", "completed", "complete"),
    ),
  };
  const client: CurrentHostOfflineTransferClient = { target: "global", ...calls };
  return { client, calls };
}

const silent = { writeOut: () => undefined, writeErr: () => undefined };
const serializedStartRequest = JSON.stringify(startRequest);
const destinationConfigArgs = ["--destination-config", "postgres-destination.json"] as const;

describe("packaged offline transfer CLI contract", () => {
  it("rejects absent, remote, mixed, and agent-style targets before transfer access", async () => {
    const { client, calls } = clientFixture();
    for (const args of [
      ["storage", "transfer", "start", "--offline", "--request", serializedStartRequest],
      [
        "storage",
        "transfer",
        "start",
        "--global",
        "--offline",
        "--request",
        serializedStartRequest,
      ],
      ["storage", "transfer", "start", "--global", "--request", serializedStartRequest],
      [
        "storage",
        "transfer",
        "start",
        "--global",
        "--offline",
        "--request",
        serializedStartRequest,
        "--remote",
      ],
      [
        "storage",
        "transfer",
        "start",
        "--global",
        "--offline",
        "--request",
        serializedStartRequest,
        "--project",
      ],
      [
        "remote",
        "storage",
        "transfer",
        "start",
        "--global",
        "--offline",
        "--request",
        serializedStartRequest,
      ],
    ]) {
      await expect(
        runCli(args, { ...silent, internalCurrentHostOfflineTransfer: client }),
      ).rejects.toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
    }
    expect(Object.values(calls).every((call) => call.mock.calls.length === 0)).toBe(true);
  });

  it("reports the accepted local global offline target through the stable receipt", async () => {
    const { client, calls } = clientFixture();
    const out: string[] = [];
    await runCli(
      [
        "storage",
        "transfer",
        "start",
        "--global",
        "--offline",
        ...destinationConfigArgs,
        "--request",
        serializedStartRequest,
      ],
      {
        ...silent,
        internalCurrentHostOfflineTransfer: client,
        writeOut: (value) => out.push(value),
      },
    );

    expect(calls.start).toHaveBeenCalledWith(startRequest);
    expect(JSON.parse(out.join(""))).toEqual(
      receipt("start", "destination-verified", "confirm-cutover"),
    );
  });

  it.each(["cutover", "finalize"] as const)(
    "rejects non-TTY %s confirmation before preview or protected operation access",
    async (action) => {
      const { client, calls } = clientFixture();
      const confirmation = action === "cutover" ? cutoverConfirmation : finalizeConfirmation;
      await expect(
        runCli(
          [
            "storage",
            "transfer",
            action,
            startRequest.transferId,
            "--global",
            "--offline",
            ...destinationConfigArgs,
            "--confirmation",
            JSON.stringify(confirmation),
          ],
          {
            ...silent,
            stdinIsTTY: false,
            stdoutIsTTY: false,
            internalCurrentHostOfflineTransfer: client,
          },
        ),
      ).rejects.toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
      expect(Object.values(calls).every((call) => call.mock.calls.length === 0)).toBe(true);
    },
  );

  it("rejects missing, mixed, stale, and mismatched confirmation before client access", async () => {
    const { client, calls } = clientFixture();
    const attempts = [
      [
        "storage",
        "transfer",
        "cutover",
        startRequest.transferId,
        "--global",
        "--offline",
        ...destinationConfigArgs,
      ],
      [
        "storage",
        "transfer",
        "finalize",
        startRequest.transferId,
        "--global",
        "--offline",
        ...destinationConfigArgs,
        "--preview",
        "--confirmation",
        JSON.stringify(finalizeConfirmation),
      ],
      [
        "storage",
        "transfer",
        "cutover",
        startRequest.transferId,
        "--global",
        "--offline",
        ...destinationConfigArgs,
        "--confirmation",
        JSON.stringify({ ...cutoverConfirmation, expiresAt: "2000-01-01T00:00:00.000Z" }),
      ],
      [
        "storage",
        "transfer",
        "cutover",
        startRequest.transferId,
        "--global",
        "--offline",
        ...destinationConfigArgs,
        "--confirmation",
        JSON.stringify(finalizeConfirmation),
      ],
    ];
    for (const args of attempts) {
      await expect(
        runCli(args, {
          ...silent,
          stdinIsTTY: true,
          stdoutIsTTY: true,
          internalCurrentHostOfflineTransfer: client,
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
    }
    expect(Object.values(calls).every((call) => call.mock.calls.length === 0)).toBe(true);
  });

  it("routes fresh previews, cutover, rollback, and finalize with global-only receipts", async () => {
    const { client, calls } = clientFixture();
    const out: string[] = [];
    const io = {
      ...silent,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      internalCurrentHostOfflineTransfer: client,
      writeOut: (value: string) => out.push(value),
    };
    await runCli(
      [
        "storage",
        "transfer",
        "cutover",
        startRequest.transferId,
        "--global",
        "--offline",
        ...destinationConfigArgs,
        "--preview",
      ],
      io,
    );
    const cutoverPreview = JSON.parse(out.pop()!);
    await runCli(
      [
        "storage",
        "transfer",
        "cutover",
        startRequest.transferId,
        "--global",
        "--offline",
        ...destinationConfigArgs,
        "--confirmation",
        JSON.stringify(cutoverPreview.confirmation),
      ],
      io,
    );
    await runCli(
      [
        "storage",
        "transfer",
        "rollback",
        startRequest.transferId,
        "--global",
        "--offline",
        ...destinationConfigArgs,
      ],
      io,
    );
    await runCli(
      [
        "storage",
        "transfer",
        "finalize",
        startRequest.transferId,
        "--global",
        "--offline",
        ...destinationConfigArgs,
        "--preview",
      ],
      io,
    );
    const finalizePreview = JSON.parse(out.pop()!);
    await runCli(
      [
        "storage",
        "transfer",
        "finalize",
        startRequest.transferId,
        "--global",
        "--offline",
        ...destinationConfigArgs,
        "--confirmation",
        JSON.stringify(finalizePreview.confirmation),
      ],
      io,
    );

    expect(calls.cutover).toHaveBeenCalledWith(startRequest.transferId, cutoverConfirmation);
    expect(calls.rollback).toHaveBeenCalledWith(startRequest.transferId);
    expect(calls.finalize).toHaveBeenCalledWith(startRequest.transferId, finalizeConfirmation);
    for (const line of out) {
      expect(JSON.parse(line)).toMatchObject({
        target: "global",
        mode: "offline",
        transport: "local",
      });
    }
  });

  it("authorizes the local host administrator before resolving transfer dependencies", async () => {
    const resolveTransferOperations = vi.fn<() => OfflineSqlTransferOperations>();
    const client = createCurrentHostOfflineTransferClient({
      authorizeLocalHostAdministrator: async () => {
        throw new Error("unauthorized");
      },
      resolveTransferOperations,
    });

    await expect(
      runCli(
        [
          "storage",
          "transfer",
          "start",
          "--global",
          "--offline",
          ...destinationConfigArgs,
          "--request",
          serializedStartRequest,
        ],
        { ...silent, internalCurrentHostOfflineTransfer: client },
      ),
    ).rejects.toThrow("unauthorized");
    expect(resolveTransferOperations).not.toHaveBeenCalled();
  });

  it("preserves the logical store and operation namespace across descriptor transfer states", () => {
    const source: Extract<LocalAuthorityDescriptor, { state: "bound" }> = {
      version: 1,
      state: "bound",
      logicalHostId: "host_01J00000000000000000000000",
      owner: { kind: "posix", uid: 1000 },
      storeId: "store_01J00000000000000000000000",
      operationNamespace: "operations_01J00000000000000000000000",
      authorityGeneration: 1,
      authorityToken: "authority_01J00000000000000000000000",
    };
    const pending = createPendingOfflineTransferAuthority(
      source,
      "transfer_01J00000000000000000000000",
    );
    expect(pending).toMatchObject({
      sourceStoreId: source.storeId,
      destinationStoreId: source.storeId,
      sourceOperationNamespace: source.operationNamespace,
      destinationOperationNamespace: source.operationNamespace,
    });
    expect(
      createActivatedOfflineTransferAuthority(pending, {
        authorityGeneration: 2,
        authorityToken: "authority_01J11111111111111111111111",
      }),
    ).toMatchObject({
      state: "bound",
      storeId: source.storeId,
      operationNamespace: source.operationNamespace,
      authorityGeneration: 2,
    });
    expect(createRolledBackOfflineTransferAuthority(pending)).toEqual(source);
  });
});
