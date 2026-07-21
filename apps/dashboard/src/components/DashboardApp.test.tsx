// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  dashboardClient,
  isDashboardUnauthorized,
  unauthorizedPredicate,
  setDashboardSession,
  toast,
} = vi.hoisted(() => {
  const dashboardClient = {
    changeRemoteClientRole: vi.fn(),
    completeDashboardLogin: vi.fn(),
    fetchActivity: vi.fn(),
    fetchCaplets: vi.fn(),
    fetchCatalogUpdates: vi.fn(),
    fetchDiagnostics: vi.fn(),
    fetchLogs: vi.fn(),
    fetchProjectBinding: vi.fn(),
    fetchRuntime: vi.fn(),
    fetchSummary: vi.fn(),
    listPendingLogins: vi.fn(),
    listRemoteClients: vi.fn(),
    listVaultGrants: vi.fn(),
    listVaultValues: vi.fn(),
    logoutDashboardSession: vi.fn(),
    pollDashboardLogin: vi.fn(),
    restartRuntime: vi.fn(),
    restoreSession: vi.fn(),
    revealVaultValue: vi.fn(),
    startDashboardLogin: vi.fn(),
    revokeRemoteClient: vi.fn(),
  };
  const unauthorizedPredicate = (error: unknown) =>
    typeof error === "object" && error !== null && "status" in error && error.status === 401;
  return {
    dashboardClient,
    isDashboardUnauthorized: vi.fn(unauthorizedPredicate),
    unauthorizedPredicate,
    setDashboardSession: vi.fn(),
    toast: {
      error: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
    },
  };
});

vi.mock("@/lib/api", () => ({
  adminV2CreateRuntimeRestart: () => dashboardClient.restartRuntime(),
  adminV2DeleteRemoteClient: (clientId: string) => dashboardClient.revokeRemoteClient(clientId),
  adminV2GetDiagnostics: () => dashboardClient.fetchDiagnostics(),
  adminV2GetHost: () => dashboardClient.fetchSummary(),
  adminV2GetProjectBinding: () => dashboardClient.fetchProjectBinding(),
  adminV2GetRemoteClient: (clientId: string) =>
    Promise.resolve({ data: { clientId }, etag: '"client"' }),
  adminV2GetRemoteLoginRequest: (flowId: string) =>
    Promise.resolve({ data: { flowId }, etag: '"login"' }),
  adminV2GetRuntime: () => dashboardClient.fetchRuntime(),
  adminV2GetVaultValue: (key: string) => Promise.resolve({ data: { key }, etag: '"vault"' }),
  adminV2ListActivity: async () => {
    const response = await dashboardClient.fetchActivity();
    return { items: response.entries ?? [] };
  },
  adminV2ListCatalogUpdateCandidates: async (options?: { cursor?: string }) => {
    const response = await dashboardClient.fetchCatalogUpdates(options);
    return { items: response.updates ?? [], nextCursor: response.nextCursor };
  },
  adminV2ListEffectiveCaplets: async (options?: { cursor?: string }) => {
    const response = await dashboardClient.fetchCaplets(options);
    return { items: response.caplets ?? [], nextCursor: response.nextCursor };
  },
  adminV2ListLogs: async () => {
    const response = await dashboardClient.fetchLogs();
    return { items: response.entries ?? [] };
  },
  adminV2ListRemoteClients: async (options?: { cursor?: string }) => {
    const response = await dashboardClient.listRemoteClients(options);
    return { items: response.clients ?? [], nextCursor: response.nextCursor };
  },
  adminV2ListRemoteLoginRequests: async (options?: { cursor?: string }) => {
    const response = await dashboardClient.listPendingLogins(options);
    return { items: response.pendingLogins ?? [], nextCursor: response.nextCursor };
  },
  adminV2ListVaultGrants: async (options?: { cursor?: string }) => {
    const response = await dashboardClient.listVaultGrants(options);
    return { items: response.grants ?? [], nextCursor: response.nextCursor };
  },
  adminV2ListVaultValues: async (options?: { cursor?: string }) => {
    const response = await dashboardClient.listVaultValues(options);
    return { items: response.values ?? [], nextCursor: response.nextCursor };
  },
  adminV2UpdateRemoteClient: (clientId: string, body: { role: string }) =>
    dashboardClient.changeRemoteClientRole(clientId, body.role),
  adminV2UpdateRemoteLoginRequest: vi.fn(),
  adminV2UpdateCatalogCaplets: vi.fn(),
  adminV2PutVaultValue: vi.fn(),
  adminV2DeleteVaultValue: vi.fn(),
  completeDashboardLogin: dashboardClient.completeDashboardLogin,
  createDashboardMutationIntent: () => ({ idempotencyKey: "test-intent" }),
  isDashboardUnauthorized,
  logoutDashboardSession: dashboardClient.logoutDashboardSession,
  pollDashboardLogin: dashboardClient.pollDashboardLogin,
  restoreDashboardSession: dashboardClient.restoreSession,
  revealVaultValue: dashboardClient.revealVaultValue,
  setDashboardSession,
  startDashboardLogin: dashboardClient.startDashboardLogin,
}));

vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("sonner", () => ({ toast }));

import {
  DashboardApp,
  DashboardPaginationLocks,
  catalogMutationLabel,
  routeFromPath,
} from "./DashboardApp";

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
const remoteClient = {
  clientId: "remote-client-id",
  clientLabel: "Build Agent",
  role: "operator",
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function deferred<T>(): Deferred<T> {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    reject = fail;
    resolve = fulfill;
  });
  return { promise, reject, resolve };
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

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
  );
}

