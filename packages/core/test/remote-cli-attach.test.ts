import { describe, expect, it, vi } from "vitest";

import { createRemoteAttachCommandAdapter } from "../src/remote-cli/attach";
import type { RemoteCapletsClient } from "../src/native/remote";

function client(): RemoteCapletsClient {
  return {
    listTools: vi.fn(async () => [
      { name: "github", capletId: "github", title: "GitHub", description: "GitHub tools" },
      { name: "github.search", capletId: "github", title: "Search" },
      { name: "linear", capletId: "linear", title: "Linear" },
    ]),
    callTool: vi.fn(async (_name, args) => ({ ok: true, args })),
    onToolsChanged: vi.fn(() => () => {}),
    close: vi.fn(async () => {}),
  };
}

describe("remote CLI Attach adapter", () => {
  it.each([
    "inspect",
    "check",
    "tools",
    "search_tools",
    "describe_tool",
    "call_tool",
    "resources",
    "search_resources",
    "resource_templates",
    "read_resource",
    "prompts",
    "search_prompts",
    "get_prompt",
    "complete",
  ] as const)("routes %s through the progressive Attach export", async (command) => {
    const transport = client();
    const adapter = createRemoteAttachCommandAdapter({ client: transport });
    const request = { operation: command, marker: "runtime" };

    await expect(adapter.request(command, { caplet: "github", request })).resolves.toEqual({
      ok: true,
      args: request,
    });
    expect(transport.callTool).toHaveBeenCalledWith("github", request);
  });

  it("builds complete-list Caplet rows from Attach discovery", async () => {
    const adapter = createRemoteAttachCommandAdapter({ client: client() });
    await expect(adapter.request("list", { includeDisabled: false })).resolves.toEqual([
      expect.objectContaining({ server: "github", name: "GitHub", source: "remote-attach" }),
      expect.objectContaining({ server: "linear", name: "Linear", source: "remote-attach" }),
    ]);
  });

  it("composes hidden CLI completion from Attach-discovered Caplet and tool names", async () => {
    const adapter = createRemoteAttachCommandAdapter({ client: client() });
    await expect(
      adapter.request("complete_cli", { shell: "bash", words: ["call-tool", "git"] }),
    ).resolves.toEqual(["github", "github.search"]);
  });
});
