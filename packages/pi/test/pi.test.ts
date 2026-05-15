import { describe, expect, it, vi, type Mock } from "vitest";
import type { NativeCapletTool, NativeCapletsService } from "@caplets/core/native";
import capletsPiExtension from "../src/index.js";

const nativeMocks = vi.hoisted(() => ({
  createNativeCapletsService: vi.fn(),
  registerNativeCapletsProcessCleanup: vi.fn(),
}));

vi.mock("@caplets/core/native", () => nativeMocks);

type RegisteredTool = {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: { result: unknown; serializationError?: string };
  }>;
};

type MockPiApi = {
  registerTool: Mock<(definition: unknown) => void>;
  getActiveTools: Mock<() => string[]>;
  setActiveTools: Mock<(names: string[]) => void>;
  on: Mock<(event: "session_shutdown", handler: () => void) => void>;
};

type MockService = NativeCapletsService & {
  listTools: Mock<() => NativeCapletTool[]>;
  execute: Mock<NativeCapletsService["execute"]>;
  reload: Mock<NativeCapletsService["reload"]>;
  onToolsChanged: Mock<NativeCapletsService["onToolsChanged"]>;
  close: Mock<NativeCapletsService["close"]>;
  setTools(tools: NativeCapletTool[]): void;
  emitToolsChanged(): void;
};

