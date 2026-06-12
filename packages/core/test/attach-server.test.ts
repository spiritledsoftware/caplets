import { describe, expect, it, vi } from "vitest";
import { NativeCapletsMcpSession } from "../src/serve/native-session";

describe("NativeCapletsMcpSession", () => {
  it("registers tools from a native Caplets service", async () => {
    const registered = new Map<string, unknown>();
    const server = {
      registerTool: vi.fn((name: string, definition: unknown, callback: unknown) => {
        registered.set(name, { definition, callback });
        return { remove: vi.fn(), update: vi.fn() };
      }),
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const service = {
      listTools: () => [
        {
          caplet: "remote-alpha",
          toolName: "caplets__remote-alpha",
          title: "Remote Alpha",
          description: "Remote alpha tool",
          promptGuidance: [],
          inputSchema: {
            type: "object",
            properties: { operation: { type: "string", enum: ["inspect"] } },
          },
          operationNames: ["inspect"],
        },
      ],
      execute: vi.fn(async () => ({ ok: true })),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined),
    };

    const session = new NativeCapletsMcpSession(service, { server: server as never });

    expect([...registered.keys()]).toEqual(["remote-alpha"]);
    const tool = registered.get("remote-alpha") as {
      callback: (request: unknown) => Promise<unknown>;
    };
    await expect(tool.callback({ operation: "inspect" })).resolves.toEqual({ ok: true });
    expect(service.execute).toHaveBeenCalledWith("remote-alpha", { operation: "inspect" });
    await session.close();
    expect(service.close).toHaveBeenCalledOnce();
  });

  it("updates registered tools when the native service changes", () => {
    let listener: ((tools: unknown[]) => void) | undefined;
    const removed = vi.fn();
    const server = {
      registerTool: vi.fn((_name: string, _definition: unknown, _callback: unknown) => ({
        remove: removed,
        update: vi.fn(),
      })),
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const service = {
      listTools: () => [
        { caplet: "alpha", title: "Alpha", description: "Alpha", promptGuidance: [] },
      ],
      execute: vi.fn(async () => ({})),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn((nextListener: (tools: unknown[]) => void) => {
        listener = nextListener;
        return () => undefined;
      }),
      close: vi.fn(async () => undefined),
    };

    new NativeCapletsMcpSession(service as never, { server: server as never });
    listener?.([{ caplet: "beta", title: "Beta", description: "Beta", promptGuidance: [] }]);

    expect(removed).toHaveBeenCalledOnce();
    expect(server.registerTool).toHaveBeenCalledWith(
      "beta",
      expect.objectContaining({ title: "Beta" }),
      expect.any(Function),
    );
  });
});
