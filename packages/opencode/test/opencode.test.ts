import { describe, expect, it, vi } from "vitest";
import { createCapletsOpenCodeHooks } from "../src/hooks";

vi.mock("@opencode-ai/plugin", () => ({
  tool: Object.assign((definition: unknown) => definition, {
    schema: {
      enum: (values: string[]) => ({
        type: "enum",
        values,
        optional: () => ({ type: "enum", values, optional: true }),
      }),
      string: () => ({
        type: "string",
        optional: () => ({ type: "string", optional: true }),
        min: () => ({ type: "string" }),
      }),
      boolean: () => ({
        type: "boolean",
        optional: () => ({ type: "boolean", optional: true }),
      }),
      number: () => ({
        int: () => ({ positive: () => ({ optional: () => ({ type: "number", optional: true }) }) }),
      }),
      record: () => ({ optional: () => ({ type: "record", optional: true }) }),
      unknown: () => ({ type: "unknown" }),
      literal: (value: string) => ({ type: "literal", value }),
      object: (shape: unknown) => ({
        type: "object",
        shape,
        strict: () => ({
          type: "object",
          shape,
          strict: true,
          optional: () => ({ type: "object", optional: true }),
        }),
      }),
      union: (options: unknown[]) => ({
        type: "union",
        options,
        optional: () => ({ type: "union", options, optional: true }),
      }),
      array: (item: unknown) => ({
        min: () => ({ optional: () => ({ type: "array", item, optional: true }) }),
      }),
    },
  }),
}));

