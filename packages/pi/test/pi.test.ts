import { describe, expect, it, vi } from "vitest";
import capletsPiExtension from "../src/index.js";

describe("@caplets/pi", () => {
  it("registers prefixed native tools with explicit prompt guidance", async () => {
    const service = {
      listTools: () => [
        {
          caplet: "git-hub",
          toolName: "caplets_git_dash_hub",
          title: "GitHub",
          description: "GitHub Caplet",
          promptGuidance: ["Use caplets_git_dash_hub for GitHub."],
        },
      ],
      execute: vi.fn(async () => ({ ok: true })),
      close: vi.fn(async () => {}),
    };
    const registered: any[] = [];

    capletsPiExtension({ registerTool: (definition) => registered.push(definition) }, { service });

    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe("caplets_git_dash_hub");
    expect(registered[0].promptGuidelines[0]).toContain("caplets_git_dash_hub");

    const result = await registered[0].execute("call-1", { operation: "get_caplet" });
    expect(service.execute).toHaveBeenCalledWith("git-hub", { operation: "get_caplet" });
    expect(result.details.result).toEqual({ ok: true });
  });
});