function button(label: string): HTMLButtonElement {
  const result = findButton(label);
  if (!result) throw new Error(`Could not find button: ${label}`);
  return result;
}

function dialogButton(label: string): HTMLButtonElement {
  const result = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!result) throw new Error(`Could not find dialog button: ${label}`);
  return result;
}

async function click(target: HTMLElement) {
  await act(async () => {
    target.click();
  });
}

async function enterConfirmation(phrase: string) {
  const input = await waitFor(
    () =>
      document.querySelector<HTMLInputElement>(`input[aria-label="Type ${phrase} to confirm"]`) ??
      undefined,
  );
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(input, phrase);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function mountDashboard(
  initialRoute: "overview" | "access" | "caplets" | "runtime" | "vault",
  readyButton: string,
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<DashboardApp initialRoute={initialRoute} />);
  });
  await waitFor(() => findButton(readyButton));
}

async function mountOverview() {
  await mountDashboard("overview", "Refresh dashboard");
  await waitFor(() =>
    document.body.textContent?.includes("Operator attention") ? true : undefined,
  );
}

function cardWithTitle(title: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="card"]')).find(
    (card) => card.querySelector('[data-slot="card-title"]')?.textContent?.trim() === title,
  );
}

async function mountVault() {
  await mountDashboard("vault", `Reveal vault value ${vaultKey}`);
}

async function openRevealConfirmation() {
  await click(button(`Reveal vault value ${vaultKey}`));
  await enterConfirmation(`reveal ${vaultKey}`);
  await waitFor(() =>
    dialogButton("Reveal for 30s").disabled ? undefined : dialogButton("Reveal for 30s"),
  );
}

async function confirmReveal() {
  await click(dialogButton("Reveal for 30s"));
}

async function reveal(value: string) {
  dashboardClient.revealVaultValue.mockResolvedValueOnce({ value });
  await openRevealConfirmation();
  await confirmReveal();
  await waitFor(
    () => document.querySelector<HTMLElement>('[aria-label="Hide revealed value"]') ?? undefined,
  );
  await waitFor(() =>
    toast.success.mock.calls.some(([message]) => message === "Vault value revealed")
      ? true
      : undefined,
  );
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  for (const method of Object.values(dashboardClient)) method.mockReset();
  dashboardClient.restoreSession.mockResolvedValue({ authenticated: true, session });
  dashboardClient.fetchSummary.mockResolvedValue({ host: { baseUrl: "http://current-host" } });
  dashboardClient.fetchCaplets.mockResolvedValue({ caplets: [] });
  dashboardClient.listRemoteClients.mockResolvedValue({ clients: [remoteClient] });
  dashboardClient.listPendingLogins.mockResolvedValue({ pendingLogins: [] });
  dashboardClient.listVaultValues.mockResolvedValue({
    values: [{ key: vaultKey, valueBytes: 12 }],
  });
  dashboardClient.listVaultGrants.mockResolvedValue({ grants: [] });
  dashboardClient.fetchRuntime.mockResolvedValue({
    runtime: { status: "healthy", version: "1.0.0" },
  });
  dashboardClient.fetchDiagnostics.mockResolvedValue({ checks: [] });
  dashboardClient.fetchActivity.mockResolvedValue({ entries: [] });
  dashboardClient.fetchLogs.mockResolvedValue({ entries: [] });
  dashboardClient.fetchProjectBinding.mockResolvedValue({});
  dashboardClient.fetchCatalogUpdates.mockResolvedValue({ updates: [] });
  dashboardClient.changeRemoteClientRole.mockResolvedValue({});
  dashboardClient.revokeRemoteClient.mockResolvedValue({});
  dashboardClient.restartRuntime.mockResolvedValue({});
  dashboardClient.revealVaultValue.mockResolvedValue({ value: "default secret" });
  isDashboardUnauthorized.mockReset();
  isDashboardUnauthorized.mockImplementation(unauthorizedPredicate);
  setDashboardSession.mockReset();
  toast.error.mockReset();
  toast.success.mockReset();
  toast.warning.mockReset();
  localStorage.clear();
  sessionStorage.clear();
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
  vi.useRealTimers();
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

describe("dashboard routing", () => {
  it("recognizes the Stored Caplets route", () => {
    expect(routeFromPath("/dashboard/stored-caplets")).toBe("stored-caplets");
  });
});

describe("Project Binding health", () => {
  it("renders canonical connected state as healthy without false operator attention", async () => {
    dashboardClient.fetchProjectBinding.mockResolvedValue({
      state: "connected",
      affectedCaplets: [],
      actions: [],
    });

    await mountOverview();

    const attentionCard = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="card"]'),
    ).find((card) => card.textContent?.includes("Operator attention"));
    const bindingCard = cardWithTitle("Project Binding");
    const bindingStatus = bindingCard?.querySelector<HTMLElement>('[data-slot="badge"]');

    expect(attentionCard?.textContent).toContain("All clear");
    expect(attentionCard?.textContent).not.toContain("Project Binding connected");
    expect(bindingStatus?.textContent).toBe("connected");
    expect(bindingStatus?.className).toContain("bg-secondary");
  });

  it("renders disconnected state as non-healthy in attention and card severity", async () => {
    dashboardClient.fetchProjectBinding.mockResolvedValue({
      state: "disconnected",
      affectedCaplets: ["catalog"],
      actions: [],
    });

    await mountOverview();

    const attentionCard = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="card"]'),
    ).find((card) => card.textContent?.includes("Operator attention"));
    const bindingCard = cardWithTitle("Project Binding");
    const bindingStatus = bindingCard?.querySelector<HTMLElement>('[data-slot="badge"]');

    expect(attentionCard?.textContent).toContain("Project Binding disconnected");
    expect(bindingStatus?.textContent).toBe("disconnected");
    expect(bindingStatus?.className).toContain("border-border");
    expect(bindingStatus?.className).not.toContain("bg-secondary");
  });
});

