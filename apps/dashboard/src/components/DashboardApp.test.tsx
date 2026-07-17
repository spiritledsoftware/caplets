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
  dashboardStorageHealth,
  isDashboardUnauthorized,
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
  dashboardStorageHealth: vi.fn(),
  isDashboardUnauthorized: vi.fn(),
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
  dashboardStorageHealth,
  isDashboardUnauthorized,
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
const unauthorizedError = new Error("Authorization required.");

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let revealResponses: Array<Deferred<{ value: string }> | { value: string }>;
let storageHealthResponse: Record<string, unknown>;

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
  if (path === "storage-health") return storageHealthResponse;
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
  storageHealthResponse = {
    backend: "sqlite",
    authorityToken: { authorityGeneration: 1, effectiveGeneration: 0 },
    readiness: "ready",
    connectivity: "connected",
    migration: "current",
    bootstrapCompatibility: "current",
    convergence: "single-node",
    guidanceCode: "ok",
  };
  dashboardStorageHealth.mockImplementation(() => Promise.resolve(storageHealthResponse));
  dashboardStorageHealth.mockClear();
  isDashboardUnauthorized.mockImplementation((error: unknown) => error === unauthorizedError);
  isDashboardUnauthorized.mockClear();
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
  vi.useRealTimers();
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

