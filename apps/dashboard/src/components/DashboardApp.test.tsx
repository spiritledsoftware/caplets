// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  acknowledgeRecoveredDashboardManagementOperations,
  dashboardApi,
  dashboardManagementMutation,
  dashboardManagementPreview,
  dashboardManagementRecoveryNoticesAcknowledged,
  recoverDashboardManagementOperations,
  setDashboardSession,
  toast,
} = vi.hoisted(() => ({
  dashboardApi: vi.fn(),
  dashboardManagementMutation: vi.fn(),
  dashboardManagementPreview: vi.fn(),
  recoverDashboardManagementOperations: vi.fn<() => Promise<unknown[]>>(async () => []),
  acknowledgeRecoveredDashboardManagementOperations: vi.fn(),
  dashboardManagementRecoveryNoticesAcknowledged: vi.fn(() => false),
  setDashboardSession: vi.fn(),
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({
  acknowledgeRecoveredDashboardManagementOperations,
  dashboardApi,
  dashboardManagementMutation,
  dashboardManagementRecoveryNoticesAcknowledged,
  dashboardManagementPreview,
  isDashboardUnauthorized: () => false,
  recoverDashboardManagementOperations,
  setDashboardSession,
}));

vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("sonner", () => ({ toast }));

import { DashboardApp, catalogMutationLabel } from "./DashboardApp";

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
  if (path === "management?resource=host-setting") {
    return {
      status: "ok",
      items: [
        {
          resource: "host-setting",
          id: "telemetry",
          selector: "effective",
          owner: "filesystem",
          source: { kind: "global-config" },
          effective: true,
          effectiveChanged: false,
          shadowChain: [
            { owner: "sql", source: { kind: "sql" } },
            { owner: "filesystem", source: { kind: "global-config" } },
          ],
          underlyingSqlAvailable: true,
          consequence: "no-effective-change-while-shadowed",
        },
      ],
    };
  }
  if (path.startsWith("management/inspect?resource=host-setting")) {
    return {
      status: "ok",
      target: {
        resource: "host-setting",
        id: "telemetry",
        selector: "underlying-sql",
        owner: "sql",
        source: { kind: "sql" },
        effective: true,
        effectiveChanged: false,
        shadowChain: [
          { owner: "sql", source: { kind: "sql" } },
          { owner: "filesystem", source: { kind: "global-config" } },
        ],
        underlyingSqlAvailable: true,
        consequence: "no-effective-change-while-shadowed",
      },
      record: { key: "telemetry", value: true, aggregateVersion: 1 },
    };
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
  toast.warning.mockClear();
  dashboardManagementPreview.mockResolvedValue({
    operation: {
      operationId: "operation-dashboard-ui-u9",
      requestIdentity: "request-dashboard-ui-u9",
      mutation: {
        kind: "host-setting-set",
        key: "telemetry",
        value: false,
        selector: "underlying-sql",
      },
    },
    result: {
      status: "preview",
      target: { consequence: "no-effective-change-while-shadowed" },
    },
  });
  dashboardManagementMutation.mockResolvedValue({
    status: "committed",
    receipt: {
      management: { consequence: "no-effective-change-while-shadowed" },
    },
  });
  recoverDashboardManagementOperations.mockResolvedValue([]);
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

describe("catalog update presentation", () => {
  it("distinguishes committed content, runtime, and no-op outcomes", () => {
    expect(catalogMutationLabel({ installed: [{ status: "content_updated" }] })).toBe(
      "Content updated",
    );
    expect(catalogMutationLabel({ installed: [{ status: "updated" }] })).toBe("Updated");
    expect(catalogMutationLabel({ installed: [{ status: "noop" }] })).toBe("Already current");
  });
});

describe("SQL ownership controls", () => {
  it("reveals the shadow chain and repeats a no-effective-change consequence in preview and receipt", async () => {
    recoverDashboardManagementOperations.mockResolvedValueOnce([
      {
        status: "not_committed",
        binding: { operationId: "operation-recovered-u9" },
      },
    ]);
    window.history.replaceState({}, "", "/dashboard/settings");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<DashboardApp initialRoute="settings" />);
    });

    await waitFor(() =>
      document.body.textContent?.includes("filesystem owner") ? document.body : undefined,
    );
    expect(document.body.textContent).toContain("sql:sql → filesystem:global-config");
    expect(document.body.textContent).toContain("Recovered operation outcomes");
    expect(document.body.textContent).toContain(
      "The original identity is fenced as not committed.",
    );

    await act(async () => {
      button("Inspect underlying SQL").click();
    });
    await waitFor(() =>
      document.body.textContent?.includes("sql owner") ? document.body : undefined,
    );

    await act(async () => {
      button("Preview SQL change").click();
    });
    await waitFor(() =>
      document.body.textContent?.includes(
        "No effective runtime change while the filesystem override remains.",
      )
        ? document.body
        : undefined,
    );
    const draft = Array.from(document.querySelectorAll("label"))
      .find((label) => label.textContent?.includes("Proposed JSON value"))
      ?.querySelector("input");
    if (!draft) throw new Error("Proposed JSON value input is missing.");
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(draft, "false");
      draft.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) => candidate.textContent?.trim() === "Apply prepared change",
      ),
    ).toBe(false);
    await act(async () => {
      button("Preview SQL change").click();
    });
    await waitFor(() => (button("Apply prepared change") ? document.body : undefined));

    await act(async () => {
      button("Apply prepared change").click();
    });
    await waitFor(() =>
      document.body.textContent?.includes(
        "Receipt: no effective runtime change while the filesystem override remains.",
      )
        ? document.body
        : undefined,
    );
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) => candidate.textContent?.trim() === "Preview SQL change",
      ),
    ).toBe(false);
    expect(
      Array.from(document.querySelectorAll("label")).some((label) =>
        label.textContent?.includes("Proposed JSON value"),
      ),
    ).toBe(false);
    expect(dashboardManagementPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "host-setting-set",
        key: "telemetry",
        selector: "underlying-sql",
      }),
    );
    expect(dashboardManagementMutation).toHaveBeenCalledWith(
      expect.objectContaining({ selector: "underlying-sql" }),
      expect.objectContaining({ operationId: "operation-dashboard-ui-u9" }),
    );
  });
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
