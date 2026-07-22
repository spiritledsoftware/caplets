// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminClient, toast } = vi.hoisted(() => ({
  adminClient: {
    adminV2CreateCapletRecordFromDocument: vi.fn(),
    adminV2DeleteCapletRecord: vi.fn(),
    adminV2DeleteCapletRecordRevision: vi.fn(),
    adminV2GetCapletRecord: vi.fn(),
    adminV2GetCapletRecordRevision: vi.fn(),
    adminV2ListCapletRecordRevisions: vi.fn(),
    adminV2ListCapletRecords: vi.fn(),
    adminV2PutCapletRecordCurrentRevision: vi.fn(),
    adminV2UpdateCapletRecord: vi.fn(),
  },
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({
  ...adminClient,
  createDashboardMutationIntent: () => ({ idempotencyKey: "test-intent" }),
}));
vi.mock("sonner", () => ({ toast }));

import {
  StoredCapletsPage,
  type StoredCapletRecord,
  type StoredCapletsPageProps,
} from "./StoredCapletsPage";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let records: StoredCapletRecord[];
let documentBody: string;
let revisions: Array<{ revisionKey: string; sequence: number; name: string }>;
let confirmAction: StoredCapletsPageProps["confirmAction"];
let confirmDestructive: StoredCapletsPageProps["confirmDestructive"];
let confirmTyped: StoredCapletsPageProps["confirmTyped"];
let action: StoredCapletsPageProps["action"];

function storedRecord(overrides: Partial<StoredCapletRecord> = {}): StoredCapletRecord {
  return {
    id: "alpha",
    recordKey: "record-alpha",
    headGeneration: 2,
    historyLimit: 5,
    updatedAt: "2026-07-18T12:00:00.000Z",
    currentRevision: {
      revisionKey: "revision-2",
      sequence: 2,
      name: "Alpha tools",
      description: "Current SQL record",
      contentHash: "sha256:current",
    },
    ...overrides,
  };
}

function generation(record: StoredCapletRecord): number {
  return record.generation ?? record.headGeneration ?? 0;
}

function currentRecord(): StoredCapletRecord {
  const record = records[0];
  if (!record) throw new Error("Expected a stored Caplet fixture.");
  return record;
}

function replaceCurrent(record: StoredCapletRecord) {
  records = [record];
}

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
  throw new Error("Timed out waiting for Stored Caplets state.");
}

function button(label: string): HTMLButtonElement {
  const result = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
  );
  if (!result) throw new Error(`Could not find button: ${label}`);
  return result;
}

async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
  await flush();
}

async function setValue(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  await act(async () => {
    valueSetter?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <StoredCapletsPage
        action={action}
        confirmAction={confirmAction}
        confirmDestructive={confirmDestructive}
        confirmTyped={confirmTyped}
      />,
    );
  });
  await waitFor(() =>
    document.body.textContent?.includes("SQL record inventory") ? true : undefined,
  );
  await flush();
}

