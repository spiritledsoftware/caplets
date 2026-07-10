import { Client } from "@modelcontextprotocol/sdk/client/index";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import type { CapletsMcpSession } from "../src/serve/session";

export async function connectMcpTestClient(
  session: Pick<CapletsMcpSession, "connect">,
): Promise<Client> {
  const clientTransport = new LinkedTransport();
  const serverTransport = new LinkedTransport();
  clientTransport.peer = serverTransport;
  serverTransport.peer = clientTransport;

  await session.connect(serverTransport);
  const client = new Client({ name: "caplets-test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

class LinkedTransport implements Transport {
  peer?: LinkedTransport;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: NonNullable<Transport["onmessage"]>;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    const peer = this.peer;
    if (!peer) throw new Error("linked MCP transport has no peer");
    await new Promise<void>((resolve) => {
      queueMicrotask(() => {
        peer.onmessage?.(structuredClone(message));
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}
