import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import type { CurrentHostManagementMutationResult } from "../src/current-host/operations";

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
      executePortable: unavailable,
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
  it.each([
    { status: "denied", reason: "revoked-role" },
    { status: "unavailable" },
    { status: "conflict", reason: "aggregate-version" },
    { status: "rejected", reason: "filesystem-owned" },
    { status: "not_found" },
    { status: "unknown", retryAllowed: false, guidance: "lookup-original-target" },
  ] as const)("sets a nonzero exit for $status management outcomes", async (failure) => {
    const binding = {
      operationId: "operation-semantic-failure",
      target: "global" as const,
      logicalHostId: "host-cli-u9",
      storeId: "store-cli-u9",
      operationNamespace: "namespace-cli-u9",
      actorId: "operator-cli-u9",
      requestIdentity: "request-semantic-failure",
      operationClass: "logical-state" as const,
    };
    const target = {
      resource: "host-setting" as const,
      id: "telemetry",
      selector: "underlying-sql" as const,
      owner: "filesystem" as const,
      source: { kind: "filesystem" },
      effective: true,
      effectiveChanged: false,
      shadowChain: [{ owner: "filesystem" as const, source: { kind: "filesystem" } }],
      underlyingSqlAvailable: false,
      consequence: "effective-runtime-changes" as const,
    };
    const outcome: CurrentHostManagementMutationResult = (() => {
      switch (failure.status) {
        case "denied":
          return { status: "denied", reason: failure.reason, binding };
        case "unavailable":
          return { status: "unavailable", binding };
        case "conflict":
          return { status: "conflict", reason: failure.reason, binding };
        case "rejected":
          return { status: "rejected", reason: failure.reason, binding, target };
        case "not_found":
          return {
            status: "not_found",
            binding,
            resource: "host-setting",
            id: "telemetry",
            selector: "underlying-sql",
          };
        case "unknown":
          return {
            status: "unknown",
            binding,
            retryAllowed: false,
            guidance: "lookup-original-target",
          };
      }
    })();
    const createBinding: CurrentHostManagementClient["createBinding"] = () => binding;
    const unavailable = async () => {
      throw new Error("not used");
    };
    const client: CurrentHostManagementClient = {
      target: "global",
      identity: binding,
      createBinding,
      mutate: async () => outcome,
      list: unavailable,
      inspect: unavailable,
      preview: unavailable,
      status: unavailable,
      executePortable: unavailable,
      lookupOperation: unavailable,
    };
    const setExitCode = vi.fn();
    await runCli(
      [
        "storage",
        "management",
        "mutate",
        JSON.stringify({
          kind: "host-setting-set",
          key: "telemetry",
          value: false,
          selector: "underlying-sql",
        }),
        "--global",
      ],
      {
        internalCurrentHostManagement: client,
        setExitCode,
        writeOut: () => undefined,
        writeErr: () => undefined,
      },
    );
    expect(setExitCode).toHaveBeenCalledWith(1);
  });

  it("keeps local and authenticated remote management targets mutually exclusive", async () => {
    for (const args of [
      ["storage", "management", "status"],
      ["storage", "management", "status", "--global", "--remote"],
      ["storage", "management", "status", "--global", "--project"],
    ]) {
      await expect(
        runCli(args, { writeOut: () => undefined, writeErr: () => undefined }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    }
  });

  it("opens verified local SQL management and portable operations without injection or leaked locks", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-cli-management-"));
    const stateRoot = join(root, "state");
    const configPath = join(root, "config.json");
    const projectConfigPath = join(root, "project.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        serve: { storage: { kind: "sqlite", stateRoot } },
        mcpServers: {
          fixture: {
            name: "CLI management fixture",
            description: "Production local administration fixture.",
            command: process.execPath,
          },
        },
      }),
      "utf8",
    );
    writeFileSync(projectConfigPath, "{}", "utf8");
    const env = {
      ...process.env,
      CAPLETS_CONFIG: configPath,
      CAPLETS_PROJECT_CONFIG: projectConfigPath,
      XDG_STATE_HOME: join(root, "xdg-state"),
    };
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const out: string[] = [];
        await runCli(["storage", "management", "status", "--global"], {
          env,
          writeOut: (value) => out.push(value),
          writeErr: () => undefined,
        });
        expect(JSON.parse(out.join(""))).toMatchObject({
          status: "ok",
          health: { backend: "sqlite" },
        });
        out.length = 0;
        await runCli(["storage", "management", "list", "--global", "--resource", "caplet"], {
          env,
          writeOut: (value) => out.push(value),
          writeErr: () => undefined,
        });
        expect(JSON.parse(out.join(""))).toMatchObject({
          status: "ok",
          items: expect.any(Array),
        });
        out.length = 0;
        await runCli(["storage", "portable", "status", "--global", "--json"], {
          env,
          writeOut: (value) => out.push(value),
          writeErr: () => undefined,
        });
        expect(JSON.parse(out.join(""))).toMatchObject({
          kind: "portable_status",
          status: "live",
          health: { backend: "sqlite" },
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