async function inspectAlpha() {
  await waitFor(() =>
    document.body.textContent?.includes("Alpha tools") ? button("Inspect") : undefined,
  );
  await click("Inspect");
  await waitFor(() =>
    document.body.textContent?.includes("Current CAPLET.md") ? true : undefined,
  );
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  records = [storedRecord()];
  documentBody = "# Alpha tools\n\nCurrent document.\n";
  revisions = [
    { revisionKey: "revision-2", sequence: 2, name: "Alpha tools" },
    { revisionKey: "revision-1", sequence: 1, name: "Alpha tools old" },
  ];
  for (const operation of Object.values(adminClient)) operation.mockReset();
  adminClient.adminV2ListCapletRecords.mockImplementation(async () => ({ items: records }));
  adminClient.adminV2GetCapletRecord.mockImplementation(async () => ({
    data: { record: currentRecord(), document: documentBody },
    etag: `"generation-${generation(currentRecord())}"`,
  }));
  adminClient.adminV2GetCapletRecordRevision.mockImplementation(
    async (_id: string, revisionKey: string) => ({
      data: revisions.find((revision) => revision.revisionKey === revisionKey),
      etag: `"${revisionKey}-etag"`,
    }),
  );
  adminClient.adminV2ListCapletRecordRevisions.mockImplementation(async () => ({
    items: revisions,
  }));
  adminClient.adminV2CreateCapletRecordFromDocument.mockImplementation(
    async (id: string, document: string, _intent: unknown, historyLimit?: number) => {
      documentBody = document;
      revisions = [{ revisionKey: "revision-1", sequence: 1, name: "Imported Caplet" }];
      const record = storedRecord({
        id,
        recordKey: `record-${id}`,
        headGeneration: 1,
        historyLimit,
        currentRevision: {
          revisionKey: "revision-1",
          sequence: 1,
          name: "Imported Caplet",
        },
      });
      replaceCurrent(record);
      return record;
    },
  );
  adminClient.adminV2UpdateCapletRecord.mockImplementation(
    async (_id: string, body: { document: string }) => {
      documentBody = body.document;
      const previous = currentRecord();
      const record = storedRecord({
        ...previous,
        headGeneration: generation(previous) + 1,
        currentRevision: {
          revisionKey: "revision-3",
          sequence: 3,
          name: "Alpha tools",
        },
      });
      revisions = [{ revisionKey: "revision-3", sequence: 3, name: "Alpha tools" }, ...revisions];
      replaceCurrent(record);
      return record;
    },
  );
  adminClient.adminV2PutCapletRecordCurrentRevision.mockImplementation(async () => {
    const previous = currentRecord();
    const restored = storedRecord({
      ...previous,
      headGeneration: generation(previous) + 1,
      currentRevision: {
        revisionKey: "revision-restored",
        sequence: 3,
        name: "Alpha tools restored",
      },
    });
    documentBody = "# Alpha restored\n";
    revisions = [
      { revisionKey: "revision-restored", sequence: 3, name: "Alpha tools restored" },
      ...revisions,
    ];
    replaceCurrent(restored);
    return restored;
  });
  adminClient.adminV2DeleteCapletRecordRevision.mockImplementation(
    async (_id: string, revisionKey: string) => {
      revisions = revisions.filter((revision) => revision.revisionKey !== revisionKey);
      const previous = currentRecord();
      const record = storedRecord({ ...previous, headGeneration: generation(previous) + 1 });
      replaceCurrent(record);
      return { record };
    },
  );
  adminClient.adminV2DeleteCapletRecord.mockImplementation(async (id: string) => {
    records = [];
    revisions = [];
    return { deleted: true, id };
  });
  toast.error.mockClear();
  toast.success.mockClear();
  action = vi.fn(async (_label, callback) => {
    await callback();
  });
  confirmAction = vi.fn(async () => true);
  confirmDestructive = vi.fn(async () => true);
  confirmTyped = vi.fn(async () => true);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe("Stored Caplets administration", () => {
  it("lists SQL records with provenance, generation, and retention", async () => {
    await mount();

    await waitFor(() => (document.body.textContent?.includes("Alpha tools") ? true : undefined));
    expect(document.body.textContent).toContain("SQL record");
    expect(document.body.textContent).toContain("Generation");
    expect(document.body.textContent).toContain("5 revisions");
    expect(adminClient.adminV2ListCapletRecords).toHaveBeenCalledOnce();
  });

  it("loads one record page initially and renders records beyond 100 after an explicit action", async () => {
    const page = Array.from({ length: 100 }, (_, index) =>
      storedRecord({
        id: `record-${String(index).padStart(3, "0")}`,
        recordKey: `key-${index}`,
        currentRevision: {
          revisionKey: `revision-${index}`,
          sequence: 1,
          name: `Stored Caplet ${index}`,
        },
      }),
    );
    const laterRecord = storedRecord({
      id: "record-100",
      recordKey: "key-100",
      currentRevision: {
        revisionKey: "revision-100",
        sequence: 1,
        name: "Later Stored Caplet",
      },
    });
    adminClient.adminV2ListCapletRecords.mockImplementation(
      async ({ cursor }: { cursor?: string } = {}) =>
        cursor === "page-2" ? { items: [laterRecord] } : { items: page, nextCursor: "page-2" },
    );

    await mount();
    expect(adminClient.adminV2ListCapletRecords).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("Later Stored Caplet");

    await click("Load more stored Caplets");
    await waitFor(() =>
      document.body.textContent?.includes("Later Stored Caplet") ? true : undefined,
    );
    expect(adminClient.adminV2ListCapletRecords).toHaveBeenNthCalledWith(2, {
      cursor: "page-2",
    });
  });

  it("loads one revision page and exposes later history after an explicit action", async () => {
    adminClient.adminV2ListCapletRecordRevisions.mockImplementation(
      async (_id: string, { cursor }: { cursor?: string } = {}) =>
        cursor === "history-page-2"
          ? {
              items: [
                {
                  revisionKey: "revision-100",
                  sequence: 100,
                  name: "Later revision",
                },
              ],
            }
          : {
              items: Array.from({ length: 100 }, (_, index) => ({
                revisionKey: `revision-${index}`,
                sequence: index,
                name: `Revision ${index}`,
              })),
              nextCursor: "history-page-2",
            },
    );

    await mount();
    await inspectAlpha();
    expect(adminClient.adminV2ListCapletRecordRevisions).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("Later revision");

    await click("Load more revisions");
    await waitFor(() => (document.body.textContent?.includes("Later revision") ? true : undefined));
    expect(adminClient.adminV2ListCapletRecordRevisions).toHaveBeenNthCalledWith(2, "alpha", {
      cursor: "history-page-2",
    });
  });

  it("imports CAPLET.md with an optional history limit", async () => {
    records = [];
    await mount();
    await click("Import CAPLET.md");

    const id = document.querySelector<HTMLInputElement>("#stored-caplet-id");
    const historyLimit = document.querySelector<HTMLInputElement>("#stored-caplet-history-limit");
    const markdown = document.querySelector<HTMLTextAreaElement>("#stored-caplet-document");
    if (!id || !historyLimit || !markdown) throw new Error("Import fields were not rendered.");
    await setValue(id, "imported-caplet");
    await setValue(historyLimit, "7");
    await setValue(markdown, "# Imported Caplet\n");
    await click("Import record");

    await waitFor(() =>
      adminClient.adminV2CreateCapletRecordFromDocument.mock.calls.length ? true : undefined,
    );
    expect(adminClient.adminV2CreateCapletRecordFromDocument).toHaveBeenCalledWith(
      "imported-caplet",
      "# Imported Caplet\n",
      { idempotencyKey: "test-intent" },
      7,
    );
    expect(action).toHaveBeenCalledWith("Imported imported-caplet", expect.any(Function));
  });

  it("edits the current Markdown with its observed detail ETag", async () => {
    await mount();
    await inspectAlpha();
    await click("Edit Markdown");

    const editor = document.querySelector<HTMLTextAreaElement>("#stored-caplet-editor");
    if (!editor) throw new Error("Stored Caplet editor was not rendered.");
    await setValue(editor, "# Alpha tools\n\nUpdated document.\n");
    await click("Save new revision");

    await waitFor(() =>
      adminClient.adminV2UpdateCapletRecord.mock.calls.length ? true : undefined,
    );
    expect(adminClient.adminV2UpdateCapletRecord).toHaveBeenCalledWith(
      "alpha",
      { document: "# Alpha tools\n\nUpdated document.\n" },
      '"generation-2"',
      { idempotencyKey: "test-intent" },
    );
  });

  it("restores a prior revision after confirmation", async () => {
    await mount();
    await inspectAlpha();
    await click("Restore revision 1");

    await waitFor(() =>
      adminClient.adminV2PutCapletRecordCurrentRevision.mock.calls.length ? true : undefined,
    );
    expect(confirmAction).toHaveBeenCalledWith(
      "Restore revision 1?",
      expect.stringContaining("creates a new current revision"),
    );
    expect(adminClient.adminV2PutCapletRecordCurrentRevision).toHaveBeenCalledWith(
      "alpha",
      "revision-1",
      '"generation-2"',
      { idempotencyKey: "test-intent" },
    );
  });

  it("deletes a revision only after destructive confirmation", async () => {
    await mount();
    await inspectAlpha();
    await click("Delete revision 1");

    await waitFor(() =>
      adminClient.adminV2DeleteCapletRecordRevision.mock.calls.length ? true : undefined,
    );
    expect(confirmDestructive).toHaveBeenCalledWith(
      "Delete revision 1?",
      expect.stringContaining("permanently removes"),
      "Delete revision",
    );
    expect(adminClient.adminV2GetCapletRecordRevision).toHaveBeenCalledWith("alpha", "revision-1");
    expect(adminClient.adminV2DeleteCapletRecordRevision).toHaveBeenCalledWith(
      "alpha",
      "revision-1",
      '"revision-1-etag"',
      '"generation-2"',
      { idempotencyKey: "test-intent" },
    );
  });

  it("hard-deletes a record only after typed id confirmation", async () => {
    await mount();
    await inspectAlpha();
    await click("Hard-delete record");

    await waitFor(() =>
      adminClient.adminV2DeleteCapletRecord.mock.calls.length ? true : undefined,
    );
    expect(confirmTyped).toHaveBeenCalledWith(
      "Hard-delete Alpha tools?",
      expect.stringContaining("permanently deletes the SQL record"),
      "delete alpha",
    );
    expect(adminClient.adminV2DeleteCapletRecord).toHaveBeenCalledWith("alpha", '"generation-2"', {
      idempotencyKey: "test-intent",
    });
    await waitFor(() =>
      document.body.textContent?.includes("No SQL Caplet Records yet") ? true : undefined,
    );
  });
});
