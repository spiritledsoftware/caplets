import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";
import {
  createInternalControlPlaneStorageMigrationService,
  type InternalControlPlaneStorageMigrationService,
} from "../src/control-plane/service";
import type { CapletsError } from "../src/errors";
import { acquireLegacyMigrationMutex } from "../src/control-plane/migration/legacy";
import type { CurrentHostManagementClient } from "../src/current-host/client-operations";

describe("internal control-plane storage initialization seam", () => {
  it("runs the explicit global-only offline command through the internal service", async () => {
    const initialize = vi.fn(async () => ({
      status: "migrated" as const,
      backend: "sqlite" as const,
      authorityToken: "authority-1",
      manifestSha256: "a".repeat(64),
    }));
    const service = createInternalControlPlaneStorageMigrationService({ initialize });
    const out: string[] = [];

    await runCli(["storage", "migrate", "--global", "--offline"], {
      internalStorageMigration: service,
      writeOut: (value) => out.push(value),
      writeErr: () => undefined,
    });

    expect(initialize).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledWith({ target: "global", mode: "offline" });
    expect(out.join("")).toBe("Global legacy storage migration complete.\n");
  });

  it("rejects incomplete or conflicting global migration selectors before dispatch", async () => {
    const migrate = vi.fn<InternalControlPlaneStorageMigrationService["migrate"]>();
    for (const args of [
      ["storage", "migrate", "--offline"],
      ["storage", "migrate", "--global"],
      ["storage", "migrate", "--global", "--offline", "--project"],
    ]) {
      await expect(
        runCli(args, {
          internalStorageMigration: { migrate },
          writeOut: () => undefined,
          writeErr: () => undefined,
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
    }
    expect(migrate).not.toHaveBeenCalled();
  });

  it("routes hidden global management through the injected client with a caller-known operation ID", async () => {
    const createBinding = vi.fn<CurrentHostManagementClient["createBinding"]>(
      (request, options) => ({
        operationId: options?.operationId ?? "operation-generated",
        target: "global",
        logicalHostId: "host-cli-u9",
        storeId: "store-cli-u9",
        operationNamespace: "namespace-cli-u9",
        actorId: "operator-cli-u9",
        requestIdentity: JSON.stringify(request),
        operationClass: "logical-state",
      }),
    );
    const mutate = vi.fn<CurrentHostManagementClient["mutate"]>(async (_mutation, binding) => ({
      status: "committed",
      binding: binding ?? createBinding({}),
      receipt: {
        status: "committed",
        binding: binding ?? createBinding({}),
        aggregateVersion: 2,
        authorityToken: { authorityGeneration: 1, effectiveGeneration: 1 },
        localApplication: "not-applicable",
        convergence: { kind: "single-node" },
        management: {
          resource: "host-setting",
          id: "telemetry",
          selector: "underlying-sql",
          owner: "sql",
          source: { kind: "sql" },
          effective: false,
          effectiveChanged: true,
          shadowChain: [{ owner: "sql", source: { kind: "sql" } }],
          underlyingSqlAvailable: true,
          consequence: "effective-runtime-changes",
        },
      },
    }));
    const unavailable = async () => {
      throw new Error("not used");
    };
    const client: CurrentHostManagementClient = {
      target: "global",
      identity: {
        logicalHostId: "host-cli-u9",
        storeId: "store-cli-u9",
        operationNamespace: "namespace-cli-u9",
      },
      createBinding,
      mutate,
      list: unavailable,
      inspect: unavailable,
      preview: unavailable,
      status: unavailable,
      lookupOperation: unavailable,
    };
    const out: string[] = [];
    const mutation = JSON.stringify({
      kind: "host-setting-set",
      key: "telemetry",
      value: false,
      selector: "underlying-sql",
    });

    await runCli(
      [
        "storage",
        "management",
        "mutate",
        mutation,
        "--global",
        "--operation-id",
        "operation-cli-u9",
      ],
      {
        internalCurrentHostManagement: client,
        writeOut: (value) => out.push(value),
        writeErr: () => undefined,
      },
    );

    expect(createBinding).toHaveBeenCalledWith(expect.any(Object), {
      operationId: "operation-cli-u9",
    });
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ selector: "underlying-sql" }),
      expect.objectContaining({
        operationId: "operation-cli-u9",
        logicalHostId: "host-cli-u9",
        storeId: "store-cli-u9",
      }),
    );
    expect(JSON.parse(out.join(""))).toMatchObject({
      status: "committed",
      receipt: {
        management: { owner: "sql", selector: "underlying-sql" },
      },
    });
  });
  it("serializes new-process migration attempts with an owner-private mutex", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-legacy-mutex-"));
    const path = join(root, "migration.lock");
    try {
      const first = await acquireLegacyMigrationMutex(path);
      await expect(acquireLegacyMigrationMutex(path)).rejects.toThrow(
        expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
      );
      await first.release();
      const second = await acquireLegacyMigrationMutex(path);
      await second.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")(
    "takes over a crash-stale mutex without stealing a live or replaced lock identity",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "caplets-legacy-mutex-stale-"));
      const path = join(root, "migration.lock");
      const script = [
        'const fs = require("node:fs");',
        "const path = process.env.LOCK_PATH;",
        'const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");',
        'const start = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\\s+/)[19];',
        'fs.writeFileSync(path, JSON.stringify({version:1,pid:process.pid,processStart:start,lockId:"child-lock"})+"\\n",{mode:0o600});',
        'process.stdout.write("ready\\n");',
        "process.stdin.resume();",
      ].join("");
      const child = spawn(process.execPath, ["-e", script], {
        env: { ...process.env, LOCK_PATH: path },
        stdio: ["pipe", "pipe", "inherit"],
      });
      try {
        await once(child.stdout!, "data");
        await expect(acquireLegacyMigrationMutex(path)).rejects.toThrow(
          expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
        );
        child.kill("SIGKILL");
        await once(child, "exit");
        const recovered = await acquireLegacyMigrationMutex(path);
        await recovered.release();
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
