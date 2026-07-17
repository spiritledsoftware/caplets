// @vitest-environment happy-dom
import { createHash } from "node:crypto";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  dashboardApi,
  dashboardPortableDownload,
  dashboardPortableOperation,
  dashboardPortableStatus,
  dashboardPortableUploadChunk,
} = vi.hoisted(() => ({
  dashboardApi: vi.fn(),
  dashboardPortableDownload: vi.fn(),
  dashboardPortableOperation: vi.fn(),
  dashboardPortableStatus: vi.fn(),
  dashboardPortableUploadChunk: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  DASHBOARD_PORTABLE_CHUNK_BYTES: 1024 * 1024,
  dashboardApi,
  dashboardPortableDownload,
  dashboardPortableOperation,
  dashboardPortableStatus,
  dashboardPortableUploadChunk,
}));

import { PortableCapletsPage } from "./PortableCapletsPage";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const caplets = [
  {
    id: "demo",
    title: "Demo Caplet",
    description: "A portable test Caplet.",
    source: "sql",
    activation: "active",
    setupRequired: false,
  },
];

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await flush();
  }
  throw new Error("Timed out waiting for portable dashboard state.");
}

function findButton(label: string): HTMLButtonElement {
  const result = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!result) throw new Error(`Could not find button: ${label}`);
  return result;
}

async function mount(options: { live?: boolean; reason?: string } = {}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <PortableCapletsPage
        caplets={caplets}
        managementTargets={[]}
        loading={false}
        liveAuthorityAvailable={options.live ?? true}
        liveAuthorityUnavailableReason={options.reason ?? "Storage is stale and read-only."}
      />,
    );
  });
  await flush();
}

