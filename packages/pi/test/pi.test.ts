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

type MockService = NativeCapletsService & {
  listTools: Mock<() => NativeCapletTool[]>;
  execute: Mock<NativeCapletsService["execute"]>;
  close: Mock<NativeCapletsService["close"]>;
};

describe("@caplets/pi", () => {
  it("registers prefixed native tools with explicit prompt guidance", async () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets_git_dash_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_dash_hub for GitHub."],
      },
    ]);
    const registered: RegisteredTool[] = [];

    capletsPiExtension(
      { registerTool: (definition) => registered.push(definition as RegisteredTool) },
      { service },
    );

    expect(registered).toHaveLength(1);
    const tool = registered[0];
    expect(tool?.name).toBe("caplets_git_dash_hub");
    expect(tool?.promptGuidelines[0]).toContain("caplets_git_dash_hub");

    const result = await tool?.execute("call-1", { operation: "get_caplet" });
    expect(service.execute).toHaveBeenCalledWith("git-hub", { operation: "get_caplet" });
    expect(result?.details.result).toEqual({ ok: true });
  });

  it("registers every listed tool", () => {
    const service = mockService([
      {
        caplet: "git-hub",
        toolName: "caplets_git_dash_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_dash_hub for GitHub."],
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

    expect(registered.map((tool) => tool.name)).toEqual(["caplets_git_dash_hub", "caplets_linear"]);
    expect(registered.map((tool) => tool.promptGuidelines[0])).toEqual([
      "Use caplets_git_dash_hub for GitHub.",
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
        toolName: "caplets_git_dash_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_dash_hub for GitHub."],
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
        toolName: "caplets_git_dash_hub",
        title: "GitHub",
        description: "GitHub Caplet",
        promptGuidance: ["Use caplets_git_dash_hub for GitHub."],
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

  it("registers process cleanup for owned services", () => {
    const service = mockService([]);
    nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);

    capletsPiExtension({ registerTool: vi.fn() });

    expect(nativeMocks.createNativeCapletsService).toHaveBeenCalled();
    expect(nativeMocks.registerNativeCapletsProcessCleanup).toHaveBeenCalledWith(service);
  });
});

function mockService(tools: NativeCapletTool[]): MockService {
  return {
    listTools: vi.fn<() => NativeCapletTool[]>(() => tools),
    execute: vi.fn(async () => ({ ok: true })),
    close: vi.fn(async () => {}),
  };
}