describe("activated SQL storage status", () => {
  it("marks a warm disconnected snapshot stale and names every blocked live operation", async () => {
    storageHealthResponse = {
      backend: "postgres",
      readiness: "stale-read-only",
      connectivity: "unavailable",
      migration: "current",
      bootstrapCompatibility: "current",
      staleAgeMs: 65_000,
      convergence: "overdue",
      guidanceCode: "storage-unavailable",
    };
    window.history.replaceState({}, "", "/dashboard/runtime");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<DashboardApp initialRoute="runtime" />);
    });
    await waitFor(() =>
      document.body.textContent?.includes("Postgres disconnected — stale read-only")
        ? document.body
        : undefined,
    );

    expect(container.textContent).toContain("Snapshot age: 1m");
    expect(container.textContent).toContain(
      "Authentication, administration, Project Binding, Attach, Vault, import/export, and mutations fail with 503",
    );
    expect(container.textContent).toContain("Runtime snapshot is stale");
    expect(container.textContent).toContain(
      "Retained runtime status is stale and non-authoritative",
    );
    expect(container.textContent).not.toContain("Runtime healthy");
  });

  it("keeps a newer stale health result when an older ready request resolves last", async () => {
    const olderReady = deferred<Record<string, unknown>>();
    const newerStale = deferred<Record<string, unknown>>();
    dashboardStorageHealth
      .mockImplementationOnce(() => olderReady.promise)
      .mockImplementationOnce(() => newerStale.promise)
      .mockImplementation(() => Promise.resolve(storageHealthResponse));
    window.history.replaceState({}, "", "/dashboard/runtime");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<DashboardApp initialRoute="runtime" />);
    });
    await waitFor(() => (dashboardStorageHealth.mock.calls.length === 2 ? true : undefined));

    await act(async () => {
      newerStale.resolve({
        backend: "postgres",
        authorityToken: { authorityGeneration: 4, effectiveGeneration: 9 },
        readiness: "stale-read-only",
        connectivity: "unavailable",
        migration: "current",
        bootstrapCompatibility: "current",
        staleAgeMs: 8_000,
        convergence: "overdue",
        guidanceCode: "storage-unavailable",
      });
    });
    await waitFor(() =>
      container?.textContent?.includes("Stale read-only") ? container : undefined,
    );

    await act(async () => {
      olderReady.resolve({
        backend: "postgres",
        authorityToken: { authorityGeneration: 4, effectiveGeneration: 9 },
        readiness: "ready",
        connectivity: "connected",
        migration: "current",
        bootstrapCompatibility: "current",
        convergence: "within-budget",
        guidanceCode: "ok",
      });
    });
    await flush();

    expect(container?.textContent).toContain("Stale read-only");
    expect(container?.textContent).not.toContain("Postgres storage ready");
  });

  it("shows availability-independent degraded guidance without dashboard authorization", async () => {
    dashboardApi.mockImplementation((path: string) =>
      path === "session" ? Promise.reject(unauthorizedError) : Promise.resolve(responseFor(path)),
    );
    storageHealthResponse = {
      backend: "postgres",
      authorityToken: { authorityGeneration: 7, effectiveGeneration: 11 },
      readiness: "stale-read-only",
      connectivity: "unavailable",
      migration: "current",
      bootstrapCompatibility: "current",
      staleAgeMs: 5_000,
      convergence: "overdue",
      guidanceCode: "storage-unavailable",
    };
    window.history.replaceState({}, "", "/dashboard");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<DashboardApp />);
    });
    await waitFor(() =>
      container?.textContent?.includes("Authorize this browser") ? container : undefined,
    );

    expect(container?.textContent).toContain("Postgres storage degraded");
    expect(container?.textContent).toContain("Stale read-only");
    expect(container?.textContent).toContain("Only declared non-security reads remain available");
  });

  it("reports connected convergence pending without calling storage disconnected", async () => {
    storageHealthResponse = {
      backend: "postgres",
      authorityToken: { authorityGeneration: 8, effectiveGeneration: 13 },
      readiness: "ready",
      connectivity: "connected",
      migration: "current",
      bootstrapCompatibility: "current",
      convergence: "pending",
      guidanceCode: "convergence-pending",
    };
    window.history.replaceState({}, "", "/dashboard/runtime");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<DashboardApp initialRoute="runtime" />);
    });
    await waitFor(() =>
      container?.textContent?.includes("Postgres convergence pending") ? container : undefined,
    );

    expect(container?.textContent).toContain("ConnectivityConnected");
    expect(container?.textContent).toContain("ReadinessReady");
    expect(container?.textContent).toContain("ConvergencePending");
    expect(container?.textContent).not.toContain("disconnected");
    expect(container?.textContent).not.toContain("storage unavailable");
  });

  it("reports a staged-compatible rollout while current authority remains ready", async () => {
    storageHealthResponse = {
      backend: "postgres",
      authorityToken: { authorityGeneration: 9, effectiveGeneration: 15 },
      readiness: "ready",
      connectivity: "connected",
      migration: "current",
      bootstrapCompatibility: "staged",
      convergence: "within-budget",
      guidanceCode: "bootstrap-staged",
    };
    window.history.replaceState({}, "", "/dashboard/runtime");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<DashboardApp initialRoute="runtime" />);
    });
    await waitFor(() =>
      container?.textContent?.includes("Postgres storage ready") ? container : undefined,
    );

    expect(container?.textContent).toContain("BootstrapStaged compatible");
    expect(container?.textContent).toContain("Current authority available");
    expect(container?.textContent).not.toContain("storage unavailable");
  });

  it("keeps every live slice available when management status reauthorizes successfully", async () => {
    storageHealthResponse = {
      backend: "postgres",
      authorityToken: { authorityGeneration: 10, effectiveGeneration: 16 },
      readiness: "ready",
      connectivity: "connected",
      migration: "current",
      bootstrapCompatibility: "current",
      convergence: "within-budget",
      guidanceCode: "ok",
    };
    dashboardApi.mockImplementation((path: string) =>
      Promise.resolve(
        path === "management/status"
          ? { status: "ok", health: storageHealthResponse }
          : responseFor(path),
      ),
    );
    window.history.replaceState({}, "", "/dashboard/runtime");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<DashboardApp initialRoute="runtime" />);
    });
    const restart = await waitFor(() => {
      const candidate = button("Restart runtime");
      return candidate.disabled ? undefined : candidate;
    });

    expect(restart.getAttribute("aria-describedby")).toBeNull();
    expect(container.textContent).toContain("Current authority available");
    expect(container.textContent).not.toContain("Live dashboard data unavailable");
    expect(dashboardApi).toHaveBeenCalledWith("management/status");
  });
  it("fails a partial live refresh closed without ready or all-clear authority", async () => {
    const unavailable = Object.assign(new Error("Live summary unavailable."), { status: 503 });
    dashboardApi.mockImplementation((path: string) =>
      path === "summary" ? Promise.reject(unavailable) : Promise.resolve(responseFor(path)),
    );
    window.history.replaceState({}, "", "/dashboard");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<DashboardApp initialRoute="overview" />);
    });
    await waitFor(() =>
      container?.textContent?.includes("Live dashboard data unavailable") ? container : undefined,
    );

    expect(container?.textContent).not.toContain("storage ready");
    expect(container?.textContent).not.toContain("All clear");

    await act(async () => {
      button("Refresh dashboard").click();
    });
    await waitFor(() => (toast.warning.mock.calls.length ? true : undefined));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("retries partial live reads automatically while storage remains ready", async () => {
    vi.useFakeTimers();
    const unavailable = Object.assign(new Error("Live summary unavailable."), { status: 503 });
    let summaryAttempts = 0;
    dashboardApi.mockImplementation((path: string) => {
      if (path === "summary" && summaryAttempts++ === 0) return Promise.reject(unavailable);
      return Promise.resolve(responseFor(path));
    });
    window.history.replaceState({}, "", "/dashboard");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<DashboardApp initialRoute="overview" />);
    });
    await waitFor(() =>
      container?.textContent?.includes("Retrying automatically while storage reports ready")
        ? container
        : undefined,
    );
    expect(summaryAttempts).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() =>
      container?.textContent?.includes("Current authority available") &&
      !container.textContent.includes("Live dashboard data unavailable")
        ? container
        : undefined,
    );

    expect(summaryAttempts).toBeGreaterThanOrEqual(2);
  });

  it("disables live-only controls with an accessible reason while cached reads remain usable", async () => {
    storageHealthResponse = {
      backend: "postgres",
      authorityToken: { authorityGeneration: 4, effectiveGeneration: 9 },
      readiness: "stale-read-only",
      connectivity: "unavailable",
      migration: "current",
      bootstrapCompatibility: "current",
      staleAgeMs: 8_000,
      convergence: "overdue",
      guidanceCode: "storage-unavailable",
    };
    window.history.replaceState({}, "", "/dashboard/runtime");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<DashboardApp initialRoute="runtime" />);
    });
    const restart = await waitFor(() => {
      const candidate = button("Restart runtime");
      return candidate.getAttribute("aria-disabled") === "true" ? candidate : undefined;
    });

    expect(restart.disabled).toBe(false);
    expect(restart.getAttribute("aria-describedby")).toBe("live-authority-disabled-reason");
    expect(document.getElementById("live-authority-disabled-reason")?.textContent).toContain(
      "Live SQL authority is unavailable",
    );
    restart.focus();
    expect(document.activeElement).toBe(restart);
    expect(restart.title).toContain("disabled until storage is ready");
    await act(async () => restart.click());
    expect(dashboardApi).not.toHaveBeenCalledWith("runtime/restart", expect.anything());

    const logout = button("Logout");
    expect(logout.disabled).toBe(false);
    expect(logout.getAttribute("aria-disabled")).toBe("true");
    expect(logout.getAttribute("aria-describedby")).toBe("live-authority-disabled-reason");
    logout.focus();
    expect(document.activeElement).toBe(logout);
    expect(logout.title).toContain("disabled until storage is ready");
    await act(async () => logout.click());
    expect(dashboardApi).not.toHaveBeenCalledWith("logout", expect.anything());
    expect(button("Refresh dashboard").disabled).toBe(false);
    expect(document.querySelector('a[href$="/activity"]')).not.toBeNull();
  });

  it("keeps the assertive outage announcement stable when only snapshot age changes", async () => {
    vi.useFakeTimers();
    storageHealthResponse = {
      backend: "postgres",
      authorityToken: { authorityGeneration: 4, effectiveGeneration: 9 },
      readiness: "stale-read-only",
      connectivity: "unavailable",
      migration: "current",
      bootstrapCompatibility: "current",
      staleAgeMs: 1_000,
      convergence: "overdue",
      guidanceCode: "storage-unavailable",
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<DashboardApp initialRoute="runtime" />);
    });
    const announcement = await waitFor(
      () => document.querySelector<HTMLElement>("[data-storage-health-announcement]") ?? undefined,
    );
    const initialAnnouncement = announcement.textContent;

    storageHealthResponse = { ...storageHealthResponse, staleAgeMs: 9_000 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() =>
      container?.textContent?.includes("Snapshot age: 9s") ? container : undefined,
    );

    expect(document.querySelector('[aria-label="Storage health"]')?.getAttribute("aria-live")).toBe(
      "off",
    );
    expect(announcement.getAttribute("role")).toBe("alert");
    expect(announcement.textContent).toBe(initialAnnouncement);
    expect(announcement.textContent).not.toContain("Snapshot age");
  });

  it("aborts active health reads and removes polling timers on unmount", async () => {
    vi.useFakeTimers();
    const firstRead = deferred<Record<string, unknown>>();
    const pollingRead = deferred<Record<string, unknown>>();
    const activeReads: AbortSignal[] = [];
    dashboardStorageHealth.mockImplementation((options?: RequestInit) => {
      if (options?.signal) activeReads.push(options.signal);
      if (activeReads.length === 1) return firstRead.promise;
      if (activeReads.length === 2) return Promise.resolve(storageHealthResponse);
      return pollingRead.promise;
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<DashboardApp />);
    });
    await waitFor(() => (activeReads.length === 2 ? true : undefined));
    expect(activeReads[0]?.aborted).toBe(true);

    await act(async () => {
      firstRead.resolve(storageHealthResponse);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => (activeReads.length === 3 ? true : undefined));

    await act(async () => {
      root?.unmount();
    });
    root = undefined;

    expect(activeReads[2]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dashboardStorageHealth).toHaveBeenCalledTimes(3);
  });

  it("fails a hanging health read closed and starts the next poll within five seconds", async () => {
    vi.useFakeTimers();
    const hangingHealth = deferred<Record<string, unknown>>();
    dashboardStorageHealth.mockImplementation(() => hangingHealth.promise);
    dashboardApi.mockImplementation((path: string) =>
      path === "session" ? Promise.reject(unauthorizedError) : Promise.resolve(responseFor(path)),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<DashboardApp />);
    });
    expect(dashboardStorageHealth).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_999);
    });
    expect(dashboardStorageHealth).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await waitFor(() =>
      container?.textContent?.includes("Connectivity to SQL storage is unavailable")
        ? container
        : undefined,
    );
    expect(button("Authorize this browser").getAttribute("aria-disabled")).toBe("true");
    expect(container?.textContent).toContain("Live operations remain unavailable");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(dashboardStorageHealth).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(dashboardStorageHealth).toHaveBeenCalledTimes(2);
  });

  it("re-enables browser authorization after stale storage recovers without a session", async () => {
    vi.useFakeTimers();
    storageHealthResponse = {
      backend: "postgres",
      authorityToken: { authorityGeneration: 4, effectiveGeneration: 9 },
      readiness: "stale-read-only",
      connectivity: "unavailable",
      migration: "current",
      bootstrapCompatibility: "current",
      staleAgeMs: 1_000,
      convergence: "overdue",
      guidanceCode: "storage-unavailable",
    };
    dashboardApi.mockImplementation((path: string) =>
      path === "session" ? Promise.reject(unauthorizedError) : Promise.resolve(responseFor(path)),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<DashboardApp />);
    });
    await waitFor(() =>
      document.body.textContent?.includes("Authorize this browser") ? document.body : undefined,
    );
    expect(button("Authorize this browser").getAttribute("aria-disabled")).toBe("true");

    storageHealthResponse = {
      backend: "postgres",
      authorityToken: { authorityGeneration: 4, effectiveGeneration: 9 },
      readiness: "ready",
      connectivity: "connected",
      migration: "current",
      bootstrapCompatibility: "current",
      convergence: "within-budget",
      guidanceCode: "ok",
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() =>
      button("Authorize this browser").getAttribute("aria-disabled") ? undefined : true,
    );

    expect(button("Authorize this browser").getAttribute("aria-disabled")).toBeNull();
  });

  it("clears revealed and live security data after a 503 refresh and disables mutations", async () => {
    await mountVault();
    await reveal("visible authority-bound secret");
    expect(container?.textContent).toContain("visible authority-bound secret");
    const serviceUnavailable = Object.assign(new Error("SQL authority unavailable."), {
      status: 503,
    });
    dashboardApi.mockImplementation((path: string) =>
      path === "summary" ? Promise.reject(serviceUnavailable) : Promise.resolve(responseFor(path)),
    );

    await act(async () => {
      button("Refresh dashboard").click();
    });
    await waitFor(() =>
      container?.textContent?.includes("live data unavailable") ? container : undefined,
    );

    expect(container?.textContent).not.toContain("visible authority-bound secret");
    expect(container?.textContent).not.toContain(vaultKey);
    await act(async () => {
      window.history.replaceState({}, "", "/dashboard/runtime");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const restart = await waitFor(() => {
      const candidate = button("Restart runtime");
      return candidate.getAttribute("aria-disabled") === "true" ? candidate : undefined;
    });
    expect(restart.getAttribute("aria-describedby")).toBe("live-authority-disabled-reason");
  });

  it("renders live SQL recovery guidance and removes it as soon as authority is stale", async () => {
    dashboardApi.mockImplementation((path: string) =>
      path === "diagnostics"
        ? Promise.resolve({
            status: "attention",
            diagnostics: {
              backend: "postgres",
              keyCompatibility: { status: "compatible" },
              readyNodes: 2,
              overdueNodes: 0,
            },
            guidance: {
              code: "activation-staged",
              summary: "A compatible bootstrap activation is staged.",
              actions: [
                "Complete or roll back the staged bootstrap activation across the Current Host.",
              ],
            },
          })
        : Promise.resolve(responseFor(path)),
    );
    window.history.replaceState({}, "", "/dashboard/runtime");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<DashboardApp initialRoute="runtime" />);
    });
    await waitFor(() =>
      container?.textContent?.includes("Complete or roll back the staged bootstrap activation")
        ? container
        : undefined,
    );

    storageHealthResponse = {
      backend: "postgres",
      authorityToken: { authorityGeneration: 9, effectiveGeneration: 15 },
      readiness: "stale-read-only",
      connectivity: "unavailable",
      migration: "current",
      bootstrapCompatibility: "staged",
      staleAgeMs: 1_000,
      convergence: "overdue",
      guidanceCode: "storage-unavailable",
    };
    await act(async () => {
      button("Refresh dashboard").click();
    });
    await waitFor(() =>
      container?.textContent?.includes("Live diagnostics unavailable") ? container : undefined,
    );

    expect(container?.textContent).not.toContain("A compatible bootstrap activation is staged.");
    expect(container?.textContent).not.toContain(
      "Complete or roll back the staged bootstrap activation",
    );
  });

  it("keeps recovered operation outcomes visible across every authenticated page", async () => {
    recoverDashboardManagementOperations.mockResolvedValue([
      {
        status: "committed",
        binding: { operationId: "operation-global-recovery-u10" },
      },
    ]);
    window.history.replaceState({}, "", "/dashboard");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<DashboardApp />);
    });
    await waitFor(() =>
      container?.textContent?.includes("operation-global-recovery-u10") ? container : undefined,
    );

    for (const pathname of [
      "/dashboard/access",
      "/dashboard/caplets",
      "/dashboard/catalog",
      "/dashboard/vault",
      "/dashboard/runtime",
      "/dashboard/activity",
      "/dashboard/settings",
      "/dashboard",
    ]) {
      await act(async () => {
        window.history.replaceState({}, "", pathname);
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      expect(container?.textContent, pathname).toContain("operation-global-recovery-u10");
    }
  });
});

