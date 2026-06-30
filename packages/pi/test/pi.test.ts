import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { generatedToolInputJsonSchema } from "@caplets/core/generated-tool-input-schema";
import type {
  NativeCapletTool,
  NativeCapletsService,
  NativeCapletsServiceOptions,
} from "@caplets/core/native";
import capletsPiExtension, {
  createCapletsPiExtension,
  loadPiSettingsArgs,
  type PiExtensionApi,
} from "../src/index";

const nativeMocks = vi.hoisted(() => ({
  createNativeCapletsService: vi.fn(),
  registerNativeCapletsProcessCleanup: vi.fn(),
  readNativeDefaults: vi.fn<() => unknown>(() => undefined),
}));

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
}));

vi.mock("@caplets/core/native", () => nativeMocks);
vi.mock("node:fs/promises", () => fsMocks);
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
  on: Mock<
    (
      event: "session_start" | "session_shutdown",
      handler: (
        event?: unknown,
        ctx?: {
          ui: { setWidget: Mock<(key: string, content: unknown, options?: unknown) => void> };
        },
      ) => void,
    ) => void
  >;
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
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
  });
  it("uses the core generated schema as Pi tool parameters", () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets__git-hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets__git-hub for GitHub."],
      },
    ]);
    const registered: RegisteredTool[] = [];

    createCapletsPiExtension({ service })({
      registerTool: (definition) => registered.push(definition as unknown as RegisteredTool),
    });

    expect(registered[0]?.parameters).toEqual(generatedToolInputJsonSchema());
  });

  it("registers Code Mode reuse guidance and session parameters", () => {
    const service = mockService([
      {
        caplet: "code_mode",
        toolName: "caplets__code_mode",
        title: "Code Mode",
        description:
          "Run Caplets Code Mode. Omit sessionId to start fresh and pass returned meta.sessionId to reuse live state.",
        promptGuidance: [
          "For REPL reuse, omit sessionId to start fresh, then pass the returned meta.sessionId on later calls that should reuse live state.",
          "Unknown or unavailable sessionId values fail before code execution; use meta.recoveryRef with caplets.debug.readRecovery({ recoveryRef }) for audit and manual reconstruction, not automatic replay.",
        ],
        inputSchema: {
          type: "object",
          properties: {
            code: { type: "string" },
            sessionId: {
              type: "string",
              description:
                "Omit to create a fresh reusable session; pass a known live session ID from meta.sessionId to reuse existing REPL state.",
            },
          },
          required: ["code"],
          additionalProperties: false,
        },
      },
    ]);
    const registered: RegisteredTool[] = [];

    createCapletsPiExtension({ service })({
      registerTool: (definition) => registered.push(definition as unknown as RegisteredTool),
    });

    expect(registered[0]).toMatchObject({
      name: "caplets__code_mode",
      description: expect.stringContaining("meta.sessionId"),
      promptGuidelines: expect.arrayContaining([
        expect.stringContaining("omit sessionId to start fresh"),
        expect.stringContaining("meta.recoveryRef"),
      ]),
      parameters: expect.objectContaining({
        properties: expect.objectContaining({
          sessionId: expect.objectContaining({
            description: expect.stringContaining("Omit to create a fresh reusable session"),
          }),
        }),
      }),
    });
  });

  it("registers prefixed native tools with explicit prompt guidance", async () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets__git-hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets__git-hub for GitHub."],
      },
      {
        caplet: "linear",
        toolName: "caplets__linear",
        title: "Linear",
        description: "Linear Caplet",
        promptGuidance: ["Use caplets__linear for Linear."],
      },
    ]);
    const registered: RegisteredTool[] = [];

    createCapletsPiExtension({ service })({
      registerTool: (definition) => registered.push(definition as unknown as RegisteredTool),
    });

    expect(registered.map((tool) => tool.name)).toEqual(["caplets__git-hub", "caplets__linear"]);
    expect(registered.map((tool) => tool.promptGuidelines[0])).toEqual([
      "Use caplets__git-hub for GitHub.",
      "Use caplets__linear for Linear.",
    ]);
    const tool = registered[0];
    expect(tool?.name).toBe("caplets__git-hub");
    expect(tool?.promptGuidelines[0]).toContain("caplets__git-hub");

    const result = await tool?.execute("call-1", { operation: "inspect" });
    expect(service.execute).toHaveBeenCalledWith("git-hub", { operation: "inspect" });
    expect(result?.details.result).toEqual({ ok: true });
  });

  it("propagates execute errors", async () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets__git-hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets__git-hub for GitHub."],
      },
    ]);
    const error = new Error("execution failed");
    service.execute.mockRejectedValueOnce(error);
    const registered: RegisteredTool[] = [];

    createCapletsPiExtension({ service })({
      registerTool: (definition) => registered.push(definition as unknown as RegisteredTool),
    });

    await expect(registered[0]?.execute("call-1", { operation: "inspect" })).rejects.toThrow(
      "execution failed",
    );
    expect(service.execute).toHaveBeenCalledWith("git-hub", { operation: "inspect" });
  });

  it("returns serialization errors in tool details", async () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets__git-hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets__git-hub for GitHub."],
      },
    ]);
    service.execute.mockResolvedValueOnce({ count: 1n });
    const registered: RegisteredTool[] = [];

    createCapletsPiExtension({ service })({
      registerTool: (definition) => registered.push(definition as unknown as RegisteredTool),
    });

    const result = await registered[0]?.execute("call-1", { operation: "inspect" });
    expect(result?.content[0]?.text).toContain("Serialization error");
    expect(result?.details.serializationError).toContain("BigInt");
  });

  it("returns stable text when JSON.stringify returns undefined", async () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets__git-hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets__git-hub for GitHub."],
      },
    ]);
    service.execute.mockResolvedValueOnce(undefined);
    const registered: RegisteredTool[] = [];

    createCapletsPiExtension({ service })({
      registerTool: (definition) => registered.push(definition as unknown as RegisteredTool),
    });

    const result = await registered[0]?.execute("call-1", { operation: "inspect" });
    expect(result?.content[0]?.text).toBe("null");
    expect(result?.details).toEqual({ result: undefined });
  });

  it("compacts noisy Code Mode values before returning agent-facing text", async () => {
    const service = mockService([
      {
        caplet: "code-mode",
        toolName: "caplets__code_mode",
        title: "Code Mode",
        description: "Code Mode Caplet",
        promptGuidance: ["Use caplets__code_mode for Code Mode."],
      },
    ]);
    service.execute.mockResolvedValueOnce({
      ok: true,
      value: {
        issue: {
          ok: true,
          data: { id: "BENCH-451", title: "Checkout authorization retry double-submit" },
          meta: { capletId: "issues", tool: "get_issue", durationMs: 12, status: "ok" },
        },
        descriptor: {
          id: "api",
          tool: {
            name: "lookup_schema",
            description: "Lookup an API schema.",
            inputSchema: { type: "object", properties: { id: { type: "string" } } },
          },
          inputSchema: { type: "object", properties: { id: { type: "string" } } },
          outputSchema: { type: "object", additionalProperties: true },
          callSignature: 'callTool(name: "lookup_schema", args: LookupSchemaInput)',
          inputTypeScript: "type LookupSchemaInput = { id: string; };",
        },
        many: Array.from({ length: 45 }, (_, index) => ({ index })),
      },
      diagnostics: [],
      logs: { entries: [], truncated: false, stored: false },
      meta: {
        runId: "run-1",
        traceId: "trace-1",
        declarationHash: "hash-1",
        sessionId: "session-1",
        sessionStatus: "created",
        recoveryRef: "recovery-1",
        timeoutMs: 10000,
        maxTimeoutMs: 10000,
        durationMs: 25,
      },
    });
    const registered: RegisteredTool[] = [];

    createCapletsPiExtension({ service })({
      registerTool: (definition) => registered.push(definition as unknown as RegisteredTool),
    });

    const result = await registered[0]?.execute("call-1", { code: "return facts;" });
    const text = result?.content[0]?.text ?? "{}";
    const parsed = JSON.parse(text);

    expect(parsed.value.issue).toEqual({
      id: "BENCH-451",
      title: "Checkout authorization retry double-submit",
    });
    expect(parsed.meta).toEqual({
      runId: "run-1",
      traceId: "trace-1",
      declarationHash: "hash-1",
      sessionId: "session-1",
      sessionStatus: "created",
      recoveryRef: "recovery-1",
      timeoutMs: 10000,
      maxTimeoutMs: 10000,
      durationMs: 25,
    });
    expect(parsed.value.descriptor).toEqual({
      id: "api",
      tool: { name: "lookup_schema", description: "Lookup an API schema." },
      callSignature: 'callTool(name: "lookup_schema", args: LookupSchemaInput)',
      inputTypeScript: "type LookupSchemaInput = { id: string; };",
    });
    expect(parsed.value.many).toHaveLength(41);
    expect(parsed.value.many.at(-1)).toEqual({ truncatedItems: 5 });
    expect(text).not.toContain("capletId");
    expect(text).not.toContain("inputSchema");
    expect(result?.details.result).toMatchObject({
      value: {
        issue: {
          meta: { capletId: "issues", tool: "get_issue", durationMs: 12, status: "ok" },
        },
      },
    });
  });

  it("renders caplet tool calls and collapsed results compactly", async () => {
    const service = mockService([
      {
        caplet: "context7",
        toolName: "caplets__context7",
        title: "Context7",
        description: "Context7 Caplet",
        promptGuidance: ["Use caplets__context7 for Context7."],
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

    createCapletsPiExtension({ service })({
      registerTool: (definition) => registered.push(definition as unknown as RegisteredTool),
    });

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
        toolName: "caplets__context7",
        title: "Context7",
        description: "Context7 Caplet",
        promptGuidance: ["Use caplets__context7 for Context7."],
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

    createCapletsPiExtension({ service })({
      registerTool: (definition) => registered.push(definition as unknown as RegisteredTool),
    });

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
        toolName: "caplets__browser",
        title: "Browser",
        description: "Browser Caplet",
        promptGuidance: ["Use caplets__browser for Browser."],
      },
      {
        caplet: "stealth-browser",
        toolName: "caplets__stealth-browser",
        title: "Stealth Browser",
        description: "Stealth Browser Caplet",
        promptGuidance: ["Use caplets__stealth-browser for Stealth Browser."],
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

    createCapletsPiExtension({ service })({
      registerTool: (definition) => registered.push(definition as unknown as RegisteredTool),
    });

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
        toolName: "caplets__browser",
        title: "Browser",
        description: "Browser Caplet",
        promptGuidance: ["Use caplets__browser for Browser."],
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

    createCapletsPiExtension({ service })({
      registerTool: (definition) => registered.push(definition as unknown as RegisteredTool),
    });

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
        toolName: "caplets__browser",
        title: "Browser",
        description: "Browser Caplet",
        promptGuidance: ["Use caplets__browser for Browser."],
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

    createCapletsPiExtension({ service })({
      registerTool: (definition) => registered.push(definition as unknown as RegisteredTool),
    });

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
        toolName: "caplets__browser",
        title: "Browser",
        description: "Browser Caplet",
        promptGuidance: ["Use caplets__browser for Browser."],
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

    createCapletsPiExtension({ service })({
      registerTool: (definition) => registered.push(definition as unknown as RegisteredTool),
    });

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
        toolName: "caplets__context7",
        title: "Context7",
        description: "Context7 Caplet",
        promptGuidance: ["Use caplets__context7 for Context7."],
      },
    ]);
    service.execute.mockResolvedValueOnce({
      content: [{ type: "text", text: "very long docs" }],
      structuredContent: {
        caplets: {
          name: "Context7",
          operation: "tools",
        },
      },
    });
    const registered: RegisteredTool[] = [];

    createCapletsPiExtension({ service })({
      registerTool: (definition) => registered.push(definition as unknown as RegisteredTool),
    });

    const tool = registered[0];
    const result = await tool?.execute("call-1", { operation: "tools" });
    const rendered = renderText(
      tool?.renderResult(result!, { expanded: true, isPartial: false }, plainTheme),
    );

    expect(rendered).toContain("✓ Context7 tools complete (ctrl+o to collapse)");
    expect(rendered).toContain("\nvery long docs");
    expect(rendered).not.toContain("Result summary:");
    expect(rendered.indexOf("✓ Context7 tools complete")).toBeLessThan(
      rendered.indexOf("very long docs"),
    );
  });

  it("does not execute active-tool actions during extension loading", () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets__git-hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets__git-hub for GitHub."],
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

    expect(() =>
      createCapletsPiExtension({ service })(api as unknown as PiExtensionApi),
    ).not.toThrow();
    expect(api.registerTool).toHaveBeenCalledOnce();
    expect(api.getActiveTools).not.toHaveBeenCalled();
    expect(api.setActiveTools).not.toHaveBeenCalled();
  });

  it("registers process cleanup for owned services", async () => {
    const service = mockService([]);
    nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);
    fsMocks.readFile.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));

    await capletsPiExtension({ registerTool: vi.fn() });

    expect(nativeMocks.createNativeCapletsService).toHaveBeenCalledWith({
      telemetryIntegration: "pi",
    });
    expect(nativeMocks.registerNativeCapletsProcessCleanup).toHaveBeenCalledWith(service);
  });

  it("passes explicit factory args to owned native service creation", () => {
    const service = mockService([]);
    const args = {
      mode: "remote",
      remote: { url: "https://caplets.example.com" },
    } satisfies Pick<NativeCapletsServiceOptions, "mode" | "remote">;
    nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);

    createCapletsPiExtension({ args })({ registerTool: vi.fn() });

    expect(nativeMocks.createNativeCapletsService).toHaveBeenCalledWith({
      ...args,
      telemetryIntegration: "pi",
    });
    expect(nativeMocks.registerNativeCapletsProcessCleanup).toHaveBeenCalledWith(service);
  });

  it("awaits owned service reload before initial tool registration", async () => {
    const tools = [
      {
        caplet: "git-hub",
        toolName: "caplets__git-hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets__git-hub for GitHub."],
      },
    ];
    let reloaded = false;
    const service = mockService([]);
    service.listTools.mockImplementation(() => (reloaded ? tools : []));
    service.reload.mockImplementation(async () => {
      reloaded = true;
      return true;
    });
    nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);
    const { api, registered } = mockPiApi();

    await createCapletsPiExtension({ args: { mode: "remote" } })(api as unknown as PiExtensionApi);

    expect(service.reload).toHaveBeenCalledOnce();
    expect(service.listTools).toHaveBeenCalledAfter(service.reload);
    expect(registered.map((tool) => tool.name)).toEqual(["caplets__git-hub"]);
  });
  it("registers newly added tools when the native service changes", () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets__git-hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets__git-hub for GitHub."],
      },
    ]);
    const { api, registered } = mockPiApi(["read", "caplets__git-hub"]);

    createCapletsPiExtension({ service })(api as unknown as PiExtensionApi);
    triggerSessionStart(api);
    expect(api.setActiveTools).toHaveBeenNthCalledWith(1, ["read", "caplets__git-hub"]);
    service.setTools([
      {
        caplet: "git-hub",
        toolName: "caplets__git-hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets__git-hub for GitHub."],
      },
      {
        caplet: "linear",
        toolName: "caplets__linear",
        title: "Linear",
        description: "Linear Caplet",
        promptGuidance: ["Use caplets__linear for Linear."],
      },
    ]);
    service.emitToolsChanged();

    expect(registered.map((tool) => tool.name)).toEqual(["caplets__git-hub", "caplets__linear"]);
    expect(api.setActiveTools).toHaveBeenLastCalledWith([
      "read",
      "caplets__git-hub",
      "caplets__linear",
    ]);
  });

  it("refreshes existing tool definitions when metadata changes", () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets__git-hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets__git-hub for GitHub."],
      },
    ]);
    const { api, registered } = mockPiApi(["read", "caplets__git-hub"]);

    createCapletsPiExtension({ service })(api as unknown as PiExtensionApi);
    triggerSessionStart(api);
    service.setTools([
      {
        caplet: "git-hub",
        toolName: "caplets__git-hub",
        title: "GitHub Reloaded",
        description: "Reloaded GitHub Caplet",
        promptGuidance: ["Use caplets__git-hub for reloaded GitHub."],
      },
    ]);
    service.emitToolsChanged();

    expect(registered.map((tool) => tool.name)).toEqual(["caplets__git-hub", "caplets__git-hub"]);
    expect(registered[1]).toMatchObject({
      label: "GitHub Reloaded",
      description: "Reloaded GitHub Caplet",
      promptGuidelines: ["Use caplets__git-hub for reloaded GitHub."],
    });
    expect(api.setActiveTools).toHaveBeenLastCalledWith(["read", "caplets__git-hub"]);
  });

  it("refreshes existing tool definitions when backing Caplet changes", () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets__git-hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets__git-hub for GitHub."],
      },
    ]);
    const { api, registered } = mockPiApi(["read", "caplets__git-hub"]);

    createCapletsPiExtension({ service })(api as unknown as PiExtensionApi);
    triggerSessionStart(api);
    service.setTools([
      {
        caplet: "github-v2",
        toolName: "caplets__git-hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets__git-hub for GitHub."],
      },
    ]);
    service.emitToolsChanged();

    expect(registered.map((tool) => tool.name)).toEqual(["caplets__git-hub", "caplets__git-hub"]);
    expect(api.setActiveTools).toHaveBeenLastCalledWith(["read", "caplets__git-hub"]);
  });

  it("re-registers re-added tools after stale signature cleanup", () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets__git-hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets__git-hub for GitHub."],
      },
    ]);
    const { api, registered } = mockPiApi(["read", "caplets__git-hub"]);

    createCapletsPiExtension({ service })(api as unknown as PiExtensionApi);
    triggerSessionStart(api);
    service.setTools([]);
    service.emitToolsChanged();
    service.setTools([
      {
        caplet: "git-hub",
        toolName: "caplets__git-hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets__git-hub for GitHub."],
      },
    ]);
    service.emitToolsChanged();

    expect(registered.map((tool) => tool.name)).toEqual(["caplets__git-hub", "caplets__git-hub"]);
    expect(api.setActiveTools).toHaveBeenLastCalledWith(["read", "caplets__git-hub"]);
  });

  it("deactivates stale Caplets while preserving non-Caplets active tools", () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets__git-hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets__git-hub for GitHub."],
      },
      {
        caplet: "linear",
        toolName: "caplets__linear",
        title: "Linear",
        description: "Linear Caplet",
        promptGuidance: ["Use caplets__linear for Linear."],
      },
    ]);
    const { api } = mockPiApi(["read", "bash", "caplets__git-hub", "caplets__linear"]);

    createCapletsPiExtension({ service })(api as unknown as PiExtensionApi);
    triggerSessionStart(api);
    service.setTools([
      {
        caplet: "linear",
        toolName: "caplets__linear",
        title: "Linear",
        description: "Linear Caplet",
        promptGuidance: ["Use caplets__linear for Linear."],
      },
    ]);
    service.emitToolsChanged();

    expect(api.setActiveTools).toHaveBeenLastCalledWith(["read", "bash", "caplets__linear"]);
  });

  it("deactivates stale Caplets that were active before extension load", () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets__git-hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets__git-hub for GitHub."],
      },
    ]);
    const { api } = mockPiApi(["read", "caplets__stale", "caplets__git-hub"]);

    createCapletsPiExtension({ service })(api as unknown as PiExtensionApi);
    triggerSessionStart(api);

    expect(api.setActiveTools).toHaveBeenCalledWith(["read", "caplets__git-hub"]);
  });

  it("works when Pi active-tool APIs are unavailable", () => {
    const service = mockService([]);
    const registered: RegisteredTool[] = [];

    createCapletsPiExtension({ service })({
      registerTool: (definition) => registered.push(definition as unknown as RegisteredTool),
    });

    service.setTools([
      {
        caplet: "linear",
        toolName: "caplets__linear",
        title: "Linear",
        description: "Linear Caplet",
        promptGuidance: ["Use caplets__linear for Linear."],
      },
    ]);
    service.emitToolsChanged();

    expect(registered.map((tool) => tool.name)).toEqual(["caplets__linear"]);
  });

  it("detaches the native listener on Pi session shutdown", () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets__git-hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets__git-hub for GitHub."],
      },
    ]);
    const { api, registered } = mockPiApi();

    createCapletsPiExtension({ service })(api as unknown as PiExtensionApi);
    triggerSessionStart(api);
    const shutdown = api.on.mock.calls.find(([event]) => event === "session_shutdown")?.[1];
    shutdown?.();
    service.setTools([
      {
        caplet: "git-hub",
        toolName: "caplets__git-hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets__git-hub for GitHub."],
      },
      {
        caplet: "linear",
        toolName: "caplets__linear",
        title: "Linear",
        description: "Linear Caplet",
        promptGuidance: ["Use caplets__linear for Linear."],
      },
    ]);
    service.emitToolsChanged();

    expect(registered.map((tool) => tool.name)).toEqual(["caplets__git-hub"]);
    expect(service.close).not.toHaveBeenCalled();
  });

  it("project Pi settings override user Pi settings", async () => {
    const service = mockService([]);
    nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);
    fsMocks.readFile
      .mockResolvedValueOnce(
        JSON.stringify({
          packages: ["npm:@caplets/pi"],
          caplets: { mode: "local" },
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          packages: ["npm:@caplets/pi"],
          caplets: {
            mode: "remote",
            remote: { url: "http://localhost:5387" },
          },
        }),
      );
    const { api } = mockPiApi();

    await capletsPiExtension(api as unknown as PiExtensionApi);

    expect(fsMocks.readFile).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(".pi/agent/settings.json"),
      "utf8",
    );
    expect(fsMocks.readFile).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(".pi/settings.json"),
      "utf8",
    );
    expect(nativeMocks.createNativeCapletsService).toHaveBeenLastCalledWith({
      mode: "remote",
      remote: { url: "http://localhost:5387" },
      telemetryIntegration: "pi",
    });
  });

  it("loads non-secret remote URL fields from Pi settings", async () => {
    const writeWarning = vi.fn();
    fsMocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        packages: ["npm:@caplets/pi"],
        caplets: {
          mode: "remote",
          remote: {
            url: "https://caplets.example.com",
            pollIntervalMs: 1_000,
          },
        },
      }),
    );
    fsMocks.readFile.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));

    const args = await loadPiSettingsArgs({ writeWarning });

    expect(args).toEqual({
      mode: "remote",
      remote: {
        url: "https://caplets.example.com",
        pollIntervalMs: 1_000,
      },
    });
    expect(writeWarning).not.toHaveBeenCalled();
  });

  it("rejects native server settings in Pi config", async () => {
    const writeWarning = vi.fn();
    fsMocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        packages: ["npm:@caplets/pi"],
        caplets: {
          mode: "remote",
          server: {
            url: "https://caplets.example.com",
          },
        },
      }),
    );
    fsMocks.readFile.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));

    const args = await loadPiSettingsArgs({ writeWarning });

    expect(args).toEqual({});
    expect(writeWarning).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring Pi settings args: invalid"),
    );
  });

  it("rejects malformed legacy remote and server settings in Pi config", async () => {
    const writeWarning = vi.fn();
    fsMocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        packages: ["npm:@caplets/pi"],
        caplets: {
          mode: "remote",
          remote: "https://caplets.example.com",
        },
      }),
    );
    fsMocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        packages: ["npm:@caplets/pi"],
        caplets: {
          mode: "remote",
          server: "https://caplets.example.com",
        },
      }),
    );

    const malformedRemoteArgs = await loadPiSettingsArgs({ writeWarning });
    const malformedServerArgs = await loadPiSettingsArgs({ writeWarning });

    expect(malformedRemoteArgs).toEqual({});
    expect(malformedServerArgs).toEqual({});
    expect(writeWarning).toHaveBeenCalledTimes(2);
    expect(writeWarning).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring Pi settings args: invalid"),
    );
  });

  it("default export loads top-level Pi settings for the native service", async () => {
    const service = mockService([]);
    nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);
    fsMocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        packages: ["npm:@caplets/pi"],
        caplets: {
          mode: "remote",
          remote: {
            url: "https://caplets.example.com",
            pollIntervalMs: 1_000,
          },
        },
      }),
    );
    fsMocks.readFile.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const { api } = mockPiApi();

    await capletsPiExtension(api as unknown as PiExtensionApi);

    expect(nativeMocks.createNativeCapletsService).toHaveBeenLastCalledWith({
      mode: "remote",
      remote: {
        url: "https://caplets.example.com",
        pollIntervalMs: 1_000,
      },
      telemetryIntegration: "pi",
    });
  });

  it("loads cloud mode from Pi settings", async () => {
    const service = mockService([]);
    nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);
    fsMocks.readFile.mockImplementation(async (path: string) =>
      path.includes(".pi/agent/settings.json")
        ? JSON.stringify({
            caplets: { mode: "cloud", remote: { url: "https://cloud.caplets.dev" } },
          })
        : Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })),
    );
    const { api } = mockPiApi();

    await capletsPiExtension(api as unknown as PiExtensionApi);

    expect(nativeMocks.createNativeCapletsService).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "cloud",
        remote: { url: "https://cloud.caplets.dev" },
      }),
    );
  });

  it("ignores package entry args and uses empty settings without top-level caplets config", async () => {
    const service = mockService([]);
    nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);
    fsMocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        packages: [
          {
            source: "npm:@caplets/pi",
            args: { mode: "remote", remote: { url: "https://ignored.example.com" } },
          },
        ],
      }),
    );
    fsMocks.readFile.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const { api } = mockPiApi();

    await capletsPiExtension(api as unknown as PiExtensionApi);

    expect(nativeMocks.createNativeCapletsService).toHaveBeenLastCalledWith({
      telemetryIntegration: "pi",
    });
  });

  it("default export uses Caplets native defaults when Pi settings are missing", async () => {
    const service = mockService([]);
    nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);
    nativeMocks.readNativeDefaults.mockReturnValueOnce({
      version: 1,
      source: "setup",
      updatedAt: "2026-06-30T00:00:00.000Z",
      daemon: { url: "http://127.0.0.1:5387/caplets" },
    });
    fsMocks.readFile
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const { api } = mockPiApi();

    await capletsPiExtension(api as unknown as PiExtensionApi);

    expect(nativeMocks.createNativeCapletsService).toHaveBeenLastCalledWith({
      mode: "daemon",
      daemon: { url: "http://127.0.0.1:5387/caplets" },
      telemetryIntegration: "pi",
    });
  });

  it("default export falls back to empty args when Pi settings are missing", async () => {
    const service = mockService([]);
    nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);
    fsMocks.readFile
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const { api } = mockPiApi();

    await capletsPiExtension(api as unknown as PiExtensionApi);

    expect(nativeMocks.createNativeCapletsService).toHaveBeenLastCalledWith({
      telemetryIntegration: "pi",
    });
  });

  it("warns and falls back to empty args when Pi settings are malformed", async () => {
    const writeWarning = vi.fn();
    fsMocks.readFile
      .mockResolvedValueOnce("{ not json")
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));

    const args = await loadPiSettingsArgs({ writeWarning });

    expect(args).toEqual({});
    expect(writeWarning).toHaveBeenCalledWith(expect.stringContaining("Ignoring Pi settings args"));
  });

  it("does not show a status widget for local settings", async () => {
    const service = mockService([]);
    nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);
    fsMocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        packages: ["npm:@caplets/pi"],
        caplets: { mode: "local" },
      }),
    );
    const { api } = mockPiApi();
    const setWidget = vi.fn();

    await capletsPiExtension(api as unknown as PiExtensionApi);
    triggerSessionStart(api, { ui: { setWidget } });

    expect(setWidget).not.toHaveBeenCalled();
  });

  it("shows a remote status widget by default for remote settings", async () => {
    const service = mockService([]);
    nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);
    fsMocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        packages: ["npm:@caplets/pi"],
        caplets: {
          mode: "remote",
          remote: { url: "https://caplets.example.com" },
        },
      }),
    );
    const { api } = mockPiApi();
    const setWidget = vi.fn();

    await capletsPiExtension(api as unknown as PiExtensionApi);
    triggerSessionStart(api, { ui: { setWidget } });

    expect(setWidget).toHaveBeenCalledWith("caplets", expect.any(Function), {
      placement: "belowEditor",
    });
    expect(renderStatusWidget(setWidget)).toBe("<success>󰖟 caplets ✓</success>");
  });

  it("can disable nerd font icons in the remote status widget", async () => {
    const service = mockService([]);
    nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);
    fsMocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        packages: ["npm:@caplets/pi"],
        caplets: {
          mode: "remote",
          remote: { url: "https://caplets.example.com" },
          nerdFontIcons: false,
        },
      }),
    );
    const { api } = mockPiApi();
    const setWidget = vi.fn();

    await capletsPiExtension(api as unknown as PiExtensionApi);
    triggerSessionStart(api, { ui: { setWidget } });

    expect(setWidget).toHaveBeenCalledWith("caplets", expect.any(Function), {
      placement: "belowEditor",
    });
    expect(renderStatusWidget(setWidget)).toBe("<success>caplets ✓</success>");
  });

  it("can disable the remote status widget from settings", async () => {
    const service = mockService([]);
    nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);
    fsMocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        packages: ["npm:@caplets/pi"],
        caplets: {
          mode: "remote",
          remote: { url: "https://caplets.example.com" },
          statusWidget: false,
        },
      }),
    );
    const { api } = mockPiApi();
    const setWidget = vi.fn();

    await capletsPiExtension(api as unknown as PiExtensionApi);
    triggerSessionStart(api, { ui: { setWidget } });

    expect(setWidget).not.toHaveBeenCalled();
  });

  it("shows remote offline when initial reload fails", async () => {
    const service = mockService([]);
    service.reload.mockResolvedValueOnce(false);
    nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);
    fsMocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        packages: ["npm:@caplets/pi"],
        caplets: { mode: "remote", remote: { url: "https://caplets.example.com" } },
      }),
    );
    const { api } = mockPiApi();
    const setWidget = vi.fn();

    await capletsPiExtension(api as unknown as PiExtensionApi);
    triggerSessionStart(api, { ui: { setWidget } });

    expect(setWidget).toHaveBeenCalledWith("caplets", expect.any(Function), {
      placement: "belowEditor",
    });
    expect(renderStatusWidget(setWidget)).toBe("<error>󰖟 caplets ×</error>");
  });

  it("programmatic args override Pi settings without reading the settings file", async () => {
    const service = mockService([]);
    nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);
    const { api } = mockPiApi();

    await createCapletsPiExtension({ args: { mode: "local" } })(api as unknown as PiExtensionApi);

    expect(fsMocks.readFile).not.toHaveBeenCalled();
    expect(nativeMocks.createNativeCapletsService).toHaveBeenLastCalledWith({
      mode: "local",
      telemetryIntegration: "pi",
    });
  });

  it("closes owned services on Pi session shutdown", async () => {
    const service = mockService([]);
    const { api } = mockPiApi();
    nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);
    fsMocks.readFile.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));

    await capletsPiExtension(api as unknown as PiExtensionApi);
    const shutdown = api.on.mock.calls.find(([event]) => event === "session_shutdown")?.[1];
    shutdown?.();

    expect(service.close).toHaveBeenCalledOnce();
  });
});

const plainTheme: RenderTheme = {
  bold: (text) => text,
  fg: (_key, text) => text,
};

function renderStatusWidget(setWidget: Mock): string {
  const factory = setWidget.mock.calls.at(-1)?.[1] as
    | ((tui: unknown, theme: { fg(key: string, text: string): string }) => RenderComponent)
    | undefined;
  if (!factory) {
    return "";
  }
  return factory({} as never, { fg: (key, text) => `<${key}>${text}</${key}>` })
    .render(80)
    .join("\n")
    .trimEnd();
}

function renderText(component: RenderComponent | undefined): string {
  return component?.render(120).join("\n") ?? "";
}

function triggerSessionStart(
  api: MockPiApi,
  ctx?: { ui: { setWidget: Mock<(key: string, content: unknown, options?: unknown) => void> } },
): void {
  const sessionStart = api.on.mock.calls.find(([event]) => event === "session_start")?.[1];
  sessionStart?.(undefined, ctx);
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
