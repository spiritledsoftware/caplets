// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dashboardApi, setDashboardSession, toast } = vi.hoisted(() => ({
  dashboardApi: vi.fn(),
  setDashboardSession: vi.fn(),
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({
  dashboardApi,
  isDashboardUnauthorized: () => false,
  setDashboardSession,
}));

vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("sonner", () => ({ toast }));

import { DashboardApp } from "./DashboardApp";

type Deferred<T> = {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
};

const vaultKey = "TEST_SECRET";
const session = {
  sessionId: "session-id",
  operatorClientId: "operator-id",
  csrfToken: "csrf-token",
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let revealResponses: Array<Deferred<{ value: string }> | { value: string }>;

function deferred<T>(): Deferred<T> {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    reject = fail;
    resolve = fulfill;
  });
  return { promise, reject, resolve };
}

function responseFor(path: string) {
  if (path === "session") return { authenticated: true, session };
  if (path === "vault") return { values: [{ key: vaultKey, valueBytes: 12 }] };
  if (path === "vault/reveal") {
    const response = revealResponses.shift();
    if (!response) throw new Error("Unexpected vault reveal request.");
    return "promise" in response ? response.promise : response;
  }
  return {};
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await flush();
  }
  throw new Error("Timed out waiting for dashboard state.");
}

function button(label: string): HTMLButtonElement {
  const result = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
  );
  if (!result) throw new Error(`Could not find button: ${label}`);
  return result;
}
async function setInput(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`Could not find input: ${selector}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function mountVault() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<DashboardApp initialRoute="vault" />);
  });
  await waitFor(
    () =>
      document.querySelector<HTMLButtonElement>(
        `button[aria-label="Reveal vault value ${vaultKey}"]`,
      ) ?? undefined,
  );
}

async function mountRoute(
  initialRoute: "caplets" | "runtime" | "settings",
  responses: Record<string, unknown>,
) {
  dashboardApi.mockImplementation((path: string) =>
    Promise.resolve(
      path === "session" ? { authenticated: true, session } : (responses[path] ?? {}),
    ),
  );
  window.history.replaceState({}, "", `/dashboard/${initialRoute}`);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<DashboardApp initialRoute={initialRoute} />);
  });
  await waitFor(() =>
    Array.from(document.querySelectorAll("h1")).some(
      (heading) => heading.textContent === initialRoute[0]?.toUpperCase() + initialRoute.slice(1),
    )
      ? true
      : undefined,
  );
}

const opaqueGeneration = {
  authorityId: `storage-provider://${"a".repeat(120)}?credential=must-stay-opaque`,
  id: `generation://${"b".repeat(120)}?token=must-stay-opaque`,
  sequence: 12,
  predecessorId: `generation://${"c".repeat(120)}?secret=must-stay-opaque`,
};

function writableHealth(activeGeneration: Record<string, unknown> = opaqueGeneration) {
  return {
    provider: "s3",
    authorityId: String(activeGeneration.authorityId ?? "storage"),
    connectivity: "healthy",
    writable: true,
    activeGeneration,
    observedGeneration: activeGeneration,
    exposureGeneration: 12,
    refresh: "current",
    lifecycle: "ready",
    readiness: "ready",
    lag: 0,
  };
}

async function openRevealConfirmation() {
  await act(async () => {
    button(`Reveal vault value ${vaultKey}`).click();
  });
  const phrase = await waitFor(
    () =>
      document.querySelector<HTMLInputElement>(
        `input[aria-label="Type reveal ${vaultKey} to confirm"]`,
      ) ?? undefined,
  );
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(phrase, `reveal ${vaultKey}`);
    phrase.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await waitFor(() => (button(`Reveal for 30s`).disabled ? undefined : button(`Reveal for 30s`)));
}

async function confirmReveal() {
  await act(async () => {
    button(`Reveal for 30s`).click();
  });
}