describe("SQL ownership controls", () => {
  it("surfaces typed non-retryable recovery outcomes from the original target", async () => {
    recoverDashboardManagementOperations.mockResolvedValueOnce([
      {
        status: "stale_namespace",
        message: "The original operation namespace is stale.",
        httpStatus: 409,
        retryAllowed: false,
        guidance: "lookup-original-target",
        operation: {
          operationId: "operation-stale-namespace-u10",
          target: {
            resource: "host-setting",
            id: "telemetry",
            selector: "underlying-sql",
          },
        },
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
      container?.textContent?.includes("operation-stale-namespace-u10") ? container : undefined,
    );

    expect(container?.textContent).toContain("Stale Namespace");
    expect(container?.textContent).toContain("The original operation namespace is stale.");
    expect(container?.textContent).toContain(
      "No mutation retry is allowed; recovery remains pinned to the original target.",
    );
  });
  it("revokes the dashboard session when a management operation loses authorization", async () => {
    dashboardApi.mockImplementation((path: string) =>
      path.startsWith("management/inspect")
        ? Promise.reject(unauthorizedError)
        : Promise.resolve(responseFor(path)),
    );
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

    await act(async () => {
      button("Inspect underlying SQL").click();
    });
    await waitFor(() =>
      document.body.textContent?.includes("Authorize this browser") ? document.body : undefined,
    );

    expect(setDashboardSession).toHaveBeenLastCalledWith(undefined);
    expect(document.body.textContent).not.toContain("Mutable host setting ownership");
  });

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

  it("clears revealed Vault content immediately when dashboard authorization is lost", async () => {
    await mountVault();
    await reveal("authorization-bound secret");
    expect(container?.textContent).toContain("authorization-bound secret");
    dashboardApi.mockImplementation((path: string) =>
      path === "summary" ? Promise.reject(unauthorizedError) : Promise.resolve(responseFor(path)),
    );

    await act(async () => {
      button("Refresh dashboard").click();
    });
    await waitFor(() =>
      container?.textContent?.includes("Authorize this browser") ? container : undefined,
    );

    expect(container?.textContent).not.toContain("authorization-bound secret");
    expect(container?.textContent).not.toContain(vaultKey);
    expect(setDashboardSession).toHaveBeenLastCalledWith(undefined);
  });
});
