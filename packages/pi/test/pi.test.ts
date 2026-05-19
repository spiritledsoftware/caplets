import { describe, expect, it, vi, type Mock } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { generatedToolInputJsonSchema } from "@caplets/core/generated-tool-input-schema";
import type {
  NativeCapletTool,
  NativeCapletsService,
  NativeCapletsServiceOptions,
} from "@caplets/core/native";
import capletsPiExtension, { type PiExtensionApi } from "../src/index";

const nativeMocks = vi.hoisted(() => ({
  createNativeCapletsService: vi.fn(),
  registerNativeCapletsProcessCleanup: vi.fn(),
}));

vi.mock("@caplets/core/native", () => nativeMocks);

type RenderTheme = {
  bold(text: string): string;
  fg(_key: string, text: string): string;
};

type RenderComponent = {
  render(width: number): string[];
  invalidate(): void;
};

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
  renderCall(args: unknown, theme: RenderTheme): RenderComponent;
  renderResult(
    result: { content: Array<{ type: string; text: string }>; details: unknown },
    options: { expanded: boolean; isPartial: boolean },
    theme: RenderTheme,
  ): RenderComponent;
};

type MockPiApi = {
  registerTool: Mock<(definition: unknown) => void>;
  getActiveTools: Mock<() => string[]>;
  setActiveTools: Mock<(names: string[]) => void>;
  on: Mock<(event: "session_start" | "session_shutdown", handler: () => void) => void>;
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
  it("uses the core generated schema as Pi tool parameters", () => {
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
      { registerTool: (definition) => registered.push(definition as unknown as RegisteredTool) },
      { service },
    );

    expect(registered[0]?.parameters).toEqual(generatedToolInputJsonSchema());
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
      { registerTool: (definition) => registered.push(definition as unknown as RegisteredTool) },
      { service },
    );

    expect(registered.map((tool) => tool.name)).toEqual(["caplets_git_hub", "caplets_linear"]);
    expect(registered.map((tool) => tool.promptGuidelines[0])).toEqual([
      "Use caplets_git_hub for GitHub.",
      "Use caplets_linear for Linear.",
    ]);
    const tool = registered[0];
    expect(tool?.name).toBe("caplets_git_hub");
    expect(tool?.promptGuidelines[0]).toContain("caplets_git_hub");

    const result = await tool?.execute("call-1", { operation: "get_caplet" });
    expect(service.execute).toHaveBeenCalledWith("git-hub", { operation: "get_caplet" });
    expect(result?.details.result).toEqual({ ok: true });
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
      { registerTool: (definition) => registered.push(definition as unknown as RegisteredTool) },
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
      { registerTool: (definition) => registered.push(definition as unknown as RegisteredTool) },
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
      { registerTool: (definition) => registered.push(definition as unknown as RegisteredTool) },
      { service },
    );

    const result = await registered[0]?.execute("call-1", { operation: "get_caplet" });
    expect(result?.content[0]?.text).toBe("null");
    expect(result?.details).toEqual({ result: undefined });
  });

  it("renders caplet tool calls and collapsed results compactly", async () => {
    const service = mockService([
      {
        caplet: "context7",
        toolName: "caplets_context7",
        title: "Context7",
        description: "Context7 Caplet",
        promptGuidance: ["Use caplets_context7 for Context7."],
      },
    ]);
    service.execute.mockResolvedValueOnce({
      content: [{ type: "text", text: "very long docs" }],
      _meta: {
        caplets: {
          name: "Context7",
          operation: "call_tool",
          tool: "query-docs",
        },
      },
    });
    const registered: RegisteredTool[] = [];

    capletsPiExtension(
      { registerTool: (definition) => registered.push(definition as unknown as RegisteredTool) },
      { service },
    );

    const tool = registered[0];
    const result = await tool?.execute("call-1", {
      operation: "call_tool",
      tool: "query-docs",
    });

    expect(
      renderText(tool?.renderCall({ operation: "call_tool", tool: "query-docs" }, plainTheme)),
    ).toBe("Context7 call_tool query-docs");
    expect(
      renderText(tool?.renderResult(result!, { expanded: false, isPartial: false }, plainTheme)),
    ).toBe("✓ Context7 call_tool query-docs complete (ctrl+o to expand)\nvery long docs");
  });

  it("renders caplet error status as failed", async () => {
    const service = mockService([
      {
        caplet: "context7",
        toolName: "caplets_context7",
        title: "Context7",
        description: "Context7 Caplet",
        promptGuidance: ["Use caplets_context7 for Context7."],
      },
    ]);
    service.execute.mockResolvedValueOnce({
      content: [{ type: "text", text: "request failed" }],
      isError: true,
      _meta: {
        caplets: {
          name: "Context7",
          operation: "call_tool",
          tool: "query-docs",
          status: "error",
        },
      },
    });
    const registered: RegisteredTool[] = [];

    capletsPiExtension(
      { registerTool: (definition) => registered.push(definition as unknown as RegisteredTool) },
      { service },
    );

    const tool = registered[0];
    const result = await tool?.execute("call-1", { operation: "call_tool", tool: "query-docs" });

    expect(
      renderText(tool?.renderResult(result!, { expanded: false, isPartial: false }, plainTheme)),
    ).toBe("✗ Context7 call_tool query-docs failed (ctrl+o to expand)\nrequest failed");
  });

  it("disambiguates identical downstream tool names by Caplet title", async () => {
    const service = mockService([
      {
        caplet: "browser",
        toolName: "caplets_browser",
        title: "Browser",
        description: "Browser Caplet",
        promptGuidance: ["Use caplets_browser for Browser."],
      },
      {
        caplet: "stealth-browser",
        toolName: "caplets_stealth_browser",
        title: "Stealth Browser",
        description: "Stealth Browser Caplet",
        promptGuidance: ["Use caplets_stealth_browser for Stealth Browser."],
      },
    ]);
    service.execute
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "clicked" }],
        _meta: { caplets: { name: "Browser", operation: "call_tool", tool: "browser_click" } },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "clicked" }],
        _meta: {
          caplets: { name: "Stealth Browser", operation: "call_tool", tool: "browser_click" },
        },
      });
    const registered: RegisteredTool[] = [];

    capletsPiExtension(
      { registerTool: (definition) => registered.push(definition as unknown as RegisteredTool) },
      { service },
    );

    const browserResult = await registered[0]?.execute("call-1", {
      operation: "call_tool",
      tool: "browser_click",
    });
    const stealthResult = await registered[1]?.execute("call-2", {
      operation: "call_tool",
      tool: "browser_click",
    });

    expect(
      renderText(
        registered[0]?.renderCall({ operation: "call_tool", tool: "browser_click" }, plainTheme),
      ),
    ).toBe("Browser call_tool browser_click");
    expect(
      renderText(
        registered[1]?.renderCall({ operation: "call_tool", tool: "browser_click" }, plainTheme),
      ),
    ).toBe("Stealth Browser call_tool browser_click");
    expect(
      renderText(
        registered[0]?.renderResult(
          browserResult!,
          { expanded: false, isPartial: false },
          plainTheme,
        ),
      ),
    ).toBe("✓ Browser call_tool browser_click complete (ctrl+o to expand)\nclicked");
    expect(
      renderText(
        registered[1]?.renderResult(
          stealthResult!,
          { expanded: false, isPartial: false },
          plainTheme,
        ),
      ),
    ).toBe("✓ Stealth Browser call_tool browser_click complete (ctrl+o to expand)\nclicked");
  });

  it("keeps collapsed output concise when caplet result content contains a large snapshot", async () => {
    const service = mockService([
      {
        caplet: "browser",
        toolName: "caplets_browser",
        title: "Browser",
        description: "Browser Caplet",
        promptGuidance: ["Use caplets_browser for Browser."],
      },
    ]);
    const largeSnapshot = "# Page snapshot\n" + "button[name='Buy now']\n".repeat(500);
    service.execute.mockResolvedValueOnce({
      content: [{ type: "text", text: largeSnapshot }],
      _meta: {
        caplets: {
          name: "Browser",
          operation: "call_tool",
          tool: "browser_snapshot",
        },
      },
    });
    const registered: RegisteredTool[] = [];

    capletsPiExtension(
      { registerTool: (definition) => registered.push(definition as unknown as RegisteredTool) },
      { service },
    );

    const tool = registered[0];
    const result = await tool?.execute("call-1", {
      operation: "call_tool",
      tool: "browser_snapshot",
    });
    const renderedLines = tool
      ?.renderResult(result!, { expanded: false, isPartial: false }, plainTheme)
      .render(120);

    expect(renderedLines?.[0]).toBe(
      "✓ Browser call_tool browser_snapshot complete (ctrl+o to expand)",
    );
    expect(renderedLines?.[1]).toContain("# Page snapshot");
    expect(renderedLines?.join("\n").length).toBeLessThan(750);
    expect(result?.details.result).toMatchObject({
      content: [{ type: "text", text: largeSnapshot }],
    });
  });

  it("truncates custom render lines to the requested terminal width", async () => {
    const service = mockService([
      {
        caplet: "browser",
        toolName: "caplets_browser",
        title: "Browser",
        description: "Browser Caplet",
        promptGuidance: ["Use caplets_browser for Browser."],
      },
    ]);
    const longToolName = "browser_" + "x".repeat(120);
    service.execute.mockResolvedValueOnce({
      content: [{ type: "text", text: "snapshot " + "y".repeat(120) }],
      _meta: {
        caplets: {
          name: "Browser",
          operation: "call_tool",
          tool: longToolName,
        },
      },
    });
    const registered: RegisteredTool[] = [];

    capletsPiExtension(
      { registerTool: (definition) => registered.push(definition as unknown as RegisteredTool) },
      { service },
    );

    const tool = registered[0];
    const result = await tool?.execute("call-1", {
      operation: "call_tool",
      tool: longToolName,
    });
    const callLines = tool
      ?.renderCall({ operation: "call_tool", tool: longToolName }, plainTheme)
      .render(40);
    const resultLines = tool
      ?.renderResult(result!, { expanded: false, isPartial: false }, plainTheme)
      .render(40);

    expect([...callLines!, ...resultLines!].map((line) => visibleWidth(line))).toEqual([
      40, 40, 40,
    ]);
  });

  it("renders screenshot artifact metadata before a concise expanded output preview", async () => {
    const service = mockService([
      {
        caplet: "browser",
        toolName: "caplets_browser",
        title: "Browser",
        description: "Browser Caplet",
        promptGuidance: ["Use caplets_browser for Browser."],
      },
    ]);
    const largeSnapshot = "# Page snapshot\n" + "main > section > article\n".repeat(500);
    service.execute.mockResolvedValueOnce({
      content: [{ type: "text", text: largeSnapshot }],
      _meta: {
        caplets: {
          name: "Browser",
          operation: "call_tool",
          tool: "browser_take_screenshot",
          artifacts: [
            {
              kind: "screenshot",
              displayPath: "./browser-caplet-localhost-4199.png",
              pathResolution: "relative-to-mcp-server",
            },
          ],
        },
      },
    });
    const registered: RegisteredTool[] = [];

    capletsPiExtension(
      { registerTool: (definition) => registered.push(definition as unknown as RegisteredTool) },
      { service },
    );

    const tool = registered[0];
    const result = await tool?.execute("call-1", {
      operation: "call_tool",
      tool: "browser_take_screenshot",
    });
    const rendered = renderText(
      tool?.renderResult(result!, { expanded: true, isPartial: false }, plainTheme),
    );

    expect(rendered).toContain("✓ Browser call_tool browser_take_screenshot complete");
    expect(rendered).toContain(
      "Artifact: screenshot ./browser-caplet-localhost-4199.png (relative-to-mcp-server)",
    );
    expect(rendered).toContain("# Page snapshot");
    expect(rendered).not.toContain("Result summary:");
    expect(rendered.length).toBeGreaterThan(900);
    expect(rendered.indexOf("Artifact: screenshot")).toBeLessThan(
      rendered.indexOf("# Page snapshot"),
    );
  });

  it("renders expanded caplet results with a metadata header before serialized output", async () => {
    const service = mockService([
      {
        caplet: "context7",
        toolName: "caplets_context7",
        title: "Context7",
        description: "Context7 Caplet",
        promptGuidance: ["Use caplets_context7 for Context7."],
      },
    ]);
    service.execute.mockResolvedValueOnce({
      content: [{ type: "text", text: "very long docs" }],
      structuredContent: {
        caplets: {
          name: "Context7",
          operation: "list_tools",
        },
      },
    });
    const registered: RegisteredTool[] = [];

    capletsPiExtension(
      { registerTool: (definition) => registered.push(definition as unknown as RegisteredTool) },
      { service },
    );

    const tool = registered[0];
    const result = await tool?.execute("call-1", { operation: "list_tools" });
    const rendered = renderText(
      tool?.renderResult(result!, { expanded: true, isPartial: false }, plainTheme),
    );

    expect(rendered).toContain("✓ Context7 list_tools complete (ctrl+o to collapse)");
    expect(rendered).toContain("\nvery long docs");
    expect(rendered).not.toContain("Result summary:");
    expect(rendered.indexOf("✓ Context7 list_tools complete")).toBeLessThan(
      rendered.indexOf("very long docs"),
    );
  });

  it("does not execute active-tool actions during extension loading", () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_hub for GitHub."],
      },
    ]);
    const api = {
      registerTool: vi.fn(),
      getActiveTools: vi.fn(() => {
        throw new Error("Extension runtime not initialized");
      }),
      setActiveTools: vi.fn(() => {
        throw new Error("Extension runtime not initialized");
      }),
      on: vi.fn(),
    };

    expect(() => capletsPiExtension(api as unknown as PiExtensionApi, { service })).not.toThrow();
    expect(api.registerTool).toHaveBeenCalledOnce();
    expect(api.getActiveTools).not.toHaveBeenCalled();
    expect(api.setActiveTools).not.toHaveBeenCalled();
  });

  it("registers process cleanup for owned services", () => {
    const service = mockService([]);
    nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);

    capletsPiExtension({ registerTool: vi.fn() });

    expect(nativeMocks.createNativeCapletsService).toHaveBeenCalled();
    expect(nativeMocks.registerNativeCapletsProcessCleanup).toHaveBeenCalledWith(service);
  });

  it("passes Pi args to owned native service creation", () => {
    const service = mockService([]);
    const args = {
      mode: "remote",
      remote: { url: "https://caplets.example.com/mcp", user: "pi-user" },
    } satisfies Pick<NativeCapletsServiceOptions, "mode" | "remote">;
    nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);

    capletsPiExtension({ registerTool: vi.fn() }, { args });

    expect(nativeMocks.createNativeCapletsService).toHaveBeenCalledWith(args);
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

    capletsPiExtension(api as unknown as PiExtensionApi, { service });
    triggerSessionStart(api);
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

    capletsPiExtension(api as unknown as PiExtensionApi, { service });
    triggerSessionStart(api);
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

    capletsPiExtension(api as unknown as PiExtensionApi, { service });
    triggerSessionStart(api);
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

    capletsPiExtension(api as unknown as PiExtensionApi, { service });
    triggerSessionStart(api);
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

    capletsPiExtension(api as unknown as PiExtensionApi, { service });
    triggerSessionStart(api);
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

    capletsPiExtension(api as unknown as PiExtensionApi, { service });
    triggerSessionStart(api);

    expect(api.setActiveTools).toHaveBeenCalledWith(["read", "caplets_git_hub"]);
  });

  it("works when Pi active-tool APIs are unavailable", () => {
    const service = mockService([]);
    const registered: RegisteredTool[] = [];

    capletsPiExtension(
      { registerTool: (definition) => registered.push(definition as unknown as RegisteredTool) },
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

    capletsPiExtension(api as unknown as PiExtensionApi, { service });
    triggerSessionStart(api);
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

    capletsPiExtension(api as unknown as PiExtensionApi);
    const shutdown = api.on.mock.calls.find(([event]) => event === "session_shutdown")?.[1];
    shutdown?.();

    expect(service.close).toHaveBeenCalledOnce();
  });
});

const plainTheme: RenderTheme = {
  bold: (text) => text,
  fg: (_key, text) => text,
};

function renderText(component: RenderComponent | undefined): string {
  return component?.render(120).join("\n") ?? "";
}

function triggerSessionStart(api: MockPiApi): void {
  const sessionStart = api.on.mock.calls.find(([event]) => event === "session_start")?.[1];
  sessionStart?.();
}

function mockPiApi(activeTools: string[] = []): { api: MockPiApi; registered: RegisteredTool[] } {
  const registered: RegisteredTool[] = [];
  let currentActiveTools = [...activeTools];
  const api: MockPiApi = {
    registerTool: vi.fn((definition) => {
      registered.push(definition as unknown as RegisteredTool);
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