describe("@caplets/pi", () => {
  it("only exposes the default extension function from the package entrypoint", async () => {
    const exports = await import("../src/index.js");

    expect(Object.keys(exports).sort()).toEqual(["default"]);
  });

  it("registers prefixed native tools with explicit prompt guidance", async () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_hub for GitHub."],
      },
    ]);
    const registered: RegisteredTool[] = [];

    capletsPiExtension(
      { registerTool: (definition) => registered.push(definition as RegisteredTool) },
      { service },
    );

    expect(registered).toHaveLength(1);
    const tool = registered[0];
    expect(tool?.name).toBe("caplets_git_hub");
    expect(tool?.promptGuidelines[0]).toContain("caplets_git_hub");

    const result = await tool?.execute("call-1", { operation: "get_caplet" });
    expect(service.execute).toHaveBeenCalledWith("git-hub", { operation: "get_caplet" });
    expect(result?.details.result).toEqual({ ok: true });
  });

  it("registers every listed tool", () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_hub for GitHub."],
      },
      {
        caplet: "linear",
        toolName: "caplets_linear",
        title: "Linear",
        description: "Linear Caplet",
        promptGuidance: ["Use caplets_linear for Linear."],
      },
    ]);
    const registered: RegisteredTool[] = [];

    capletsPiExtension(
      { registerTool: (definition) => registered.push(definition as RegisteredTool) },
      { service },
    );

    expect(registered.map((tool) => tool.name)).toEqual(["caplets_git_hub", "caplets_linear"]);
    expect(registered.map((tool) => tool.promptGuidelines[0])).toEqual([
      "Use caplets_git_hub for GitHub.",
      "Use caplets_linear for Linear.",
    ]);
  });

  it("does not register tools for an empty service", () => {
    const service = mockService([]);
    const registered: RegisteredTool[] = [];

    capletsPiExtension(
      { registerTool: (definition) => registered.push(definition as RegisteredTool) },
      { service },
    );

    expect(registered).toEqual([]);
    expect(service.execute).not.toHaveBeenCalled();
    expect(service.close).not.toHaveBeenCalled();
  });

  it("propagates execute errors", async () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_hub for GitHub."],
      },
    ]);
    const error = new Error("execution failed");
    service.execute.mockRejectedValueOnce(error);
    const registered: RegisteredTool[] = [];

    capletsPiExtension(
      { registerTool: (definition) => registered.push(definition as RegisteredTool) },
      { service },
    );

    await expect(registered[0]?.execute("call-1", { operation: "get_caplet" })).rejects.toThrow(
      "execution failed",
    );
    expect(service.execute).toHaveBeenCalledWith("git-hub", { operation: "get_caplet" });
  });

  it("returns serialization errors in tool details", async () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_hub for GitHub."],
      },
    ]);
    service.execute.mockResolvedValueOnce({ count: 1n });
    const registered: RegisteredTool[] = [];

    capletsPiExtension(
      { registerTool: (definition) => registered.push(definition as RegisteredTool) },
      { service },
    );

    const result = await registered[0]?.execute("call-1", { operation: "get_caplet" });
    expect(result?.content[0]?.text).toContain("Serialization error");
    expect(result?.details.serializationError).toContain("BigInt");
  });

  it("returns stable text when JSON.stringify returns undefined", async () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_hub for GitHub."],
      },
    ]);
    service.execute.mockResolvedValueOnce(undefined);
    const registered: RegisteredTool[] = [];

    capletsPiExtension(
      { registerTool: (definition) => registered.push(definition as RegisteredTool) },
      { service },
    );

    const result = await registered[0]?.execute("call-1", { operation: "get_caplet" });
    expect(result?.content[0]?.text).toBe("null");
    expect(result?.details).toEqual({ result: undefined });
  });

  it("registers process cleanup for owned services", () => {
    const service = mockService([]);
    nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);

    capletsPiExtension({ registerTool: vi.fn() });

    expect(nativeMocks.createNativeCapletsService).toHaveBeenCalled();
    expect(nativeMocks.registerNativeCapletsProcessCleanup).toHaveBeenCalledWith(service);
  });

  it("registers newly added tools when the native service changes", () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_hub for GitHub."],
      },
    ]);
    const { api, registered } = mockPiApi(["read", "caplets_git_hub"]);

    capletsPiExtension(api, { service });
    expect(api.setActiveTools).toHaveBeenNthCalledWith(1, ["read", "caplets_git_hub"]);
    service.setTools([
      {
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_hub for GitHub."],
      },
      {
        caplet: "linear",
        toolName: "caplets_linear",
        title: "Linear",
        description: "Linear Caplet",
        promptGuidance: ["Use caplets_linear for Linear."],
      },
    ]);
    service.emitToolsChanged();

    expect(registered.map((tool) => tool.name)).toEqual(["caplets_git_hub", "caplets_linear"]);
    expect(api.setActiveTools).toHaveBeenLastCalledWith([
      "read",
      "caplets_git_hub",
      "caplets_linear",
    ]);
  });

  it("refreshes existing tool definitions when metadata changes", () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_hub for GitHub."],
      },
    ]);
    const { api, registered } = mockPiApi(["read", "caplets_git_hub"]);

    capletsPiExtension(api, { service });
    service.setTools([
      {
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "GitHub Reloaded",
        description: "Reloaded GitHub Caplet",
        promptGuidance: ["Use caplets_git_hub for reloaded GitHub."],
      },
    ]);
    service.emitToolsChanged();

    expect(registered.map((tool) => tool.name)).toEqual(["caplets_git_hub", "caplets_git_hub"]);
    expect(registered[1]).toMatchObject({
      label: "GitHub Reloaded",
      description: "Reloaded GitHub Caplet",
      promptGuidelines: ["Use caplets_git_hub for reloaded GitHub."],
    });
    expect(api.setActiveTools).toHaveBeenLastCalledWith(["read", "caplets_git_hub"]);
  });

  it("refreshes existing tool definitions when backing Caplet changes", () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_hub for GitHub."],
      },
    ]);
    const { api, registered } = mockPiApi(["read", "caplets_git_hub"]);

    capletsPiExtension(api, { service });
    service.setTools([
      {
        caplet: "github-v2",
        toolName: "caplets_git_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_hub for GitHub."],
      },
    ]);
    service.emitToolsChanged();

    expect(registered.map((tool) => tool.name)).toEqual(["caplets_git_hub", "caplets_git_hub"]);
    expect(api.setActiveTools).toHaveBeenLastCalledWith(["read", "caplets_git_hub"]);
  });

  it("re-registers re-added tools after stale signature cleanup", () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_hub for GitHub."],
      },
    ]);
    const { api, registered } = mockPiApi(["read", "caplets_git_hub"]);

    capletsPiExtension(api, { service });
    service.setTools([]);
    service.emitToolsChanged();
    service.setTools([
      {
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_hub for GitHub."],
      },
    ]);
    service.emitToolsChanged();

    expect(registered.map((tool) => tool.name)).toEqual(["caplets_git_hub", "caplets_git_hub"]);
    expect(api.setActiveTools).toHaveBeenLastCalledWith(["read", "caplets_git_hub"]);
  });

  it("deactivates stale Caplets while preserving non-Caplets active tools", () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_hub for GitHub."],
      },
      {
        caplet: "linear",
        toolName: "caplets_linear",
        title: "Linear",
        description: "Linear Caplet",
        promptGuidance: ["Use caplets_linear for Linear."],
      },
    ]);
    const { api } = mockPiApi(["read", "bash", "caplets_git_hub", "caplets_linear"]);

    capletsPiExtension(api, { service });
    service.setTools([
      {
        caplet: "linear",
        toolName: "caplets_linear",
        title: "Linear",
        description: "Linear Caplet",
        promptGuidance: ["Use caplets_linear for Linear."],
      },
    ]);
    service.emitToolsChanged();

    expect(api.setActiveTools).toHaveBeenLastCalledWith(["read", "bash", "caplets_linear"]);
  });

  it("deactivates stale Caplets that were active before extension load", () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_hub for GitHub."],
      },
    ]);
    const { api } = mockPiApi(["read", "caplets_stale", "caplets_git_hub"]);

    capletsPiExtension(api, { service });

    expect(api.setActiveTools).toHaveBeenCalledWith(["read", "caplets_git_hub"]);
  });

  it("works when Pi active-tool APIs are unavailable", () => {
    const service = mockService([]);
    const registered: RegisteredTool[] = [];

    capletsPiExtension(
      { registerTool: (definition) => registered.push(definition as RegisteredTool) },
      { service },
    );

    service.setTools([
      {
        caplet: "linear",
        toolName: "caplets_linear",
        title: "Linear",
        description: "Linear Caplet",
        promptGuidance: ["Use caplets_linear for Linear."],
      },
    ]);
    service.emitToolsChanged();

    expect(registered.map((tool) => tool.name)).toEqual(["caplets_linear"]);
  });

  it("detaches the native listener on Pi session shutdown", () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_hub for GitHub."],
      },
    ]);
    const { api, registered } = mockPiApi();

    capletsPiExtension(api, { service });
    const shutdown = api.on.mock.calls.find(([event]) => event === "session_shutdown")?.[1];
    shutdown?.();
    service.setTools([
      {
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_hub for GitHub."],
      },
      {
        caplet: "linear",
        toolName: "caplets_linear",
        title: "Linear",
        description: "Linear Caplet",
        promptGuidance: ["Use caplets_linear for Linear."],
      },
    ]);
    service.emitToolsChanged();

    expect(registered.map((tool) => tool.name)).toEqual(["caplets_git_hub"]);
    expect(service.close).not.toHaveBeenCalled();
  });

  it("closes owned services on Pi session shutdown", () => {
    const service = mockService([]);
    const { api } = mockPiApi();
    nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);

    capletsPiExtension(api);
    const shutdown = api.on.mock.calls.find(([event]) => event === "session_shutdown")?.[1];
    shutdown?.();

    expect(service.close).toHaveBeenCalledOnce();
  });
});

function mockPiApi(activeTools: string[] = []): { api: MockPiApi; registered: RegisteredTool[] } {
  const registered: RegisteredTool[] = [];
  let currentActiveTools = [...activeTools];
  const api: MockPiApi = {
    registerTool: vi.fn((definition) => {
      registered.push(definition as RegisteredTool);
    }),
    getActiveTools: vi.fn(() => [...currentActiveTools]),
    setActiveTools: vi.fn((names) => {
      currentActiveTools = [...names];
    }),
    on: vi.fn(),
  };
  return { api, registered };
}

function mockService(tools: NativeCapletTool[]): MockService {
  let currentTools = tools;
  const listeners = new Set<(tools: NativeCapletTool[]) => void>();
  return {
    listTools: vi.fn<() => NativeCapletTool[]>(() => currentTools),
    execute: vi.fn(async () => ({ ok: true })),
    reload: vi.fn(async () => true),
    onToolsChanged: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    close: vi.fn(async () => {}),
    setTools(nextTools) {
      currentTools = nextTools;
    },
    emitToolsChanged() {
      for (const listener of listeners) listener(currentTools);
    },
  };
}
