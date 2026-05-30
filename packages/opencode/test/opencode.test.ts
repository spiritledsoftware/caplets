import { describe, expect, it, vi } from "vitest";

vi.mock("@opencode-ai/plugin", () => ({
  tool: Object.assign((definition: unknown) => definition, {
    schema: {
      enum: () => ({ type: "enum" }),
      string: () => ({ optional: () => ({ type: "string", optional: true }), min: () => ({}) }),
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
      array: () => ({ min: () => ({ optional: () => ({ type: "array", optional: true }) }) }),
    },
  }),
}));

describe("@caplets/opencode", () => {
  it("registers one prefixed native tool per Caplet", async () => {
    const { createCapletsOpenCodeHooks } = await import("../src/hooks");
    const service = {
      listTools: () => [
        {
          caplet: "git-hub",
          toolName: "caplets_git_hub",
          title: "GitHub",
          description: "GitHub\n\nUse this Caplet.",
          promptGuidance: ["Use caplets_git_hub for GitHub."],
        },
      ],
      execute: vi.fn(async () => ({ ok: true })),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    };

    const hooks = await createCapletsOpenCodeHooks(service);

    expect(Object.keys(hooks.tool ?? {})).toEqual(["caplets_git_hub"]);
    const capletsTool = hooks.tool!.caplets_git_hub as {
      execute(args: unknown, context: unknown): Promise<string>;
    };
    const result = await capletsTool.execute({ operation: "inspect" }, {} as never);
    expect(service.execute).toHaveBeenCalledWith("git-hub", { operation: "inspect" });
    expect(result).toContain('"ok": true');

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]?.({} as never, output);
    expect(output.system.join("\n")).toContain("caplets_git_hub");
  });

  it("returns stable text when tool result serialization fails", async () => {
    const { createCapletsOpenCodeHooks } = await import("../src/hooks");
    const service = {
      listTools: () => [
        {
          caplet: "git-hub",
          toolName: "caplets_git_hub",
          title: "GitHub",
          description: "GitHub\n\nUse this Caplet.",
          promptGuidance: ["Use caplets_git_hub for GitHub."],
        },
      ],
      execute: vi.fn(async () => ({ count: 1n })),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    };

    const hooks = await createCapletsOpenCodeHooks(service);
    const capletsTool = hooks.tool!.caplets_git_hub as {
      execute(args: unknown, context: unknown): Promise<string>;
    };

    const result = await capletsTool.execute({ operation: "inspect" }, {} as never);

    expect(result).toContain("Serialization error");
    expect(result).toContain("BigInt");
  });

  it("returns stable text when JSON.stringify returns undefined", async () => {
    const { createCapletsOpenCodeHooks } = await import("../src/hooks");
    const service = {
      listTools: () => [
        {
          caplet: "git-hub",
          toolName: "caplets_git_hub",
          title: "GitHub",
          description: "GitHub\n\nUse this Caplet.",
          promptGuidance: ["Use caplets_git_hub for GitHub."],
        },
      ],
      execute: vi.fn(async () => undefined),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    };

    const hooks = await createCapletsOpenCodeHooks(service);
    const capletsTool = hooks.tool!.caplets_git_hub as {
      execute(args: unknown, context: unknown): Promise<string>;
    };

    await expect(capletsTool.execute({ operation: "inspect" }, {} as never)).resolves.toBe("null");
  });

  it("refreshes system guidance for remaining registered tools only", async () => {
    const { createCapletsOpenCodeHooks } = await import("../src/hooks");
    let tools = [
      {
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "GitHub",
        description: "GitHub\n\nUse this Caplet.",
        promptGuidance: ["Use caplets_git_hub for GitHub."],
      },
      {
        caplet: "linear",
        toolName: "caplets_linear",
        title: "Linear",
        description: "Linear\n\nUse this Caplet.",
        promptGuidance: ["Use caplets_linear for Linear."],
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
        toolName: "caplets_linear",
        title: "Linear",
        description: "Linear\n\nUse this Caplet.",
        promptGuidance: ["Use caplets_linear for Linear."],
      },
      {
        caplet: "slack",
        toolName: "caplets_slack",
        title: "Slack",
        description: "Slack\n\nUse this Caplet.",
        promptGuidance: ["Use caplets_slack for Slack."],
      },
    ];

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]?.({} as never, output);

    const system = output.system.join("\n");
    expect(system).toContain("caplets_linear");
    expect(system).not.toContain("caplets_git_hub");
    expect(system).not.toContain("caplets_slack");
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
    };
    vi.doMock("@caplets/core/native", () => nativeMocks);
    const plugin = (await import("../src/index")).default;

    await plugin(
      {} as never,
      {
        mode: "remote",
        server: {
          url: "https://caplets.example.com",
          user: "caplets",
        },
        remote: {
          pollIntervalMs: 5_000,
        },
      } as never,
    );

    expect(nativeMocks.createNativeCapletsService).toHaveBeenCalledWith({
      mode: "remote",
      server: {
        url: "https://caplets.example.com",
        user: "caplets",
      },
      remote: {
        pollIntervalMs: 5_000,
      },
    });
  });

  it("awaits initial native service reload before creating hooks", async () => {
    vi.resetModules();
    const tools = [
      {
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_hub for GitHub."],
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
    };
    vi.doMock("@caplets/core/native", () => nativeMocks);
    const plugin = (await import("../src/index")).default;

    const hooks = await plugin({} as never, undefined as never);

    expect(service.reload).toHaveBeenCalledOnce();
    expect(service.listTools).toHaveBeenCalledAfter(service.reload);
    expect(Object.keys(hooks.tool ?? {})).toEqual(["caplets_git_hub"]);
  });
});
