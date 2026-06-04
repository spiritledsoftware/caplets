import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CapletsError } from "../src/errors";
import { CloudAuthStore } from "../src/cloud-auth/store";
import { RemoteNativeCapletsService, type RemoteCapletsClient } from "../src/native/remote";
import {
  createNativeCapletsService,
  resetNativeProjectBindingFallbackWarningForTests,
} from "../src/native/service";
import { hostedCredentials, tempCloudAuthPath } from "./fixtures/cloud-auth";

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
      message: expect.stringContaining("CAPLETS_REMOTE_TOKEN"),
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
  const dirs: string[] = [];

  afterEach(() => {
    resetNativeProjectBindingFallbackWarningForTests();
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a composite service using the factory seam", async () => {
    const fixture = client();
    const service = createNativeCapletsService({
      mode: "remote",
      server: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
    });

    expect(service).not.toBeInstanceOf(RemoteNativeCapletsService);
    await service.close();
  });

  it("does not create the remote service when local overlay construction fails", () => {
    const fixture = client();
    const remoteClientFactory = vi.fn(() => fixture.api);
    const localServiceFactory = vi.fn(() => {
      throw new Error("local construction failed");
    });

    expect(() =>
      createNativeCapletsService({
        mode: "remote",
        server: { url: "http://127.0.0.1:5387" },
        remoteClientFactory,
        localServiceFactory,
      }),
    ).toThrow("local construction failed");

    expect(localServiceFactory).toHaveBeenCalledTimes(1);
    expect(remoteClientFactory).not.toHaveBeenCalled();
    expect(fixture.api.close).not.toHaveBeenCalled();
  });

  it("closes the local service when remote construction fails after local starts", () => {
    const localClose = vi.fn(async () => undefined);
    const localService = {
      listTools: vi.fn(() => []),
      execute: vi.fn(async () => undefined),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: localClose,
    };
    const remoteClientFactory = vi.fn(() => {
      throw new Error("remote construction failed");
    });

    expect(() =>
      createNativeCapletsService({
        mode: "remote",
        server: { url: "http://127.0.0.1:5387" },
        localServiceFactory: vi.fn(() => localService),
        remoteClientFactory,
      }),
    ).toThrow("remote construction failed");

    expect(remoteClientFactory).toHaveBeenCalledTimes(1);
    expect(localClose).toHaveBeenCalledTimes(1);
  });

  it("reports local close failures when remote construction fails after local starts", async () => {
    const writeErr = vi.fn();
    const localClose = vi.fn(async () => {
      throw new Error("close failed");
    });
    const localService = {
      listTools: vi.fn(() => []),
      execute: vi.fn(async () => undefined),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: localClose,
    };
    const remoteClientFactory = vi.fn(() => {
      throw new Error("remote construction failed");
    });

    expect(() =>
      createNativeCapletsService({
        mode: "remote",
        server: { url: "http://127.0.0.1:5387" },
        localServiceFactory: vi.fn(() => localService),
        remoteClientFactory,
        writeErr,
      }),
    ).toThrow("remote construction failed");

    expect(localClose).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(writeErr).toHaveBeenCalledWith(
        expect.stringContaining("Could not close local overlay Caplets service: close failed"),
      ),
    );
  });

  it("fails hard when explicit remote mode cannot create the remote Project Binding service", () => {
    const localClose = vi.fn(async () => undefined);
    const localService = {
      listTools: vi.fn(() => []),
      execute: vi.fn(async () => undefined),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: localClose,
    };

    expect(() =>
      createNativeCapletsService({
        mode: "remote",
        server: { url: "http://127.0.0.1:5387" },
        localServiceFactory: vi.fn(() => localService),
        remoteClientFactory: vi.fn(() => {
          throw new Error("Project Binding unavailable");
        }),
      }),
    ).toThrow("Project Binding unavailable");

    expect(localClose).toHaveBeenCalledTimes(1);
  });

  it("falls back to local overlay once when configured remote Project Binding is unavailable", async () => {
    const writeErr = vi.fn();
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);

    const service = createNativeCapletsService({
      server: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => {
        throw new Error("Project Binding unavailable");
      }),
      configPath,
      projectConfigPath,
      writeErr,
    });
    const secondService = createNativeCapletsService({
      server: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => {
        throw new Error("Project Binding unavailable");
      }),
      configPath,
      projectConfigPath,
      writeErr,
    });

    expect(service.listTools().map((tool) => tool.caplet)).toEqual(["local"]);
    expect(writeErr).toHaveBeenCalledTimes(1);
    expect(writeErr).toHaveBeenCalledWith(
      "Remote project binding unavailable; using local Caplets only. Run caplets doctor for details.\n",
    );
    await service.close();
    await secondService.close();
  });

  it("lists local overlay Caplets after remote tools and shadows matching remote Caplets", async () => {
    const fixture = client([
      { name: "shared", title: "Remote Shared" },
      { name: "remote-only", title: "Remote Only" },
    ]);
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        shared: { name: "Local Shared", description: "Local wins.", command: process.execPath },
        "local-only": { name: "Local Only", description: "Local only.", command: process.execPath },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({
      mode: "remote",
      server: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
    });

    await service.reload();

    expect(service.listTools().map((tool) => [tool.caplet, tool.title])).toEqual([
      ["remote-only", "Remote Only"],
      ["shared", "Local Shared"],
      ["local-only", "Local Only"],
    ]);
    await service.close();
  });

  it("executes local overlay Caplets locally and remote-only Caplets remotely", async () => {
    const fixture = client([{ name: "remote-only", title: "Remote Only" }]);
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({
      mode: "remote",
      server: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
    });
    await service.reload();

    await expect(service.execute("local", { operation: "inspect" })).resolves.toEqual(
      expect.objectContaining({ content: expect.any(Array) }),
    );
    await expect(service.execute("remote-only", { input: true })).resolves.toEqual({
      name: "remote-only",
      args: { input: true },
    });

    expect(fixture.api.callTool).toHaveBeenCalledTimes(1);
    expect(fixture.api.callTool).toHaveBeenCalledWith("remote-only", { input: true });
    await service.close();
  });

  it("emits one merged tools-changed event only when the merged set changes", async () => {
    const fixture = client([{ name: "alpha", title: "Alpha" }]);
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({
      mode: "remote",
      server: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
    });
    await service.reload();
    const listener = vi.fn();
    service.onToolsChanged(listener);

    fixture.setTools([{ name: "beta", title: "Beta" }]);
    fixture.emit();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));

    expect(listener).toHaveBeenCalledWith([
      expect.objectContaining({ caplet: "beta" }),
      expect.objectContaining({ caplet: "local" }),
    ]);
    await expect(service.reload()).resolves.toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it("emits one merged tools-changed event when both children change during explicit reload", async () => {
    const fixture = client([{ name: "alpha", title: "Alpha" }]);
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({
      mode: "remote",
      server: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
    });
    await service.reload();
    const listener = vi.fn();
    service.onToolsChanged(listener);
    fixture.setTools([{ name: "beta", title: "Beta" }]);
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          local: { name: "Local Renamed", description: "Local Caplet.", command: process.execPath },
        },
      }),
      "utf8",
    );

    await expect(service.reload()).resolves.toBe(true);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([
      expect.objectContaining({ caplet: "beta", title: "Beta" }),
      expect.objectContaining({ caplet: "local", title: "Local Renamed" }),
    ]);
    await service.close();
  });

  it("isolates listener failures while continuing notifications during reload", async () => {
    const fixture = client([{ name: "alpha", title: "Alpha" }]);
    const writeErr = vi.fn();
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({
      mode: "remote",
      server: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
      writeErr,
    });
    await service.reload();
    service.onToolsChanged(() => {
      throw new Error("listener exploded");
    });
    const secondListener = vi.fn();
    service.onToolsChanged(secondListener);
    fixture.setTools([{ name: "beta", title: "Beta" }]);

    await expect(service.reload()).resolves.toBe(true);

    expect(secondListener).toHaveBeenCalledWith([
      expect.objectContaining({ caplet: "beta" }),
      expect.objectContaining({ caplet: "local" }),
    ]);
    expect(writeErr).toHaveBeenCalledWith(
      expect.stringContaining("Caplets tools-changed listener failed"),
    );
    await service.close();
  });

  it("keeps last known-good merged tools and warns when a child reload rejects unexpectedly", async () => {
    const fixture = client([{ name: "alpha", title: "Alpha" }]);
    const writeErr = vi.fn();
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({
      mode: "remote",
      server: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
      writeErr,
    });
    await service.reload();
    const listener = vi.fn();
    service.onToolsChanged(listener);
    const remote = (service as unknown as { remote: { reload: () => Promise<boolean> } }).remote;
    remote.reload = vi.fn(async () => {
      fixture.setTools([{ name: "beta", title: "Beta" }]);
      throw new Error("remote exploded");
    });

    await expect(service.reload()).resolves.toBe(false);

    expect(service.listTools().map((tool) => [tool.caplet, tool.title])).toEqual([
      ["alpha", "Alpha"],
      ["local", "Local"],
    ]);
    expect(listener).not.toHaveBeenCalled();
    expect(writeErr).toHaveBeenCalledWith(
      expect.stringContaining("Could not reload composite Caplets tools"),
    );
    await service.close();
  });

  it("keeps the last known-good merged tools when local overlay reload only warns", async () => {
    const fixture = client([{ name: "remote", title: "Remote" }]);
    const writeErr = vi.fn();
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({
      mode: "remote",
      server: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
      writeErr,
    });
    await service.reload();
    writeFileSync(configPath, "{ invalid json", "utf8");

    await expect(service.reload()).resolves.toBe(true);

    expect(service.listTools().map((tool) => tool.caplet)).toEqual(["remote", "local"]);
    expect(writeErr).toHaveBeenCalledWith(expect.stringContaining("Caplets local overlay warning"));
    await service.close();
  });

  it("starts with remote tools when initial local overlay loading warns", async () => {
    const fixture = client([{ name: "remote", title: "Remote" }]);
    const writeErr = vi.fn();
    const { dir, configPath, projectConfigPath } = tempConfig({});
    dirs.push(dir);
    writeFileSync(configPath, "{ invalid json", "utf8");

    const service = createNativeCapletsService({
      mode: "remote",
      server: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
      writeErr,
    });

    await service.reload();

    expect(service.listTools().map((tool) => tool.caplet)).toEqual(["remote"]);
    expect(writeErr).toHaveBeenCalledWith(expect.stringContaining("Caplets local overlay warning"));
    await service.close();
  });

  it("starts Cloud Project Binding when native service runs in cloud mode", async () => {
    const path = tempCloudAuthPath();
    vi.stubEnv("CAPLETS_CLOUD_AUTH_PATH", path);
    await new CloudAuthStore({ path }).save(hostedCredentials({ accessToken: "cloud-access" }));
    const factory = vi.fn(() => client([{ name: "remote", description: "Remote" }]).api);
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);

    const service = createNativeCapletsService({
      mode: "cloud",
      server: { url: "https://cloud.caplets.dev" },
      remoteClientFactory: factory,
      configPath,
      projectConfigPath,
    });

    await service.reload();
    expect(service.listTools().map((tool) => tool.caplet)).toContain("remote");
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        url: new URL("https://cloud.caplets.dev/mcp"),
        requestInit: { headers: { Authorization: "Bearer cloud-access" } },
      }),
    );
    await service.close();
  });

  it("picks up valid local overlay additions when existing warnings are unchanged", async () => {
    const fixture = client([{ name: "remote", title: "Remote" }]);
    const writeErr = vi.fn();
    const { dir, configPath, projectConfigPath } = tempConfig({});
    const badCapletPath = join(dirname(configPath), "bad.md");
    dirs.push(dir);
    writeFileSync(
      badCapletPath,
      ["---", "name: Bad", "description: Missing backend config.", "---", "# Bad"].join("\n"),
      "utf8",
    );
    const service = createNativeCapletsService({
      mode: "remote",
      server: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
      writeErr,
    });
    await service.reload();

    writeFileSync(
      join(dirname(configPath), "local.md"),
      [
        "---",
        "name: Local",
        "description: Local Caplet.",
        "mcpServer:",
        `  command: ${JSON.stringify(process.execPath)}`,
        "---",
        "# Local",
      ].join("\n"),
      "utf8",
    );

    await expect(service.reload()).resolves.toBe(true);

    expect(service.listTools().map((tool) => tool.caplet)).toEqual(["remote", "local"]);
    expect(writeErr).toHaveBeenCalledWith(expect.stringContaining(badCapletPath));
    await service.close();
  });

  it("closes remote and local overlay services idempotently", async () => {
    vi.useFakeTimers();
    const fixture = client();
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({
      mode: "remote",
      server: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
      remote: { pollIntervalMs: 1_000 },
    });

    await service.close();
    await service.close();
    vi.advanceTimersByTime(1_000);

    expect(fixture.api.close).toHaveBeenCalledTimes(1);
    expect(fixture.api.listTools).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("registers and tears down local presence in cloud remote mode", async () => {
    const fixture = client();
    const fetch = vi.fn(
      async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const url = new URL(input.toString());
        if (url.pathname.endsWith("/api/project-bindings") && init?.method === "POST") {
          return Response.json({
            binding: { bindingId: "presence_1" },
          });
        }
        if (url.pathname.endsWith("/api/project-bindings/presence_1") && init?.method === "PATCH") {
          return Response.json({
            binding: { bindingId: "presence_1" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);

    const service = createNativeCapletsService({
      mode: "remote",
      server: { url: "http://127.0.0.1:5387", fetch },
      remote: {
        cloud: {
          url: "https://cloud.caplets.dev",
          accessToken: "token",
          workspaceId: "ws_1",
          projectRoot: dirname(projectConfigPath),
          heartbeatIntervalMs: 60_000,
        },
      },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.anything()));
    await service.close();

    const projectBindingBodies = fetch.mock.calls
      .map(([, init]) => init?.body)
      .filter((body): body is string => typeof body === "string")
      .map(
        (body) => JSON.parse(body) as { projectFiles?: Array<{ path: string; content: string }> },
      );
    expect(projectBindingBodies[0]?.projectFiles).toEqual([{ path: "config.json", content: "{}" }]);
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://cloud.caplets.dev/api/project-bindings/presence_1"),
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ state: "offline" }),
      }),
    );
  });

  it("updates local presence after local overlay reload changes the Caplet set", async () => {
    const fixture = client();
    const fetch = vi.fn(
      async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const url = new URL(input.toString());
        if (url.pathname.endsWith("/api/project-bindings") && init?.method === "POST") {
          return Response.json({
            binding: { bindingId: "presence_1" },
          });
        }
        if (url.pathname.endsWith("/api/project-bindings/presence_1") && init?.method === "PATCH") {
          return Response.json({
            binding: { bindingId: "presence_1" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    const { dir, configPath, projectConfigPath } = tempConfig({});
    dirs.push(dir);
    const service = createNativeCapletsService({
      mode: "remote",
      server: { url: "http://127.0.0.1:5387", fetch },
      remote: {
        cloud: {
          url: "https://cloud.caplets.dev",
          accessToken: "token",
          workspaceId: "ws_1",
          projectRoot: dirname(projectConfigPath),
        },
      },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.anything()));

    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          local: { name: "Local", description: "Local Caplet.", command: process.execPath },
        },
      }),
      "utf8",
    );
    await service.reload();

    expect(fetch).toHaveBeenCalledWith(
      new URL("https://cloud.caplets.dev/api/project-bindings"),
      expect.objectContaining({ method: "POST" }),
    );
    await service.close();
  });

  it("fails fast for invalid remote config", () => {
    expect(() =>
      createNativeCapletsService({ mode: "remote", server: { url: "http://example.com" } }),
    ).toThrow(/https/u);
  });
});

function tempConfig(config: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "caplets-native-remote-"));
  const userDir = join(dir, "user");
  const projectDir = join(dir, "project", ".caplets");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const configPath = join(userDir, "config.json");
  const projectConfigPath = join(projectDir, "config.json");
  writeFileSync(configPath, JSON.stringify(config), "utf8");
  writeFileSync(projectConfigPath, JSON.stringify({}), "utf8");
  return { dir, configPath, projectConfigPath };
}