describe("dashboard pagination lock ownership", () => {
  it("keeps a newer same-key request locked when a stale request settles after reset", () => {
    const locks = new DashboardPaginationLocks();
    const ownerA = locks.tryAcquire("clients");
    expect(ownerA).toBeTypeOf("symbol");

    locks.reset();
    const ownerB = locks.tryAcquire("clients");
    expect(ownerB).toBeTypeOf("symbol");

    locks.release("clients", ownerA);
    expect(locks.tryAcquire("clients")).toBeUndefined();

    locks.release("clients", ownerB);
    expect(locks.tryAcquire("clients")).toBeTypeOf("symbol");
  });
});

describe("bounded dashboard collections", () => {
  it("loads one page initially and exposes later Access records only after keyboard-reachable actions", async () => {
    dashboardClient.listRemoteClients.mockImplementation(
      async ({ cursor }: { cursor?: string } = {}) =>
        cursor === "clients-next"
          ? {
              clients: [{ clientId: "client-100", clientLabel: "Later client", role: "access" }],
            }
          : {
              clients: Array.from({ length: 100 }, (_, index) => ({
                clientId: `client-${index}`,
                clientLabel: `Client ${index}`,
                role: "access",
              })),
              nextCursor: "clients-next",
            },
    );
    dashboardClient.listPendingLogins.mockImplementation(
      async ({ cursor }: { cursor?: string } = {}) =>
        cursor === "pending-next"
          ? {
              pendingLogins: [
                {
                  flowId: "flow-100",
                  clientLabel: "Later login",
                  requestedRole: "access",
                  status: "pending",
                },
              ],
            }
          : {
              pendingLogins: Array.from({ length: 100 }, (_, index) => ({
                flowId: `flow-${index}`,
                clientLabel: `Login ${index}`,
                requestedRole: "access",
                status: "pending",
              })),
              nextCursor: "pending-next",
            },
    );

    await mountDashboard("access", "Load more clients");

    expect(dashboardClient.fetchCaplets).toHaveBeenCalledOnce();
    expect(dashboardClient.listRemoteClients).toHaveBeenCalledOnce();
    expect(dashboardClient.listPendingLogins).toHaveBeenCalledOnce();
    expect(dashboardClient.listVaultValues).toHaveBeenCalledOnce();
    expect(dashboardClient.listVaultGrants).toHaveBeenCalledOnce();
    expect(dashboardClient.fetchCatalogUpdates).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("Later client");
    expect(document.body.textContent).not.toContain("Later login");

    await click(button("Load more clients"));
    await click(button("Load more pending logins"));
    await waitFor(() =>
      document.body.textContent?.includes("Later client") &&
      document.body.textContent.includes("Later login")
        ? true
        : undefined,
    );

    expect(dashboardClient.listRemoteClients).toHaveBeenNthCalledWith(2, {
      cursor: "clients-next",
    });
    expect(dashboardClient.listPendingLogins).toHaveBeenNthCalledWith(2, {
      cursor: "pending-next",
    });
  });

  it("increments effective Caplets and update candidates one page per action", async () => {
    dashboardClient.fetchCaplets.mockImplementation(async ({ cursor }: { cursor?: string } = {}) =>
      cursor === "caplets-next"
        ? { caplets: [{ id: "caplet-100" }] }
        : {
            caplets: Array.from({ length: 100 }, (_, index) => ({ id: `caplet-${index}` })),
            nextCursor: "caplets-next",
          },
    );
    dashboardClient.fetchCatalogUpdates.mockImplementation(
      async ({ cursor }: { cursor?: string } = {}) =>
        cursor === "updates-next"
          ? { updates: [{ id: "caplet-100", status: "ready" }] }
          : {
              updates: Array.from({ length: 100 }, (_, index) => ({
                id: `caplet-${index}`,
                status: "ready",
              })),
              nextCursor: "updates-next",
            },
    );

    await mountDashboard("caplets", "Load more effective Caplets");
    expect(dashboardClient.fetchCaplets).toHaveBeenCalledOnce();
    expect(dashboardClient.fetchCatalogUpdates).toHaveBeenCalledOnce();

    await click(button("Load more effective Caplets"));
    await click(button("Load more update candidates"));
    await waitFor(() =>
      document.body.textContent?.includes("101 effective Caplets loaded") &&
      document.body.textContent.includes("101 update candidates loaded")
        ? true
        : undefined,
    );
  });

  it("increments Vault values and grants independently without auto-draining", async () => {
    dashboardClient.listVaultValues.mockImplementation(
      async ({ cursor }: { cursor?: string } = {}) =>
        cursor === "values-next"
          ? { values: [{ key: "LATER_SECRET", valueBytes: 1 }] }
          : {
              values: Array.from({ length: 100 }, (_, index) => ({
                key: `SECRET_${index}`,
                valueBytes: 1,
              })),
              nextCursor: "values-next",
            },
    );
    dashboardClient.listVaultGrants.mockImplementation(
      async ({ cursor }: { cursor?: string } = {}) =>
        cursor === "grants-next"
          ? {
              grants: [
                {
                  storedKey: "LATER_SECRET",
                  capletId: "later-caplet",
                  referenceName: "TOKEN",
                  origin: { kind: "stored-record" },
                },
              ],
            }
          : {
              grants: Array.from({ length: 100 }, (_, index) => ({
                storedKey: `SECRET_${index}`,
                capletId: `caplet-${index}`,
                referenceName: `TOKEN_${index}`,
                origin: { kind: "stored-record" },
              })),
              nextCursor: "grants-next",
            },
    );

    await mountDashboard("vault", "Load more Vault values");
    expect(dashboardClient.listVaultValues).toHaveBeenCalledOnce();
    expect(dashboardClient.listVaultGrants).toHaveBeenCalledOnce();

    await click(button("Load more Vault values"));
    await click(button("Load more Vault grants"));
    await waitFor(() =>
      document.body.textContent?.includes("101 Vault values loaded") &&
      document.body.textContent.includes("101 Vault grants loaded")
        ? true
        : undefined,
    );
  });
});

