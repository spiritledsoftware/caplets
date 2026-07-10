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
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
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
  });
});