async function selectImportFile(
  file = new File(["portable bytes"], "demo.caplet", {
    type: "application/vnd.caplets.portable",
  }),
) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("Import file input is missing.");
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState({}, "", "/dashboard/caplets");
  dashboardApi.mockReset();
  dashboardPortableDownload.mockReset();
  dashboardPortableOperation.mockReset();
  dashboardPortableStatus.mockReset();
  dashboardPortableUploadChunk.mockReset();
  dashboardPortableUploadChunk.mockResolvedValue({ status: "accepted" });
  dashboardPortableDownload.mockReturnValue(
    "/dashboard/api/portable/artifacts?ref=portable-export",
  );
  dashboardPortableStatus.mockResolvedValue({
    kind: "portable_status",
    status: "live",
    health: {},
    guidanceCode: "ok",
  });
  dashboardPortableOperation.mockImplementation(async (operation: { kind: string }) => {
    throw new Error(`Unexpected portable operation: ${operation.kind}`);
  });
  vi.stubGlobal("crypto", {
    randomUUID: vi.fn(() => "uuid"),
    subtle: {
      digest: vi.fn(async () => new Uint8Array(32).fill(10).buffer),
    },
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("portable Caplets flow", () => {
  it("shows an inert preview, replacement and setup decisions, cancellation, and activation success", async () => {
    dashboardPortableOperation.mockImplementation(async (operation: { kind: string }) => {
      if (operation.kind === "portable_status") {
        return { kind: operation.kind, status: "live", health: {}, guidanceCode: "ok" };
      }
      if (operation.kind === "portable_import_session_create") {
        return {
          kind: operation.kind,
          status: "created",
          session: {
            sessionId: "session-1",
            operationId: "portable_uuid",
            state: "created",
            nextOffset: 0,
            reservedBytes: 14,
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        };
      }
      if (operation.kind === "portable_import_session_finalize") {
        return {
          kind: operation.kind,
          status: "finalized",
          session: { sessionId: "session-1" },
          artifact: {
            reference: {
              uri: "caplets://artifacts/host/final",
              operationId: "portable_uuid",
            },
            sha256: "a".repeat(64),
            byteLength: 14,
            mimeType: "application/vnd.caplets.portable",
          },
        };
      }
      if (operation.kind === "portable_import_preview") {
        return {
          kind: operation.kind,
          status: "previewed",
          proposal: {
            proposalId: "proposal-1",
            proposalHash: "proposal-hash",
            operationId: "portable_uuid",
            capletId: "demo-imported",
            collisionPolicy: "replace",
            differences: [
              { field: '<img src=x onerror="globalThis.pwned=true">', effect: "changed" },
            ],
            setupDependencies: [{ name: "API_TOKEN", type: "local", status: "required" }],
            consequence: "effective-runtime-changes",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        };
      }
      if (operation.kind === "portable_import_activate") {
        return {
          kind: operation.kind,
          status: "committed",
          receipt: { operationId: "operation-1" },
          caplet: {
            id: "demo-imported",
            activation: "setup-required",
            setupDependencies: [{ name: "API_TOKEN", type: "local", status: "required" }],
          },
        };
      }
      throw new Error(`Unexpected portable operation: ${operation.kind}`);
    });
    await mount();
    await selectImportFile();

    await act(async () => findButton("Preview import").click());
    await waitFor(() =>
      document.body.textContent?.includes("effective-runtime-changes") ? true : undefined,
    );

    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain('<img src=x onerror="globalThis.pwned=true">');
    expect(document.body.textContent).toContain("API_TOKEN");
    expect(
      document.querySelector<HTMLAnchorElement>('a[href^="/dashboard/vault?returnTo="]'),
    ).not.toBeNull();
    expect(findButton("Activate import").disabled).toBe(true);

    const confirmation = document.querySelector<HTMLInputElement>(
      'input[name="portable-activation-confirmation"]',
    );
    if (!confirmation) throw new Error("Activation confirmation is missing.");
    await act(async () => confirmation.click());
    await act(async () => findButton("Activate import").click());
    await waitFor(() =>
      document.body.textContent?.includes("Import activated") ? true : undefined,
    );
    expect(document.body.textContent).toContain("Setup Required");

    expect(
      dashboardPortableOperation.mock.calls
        .filter(([operation]) => operation.kind.startsWith("portable_import_"))
        .map(([operation, operationId]) => [operation.kind, operationId]),
    ).toEqual([
      ["portable_import_session_create", "portable_uuid"],
      ["portable_import_session_finalize", "portable_uuid"],
      ["portable_import_preview", "portable_uuid"],
      ["portable_import_activate", "portable_uuid"],
    ]);
    expect(dashboardPortableUploadChunk).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "portable_uuid" }),
    );
    await act(async () => findButton("Import another").click());
    expect(document.body.textContent).not.toContain("Import activated");
  });

  it("preserves a rejected proposal for replacement retry and allows cancellation", async () => {
    let previewCount = 0;
    dashboardPortableOperation.mockImplementation(async (operation: { kind: string }) => {
      if (operation.kind === "portable_status")
        return { kind: operation.kind, status: "live", health: {}, guidanceCode: "ok" };
      if (operation.kind === "portable_import_session_create") {
        return {
          kind: operation.kind,
          status: "created",
          session: {
            sessionId: "session-2",
            operationId: "portable_uuid",
          },
        };
      }
      if (operation.kind === "portable_import_session_finalize") {
        return {
          kind: operation.kind,
          status: "finalized",
          session: { sessionId: "session-2" },
          artifact: {
            reference: {
              uri: "caplets://artifacts/host/final",
              operationId: "portable_uuid",
            },
          },
        };
      }
      if (operation.kind === "portable_import_preview") {
        previewCount += 1;
        return previewCount === 1
          ? { kind: operation.kind, status: "rejected", reason: "sql-collision" }
          : {
              kind: operation.kind,
              status: "previewed",
              proposal: {
                proposalId: "proposal-2",
                proposalHash: "hash-2",
                operationId: "portable_uuid",
                capletId: "demo",
                collisionPolicy: "replace",
                differences: [],
                setupDependencies: [],
                consequence: "effective-runtime-changes",
                expiresAt: "2099-01-01T00:00:00.000Z",
              },
            };
      }
      throw new Error(`Unexpected operation: ${operation.kind}`);
    });
    await mount();
    await selectImportFile();
    await act(async () => findButton("Preview import").click());
    await waitFor(() => (document.querySelector('[role="alert"]') ? true : undefined));
    expect(document.body.textContent).toContain("SQL collision");

    const replace = document.querySelector<HTMLInputElement>('input[value="replace"]');
    if (!replace) throw new Error("Replacement decision is missing.");
    await act(async () => replace.click());
    const replacementConfirmation = document.querySelector<HTMLInputElement>(
      'input[name="portable-replacement-confirmation"]',
    );
    if (!replacementConfirmation) throw new Error("Replacement confirmation is missing.");
    await act(async () => replacementConfirmation.click());
    await act(async () => findButton("Retry preview").click());
    await waitFor(() =>
      document.body.textContent?.includes("effective-runtime-changes") ? true : undefined,
    );

    await act(async () => findButton("Cancel import").click());
    expect(document.body.textContent).not.toContain("effective-runtime-changes");
    expect(document.body.textContent).toContain("Select a portable Caplet file");
  });

  it("accepts the exact 256 MiB boundary and rejects one byte over it", async () => {
    await mount();
    const exactBoundary = {
      name: "boundary.caplet",
      size: 256 * 1024 * 1024,
      type: "application/vnd.caplets.portable",
    } as File;
    await selectImportFile(exactBoundary);
    expect(findButton("Preview import").disabled).toBe(false);

    const overBoundary = {
      ...exactBoundary,
      size: exactBoundary.size + 1,
    } as File;
    await selectImportFile(overBoundary);
    expect(findButton("Retry preview").disabled).toBe(true);
    expect(document.body.textContent).toContain("cannot exceed 256 MiB");
  });

  it("hashes and uploads multi-MiB files only through bounded 1 MiB slices", async () => {
    dashboardPortableOperation.mockImplementation(
      async (operation: { kind: string }, operationId: string) => {
        if (operation.kind === "portable_import_session_create") {
          return {
            kind: operation.kind,
            status: "created",
            session: { sessionId: "session-large", operationId },
          };
        }
        if (operation.kind === "portable_import_session_finalize") {
          return {
            kind: operation.kind,
            status: "finalized",
            session: { sessionId: "session-large", operationId },
            artifact: {
              reference: {
                uri: "caplets://artifacts/host/large",
                operationId,
              },
            },
          };
        }
        if (operation.kind === "portable_import_preview") {
          return { kind: operation.kind, status: "rejected", reason: "sql-collision" };
        }
        throw new Error(`Unexpected operation: ${operation.kind}`);
      },
    );
    const file = new File(
      [
        new Uint8Array(1024 * 1024).fill(1),
        new Uint8Array(1024 * 1024).fill(2),
        new Uint8Array(17).fill(3),
      ],
      "large.caplet",
      { type: "application/vnd.caplets.portable" },
    );
    vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("whole-file buffering is forbidden"));
    await mount();
    await selectImportFile(file);

    await act(async () => findButton("Preview import").click());
    await waitFor(() => (dashboardPortableUploadChunk.mock.calls.length === 3 ? true : undefined));

    expect(
      dashboardPortableUploadChunk.mock.calls.map((call) => {
        const chunk = call[0] as { bytes: Uint8Array; operationId: string };
        return [chunk.bytes.byteLength, chunk.operationId];
      }),
    ).toEqual([
      [1024 * 1024, "portable_uuid"],
      [1024 * 1024, "portable_uuid"],
      [17, "portable_uuid"],
    ]);
    const createCall = dashboardPortableOperation.mock.calls.find(
      ([operation]) => operation.kind === "portable_import_session_create",
    );
    expect(createCall?.[0]).toMatchObject({
      expectedSha256: createHash("sha256")
        .update(new Uint8Array(1024 * 1024).fill(1))
        .update(new Uint8Array(1024 * 1024).fill(2))
        .update(new Uint8Array(17).fill(3))
        .digest("hex"),
    });
    expect(file.arrayBuffer).not.toHaveBeenCalled();
  });

  it("preserves list/detail return context and downloads an effective export", async () => {
    dashboardPortableOperation.mockImplementation(async (operation: { kind: string }) => {
      if (operation.kind === "portable_status")
        return { kind: operation.kind, status: "live", health: {}, guidanceCode: "ok" };
      if (operation.kind === "portable_export_create") {
        return {
          kind: operation.kind,
          status: "created",
          artifactType: "file",
          artifact: {
            reference: { uri: "caplets://artifacts/host/export" },
            sha256: "b".repeat(64),
            byteLength: 6,
            mimeType: "application/vnd.caplets.portable",
          },
        };
      }
      throw new Error(`Unexpected operation: ${operation.kind}`);
    });
    let downloadedHref: string | undefined;
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadedHref = this.href;
      });
    await mount();

    const detailLink = document.querySelector<HTMLAnchorElement>(
      'a[href="/dashboard/caplets/demo"]',
    );
    if (!detailLink) throw new Error("Caplet detail link is missing.");
    await act(async () =>
      detailLink.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })),
    );
    expect(window.location.pathname).toBe("/dashboard/caplets/demo");
    expect(document.body.textContent).toContain("Effective record");

    await act(async () => findButton("Export effective").click());
    await waitFor(() => (anchorClick.mock.calls.length ? true : undefined));
    expect(dashboardPortableDownload).toHaveBeenCalledWith("caplets://artifacts/host/export");
    expect(downloadedHref).toContain("/dashboard/api/portable/artifacts?ref=portable-export");

    await act(async () => findButton("Back to Caplets").click());
    expect(window.location.pathname).toBe("/dashboard/caplets");
    expect(document.activeElement?.textContent).toContain("Demo Caplet");
  });

  it("blocks stale operations with an accessible reason and exposes safe errors", async () => {
    dashboardPortableStatus.mockRejectedValueOnce(new Error("/private/server/caplet missing"));
    await mount({ live: false, reason: "Storage is stale and read-only." });

    expect(findButton("Preview import").disabled).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Storage is stale and read-only.",
    );
    expect(document.body.textContent).not.toContain("/private/server");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Portable status is unavailable.",
    );
  });
});