describe("Remote Client role changes", () => {
  it("confirms one semantic mutation and invalidates visible client state only after success", async () => {
    const mutation = deferred<unknown>();
    dashboardClient.changeRemoteClientRole.mockReturnValueOnce(mutation.promise);
    dashboardClient.listRemoteClients
      .mockResolvedValueOnce({ clients: [remoteClient] })
      .mockResolvedValue({ clients: [{ ...remoteClient, role: "access" }] });
    await mountDashboard("access", "Change Build Agent to access role");
    const initialClientLoads = dashboardClient.listRemoteClients.mock.calls.length;

    await click(button("Change Build Agent to access role"));
    await waitFor(() => findButton("Continue"));
    expect(dashboardClient.changeRemoteClientRole).not.toHaveBeenCalled();

    await click(dialogButton("Continue"));
    await waitFor(() =>
      dashboardClient.changeRemoteClientRole.mock.calls.length === 1 ? true : undefined,
    );

    expect(dashboardClient.changeRemoteClientRole).toHaveBeenCalledWith(
      remoteClient.clientId,
      "access",
    );
    expect(dashboardClient.listRemoteClients).toHaveBeenCalledTimes(initialClientLoads);
    expect(toast.success).not.toHaveBeenCalled();
    expect(findButton("Change Build Agent to access role")).toBeDefined();

    await act(async () => {
      mutation.resolve({});
    });

    await waitFor(() => findButton("Change Build Agent to operator role"));
    expect(dashboardClient.changeRemoteClientRole).toHaveBeenCalledTimes(1);
    expect(dashboardClient.listRemoteClients).toHaveBeenCalledTimes(initialClientLoads + 1);
    expect(toast.success).toHaveBeenCalledWith("Role changed");
  });

  it("reports rejection without invalidating the usable client state", async () => {
    dashboardClient.changeRemoteClientRole.mockRejectedValueOnce(new Error("role denied"));
    await mountDashboard("access", "Change Build Agent to access role");
    const initialClientLoads = dashboardClient.listRemoteClients.mock.calls.length;

    await click(button("Change Build Agent to access role"));
    await click(await waitFor(() => findButton("Continue")));
    await waitFor(() => (toast.error.mock.calls.length ? true : undefined));

    expect(dashboardClient.changeRemoteClientRole).toHaveBeenCalledTimes(1);
    expect(dashboardClient.listRemoteClients).toHaveBeenCalledTimes(initialClientLoads);
    expect(toast.error).toHaveBeenCalledWith("role denied");
    expect(findButton("Change Build Agent to access role")).toBeDefined();
  });

  it("applies an older successful refresh when a newer-started mutation rejects", async () => {
    const olderMutation = deferred<unknown>();
    const newerMutation = deferred<unknown>();
    const olderRefresh = deferred<{ clients: Array<typeof remoteClient> }>();
    dashboardClient.changeRemoteClientRole
      .mockReturnValueOnce(olderMutation.promise)
      .mockReturnValueOnce(newerMutation.promise);
    dashboardClient.listRemoteClients
      .mockResolvedValueOnce({ clients: [remoteClient] })
      .mockReturnValueOnce(olderRefresh.promise);
    await mountDashboard("access", "Change Build Agent to access role");

    await click(button("Change Build Agent to access role"));
    await click(await waitFor(() => findButton("Continue")));
    await waitFor(() =>
      dashboardClient.changeRemoteClientRole.mock.calls.length === 1 ? true : undefined,
    );
    await act(async () => {
      olderMutation.resolve({});
    });
    await waitFor(() =>
      dashboardClient.listRemoteClients.mock.calls.length === 2 ? true : undefined,
    );

    await click(button("Change Build Agent to access role"));
    await click(await waitFor(() => findButton("Continue")));
    await waitFor(() =>
      dashboardClient.changeRemoteClientRole.mock.calls.length === 2 ? true : undefined,
    );
    await act(async () => {
      newerMutation.reject(new Error("newer role denied"));
    });
    await waitFor(() =>
      toast.error.mock.calls.some(([message]) => message === "newer role denied")
        ? true
        : undefined,
    );

    await act(async () => {
      olderRefresh.resolve({ clients: [{ ...remoteClient, role: "access" }] });
    });
    await waitFor(() => findButton("Change Build Agent to operator role"));

    expect(toast.success).toHaveBeenCalledWith("Role changed");
    expect(toast.error).toHaveBeenCalledWith("newer role denied");
  });

  it("renders successful mutations by completion order rather than start order", async () => {
    const deployClient = {
      clientId: "deploy-client-id",
      clientLabel: "Deploy Agent",
      role: "operator",
    };
    const firstStartedMutation = deferred<unknown>();
    const secondStartedMutation = deferred<unknown>();
    dashboardClient.changeRemoteClientRole
      .mockReturnValueOnce(firstStartedMutation.promise)
      .mockReturnValueOnce(secondStartedMutation.promise);
    dashboardClient.listRemoteClients
      .mockResolvedValueOnce({ clients: [remoteClient, deployClient] })
      .mockResolvedValueOnce({
        clients: [remoteClient, { ...deployClient, role: "access" }],
      })
      .mockResolvedValue({
        clients: [
          { ...remoteClient, role: "access" },
          { ...deployClient, role: "access" },
        ],
      });
    await mountDashboard("access", "Change Build Agent to access role");

    await click(button("Change Build Agent to access role"));
    await click(await waitFor(() => findButton("Continue")));
    await waitFor(() =>
      dashboardClient.changeRemoteClientRole.mock.calls.length === 1 ? true : undefined,
    );
    await click(button("Change Deploy Agent to access role"));
    await click(await waitFor(() => findButton("Continue")));
    await waitFor(() =>
      dashboardClient.changeRemoteClientRole.mock.calls.length === 2 ? true : undefined,
    );

    await act(async () => {
      secondStartedMutation.resolve({});
    });
    await waitFor(() => findButton("Change Deploy Agent to operator role"));
    expect(findButton("Change Build Agent to access role")).toBeDefined();

    await act(async () => {
      firstStartedMutation.resolve({});
    });
    await waitFor(() => findButton("Change Build Agent to operator role"));

    expect(findButton("Change Deploy Agent to operator role")).toBeDefined();
    expect(toast.success).toHaveBeenCalledTimes(2);
  });
});

