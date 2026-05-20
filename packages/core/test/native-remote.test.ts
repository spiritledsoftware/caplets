import { describe, expect, it, vi } from "vitest";

import type { CapletsError } from "../src/errors";
import { RemoteNativeCapletsService, type RemoteCapletsClient } from "../src/native/remote";
import { createNativeCapletsService } from "../src/native/service";

function client(
  tools: Array<{ name: string; title?: string | undefined; description?: string | undefined }> = [
    { name: "alpha", title: "Alpha", description: "Remote alpha" },
  ],
) {
  const listeners = new Set<() => void>();
  return {
    api: {
      listTools: vi.fn(async () => tools),
      callTool: vi.fn(async (name: string, args: unknown) => ({ name, args })),
      onToolsChanged: vi.fn((listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      close: vi.fn(async () => undefined),
    } satisfies RemoteCapletsClient,
    emit: () => {
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
    setTools: (next: typeof tools) => {
      tools = next;
    },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("RemoteNativeCapletsService", () => {
  it("maps remote MCP tools to native Caplet tools", async () => {
    const fixture = client([{ name: "git-hub", title: undefined, description: "GitHub tools" }]);
    const service = new RemoteNativeCapletsService({ client: fixture.api, pollIntervalMs: 60_000 });

    await service.reload();

    expect(service.listTools()).toEqual([
      expect.objectContaining({
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "git-hub",
      }),
    ]);
    expect(service.listTools()[0]?.description).toContain("GitHub tools");
    expect(service.listTools()[0]?.description).toContain("Native tool name: caplets_git_hub");
    expect(service.listTools()[0]?.description).toContain("Remote Caplet ID: git-hub");
    expect(service.listTools()[0]?.promptGuidance.join("\n")).toContain("remote Caplets service");

    await service.close();
  });

  it("executes by remote Caplet ID", async () => {
    const fixture = client();
    const service = new RemoteNativeCapletsService({ client: fixture.api, pollIntervalMs: 60_000 });

    await expect(service.execute("alpha", { input: true })).resolves.toEqual({
      name: "alpha",
      args: { input: true },
    });
    expect(fixture.api.callTool).toHaveBeenCalledWith("alpha", { input: true });

    await service.close();
  });

  it("reconnects once and retries executions after session-like failures", async () => {
    const first = client();
    const second = client();
    first.api.callTool = vi.fn(async () => {
      throw new Error("transport connection closed");
    });
    second.api.callTool = vi.fn(async (name: string, args: unknown) => ({
      name,
      args,
      client: "second",
    }));
    const factory = vi.fn(() => second.api);
    const service = new RemoteNativeCapletsService({
      client: first.api,
      clientFactory: factory,
      pollIntervalMs: 60_000,
    });

    await expect(service.execute("alpha", { input: true })).resolves.toEqual({
      name: "alpha",
      args: { input: true },
      client: "second",
    });

    expect(first.api.callTool).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(first.api.close).toHaveBeenCalledTimes(1);
    expect(second.api.callTool).toHaveBeenCalledWith("alpha", { input: true });

    await service.close();
  });

  it("notifies listeners when remote tool list changes", async () => {
    const fixture = client([{ name: "alpha", description: "Alpha" }]);
    const service = new RemoteNativeCapletsService({ client: fixture.api, pollIntervalMs: 60_000 });
    await service.reload();
    const listener = vi.fn();
    service.onToolsChanged(listener);
    fixture.setTools([{ name: "beta", title: "Beta", description: "Beta" }]);

    fixture.emit();
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());

    expect(listener).toHaveBeenCalledWith([
      expect.objectContaining({ caplet: "beta", toolName: "caplets_beta" }),
    ]);
    await service.close();
  });

  it("keeps last known-good tools and warns when reload fails", async () => {
    const fixture = client([{ name: "alpha", description: "Alpha" }]);
    const writeErr = vi.fn();
    const service = new RemoteNativeCapletsService({
      client: fixture.api,
      pollIntervalMs: 60_000,
      writeErr,
    });
    await service.reload();
    fixture.api.listTools = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(service.reload()).resolves.toBe(false);

    expect(service.listTools()).toEqual([expect.objectContaining({ caplet: "alpha" })]);
    expect(writeErr).toHaveBeenCalledWith(
      expect.stringContaining("Could not reload remote Caplets tools"),
    );
    await service.close();
  });

  it("reconnects once for invalid remote sessions and keeps last known-good tools if retry fails", async () => {
    const first = client([{ name: "alpha", description: "Alpha" }]);
    const second = client([{ name: "beta", description: "Beta" }]);
    const writeErr = vi.fn();
    second.api.listTools = vi.fn(async () => {
      throw new Error("still closed connection");
    });
    const factory = vi.fn(() => second.api);
    const service = new RemoteNativeCapletsService({
      client: first.api,
      clientFactory: factory,
      pollIntervalMs: 60_000,
      writeErr,
    });
    await service.reload();
    first.api.listTools = vi.fn(async () => {
      throw new Error("invalid session");
    });

    await expect(service.reload()).resolves.toBe(false);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(first.api.close).toHaveBeenCalledTimes(1);
    expect(service.listTools()).toEqual([expect.objectContaining({ caplet: "alpha" })]);
    expect(writeErr).toHaveBeenCalledWith(expect.stringContaining("still closed connection"));
    await service.close();
  });

  it("does not create or retain a new client when closed during failed reconnect", async () => {
    const first = client([{ name: "alpha", description: "Alpha" }]);
    const second = client([{ name: "beta", description: "Beta" }]);
    const firstClose = deferred();
    const writeErr = vi.fn();
    first.api.close = vi.fn(async (): Promise<undefined> => {
      await firstClose.promise;
      return undefined;
    });
    first.api.listTools = vi.fn(async () => {
      throw new Error("transport connection closed");
    });
    const factory = vi.fn(() => second.api);
    const service = new RemoteNativeCapletsService({
      client: first.api,
      clientFactory: factory,
      pollIntervalMs: 60_000,
      writeErr,
    });

    const reload = service.reload();
    await vi.waitFor(() => expect(first.api.close).toHaveBeenCalledTimes(1));
    const closing = service.close();
    firstClose.resolve();

    await expect(reload).resolves.toBe(false);
    await closing;

    expect(factory).not.toHaveBeenCalled();
    expect(second.api.onToolsChanged).not.toHaveBeenCalled();
    expect(second.listenerCount()).toBe(0);
    expect(second.api.close).not.toHaveBeenCalled();
    expect(writeErr).not.toHaveBeenCalled();
  });

  it("reconnects once for invalid remote sessions and reloads from the new client", async () => {
    const first = client([{ name: "alpha", description: "Alpha" }]);
    const second = client([{ name: "beta", description: "Beta" }]);
    const service = new RemoteNativeCapletsService({
      client: first.api,
      clientFactory: vi.fn(() => second.api),
      pollIntervalMs: 60_000,
    });
    await service.reload();
    first.api.listTools = vi.fn(async () => {
      throw new Error("transport connection closed");
    });

    await expect(service.reload()).resolves.toBe(true);

    expect(service.listTools()).toEqual([expect.objectContaining({ caplet: "beta" })]);
    await service.close();
  });

  it("classifies remote auth failures with credential guidance", async () => {
    const fixture = client();
    fixture.api.callTool = vi.fn(async () => {
      throw new Error("403 Forbidden");
    });
    const service = new RemoteNativeCapletsService({ client: fixture.api, pollIntervalMs: 60_000 });

    await expect(service.execute("alpha", {})).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: expect.stringContaining("CAPLETS_SERVER_USER"),
    } satisfies Partial<CapletsError>);

    await service.close();
  });

  it("polls the remote service as a fallback for tool changes", async () => {
    vi.useFakeTimers();
    const fixture = client([{ name: "alpha", description: "Alpha" }]);
    const service = new RemoteNativeCapletsService({ client: fixture.api, pollIntervalMs: 1_000 });

    vi.advanceTimersByTime(1_000);
    await vi.waitFor(() => expect(fixture.api.listTools).toHaveBeenCalledTimes(1));

    await service.close();
    vi.useRealTimers();
  });

  it("cleans up subscriptions, polling, listeners, and client close idempotently", async () => {
    vi.useFakeTimers();
    const fixture = client();
    const service = new RemoteNativeCapletsService({ client: fixture.api, pollIntervalMs: 1_000 });
    service.onToolsChanged(vi.fn());
    expect(fixture.listenerCount()).toBe(1);

    await service.close();
    await service.close();
    vi.advanceTimersByTime(1_000);

    expect(fixture.listenerCount()).toBe(0);
    expect(fixture.api.close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("createNativeCapletsService remote mode", () => {
  it("creates a remote service using the factory seam", () => {
    const fixture = client();
    const service = createNativeCapletsService({
      mode: "remote",
      server: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
    });

    expect(service).toBeInstanceOf(RemoteNativeCapletsService);
  });

  it("fails fast for invalid remote config", () => {
    expect(() =>
      createNativeCapletsService({ mode: "remote", server: { url: "http://example.com" } }),
    ).toThrow(/https/u);
  });
});
