import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listSupportedAddMcpClients, upsertCapletsMcpServer } from "../src/cli/add-mcp-adapter";

describe("add-mcp adapter", () => {
  it("exposes canonical supported MCP client IDs from the pinned add-mcp contract", () => {
    const ids = listSupportedAddMcpClients().map((client) => client.id);

    expect(ids).toEqual([...new Set(ids)]);
    expect(ids).toEqual(expect.arrayContaining(["codex", "claude-code", "opencode"]));
  });

  it("upserts the Caplets server into disposable config only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-mcp-contract-"));
    try {
      const result = await upsertCapletsMcpServer({
        clientId: "codex",
        daemonBaseUrl: "http://127.0.0.1:5387/caplets",
        cwd: dir,
      });

      expect(result).toMatchObject({ success: true, clientId: "codex" });
      expect(result.path).toContain(dir);
      expect(result.error).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