describe("Remote Client revocation", () => {
  it("cannot bypass typed confirmation and preserves usable state after rejection", async () => {
    dashboardClient.revokeRemoteClient.mockRejectedValueOnce(new Error("revoke denied"));
    await mountDashboard("access", "Revoke Build Agent");
    const initialClientLoads = dashboardClient.listRemoteClients.mock.calls.length;

    await click(button("Revoke Build Agent"));
    await waitFor(
      () =>
        document.querySelector<HTMLInputElement>(
          `input[aria-label="Type revoke ${remoteClient.clientId} to confirm"]`,
        ) ?? undefined,
    );
    await click(dialogButton("Cancel"));
    expect(dashboardClient.revokeRemoteClient).not.toHaveBeenCalled();

    await click(button("Revoke Build Agent"));
    await enterConfirmation(`revoke ${remoteClient.clientId}`);
    await click(dialogButton("Confirm"));
    await waitFor(() => (toast.error.mock.calls.length ? true : undefined));

    expect(dashboardClient.revokeRemoteClient).toHaveBeenCalledOnce();
    expect(dashboardClient.revokeRemoteClient).toHaveBeenCalledWith(remoteClient.clientId);
    expect(dashboardClient.listRemoteClients).toHaveBeenCalledTimes(initialClientLoads);
    expect(toast.error).toHaveBeenCalledWith("revoke denied");
    expect(findButton("Revoke Build Agent")).toBeDefined();
  });

  it("calls revoke once and invalidates the client only after success", async () => {
    const mutation = deferred<unknown>();
    dashboardClient.revokeRemoteClient.mockReturnValueOnce(mutation.promise);
    dashboardClient.listRemoteClients
      .mockResolvedValueOnce({ clients: [remoteClient] })
      .mockResolvedValue({ clients: [] });
    await mountDashboard("access", "Revoke Build Agent");
    const initialClientLoads = dashboardClient.listRemoteClients.mock.calls.length;

    await click(button("Revoke Build Agent"));
    expect(dashboardClient.revokeRemoteClient).not.toHaveBeenCalled();
    await enterConfirmation(`revoke ${remoteClient.clientId}`);
    await click(dialogButton("Confirm"));
    await waitFor(() =>
      dashboardClient.revokeRemoteClient.mock.calls.length === 1 ? true : undefined,
    );

    expect(dashboardClient.revokeRemoteClient).toHaveBeenCalledWith(remoteClient.clientId);
    expect(dashboardClient.revokeRemoteClient).toHaveBeenCalledOnce();
    expect(dashboardClient.listRemoteClients).toHaveBeenCalledTimes(initialClientLoads);
    expect(toast.success).not.toHaveBeenCalled();
    expect(findButton("Revoke Build Agent")).toBeDefined();

    await act(async () => {
      mutation.resolve({});
    });
    await waitFor(() => (findButton("Revoke Build Agent") ? undefined : true));

    expect(dashboardClient.listRemoteClients).toHaveBeenCalledTimes(initialClientLoads + 1);
    expect(toast.success).toHaveBeenCalledWith("Client revoked");
  });

  it("ends an acting Operator Client session terminated by revocation", async () => {
    const actingClient = {
      clientId: session.operatorClientId,
      clientLabel: "This Browser",
      role: "operator",
    };
    dashboardClient.listRemoteClients.mockResolvedValue({ clients: [actingClient] });
    dashboardClient.revokeRemoteClient.mockRejectedValueOnce(
      Object.assign(new Error("session ended"), { status: 401 }),
    );
    await mountDashboard("access", "Revoke This Browser");

    await click(button("Revoke This Browser"));
    await enterConfirmation(`revoke ${actingClient.clientId}`);
    await click(dialogButton("Confirm"));

    await waitFor(() => findButton("Authorize this browser"));
    expect(dashboardClient.revokeRemoteClient).toHaveBeenCalledWith(actingClient.clientId);
    expect(setDashboardSession).toHaveBeenLastCalledWith(undefined);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("does not let a stale role-change refresh restore a revoked client", async () => {
    const staleClientLoad = deferred<{ clients: Array<typeof remoteClient> }>();
    dashboardClient.listRemoteClients
      .mockResolvedValueOnce({ clients: [remoteClient] })
      .mockReturnValueOnce(staleClientLoad.promise)
      .mockResolvedValue({ clients: [] });
    await mountDashboard("access", "Change Build Agent to access role");

    await click(button("Change Build Agent to access role"));
    await click(await waitFor(() => findButton("Continue")));
    await waitFor(() =>
      dashboardClient.listRemoteClients.mock.calls.length === 2 ? true : undefined,
    );

    await click(button("Revoke Build Agent"));
    await enterConfirmation(`revoke ${remoteClient.clientId}`);
    await click(dialogButton("Confirm"));
    await waitFor(() => (findButton("Revoke Build Agent") ? undefined : true));
    expect(dashboardClient.revokeRemoteClient).toHaveBeenCalledOnce();
    expect(dashboardClient.revokeRemoteClient).toHaveBeenCalledWith(remoteClient.clientId);
    expect(toast.success).toHaveBeenCalledWith("Client revoked");

    await act(async () => {
      staleClientLoad.resolve({ clients: [{ ...remoteClient, role: "access" }] });
    });
    await flush();

    expect(findButton("Revoke Build Agent")).toBeUndefined();
    expect(toast.success).not.toHaveBeenCalledWith("Role changed");
  });

  it("holds a stale role refresh while revoke is pending and applies it after rejection", async () => {
    const staleClientLoad = deferred<{ clients: Array<typeof remoteClient> }>();
    const revokeMutation = deferred<unknown>();
    dashboardClient.listRemoteClients
      .mockResolvedValueOnce({ clients: [remoteClient] })
      .mockReturnValueOnce(staleClientLoad.promise);
    dashboardClient.revokeRemoteClient.mockReturnValueOnce(revokeMutation.promise);
    await mountDashboard("access", "Change Build Agent to access role");

    await click(button("Change Build Agent to access role"));
    await click(await waitFor(() => findButton("Continue")));
    await waitFor(() =>
      dashboardClient.listRemoteClients.mock.calls.length === 2 ? true : undefined,
    );

    await click(button("Revoke Build Agent"));
    await enterConfirmation(`revoke ${remoteClient.clientId}`);
    await click(dialogButton("Confirm"));
    await waitFor(() =>
      dashboardClient.revokeRemoteClient.mock.calls.length === 1 ? true : undefined,
    );

    await act(async () => {
      staleClientLoad.resolve({ clients: [{ ...remoteClient, role: "access" }] });
    });
    await flush();

    expect(findButton("Change Build Agent to access role")).toBeDefined();
    expect(findButton("Change Build Agent to operator role")).toBeUndefined();
    expect(toast.success).not.toHaveBeenCalledWith("Role changed");

    await act(async () => {
      revokeMutation.reject(new Error("revoke denied"));
    });
    await waitFor(() => findButton("Change Build Agent to operator role"));

    expect(toast.success).toHaveBeenCalledWith("Role changed");
    expect(toast.error).toHaveBeenCalledWith("revoke denied");
  });
});

describe("runtime restart", () => {
  it("keeps the confirmed restart visibly pending without early success", async () => {
    const mutation = deferred<unknown>();
    dashboardClient.restartRuntime.mockReturnValueOnce(mutation.promise);
    await mountDashboard("runtime", "Restart runtime");

    await click(button("Restart runtime"));
    expect(dashboardClient.restartRuntime).not.toHaveBeenCalled();
    await enterConfirmation("restart runtime");
    await click(dialogButton("Restart runtime"));
    await waitFor(() => (dashboardClient.restartRuntime.mock.calls.length ? true : undefined));

    expect(dashboardClient.restartRuntime).toHaveBeenCalledOnce();
    expect(button("Restart runtime").disabled).toBe(true);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("keeps restart admission pending across navigation and clears it after rejection", async () => {
    const mutation = deferred<unknown>();
    dashboardClient.restartRuntime.mockReturnValueOnce(mutation.promise);
    await mountDashboard("runtime", "Restart runtime");

    await click(button("Restart runtime"));
    await enterConfirmation("restart runtime");
    await click(dialogButton("Restart runtime"));
    await waitFor(() =>
      dashboardClient.restartRuntime.mock.calls.length === 1 ? true : undefined,
    );

    await act(async () => {
      window.history.replaceState({}, "", "/dashboard");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await flush();
    expect(findButton("Restart runtime")).toBeUndefined();

    await act(async () => {
      window.history.replaceState({}, "", "/dashboard/runtime");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const remountedRestart = await waitFor(() => findButton("Restart runtime"));

    expect(remountedRestart.disabled).toBe(true);
    expect(remountedRestart.getAttribute("aria-busy")).toBe("true");
    await click(remountedRestart);
    expect(dashboardClient.restartRuntime).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      mutation.reject(new Error("restart unavailable after navigation"));
    });
    await waitFor(() => (button("Restart runtime").disabled ? undefined : true));

    expect(dashboardClient.restartRuntime).toHaveBeenCalledOnce();
    expect(toast.error).toHaveBeenCalledWith("restart unavailable after navigation");
  });

  it("invalidates runtime state and reports success after one restart resolves", async () => {
    const mutation = deferred<unknown>();
    dashboardClient.restartRuntime.mockReturnValueOnce(mutation.promise);
    dashboardClient.fetchRuntime
      .mockResolvedValueOnce({ runtime: { status: "healthy", version: "1.0.0" } })
      .mockResolvedValue({ runtime: { status: "restarting", version: "1.0.1" } });
    await mountDashboard("runtime", "Restart runtime");
    const initialRuntimeLoads = dashboardClient.fetchRuntime.mock.calls.length;

    await click(button("Restart runtime"));
    await enterConfirmation("restart runtime");
    await click(dialogButton("Restart runtime"));
    await waitFor(() => (dashboardClient.restartRuntime.mock.calls.length ? true : undefined));
    expect(toast.success).not.toHaveBeenCalled();

    await act(async () => {
      mutation.resolve({});
    });

    await waitFor(() =>
      container?.textContent?.includes("1.0.1") && container.textContent.includes("Restarting")
        ? true
        : undefined,
    );
    expect(dashboardClient.restartRuntime).toHaveBeenCalledOnce();
    expect(dashboardClient.fetchRuntime).toHaveBeenCalledTimes(initialRuntimeLoads + 1);
    expect(toast.success).toHaveBeenCalledWith("Restart requested");
  });

  it("reports restart rejection without replacing stable runtime state", async () => {
    dashboardClient.restartRuntime.mockRejectedValueOnce(new Error("restart unavailable"));
    await mountDashboard("runtime", "Restart runtime");
    const initialRuntimeLoads = dashboardClient.fetchRuntime.mock.calls.length;

    await click(button("Restart runtime"));
    await enterConfirmation("restart runtime");
    await click(dialogButton("Restart runtime"));
    await waitFor(() => (toast.error.mock.calls.length ? true : undefined));

    expect(dashboardClient.restartRuntime).toHaveBeenCalledOnce();
    expect(dashboardClient.fetchRuntime).toHaveBeenCalledTimes(initialRuntimeLoads);
    expect(container?.textContent).toContain("1.0.0");
    expect(toast.error).toHaveBeenCalledWith("restart unavailable");
    expect(button("Restart runtime").disabled).toBe(false);
  });
});

describe("private Vault Reveal ceremony", () => {
  it("requires confirmation, calls reveal once, and invalidates Vault only after success", async () => {
    const mutation = deferred<{ value: string }>();
    dashboardClient.revealVaultValue.mockReturnValueOnce(mutation.promise);
    await mountVault();
    const initialVaultLoads = dashboardClient.listVaultValues.mock.calls.length;

    await click(button(`Reveal vault value ${vaultKey}`));
    expect(dashboardClient.revealVaultValue).not.toHaveBeenCalled();
    await enterConfirmation(`reveal ${vaultKey}`);
    await confirmReveal();
    await waitFor(() => (dashboardClient.revealVaultValue.mock.calls.length ? true : undefined));

    expect(dashboardClient.revealVaultValue).toHaveBeenCalledWith(vaultKey, `reveal ${vaultKey}`);
    expect(dashboardClient.revealVaultValue).toHaveBeenCalledOnce();
    expect(dashboardClient.listVaultValues).toHaveBeenCalledTimes(initialVaultLoads);
    expect(toast.success).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-label="Hide revealed value"]')).toBeNull();

    await act(async () => {
      mutation.resolve({ value: "visible secret" });
    });
    await waitFor(
      () => document.querySelector<HTMLElement>('[aria-label="Hide revealed value"]') ?? undefined,
    );
    await waitFor(() =>
      toast.success.mock.calls.some(([message]) => message === "Vault value revealed")
        ? true
        : undefined,
    );

    expect(container?.textContent).toContain("visible secret");
    expect(dashboardClient.listVaultValues).toHaveBeenCalledTimes(initialVaultLoads + 1);
    expect(toast.success).toHaveBeenCalledWith("Vault value revealed");
  });

  it("reports an active reveal rejection and leaves the Vault usable", async () => {
    dashboardClient.revealVaultValue.mockRejectedValueOnce(new Error("reveal denied"));
    await mountVault();
    const initialVaultLoads = dashboardClient.listVaultValues.mock.calls.length;

    await openRevealConfirmation();
    await confirmReveal();
    await waitFor(() => (toast.error.mock.calls.length ? true : undefined));

    expect(dashboardClient.revealVaultValue).toHaveBeenCalledOnce();
    expect(dashboardClient.listVaultValues).toHaveBeenCalledTimes(initialVaultLoads);
    expect(toast.error).toHaveBeenCalledWith("reveal denied");
    expect(document.querySelector('[aria-label="Hide revealed value"]')).toBeNull();
    expect(findButton(`Reveal vault value ${vaultKey}`)).toBeDefined();
  });

  it("dismisses a parent-owned reveal confirmation when Vault unmounts", async () => {
    await mountVault();
    await click(button(`Reveal vault value ${vaultKey}`));
    await waitFor(
      () =>
        document.querySelector<HTMLInputElement>(
          `input[aria-label="Type reveal ${vaultKey} to confirm"]`,
        ) ?? undefined,
    );

    await act(async () => {
      window.history.replaceState({}, "", "/dashboard");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await flush();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(dashboardClient.revealVaultValue).not.toHaveBeenCalled();
  });

  it("suppresses a pending reveal result after navigation cleanup", async () => {
    const pending = deferred<{ value: string }>();
    dashboardClient.revealVaultValue.mockReturnValueOnce(pending.promise);
    await mountVault();
    await openRevealConfirmation();
    await confirmReveal();
    await waitFor(() => (dashboardClient.revealVaultValue.mock.calls.length ? true : undefined));
    dashboardClient.listVaultValues.mockClear();
    toast.success.mockClear();

    await act(async () => {
      window.history.replaceState({}, "", "/dashboard/runtime");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => findButton("Restart runtime"));
    await act(async () => {
      pending.resolve({ value: "late navigation secret" });
    });
    await flush();

    expect(container?.textContent).not.toContain("late navigation secret");
    expect(dashboardClient.listVaultValues).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("clears a revealed value across navigation and never writes it to browser storage", async () => {
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    await mountVault();
    storageWrite.mockClear();
    await reveal("navigation secret");

    expect(
      storageWrite.mock.calls.some(([, value]) => String(value).includes("navigation secret")),
    ).toBe(false);

    await act(async () => {
      window.history.replaceState({}, "", "/dashboard/runtime");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => findButton("Restart runtime"));
    expect(container?.textContent).not.toContain("navigation secret");

    await act(async () => {
      window.history.replaceState({}, "", "/dashboard/vault");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => findButton(`Reveal vault value ${vaultKey}`));
    expect(container?.textContent).not.toContain("navigation secret");

    await reveal("reload secret");
    await act(async () => {
      root?.unmount();
    });
    root = createRoot(container!);
    await act(async () => {
      root?.render(<DashboardApp initialRoute="vault" />);
    });
    await waitFor(() => findButton(`Reveal vault value ${vaultKey}`));

    expect(container?.textContent).not.toContain("reload secret");
    expect(
      storageWrite.mock.calls.some(([, value]) => String(value).includes("reload secret")),
    ).toBe(false);
  });

  it("expires a revealed value after its private display timer", async () => {
    vi.useFakeTimers();
    await mountVault();
    await reveal("expiring secret");
    expect(container?.textContent).toContain("expiring secret");

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });

    expect(container?.textContent).not.toContain("expiring secret");
    expect(document.querySelector('[aria-label="Hide revealed value"]')).toBeNull();
  });

  it("does not refresh or toast when Hide invalidates a pending reveal", async () => {
    await mountVault();
    await reveal("visible secret");
    toast.success.mockClear();
    dashboardClient.listVaultValues.mockClear();
    dashboardClient.revealVaultValue.mockClear();

    const stale = deferred<{ value: string }>();
    dashboardClient.revealVaultValue.mockReturnValueOnce(stale.promise);
    await openRevealConfirmation();
    await confirmReveal();
    await waitFor(() => (dashboardClient.revealVaultValue.mock.calls.length ? true : undefined));

    await click(button("Hide revealed value"));
    await act(async () => {
      stale.resolve({ value: "stale secret" });
    });
    await flush();

    expect(dashboardClient.listVaultValues).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(container?.textContent).not.toContain("stale secret");
  });

  it("does not show an error when Hide invalidates a rejected reveal", async () => {
    await mountVault();
    await reveal("visible secret");
    toast.error.mockClear();
    dashboardClient.revealVaultValue.mockClear();

    const stale = deferred<{ value: string }>();
    dashboardClient.revealVaultValue.mockReturnValueOnce(stale.promise);
    await openRevealConfirmation();
    await confirmReveal();
    await waitFor(() => (dashboardClient.revealVaultValue.mock.calls.length ? true : undefined));

    await click(button("Hide revealed value"));
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
    dashboardClient.listVaultValues.mockClear();
    dashboardClient.revealVaultValue.mockClear();

    const stale = deferred<{ value: string }>();
    const current = deferred<{ value: string }>();
    dashboardClient.revealVaultValue
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);
    await openRevealConfirmation();
    await confirmReveal();
    await openRevealConfirmation();
    await confirmReveal();
    await waitFor(() =>
      dashboardClient.revealVaultValue.mock.calls.length === 2 ? true : undefined,
    );

    await act(async () => {
      stale.resolve({ value: "stale secret" });
    });
    await flush();

    expect(dashboardClient.listVaultValues).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(container?.textContent).not.toContain("stale secret");

    await act(async () => {
      current.resolve({ value: "current secret" });
    });
    await flush();

    expect(container?.textContent).toContain("current secret");
    expect(dashboardClient.listVaultValues).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledWith("Vault value revealed");
  });
});
