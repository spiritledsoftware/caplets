import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeHttpApp } from "../src/cloud/runtime-http";

describe("Cloud runtime adapter HTTP provenance boundary", () => {
  it("rejects runtime adapter calls without the runtime bearer token", async () => {
    const app = createRuntimeHttpApp({
      configPath: join(tmpdir(), "caplets-missing-config.json"),
      projectConfigPath: join(tmpdir(), "caplets-missing-project-config.json"),
      runtimeId: "runtime_1",
      sandboxId: "sandbox_1",
      executionKind: "cloud",
      token: "runtime_secret",
    });

    const response = await app.request("http://adapter.local/runtime/tools/list", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });
});
