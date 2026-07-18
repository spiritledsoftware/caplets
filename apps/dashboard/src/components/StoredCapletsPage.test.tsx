// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dashboardApi, toast } = vi.hoisted(() => ({
  dashboardApi: vi.fn(),
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ dashboardApi }));
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

function responseFor(path: string, options?: RequestInit) {
  const method = options?.method ?? "GET";
  if (path === "stored-caplets" && method === "GET") return { records };
  if (path === "stored-caplets" && method === "POST") {
    const body = JSON.parse(String(options?.body)) as {
      id: string;
      document: string;
      historyLimit?: number;
    };
    documentBody = body.document;
    revisions = [{ revisionKey: "revision-1", sequence: 1, name: "Imported Caplet" }];
    const record = storedRecord({
      id: body.id,
      recordKey: `record-${body.id}`,
      headGeneration: 1,
      historyLimit: body.historyLimit,
      currentRevision: {
        revisionKey: "revision-1",
        sequence: 1,
        name: "Imported Caplet",
      },
    });
    replaceCurrent(record);
    return { record };
  }

  if (path.endsWith("/revisions") && method === "GET") return { revisions };
  if (path.endsWith("/restore") && method === "POST") {
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
    return { record: restored };
  }

  if (path.includes("/revisions/") && method === "DELETE") {
    const revisionKey = decodeURIComponent(path.split("/revisions/")[1] ?? "");
    revisions = revisions.filter((revision) => revision.revisionKey !== revisionKey);
    const previous = currentRecord();
    const record = storedRecord({ ...previous, headGeneration: generation(previous) + 1 });
    replaceCurrent(record);
    return { record };
  }

  if (path === "stored-caplets/alpha" && method === "PUT") {
    const body = JSON.parse(String(options?.body)) as {
      document: string;
      expectedGeneration: number;
    };
    documentBody = body.document;
    const previous = currentRecord();
    const record = storedRecord({
      ...previous,
      headGeneration: body.expectedGeneration + 1,
      currentRevision: {
        revisionKey: "revision-3",
        sequence: 3,
        name: "Alpha tools",
      },
    });
    revisions = [{ revisionKey: "revision-3", sequence: 3, name: "Alpha tools" }, ...revisions];
    replaceCurrent(record);
    return { record };
  }

  if (path === "stored-caplets/alpha" && method === "DELETE") {
    records = [];
    revisions = [];
    return { deleted: true, id: "alpha" };
  }

  if (path.startsWith("stored-caplets/") && method === "GET") {
    return { record: currentRecord(), document: documentBody };
  }
  throw new Error(`Unexpected dashboard request: ${method} ${path}`);
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
  dashboardApi.mockImplementation((path: string, options?: RequestInit) =>
    Promise.resolve(responseFor(path, options)),
  );
  dashboardApi.mockClear();
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
    expect(dashboardApi).toHaveBeenCalledWith("stored-caplets");
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
      dashboardApi.mock.calls.some(
        ([path, options]) => path === "stored-caplets" && options?.method === "POST",
      )
        ? true
        : undefined,
    );
    expect(dashboardApi).toHaveBeenCalledWith("stored-caplets", {
      method: "POST",
      body: JSON.stringify({
        id: "imported-caplet",
        document: "# Imported Caplet\n",
        historyLimit: 7,
      }),
    });
    expect(action).toHaveBeenCalledWith("Imported imported-caplet", expect.any(Function));
  });

  it("edits the current Markdown with its observed CAS generation", async () => {
    await mount();
    await inspectAlpha();
    await click("Edit Markdown");

    const editor = document.querySelector<HTMLTextAreaElement>("#stored-caplet-editor");
    if (!editor) throw new Error("Stored Caplet editor was not rendered.");
    await setValue(editor, "# Alpha tools\n\nUpdated document.\n");
    await click("Save new revision");

    await waitFor(() =>
      dashboardApi.mock.calls.some(
        ([path, options]) => path === "stored-caplets/alpha" && options?.method === "PUT",
      )
        ? true
        : undefined,
    );
    expect(dashboardApi).toHaveBeenCalledWith("stored-caplets/alpha", {
      method: "PUT",
      body: JSON.stringify({
        document: "# Alpha tools\n\nUpdated document.\n",
        expectedGeneration: 2,
      }),
    });
  });

  it("restores a prior revision after confirmation", async () => {
    await mount();
    await inspectAlpha();
    await click("Restore revision 1");

    await waitFor(() =>
      dashboardApi.mock.calls.some(
        ([path]) => path === "stored-caplets/alpha/revisions/revision-1/restore",
      )
        ? true
        : undefined,
    );
    expect(confirmAction).toHaveBeenCalledWith(
      "Restore revision 1?",
      expect.stringContaining("creates a new current revision"),
    );
    expect(dashboardApi).toHaveBeenCalledWith("stored-caplets/alpha/revisions/revision-1/restore", {
      method: "POST",
      body: JSON.stringify({ expectedGeneration: 2 }),
    });
  });

  it("deletes a revision only after destructive confirmation", async () => {
    await mount();
    await inspectAlpha();
    await click("Delete revision 1");

    await waitFor(() =>
      dashboardApi.mock.calls.some(
        ([path, options]) =>
          path === "stored-caplets/alpha/revisions/revision-1" && options?.method === "DELETE",
      )
        ? true
        : undefined,
    );
    expect(confirmDestructive).toHaveBeenCalledWith(
      "Delete revision 1?",
      expect.stringContaining("permanently removes"),
      "Delete revision",
    );
    expect(dashboardApi).toHaveBeenCalledWith("stored-caplets/alpha/revisions/revision-1", {
      method: "DELETE",
      body: JSON.stringify({ expectedGeneration: 2 }),
    });
  });

  it("hard-deletes a record only after typed id confirmation", async () => {
    await mount();
    await inspectAlpha();
    await click("Hard-delete record");

    await waitFor(() =>
      dashboardApi.mock.calls.some(
        ([path, options]) => path === "stored-caplets/alpha" && options?.method === "DELETE",
      )
        ? true
        : undefined,
    );
    expect(confirmTyped).toHaveBeenCalledWith(
      "Hard-delete Alpha tools?",
      expect.stringContaining("permanently deletes the SQL record"),
      "delete alpha",
    );
    expect(dashboardApi).toHaveBeenCalledWith("stored-caplets/alpha", {
      method: "DELETE",
      body: JSON.stringify({ expectedGeneration: 2 }),
    });
    await waitFor(() =>
      document.body.textContent?.includes("No SQL Caplet Records yet") ? true : undefined,
    );
  });
});