async function reveal(value: string) {
  revealResponses.push({ value });
  await openRevealConfirmation();
  await confirmReveal();
  await waitFor(
    () => document.querySelector<HTMLElement>(`[aria-label="Hide revealed value"]`) ?? undefined,
  );
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  revealResponses = [];
  dashboardApi.mockImplementation((path: string) => Promise.resolve(responseFor(path)));
  dashboardApi.mockClear();
  setDashboardSession.mockClear();
  toast.error.mockClear();
  toast.success.mockClear();
  window.history.replaceState({}, "", "/dashboard/vault");
  window.matchMedia = vi.fn().mockReturnValue({
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    matches: false,
    media: "",
    removeEventListener: vi.fn(),
    removeListener: vi.fn(),
  });
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

describe("Vault reveal races", () => {
  it("dismisses a parent-owned reveal confirmation when Vault unmounts", async () => {
    await mountVault();
    await openRevealConfirmation();

    await act(async () => {
      window.history.replaceState({}, "", "/dashboard");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await flush();

    expect(document.body.textContent).not.toContain("Reveal secret value?");
    expect(dashboardApi.mock.calls.filter(([path]) => path === "vault/reveal")).toHaveLength(0);
  });

  it("does not refresh or toast when Hide invalidates a pending reveal", async () => {
    await mountVault();
    await reveal("visible secret");
    toast.success.mockClear();

    const stale = deferred<{ value: string }>();
    revealResponses.push(stale);
    await openRevealConfirmation();
    await confirmReveal();
    await waitFor(() =>
      dashboardApi.mock.calls.some(([path]) => path === "vault/reveal") ? true : undefined,
    );
    dashboardApi.mockClear();

    await act(async () => {
      button("Hide revealed value").click();
    });
    await act(async () => {
      stale.resolve({ value: "stale secret" });
    });
    await flush();

    expect(dashboardApi).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("does not show an error when Hide invalidates a rejected reveal", async () => {
    await mountVault();
    await reveal("visible secret");
    toast.error.mockClear();

    const stale = deferred<{ value: string }>();
    revealResponses.push(stale);
    await openRevealConfirmation();
    await confirmReveal();
    await waitFor(() =>
      dashboardApi.mock.calls.some(([path]) => path === "vault/reveal") ? true : undefined,
    );

    await act(async () => {
      button("Hide revealed value").click();
    });
    await act(async () => {
      stale.reject(new Error("stale request failed"));
    });
    await flush();

    expect(toast.error).not.toHaveBeenCalled();
  });

  it("does not refresh or toast when a newer reveal invalidates an older response", async () => {
    await mountVault();
    await reveal("visible secret");
    toast.success.mockClear();
    dashboardApi.mockClear();

    const stale = deferred<{ value: string }>();
    const current = deferred<{ value: string }>();
    revealResponses.push(stale, current);
    await openRevealConfirmation();
    await confirmReveal();
    await openRevealConfirmation();
    await confirmReveal();
    await waitFor(() =>
      dashboardApi.mock.calls.filter(([path]) => path === "vault/reveal").length === 2
        ? true
        : undefined,
    );
    dashboardApi.mockClear();

    await act(async () => {
      stale.resolve({ value: "stale secret" });
    });
    await flush();

    expect(dashboardApi).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();

    await act(async () => {
      current.resolve({ value: "current secret" });
    });
    await flush();
    expect(container?.textContent).toContain("current secret");
    expect(dashboardApi).toHaveBeenCalledWith("vault");
    expect(toast.success).toHaveBeenCalledWith("Vault value revealed");
  });
});

describe("authority storage presentation", () => {
  it("renders distinct authority, exposure, lag, and safe degraded health", async () => {
    await mountRoute("runtime", {
      runtime: {
        runtime: {
          status: "ok",
          version: "1.2.3",
          bind: "https://internal.example/runtime",
        },
        health: {
          provider: "postgresql",
          authorityId: "production-authority",
          connectivity: "degraded",
          writable: false,
          activeGeneration: {
            authorityId: "production-authority",
            id: "generation-seven",
            sequence: 7,
            predecessorId: "generation-six",
          },
          observedGeneration: {
            authorityId: "production-authority",
            id: "generation-nine",
            sequence: 9,
            predecessorId: "generation-eight",
          },
          exposureGeneration: 4,
          refresh: "failed",
          lifecycle: "degraded",
          readiness: "ready",
          lag: 2,
          stagedFingerprint: "abcdef0123456789abcdef",
          endpoint: "https://provider.example/private",
          lastError: {
            code: "AUTHORITY_UNAVAILABLE",
            message: "Could not reach https://db.example/private?token=secret-value",
            details: { password: "must-not-render" },
          },
        },
      },
      diagnostics: { checks: [{ id: "runtime", status: "ok" }] },
    });

    await waitFor(() => (container?.textContent?.includes("Unavailable") ? true : undefined));
    const text = container?.textContent ?? "";
    expect(text).toContain("Postgresql");
    expect(text).not.toContain("production-authority");
    expect(text).toContain("Storage Generation · Active");
    expect(text).toContain("Generation 7");
    expect(text).toContain("Storage Generation · Observed");
    expect(text).toContain("Generation 9");
    expect(text).toContain("Exposure Generation");
    expect(text).toContain("Generation 4");
    expect(text).toContain("2 generations");
    expect(text).toContain("Could not reach remote endpoint");
    expect(text).not.toContain("https://");
    expect(text).not.toContain("secret-value");
    expect(text).not.toContain("must-not-render");
    expect(text).not.toMatch(/\bAuthority\b/u);
  });

  it("marks staged IDs reserved and exposes mutation only for authority-owned Caplets", async () => {
    const activeGeneration = {
      authorityId: "shared-authority",
      id: "generation-12",
      sequence: 12,
      predecessorId: "generation-11",
    };
    await mountRoute("caplets", {
      caplets: {
        caplets: [
          {
            id: "staged-tool",
            title: "Staged tool",
            source: { kind: "project-file", path: "/private/project/CAPLET.md" },
          },
          {
            id: "shared-tool",
            title: "Shared tool",
            source: {
              kind: "authority",
              authorityId: "shared-authority",
              generationId: "generation-12",
            },
          },
        ],
      },
      "catalog/updates": {
        updates: [
          { id: "staged-tool", status: "available" },
          { id: "shared-tool", status: "available" },
        ],
      },
      runtime: {
        health: {
          provider: "s3",
          authorityId: "shared-authority",
          connectivity: "healthy",
          writable: true,
          activeGeneration,
          observedGeneration: activeGeneration,
          exposureGeneration: 5,
          refresh: "current",
          lifecycle: "ready",
          readiness: "ready",
          lag: 0,
        },
      },
      "catalog/update": {},
    });

    await waitFor(
      () =>
        document.querySelector('[aria-label="staged-tool is immutable and reserved"]') ?? undefined,
    );
    expect(
      document.querySelector('button[aria-label^="Review update for staged-tool"]'),
    ).toBeNull();
    const updateButton = button(
      "Review update for shared-tool; conflicts require refresh and review",
    );
    expect(container?.textContent).toContain("Immutable on this host");
    expect(container?.textContent).toContain("Storage Generation protection");
    expect(container?.textContent).not.toContain("/private/project");

    await act(async () => {
      updateButton.click();
    });
    const phrase = await waitFor(
      () =>
        document.querySelector<HTMLInputElement>(
          'input[aria-label="Type update shared-tool to confirm"]',
        ) ?? undefined,
    );
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(phrase, "update shared-tool");
      phrase.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      button("Confirm").click();
    });
    await waitFor(() =>
      dashboardApi.mock.calls.some(([path]) => path === "catalog/update") ? true : undefined,
    );
    const updateCall = dashboardApi.mock.calls.find(([path]) => path === "catalog/update");
    expect(JSON.parse(String(updateCall?.[1]?.body))).toMatchObject({
      capletId: "shared-tool",
      expectedGeneration: activeGeneration,
    });
  });

  it("keeps filesystem-only settings usable without exposing host URLs or session secrets", async () => {
    await mountRoute("settings", {
      summary: {
        host: { baseUrl: "https://private-host.example/dashboard", version: "1.2.3" },
      },
      runtime: { runtime: { status: "ok", bind: "https://private-bind.example" } },
      diagnostics: { status: "ok" },
    });

    await waitFor(() =>
      container?.textContent?.includes("Storage unavailable") ? true : undefined,
    );
    const text = container?.textContent ?? "";
    expect(text).toContain("Existing local reads remain available");
    expect(text).toContain("Secret values are not displayed");
    expect(text).not.toContain("private-host.example");
    expect(text).not.toContain("private-bind.example");
    expect(text).not.toContain(session.csrfToken);
  });

  it("announces a recovered writable authority without stale error guidance", async () => {
    await mountRoute("settings", {
      diagnostics: {
        health: {
          provider: "sqlite",
          authorityId: "recovered-authority",
          connectivity: "healthy",
          writable: true,
          activeGeneration: {
            authorityId: "recovered-storage",
            id: "generation-3",
            sequence: 3,
            predecessorId: "generation-2",
          },
          observedGeneration: {
            authorityId: "recovered-storage",
            id: "generation-3",
            sequence: 3,
            predecessorId: "generation-2",
          },
          exposureGeneration: 8,
          refresh: "current",
          lifecycle: "recovered",
          readiness: "ready",
          lag: 0,
        },
      },
    });

    await waitFor(() => (container?.textContent?.includes("Recovered") ? true : undefined));
    expect(container?.textContent).toContain("Storage recovered");
    expect(container?.textContent).toContain("Writes are enabled");
    expect(container?.textContent).toContain("0 generations");
  });
  it("shows authority CRUD controls only for writable authority entries", async () => {
    const activeGeneration = {
      authorityId: "shared-authority",
      id: "generation-12",
      sequence: 12,
      predecessorId: "generation-11",
    };
    await mountRoute("caplets", {
      caplets: {
        caplets: [
          {
            id: "staged-tool",
            title: "Staged tool",
            source: { kind: "project-file", path: "/private/project/CAPLET.md" },
          },
          {
            id: "authority-tool",
            name: "Authority tool",
            source: {
              kind: "authority",
              authorityId: "shared-authority",
              generationId: "generation-12",
            },
            config: { name: "Authority tool", description: "Managed by authority" },
          },
        ],
      },
      runtime: {
        health: {
          authorityId: "shared-authority",
          connectivity: "healthy",
          writable: true,
          activeGeneration,
          observedGeneration: activeGeneration,
          exposureGeneration: 12,
          refresh: "current",
          lifecycle: "ready",
          readiness: "ready",
          lag: 0,
        },
      },
      "caplets/create": { status: "active", generation: activeGeneration },
      settings: { settings: {} },
    });

    await waitFor(() => button("Create Caplet"));
    expect(
      document.querySelector('button[aria-label="Edit Storage-managed Caplet authority-tool"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('button[aria-label="Delete Storage-managed Caplet authority-tool"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('button[aria-label="Edit Storage-managed Caplet staged-tool"]'),
    ).toBeNull();
    expect(
      document.querySelector('button[aria-label="Delete Storage-managed Caplet staged-tool"]'),
    ).toBeNull();

    const idInput = document.querySelector<HTMLInputElement>(
      'input[aria-label="Storage-managed Caplet ID"]',
    );
    if (!idInput) throw new Error("Authority Caplet ID input missing.");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(idInput, "new-authority-tool");
      idInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await setInput('input[aria-label="MCP stdio command"]', "node");
    await act(async () => {
      button("Create Caplet").click();
    });
    await waitFor(() =>
      dashboardApi.mock.calls.some(([path]) => path === "caplets/create") ? true : undefined,
    );
    const createCall = dashboardApi.mock.calls.find(([path]) => path === "caplets/create");
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      record: {
        id: "new-authority-tool",
        name: "new-authority-tool",
        description: "Storage-managed Caplet",
        backend: { transport: "stdio", command: "node" },
      },
      expectedGeneration: activeGeneration,
      idempotencyKey: expect.any(String),
    });
  });

  it("starts a fresh idempotency intent when editing after an active create", async () => {
    const firstGeneration: {
      authorityId: string;
      id: string;
      sequence: number;
      predecessorId: string | null;
    } = {
      authorityId: "shared-authority",
      id: "generation-1",
      sequence: 1,
      predecessorId: null,
    };
    let currentGeneration = firstGeneration;
    let caplets: Array<Record<string, unknown>> = [];
    let createKey: string | undefined;
    let updateKey: string | undefined;
    await mountRoute("caplets", {
      caplets: { caplets: [] },
      runtime: {
        health: {
          connectivity: "healthy",
          writable: true,
          activeGeneration: firstGeneration,
          observedGeneration: firstGeneration,
        },
      },
      settings: { settings: {} },
    });
    dashboardApi.mockImplementation((path: string, options?: { body?: unknown }) => {
      if (path === "session") return { authenticated: true, session };
      if (path === "caplets") return Promise.resolve({ caplets });
      if (path === "runtime" || path === "diagnostics") {
        return Promise.resolve({
          health: {
            connectivity: "healthy",
            writable: true,
            activeGeneration: currentGeneration,
            observedGeneration: currentGeneration,
          },
        });
      }
      if (path === "caplets/create") {
        createKey = JSON.parse(String(options?.body)).idempotencyKey;
        currentGeneration = {
          ...firstGeneration,
          id: "generation-2",
          sequence: 2,
          predecessorId: firstGeneration.id,
        };
        caplets = [
          {
            id: "new-authority-tool",
            name: "New authority tool",
            description: "Created authority tool",
            source: {
              kind: "authority",
              authorityId: "shared-authority",
              generationId: "generation-2",
            },
            config: { name: "New authority tool", description: "Created authority tool" },
            backendConfig: { transport: "stdio", command: "node" },
          },
        ];
        return Promise.resolve({ status: "active", generation: currentGeneration });
      }
      if (path === "caplets/update") {
        updateKey = JSON.parse(String(options?.body)).idempotencyKey;
        return Promise.resolve({
          status: "active",
          generation: {
            ...currentGeneration,
            id: "generation-3",
            sequence: 3,
            predecessorId: currentGeneration.id,
          },
        });
      }
      return Promise.resolve({});
    });
    await setInput('input[aria-label="Storage-managed Caplet ID"]', "new-authority-tool");
    await setInput('input[aria-label="MCP stdio command"]', "node");
    await act(async () => {
      button("Create Caplet").click();
    });
    await waitFor(() => (createKey ? createKey : undefined));
    await waitFor(() => button("Edit Storage-managed Caplet new-authority-tool"));
    await act(async () => {
      button("Edit Storage-managed Caplet new-authority-tool").click();
    });
    await waitFor(() => button("Save Caplet"));
    await setInput('input[aria-label="Storage-managed Caplet name"]', "Edited authority tool");
    await act(async () => {
      button("Save Caplet").click();
    });
    await waitFor(() => (updateKey ? updateKey : undefined));
    expect(updateKey).toBeDefined();
    expect(updateKey).not.toBe(createKey);
  });

  it("starts a fresh idempotency intent when revoking after an active grant", async () => {
    const firstGeneration = {
      authorityId: "shared-authority",
      id: "generation-1",
      sequence: 1,
      predecessorId: null,
    };
    let grantKey: string | undefined;
    let revokeKey: string | undefined;
    await mountRoute("settings", {
      diagnostics: {
        health: {
          connectivity: "healthy",
          writable: true,
          activeGeneration: firstGeneration,
          observedGeneration: firstGeneration,
        },
      },
      runtime: {
        health: {
          connectivity: "healthy",
          writable: true,
          activeGeneration: firstGeneration,
          observedGeneration: firstGeneration,
        },
      },
      settings: {
        settings: {
          telemetry: true,
          defaultSearchLimit: 10,
          maxSearchLimit: 20,
          options: { exposure: "direct" },
        },
      },
    });
    dashboardApi.mockImplementation((path: string, options?: { body?: unknown }) => {
      if (path === "session") return { authenticated: true, session };
      if (path === "setup/grant") {
        grantKey = JSON.parse(String(options?.body)).idempotencyKey;
        return Promise.resolve({
          status: "active",
          generation: {
            ...firstGeneration,
            id: "generation-2",
            sequence: 2,
            predecessorId: firstGeneration.id,
          },
        });
      }
      if (path === "setup/revoke") {
        revokeKey = JSON.parse(String(options?.body)).idempotencyKey;
        return Promise.resolve({
          status: "active",
          generation: {
            ...firstGeneration,
            id: "generation-3",
            sequence: 3,
            predecessorId: "generation-2",
          },
        });
      }
      return Promise.resolve({
        health: {
          connectivity: "healthy",
          writable: true,
          activeGeneration: firstGeneration,
          observedGeneration: firstGeneration,
        },
        settings: {
          telemetry: true,
          defaultSearchLimit: 10,
          maxSearchLimit: 20,
          options: { exposure: "direct" },
        },
      });
    });
    await setInput('input[aria-label="Setup Caplet ID"]', "authority-tool");
    await setInput('input[aria-label="Setup content hash"]', "sha256:12345678");
    await act(async () => {
      button("Grant setup approval").click();
    });
    await waitFor(() => (grantKey ? grantKey : undefined));
    await act(async () => {
      button("Revoke setup approval").click();
    });
    await waitFor(() => (revokeKey ? revokeKey : undefined));
    expect(revokeKey).toBeDefined();
    expect(revokeKey).not.toBe(grantKey);
  });

  it("clears the edit form after deleting the edited authority Caplet", async () => {
    const generation = {
      authorityId: "shared-authority",
      id: "generation-1",
      sequence: 1,
      predecessorId: null,
    };
    const caplet = {
      id: "authority-tool",
      name: "Authority tool",
      description: "Managed by authority",
      source: { kind: "authority", authorityId: "shared-authority", generationId: generation.id },
      config: { name: "Authority tool", description: "Managed by authority" },
      backendConfig: { transport: "stdio", command: "node" },
    };
    let deleted = false;
    await mountRoute("caplets", {
      caplets: { caplets: [caplet] },
      runtime: {
        health: {
          connectivity: "healthy",
          writable: true,
          activeGeneration: generation,
          observedGeneration: generation,
        },
      },
      settings: { settings: {} },
    });
    dashboardApi.mockImplementation((path: string) => {
      if (path === "session") return { authenticated: true, session };
      if (path === "caplets") return Promise.resolve({ caplets: deleted ? [] : [caplet] });
      if (path === "runtime" || path === "diagnostics") {
        return Promise.resolve({
          health: {
            connectivity: "healthy",
            writable: true,
            activeGeneration: generation,
            observedGeneration: generation,
          },
        });
      }
      if (path === "caplets/delete") {
        deleted = true;
        return Promise.resolve({ status: "active", generation });
      }
      return Promise.resolve({});
    });
    await act(async () => {
      button("Edit Storage-managed Caplet authority-tool").click();
    });
    await waitFor(() => button("Save Caplet"));
    await act(async () => {
      button("Delete Storage-managed Caplet authority-tool").click();
    });
    await waitFor(() =>
      document.querySelector('input[aria-label="Type delete authority-tool to confirm"]'),
    );
    await setInput(
      'input[aria-label="Type delete authority-tool to confirm"]',
      "delete authority-tool",
    );
    await act(async () => {
      button("Confirm").click();
    });
    await waitFor(() => (deleted ? true : undefined));
    await waitFor(() => button("Create Caplet"));
    expect(document.querySelector('button[aria-label="Cancel edit"]')).toBeNull();
    expect(
      document
        .querySelector('input[aria-label="Storage-managed Caplet ID"]')
        ?.getAttribute("value"),
    ).toBe("");
  });

  it("preserves a Caplet draft and names the changed generation after conflict", async () => {
    const activeGeneration = {
      authorityId: "authority",
      id: "generation-1",
      sequence: 1,
      predecessorId: null,
    };
    await mountRoute("caplets", {
      runtime: {
        health: { writable: true, activeGeneration, observedGeneration: activeGeneration },
      },
    });
    dashboardApi.mockImplementation((path: string) => {
      if (path === "caplets/create") {
        const error = new Error("Authority Generation conflict") as Error & { body?: unknown };
        error.body = {
          error: {
            details: {
              kind: "conflict",
              activeGeneration: {
                authorityId: "authority",
                id: "generation-2",
                sequence: 2,
                predecessorId: "generation-1",
              },
            },
          },
        };
        return Promise.reject(error);
      }
      if (path === "diagnostics") {
        return Promise.resolve({
          health: { writable: true, activeGeneration, observedGeneration: activeGeneration },
        });
      }
      return Promise.resolve({});
    });
    const idInput = document.querySelector<HTMLInputElement>(
      'input[aria-label="Storage-managed Caplet ID"]',
    );
    if (!idInput) throw new Error("Authority Caplet ID input missing.");
    await setInput('input[aria-label="MCP stdio command"]', "node");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(idInput, "conflict-draft");
      idInput.dispatchEvent(new Event("input", { bubbles: true }));
      idInput.dispatchEvent(new Event("change", { bubbles: true }));
      button("Create Caplet").click();
    });
    await waitFor(() =>
      dashboardApi.mock.calls.some(([path]) => path === "caplets/create") ? true : undefined,
    );
    await flush();
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Storage-managed Caplet ID"]')
        ?.value,
    ).toBe("conflict-draft");
    expect(container?.textContent).toContain("changed to 2");
    expect(container?.textContent).toContain("Refresh and review latest Storage Generation");
  });

  it("keeps a durable pending receipt and disables duplicate Caplet submission", async () => {
    const generation = {
      authorityId: "authority",
      id: "generation-1",
      sequence: 1,
      predecessorId: null,
    };
    await mountRoute("caplets", {
      runtime: {
        health: {
          writable: true,
          activeGeneration: generation,
          observedGeneration: generation,
        },
      },
    });
    dashboardApi.mockImplementation((path: string) => {
      if (path === "caplets/create") {
        return Promise.resolve({
          status: "pending",
          generation: {
            authorityId: "authority",
            id: "generation-2",
            sequence: 2,
            predecessorId: "generation-1",
          },
          idempotencyKey: "pending-intent",
        });
      }
      if (path === "diagnostics") {
        return Promise.resolve({
          health: {
            writable: true,
            activeGeneration: generation,
            observedGeneration: generation,
          },
        });
      }
      return Promise.resolve({});
    });
    const idInput = document.querySelector<HTMLInputElement>(
      'input[aria-label="Storage-managed Caplet ID"]',
    );
    if (!idInput) throw new Error("Authority Caplet ID input missing.");
    await setInput('input[aria-label="MCP stdio command"]', "node");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(idInput, "pending-draft");
      idInput.dispatchEvent(new Event("input", { bubbles: true }));
      idInput.dispatchEvent(new Event("change", { bubbles: true }));
      button("Create Caplet").click();
    });
    await waitFor(() =>
      container?.textContent?.includes("activation is still pending") ? true : undefined,
    );
    expect(button("Create Caplet").disabled).toBe(true);
    expect(container?.textContent).toContain("Do not submit a duplicate change");
  });
  it("forwards long URL-like Storage Generation identity fields byte-for-byte without displaying them", async () => {
    await mountRoute("caplets", {
      runtime: { health: writableHealth() },
      caplets: { caplets: [] },
      settings: { settings: {} },
      "caplets/create": { status: "active", generation: opaqueGeneration },
    });

    await setInput('input[aria-label="Storage-managed Caplet ID"]', "opaque-token-tool");
    await setInput('input[aria-label="MCP stdio command"]', "node");
    await act(async () => {
      button("Create Caplet").click();
    });
    const createCall = await waitFor(
      () => dashboardApi.mock.calls.find(([path]) => path === "caplets/create") ?? undefined,
    );
    expect(JSON.parse(String(createCall[1]?.body)).expectedGeneration).toEqual(opaqueGeneration);
    expect(container?.textContent).not.toContain(opaqueGeneration.authorityId);
    expect(container?.textContent).not.toContain(opaqueGeneration.id);
    expect(container?.textContent).not.toContain(opaqueGeneration.predecessorId);
  });

  it("blocks every Caplet mutation when Storage Generation identity is incomplete", async () => {
    await mountRoute("caplets", {
      runtime: {
        health: writableHealth({
          authorityId: "raw-partial-authority-id",
          sequence: 12,
        }),
      },
      caplets: {
        caplets: [
          {
            id: "managed-tool",
            source: { kind: "authority", authorityId: "raw-partial-authority-id" },
          },
          { id: "legacy-tool", source: { kind: "legacy" } },
        ],
      },
      "catalog/updates": {
        updates: [
          { id: "managed-tool", status: "available" },
          { id: "legacy-tool", status: "available" },
        ],
      },
    });

    await waitFor(() =>
      container?.textContent?.includes("Storage unavailable") ? true : undefined,
    );
    expect(button("Create Caplet").disabled).toBe(true);
    expect(button("Edit Storage-managed Caplet managed-tool").disabled).toBe(true);
    expect(button("Delete Storage-managed Caplet managed-tool").disabled).toBe(true);
    expect(
      button("Update unavailable for legacy-tool until Storage identity is refreshed").disabled,
    ).toBe(true);
    expect(container?.textContent).toContain("Refresh and review");
    expect(container?.textContent).not.toContain("raw-partial-authority-id");
  });

  it("requires refresh and review when pending activation observes an out-of-order identity", async () => {
    const initialGeneration = {
      authorityId: "storage-a",
      id: "generation-1",
      sequence: 1,
      predecessorId: null,
    };
    const receiptGeneration = {
      authorityId: "storage-a",
      id: "generation-2",
      sequence: 2,
      predecessorId: "generation-1",
    };
    const laterGeneration = {
      authorityId: "storage-a",
      id: "generation-3",
      sequence: 3,
      predecessorId: "generation-2",
    };
    await mountRoute("caplets", {
      runtime: { health: writableHealth(initialGeneration) },
      caplets: { caplets: [] },
    });
    dashboardApi.mockImplementation((path: string) => {
      if (path === "session") return Promise.resolve({ authenticated: true, session });
      if (path === "caplets/create") {
        return Promise.resolve({ status: "pending", generation: receiptGeneration });
      }
      if (path === "diagnostics") {
        return Promise.resolve({ health: writableHealth(laterGeneration) });
      }
      return Promise.resolve({});
    });

    await setInput('input[aria-label="Storage-managed Caplet ID"]', "out-of-order-tool");
    await setInput('input[aria-label="MCP stdio command"]', "node");
    await act(async () => {
      button("Create Caplet").click();
    });
    await waitFor(() =>
      container?.textContent?.includes("Refresh and review latest Storage Generation")
        ? true
        : undefined,
    );
    expect(container?.textContent).not.toContain("activation is still pending");
    expect(button("Create Caplet").disabled).toBe(true);
  });

  it("forwards the same opaque identity through settings and setup mutations", async () => {
    await mountRoute("settings", {
      runtime: { health: writableHealth() },
      diagnostics: { health: writableHealth() },
      settings: {
        settings: {
          telemetry: false,
          defaultSearchLimit: 20,
          maxSearchLimit: 50,
          options: { exposure: "code_mode" },
        },
      },
      "setup/grant": { status: "active", generation: opaqueGeneration },
    });
    expect(container?.textContent).not.toMatch(/\bAuthority\b/u);
    dashboardApi.mockClear();

    await act(async () => {
      button("Save settings").click();
    });
    await setInput('input[aria-label="Setup Caplet ID"]', "opaque-setup-tool");
    await setInput('input[aria-label="Setup content hash"]', "sha256:12345678");
    await act(async () => {
      button("Grant setup approval").click();
    });

    const settingsCall = await waitFor(
      () =>
        dashboardApi.mock.calls.find(
          ([path, options]) => path === "settings" && options?.method === "POST",
        ) ?? undefined,
    );
    const setupCall = await waitFor(
      () => dashboardApi.mock.calls.find(([path]) => path === "setup/grant") ?? undefined,
    );
    expect(JSON.parse(String(settingsCall[1]?.body)).expectedGeneration).toEqual(opaqueGeneration);
    expect(JSON.parse(String(setupCall[1]?.body)).expectedGeneration).toEqual(opaqueGeneration);
  });

  it("re-enables mutations only after refresh returns a fresh complete identity", async () => {
    await mountRoute("caplets", {
      runtime: {
        health: writableHealth({
          authorityId: "partial-storage",
          sequence: 12,
        }),
      },
      caplets: { caplets: [] },
    });
    expect(button("Create Caplet").disabled).toBe(true);
    dashboardApi.mockImplementation((path: string) => {
      if (path === "session") return Promise.resolve({ authenticated: true, session });
      if (path === "runtime" || path === "diagnostics") {
        return Promise.resolve({ health: writableHealth() });
      }
      if (path === "caplets") return Promise.resolve({ caplets: [] });
      return Promise.resolve({});
    });

    await act(async () => {
      button("Refresh and review Storage").click();
    });
    await waitFor(() => (button("Create Caplet").disabled ? undefined : true));
    expect(container?.textContent).not.toContain("Storage unavailable");
  });

  it("uses Storage terminology in ownership, editor, and deletion confirmation surfaces", async () => {
    await mountRoute("caplets", {
      runtime: { health: writableHealth() },
      caplets: {
        caplets: [
          {
            id: "managed-tool",
            source: { kind: "authority", authorityId: opaqueGeneration.authorityId },
          },
          { id: "staged-tool", source: { kind: "project-file" } },
        ],
      },
    });

    expect(container?.textContent).toContain("Storage-managed");
    expect(container?.textContent).toContain("Storage Generation protection");
    expect(container?.textContent).toContain("Immutable staged definition");
    expect(container?.textContent).not.toMatch(/\bAuthority\b/u);
    await act(async () => {
      button("Edit Storage-managed Caplet managed-tool").click();
    });
    expect(container?.textContent).toContain("Edit Storage-managed Caplet");
    await act(async () => {
      button("Cancel edit").click();
    });
    await act(async () => {
      button("Delete Storage-managed Caplet managed-tool").click();
    });
    await flush();
    expect(document.body.textContent).toContain("Delete Storage-managed Caplet?");
    expect(document.body.textContent).toContain("Storage Generation review");
  });
});
