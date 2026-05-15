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
  it("registers one prefixed native tool per Caplet", async () => {
    const { createCapletsOpenCodeHooks } = await import("../src/index.js");
    const service = {
      listTools: () => [
        {
          caplet: "git-hub",
          toolName: "caplets_git_dash_hub",
          title: "GitHub",
          description: "GitHub\n\nUse this Caplet.",
          promptGuidance: ["Use caplets_git_dash_hub for GitHub."],
        },
      ],
      execute: vi.fn(async () => ({ ok: true })),
      close: vi.fn(async () => {}),
    };

    const hooks = await createCapletsOpenCodeHooks(service);

    expect(Object.keys(hooks.tool ?? {})).toEqual(["caplets_git_dash_hub"]);
    const capletsTool = hooks.tool!.caplets_git_dash_hub as {
      execute(args: unknown, context: unknown): Promise<string>;
    };
    const result = await capletsTool.execute({ operation: "get_caplet" }, {} as never);
    expect(service.execute).toHaveBeenCalledWith("git-hub", { operation: "get_caplet" });
    expect(result).toContain('"ok": true');

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]?.({} as never, output);
    expect(output.system.join("\n")).toContain("caplets_git_dash_hub");
  });
});