describe("@caplets/opencode", () => {
  it("registers one prefixed native tool per Caplet plus Code Mode", async () => {
    const service = {
      listTools: () => [
        {
          caplet: "git-hub",
          toolName: "caplets__git-hub",
          title: "GitHub",
          description: "GitHub\n\nUse this Caplet.",
          promptGuidance: ["Use caplets__git-hub for GitHub."],
        },
        {
          caplet: "code_mode",
          toolName: "caplets__code_mode",
          title: "Code Mode",
          description:
            "Run Caplets Code Mode TypeScript. Omit sessionId to start fresh and pass returned meta.sessionId to reuse live state.",
          codeModeRun: true,
          promptGuidance: [
            "Use caplets__code_mode for multi-step Caplets workflows.",
            "For REPL reuse, omit sessionId to start fresh, then pass the returned meta.sessionId on later calls that should reuse live state.",
          ],
        },
      ],
      execute: vi.fn(async (caplet: string) =>
        caplet === "code_mode"
          ? {
              ok: true,
              value: { ok: true },
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
            }
          : { ok: true },
      ),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    };

    const hooks = await createCapletsOpenCodeHooks(service);

    expect(Object.keys(hooks.tool ?? {})).toEqual(["caplets__git-hub", "caplets__code_mode"]);
    const capletsTool = hooks.tool!["caplets__git-hub"] as {
      execute(args: unknown, context: unknown): Promise<string>;
    };
    const result = await capletsTool.execute({ operation: "inspect" }, {} as never);
    expect(service.execute).toHaveBeenCalledWith("git-hub", { operation: "inspect" });
    expect(result).toContain('"ok": true');

    const runTool = hooks.tool!.caplets__code_mode as {
      description?: string;
      args: { code?: unknown; timeoutMs?: unknown; sessionId?: unknown };
      execute(args: unknown, context: unknown): Promise<string>;
    };
    expect(runTool.description).toContain("meta.sessionId");
    expect(runTool.args).toMatchObject({
      code: { type: "string" },
      timeoutMs: { type: "number", optional: true },
      sessionId: { type: "string", optional: true },
    });
    const runResult = await runTool.execute({ code: "return {ok:true};" }, {} as never);
    expect(service.execute).toHaveBeenCalledWith("code_mode", { code: "return {ok:true};" });
    expect(runResult).toContain('"ok": true');
    expect(JSON.parse(runResult)).toMatchObject({
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
    await runTool.execute({ code: "return {ok:true};", sessionId: "" }, {} as never);
    expect(service.execute).toHaveBeenLastCalledWith("code_mode", { code: "return {ok:true};" });
    await runTool.execute({ code: "return {ok:true};", sessionId: "session-1" }, {} as never);
    expect(service.execute).toHaveBeenLastCalledWith("code_mode", {
      code: "return {ok:true};",
      sessionId: "session-1",
    });
    await runTool.execute({ code: "return {ok:true};", sessionId: "session-2" }, {} as never);
    expect(service.execute).toHaveBeenLastCalledWith("code_mode", {
      code: "return {ok:true};",
      sessionId: "session-2",
    });

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]?.({} as never, output);
    expect(output.system.join("\n")).toContain("caplets__git-hub");
    expect(output.system.join("\n")).toContain("caplets__code_mode");
  });

  it("returns stable text when tool result serialization fails", async () => {
    const service = {
      listTools: () => [
        {
          caplet: "git-hub",
          toolName: "caplets__git-hub",
          title: "GitHub",
          description: "GitHub\n\nUse this Caplet.",
          promptGuidance: ["Use caplets__git-hub for GitHub."],
        },
      ],
      execute: vi.fn(async () => ({ count: 1n })),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    };

    const hooks = await createCapletsOpenCodeHooks(service);
    const capletsTool = hooks.tool!["caplets__git-hub"] as {
      execute(args: unknown, context: unknown): Promise<string>;
    };

    const result = await capletsTool.execute({ operation: "inspect" }, {} as never);

    expect(result).toContain("Serialization error");
    expect(result).toContain("BigInt");
  });

  it("uses direct native input schemas without progressive operation args", async () => {
    const service = {
      listTools: () => [
        {
          caplet: "status__ping",
          toolName: "caplets__status__ping",
          title: "ping",
          description: "Ping the service.",
          promptGuidance: ["Use caplets__status__ping."],
          inputSchema: {
            type: "object",
            properties: {
              mode: { enum: ["fast", "safe"] },
              verbose: { type: "boolean" },
              tags: { type: "array", items: { type: "string" } },
              priorityTags: { type: "array", items: { enum: ["high", "low"] } },
              looseTags: { type: "array", items: { anyOf: [{ type: "string" }] } },
            },
          },
        },
      ],
      execute: vi.fn(async () => ({ ok: true })),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    };

    const hooks = await createCapletsOpenCodeHooks(service);
    const directTool = hooks.tool!.caplets__status__ping as {
      args: Record<string, unknown>;
      execute(args: unknown, context: unknown): Promise<string>;
    };

    expect(directTool.args).toMatchObject({
      mode: { type: "enum", values: ["fast", "safe"], optional: true },
      verbose: { type: "boolean", optional: true },
      tags: { type: "array", item: { type: "string" }, optional: true },
      priorityTags: {
        type: "array",
        item: { type: "enum", values: ["high", "low"] },
        optional: true,
      },
      looseTags: { type: "array", item: { type: "string" }, optional: true },
    });
    await directTool.execute({ verbose: true }, {} as never);
    expect(service.execute).toHaveBeenCalledWith("status__ping", { verbose: true });
  });

  it("returns stable text when JSON.stringify returns undefined", async () => {
    const service = {
      listTools: () => [
        {
          caplet: "git-hub",
          toolName: "caplets__git-hub",
          title: "GitHub",
          description: "GitHub\n\nUse this Caplet.",
          promptGuidance: ["Use caplets__git-hub for GitHub."],
        },
      ],
      execute: vi.fn(async () => undefined),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    };

    const hooks = await createCapletsOpenCodeHooks(service);
    const capletsTool = hooks.tool!["caplets__git-hub"] as {
      execute(args: unknown, context: unknown): Promise<string>;
    };

    await expect(capletsTool.execute({ operation: "inspect" }, {} as never)).resolves.toBe("null");
  });

  it("refreshes system guidance for remaining registered tools only", async () => {
    let tools = [
      {
        caplet: "git-hub",
        toolName: "caplets__git-hub",
        title: "GitHub",
        description: "GitHub\n\nUse this Caplet.",
        promptGuidance: ["Use caplets__git-hub for GitHub."],
      },
      {
        caplet: "linear",
        toolName: "caplets__linear",
        title: "Linear",
        description: "Linear\n\nUse this Caplet.",
        promptGuidance: ["Use caplets__linear for Linear."],
      },
    ];
    const service = {
      listTools: () => tools,
      execute: vi.fn(async () => ({ ok: true })),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    };

    const hooks = await createCapletsOpenCodeHooks(service);
    tools = [
      {
        caplet: "linear",
        toolName: "caplets__linear",
        title: "Linear",
        description: "Linear\n\nUse this Caplet.",
        promptGuidance: ["Use caplets__linear for Linear."],
      },
      {
        caplet: "slack",
        toolName: "caplets__slack",
        title: "Slack",
        description: "Slack\n\nUse this Caplet.",
        promptGuidance: ["Use caplets__slack for Slack."],
      },
    ];

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]?.({} as never, output);

    const system = output.system.join("\n");
    expect(system).toContain("caplets__linear");
    expect(system).not.toContain("caplets__git-hub");
    expect(system).not.toContain("caplets__slack");
  });

  it("passes second-argument config into the native service", async () => {
    vi.resetModules();
    const nativeMocks = {
      createNativeCapletsService: vi.fn(() => ({
        listTools: () => [],
        execute: vi.fn(async () => ({})),
        reload: vi.fn(async () => true),
        onToolsChanged: vi.fn(() => () => {}),
        close: vi.fn(async () => {}),
      })),
      registerNativeCapletsProcessCleanup: vi.fn(),
      hasNativeRuntimeSelectionEnv: vi.fn(() => false),
      readNativeDefaults: vi.fn(() => undefined),
    };
    vi.doMock("@caplets/core/native", () => nativeMocks);
    const plugin = (await import("../src/index")).default;

    await plugin(
      {} as never,
      {
        mode: "remote",
        remote: {
          url: "https://caplets.example.com",
          pollIntervalMs: 5_000,
        },
      } as never,
    );

    expect(nativeMocks.createNativeCapletsService).toHaveBeenCalledWith({
      mode: "remote",
      remote: {
        url: "https://caplets.example.com",
        pollIntervalMs: 5_000,
      },
      telemetryIntegration: "opencode",
    });
  });

  it("uses Caplets native defaults when no explicit config is provided", async () => {
    vi.resetModules();
    const nativeMocks = {
      createNativeCapletsService: vi.fn(() => ({
        listTools: () => [],
        execute: vi.fn(async () => ({})),
        reload: vi.fn(async () => true),
        onToolsChanged: vi.fn(() => () => {}),
        close: vi.fn(async () => {}),
      })),
      registerNativeCapletsProcessCleanup: vi.fn(),
      hasNativeRuntimeSelectionEnv: vi.fn(() => false),
      readNativeDefaults: vi.fn(() => ({
        version: 1,
        source: "setup",
        updatedAt: "2026-06-30T00:00:00.000Z",
        daemon: { url: "http://127.0.0.1:5387/caplets" },
      })),
    };
    vi.doMock("@caplets/core/native", () => nativeMocks);
    const plugin = (await import("../src/index")).default;

    await plugin({} as never, undefined as never);

    expect(nativeMocks.createNativeCapletsService).toHaveBeenCalledWith({
      mode: "daemon",
      daemon: { url: "http://127.0.0.1:5387/caplets" },
      telemetryIntegration: "opencode",
    });
  });

  it("uses Caplets native defaults when OpenCode passes an empty config object", async () => {
    vi.resetModules();
    const nativeMocks = {
      createNativeCapletsService: vi.fn(() => ({
        listTools: () => [],
        execute: vi.fn(async () => ({})),
        reload: vi.fn(async () => true),
        onToolsChanged: vi.fn(() => () => {}),
        close: vi.fn(async () => {}),
      })),
      registerNativeCapletsProcessCleanup: vi.fn(),
      hasNativeRuntimeSelectionEnv: vi.fn(() => false),
      readNativeDefaults: vi.fn(() => ({
        version: 1,
        source: "setup",
        updatedAt: "2026-06-30T00:00:00.000Z",
        daemon: { url: "http://127.0.0.1:5387/caplets" },
      })),
    };
    vi.doMock("@caplets/core/native", () => nativeMocks);
    const plugin = (await import("../src/index")).default;

    await plugin({} as never, {} as never);

    expect(nativeMocks.createNativeCapletsService).toHaveBeenCalledWith({
      mode: "daemon",
      daemon: { url: "http://127.0.0.1:5387/caplets" },
      telemetryIntegration: "opencode",
    });
  });

  it("lets native environment selectors override Caplets native defaults", async () => {
    vi.resetModules();
    const nativeMocks = {
      createNativeCapletsService: vi.fn(() => ({
        listTools: () => [],
        execute: vi.fn(async () => ({})),
        reload: vi.fn(async () => true),
        onToolsChanged: vi.fn(() => () => {}),
        close: vi.fn(async () => {}),
      })),
      registerNativeCapletsProcessCleanup: vi.fn(),
      hasNativeRuntimeSelectionEnv: vi.fn(() => true),
      readNativeDefaults: vi.fn(() => ({
        version: 1,
        source: "setup",
        updatedAt: "2026-06-30T00:00:00.000Z",
        daemon: { url: "http://127.0.0.1:5387/caplets" },
      })),
    };
    vi.doMock("@caplets/core/native", () => nativeMocks);
    const plugin = (await import("../src/index")).default;

    await plugin({} as never, undefined as never);

    expect(nativeMocks.readNativeDefaults).not.toHaveBeenCalled();
    expect(nativeMocks.createNativeCapletsService).toHaveBeenCalledWith({
      telemetryIntegration: "opencode",
    });
  });

  it("awaits initial native service reload before creating hooks", async () => {
    vi.resetModules();
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
    const service = {
      listTools: vi.fn(() => (reloaded ? tools : [])),
      execute: vi.fn(async () => ({})),
      reload: vi.fn(async () => {
        reloaded = true;
        return true;
      }),
      onToolsChanged: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    };
    const nativeMocks = {
      createNativeCapletsService: vi.fn(() => service),
      registerNativeCapletsProcessCleanup: vi.fn(),
      hasNativeRuntimeSelectionEnv: vi.fn(() => false),
      readNativeDefaults: vi.fn(() => undefined),
    };
    vi.doMock("@caplets/core/native", () => nativeMocks);
    const plugin = (await import("../src/index")).default;

    const hooks = await plugin({} as never, undefined as never);

    expect(service.reload).toHaveBeenCalledOnce();
    expect(service.listTools).toHaveBeenCalledAfter(service.reload);
    expect(Object.keys(hooks.tool ?? {})).toEqual(["caplets__git-hub"]);
  });
});
