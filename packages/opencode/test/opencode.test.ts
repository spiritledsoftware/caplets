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
      array: () => ({ min: () => ({ optional: () => ({ type: "array", optional: true }) }) }),
    },
  }),
}));

describe("@caplets/opencode", () => {
  it("only exposes the default plugin function from the package entrypoint", async () => {
    const exports = await import("../src/index.js");

    expect(Object.keys(exports).sort()).toEqual(["default"]);
  });

  it("registers one prefixed native tool per Caplet", async () => {
    const { createCapletsOpenCodeHooks } = await import("../src/hooks.js");
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
    const result = await capletsTool.execute({ operation: "get_caplet" }, {} as never);
    expect(service.execute).toHaveBeenCalledWith("git-hub", { operation: "get_caplet" });
    expect(result).toContain('"ok": true');

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]?.({} as never, output);
    expect(output.system.join("\n")).toContain("caplets_git_hub");
  });

  it("returns stable text when tool result serialization fails", async () => {
    const { createCapletsOpenCodeHooks } = await import("../src/hooks.js");
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

    const result = await capletsTool.execute({ operation: "get_caplet" }, {} as never);

    expect(result).toContain("Serialization error");
    expect(result).toContain("BigInt");
  });

  it("returns stable text when JSON.stringify returns undefined", async () => {
    const { createCapletsOpenCodeHooks } = await import("../src/hooks.js");
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

    await expect(capletsTool.execute({ operation: "get_caplet" }, {} as never)).resolves.toBe(
      "null",
    );
  });

  it("refreshes system guidance for remaining registered native tools", async () => {
    const { createCapletsOpenCodeHooks } = await import("../src/hooks.js");
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
    ];

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]?.({} as never, output);

    expect(output.system.join("\n")).toContain("caplets_linear");
    expect(output.system.join("\n")).not.toContain("caplets_git_hub");
  });

  it("does not advertise newly added unregistered native tools", async () => {
    const { createCapletsOpenCodeHooks } = await import("../src/hooks.js");
    let tools = [
      {
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "GitHub",
        description: "GitHub\n\nUse this Caplet.",
        promptGuidance: ["Use caplets_git_hub for GitHub."],
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
      ...tools,
      {
        caplet: "linear",
        toolName: "caplets_linear",
        title: "Linear",
        description: "Linear\n\nUse this Caplet.",
        promptGuidance: ["Use caplets_linear for Linear."],
      },
    ];

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]?.({} as never, output);

    expect(output.system.join("\n")).toContain("caplets_git_hub");
    expect(output.system.join("\n")).not.toContain("caplets_linear");
  });
});
