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
      execute: vi.fn(async () => ({
        ok: true,
        value: { smoke: true },
        diagnostics: [],
        logs: { entries: [], truncated: false, stored: false },
      })),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined),
    };

    const session = new NativeCapletsMcpSession(service, { server: server as never });

    expect([...registered.keys()]).toEqual(["remote-alpha"]);
    const tool = registered.get("remote-alpha") as {
      callback: (request: unknown) => Promise<unknown>;
    };
    const result = await tool.callback({ operation: "inspect" });
    const envelope = {
      ok: true,
      value: { smoke: true },
      diagnostics: [],
      logs: { entries: [], truncated: false, stored: false },
    };
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
      structuredContent: envelope,
    });
    expect(service.execute).toHaveBeenCalledWith("remote-alpha", { operation: "inspect" });
    await session.close();
    expect(service.close).toHaveBeenCalledOnce();
  });

  it("marks native tool envelopes with ok false as MCP errors", async () => {
    const registered = new Map<string, unknown>();
    const server = {
      registerTool: vi.fn((name: string, definition: unknown, callback: unknown) => {
        registered.set(name, { definition, callback });
        return { remove: vi.fn(), update: vi.fn() };
      }),
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const envelope = {
      ok: false,
      error: { code: "REQUEST_INVALID", message: "Bad request" },
      diagnostics: [],
    };
    const service = {
      listTools: () => [{ caplet: "code_mode", title: "Code Mode", description: "Code Mode" }],
      execute: vi.fn(async () => envelope),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined),
    };

    const session = new NativeCapletsMcpSession(service as never, { server: server as never });

    const tool = registered.get("code_mode") as {
      callback: (request: unknown) => Promise<unknown>;
    };
    await expect(tool.callback({})).resolves.toEqual({
      content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
      structuredContent: envelope,
      isError: true,
    });
    await session.close();
  });

  it("passes through native tool results that are already MCP call results", async () => {
    const registered = new Map<string, unknown>();
    const server = {
      registerTool: vi.fn((name: string, definition: unknown, callback: unknown) => {
        registered.set(name, { definition, callback });
        return { remove: vi.fn(), update: vi.fn() };
      }),
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const callResult = {
      content: [{ type: "text", text: "hello" }],
      structuredContent: { message: "hello" },
    };
    const service = {
      listTools: () => [{ caplet: "alpha", title: "Alpha", description: "Alpha" }],
      execute: vi.fn(async () => callResult),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined),
    };

    const session = new NativeCapletsMcpSession(service as never, { server: server as never });

    const tool = registered.get("alpha") as {
      callback: (request: unknown) => Promise<unknown>;
    };
    await expect(tool.callback({})).resolves.toBe(callResult);
    await session.close();
  });

  it("registers native tool annotations with MCP clients", async () => {
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
          caplet: "alpha",
          title: "Alpha",
          description: "Alpha",
          annotations: { readOnlyHint: true },
        },
      ],
      execute: vi.fn(async () => ({})),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined),
    };

    const session = new NativeCapletsMcpSession(service as never, { server: server as never });

    expect(registered.get("alpha")).toEqual({
      definition: expect.objectContaining({
        annotations: { readOnlyHint: true },
      }),
      callback: expect.any(Function),
    });
    await session.close();
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
