import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireLegacyMigrationExclusion,
  type AcquireLegacyMigrationExclusionOptions,
  type LegacyMigrationExclusion,
} from "../src/control-plane/migration/exclusion";
import { parseLsofRecords } from "../src/control-plane/migration/exclusion/macos";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await stopChild(child);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("macOS lsof identity adapter", () => {
  it("matches relocated objects by device and inode instead of a stale pathname", () => {
    expect(parseLsofRecords("p41\0f7\0D0x10\0n/legacy/state.json (deleted)\0i99\0")).toEqual([
      { pid: 41, descriptor: "7", device: "16", inode: "99" },
    ]);
  });
});

describe.runIf(process.platform === "linux")("legacy migration POSIX exclusion", () => {
  it("relocates one dedicated boundary, publishes type-inverting tombstones, and rolls back exactly", async () => {
    const fixture = createFixture();
    const before = snapshotFixture(fixture.boundary);
    const lease = await acquire(fixture);

    expect(existsSync(fixture.boundary)).toBe(true);
    expect(statSync(join(fixture.boundary, "state.json")).isDirectory()).toBe(true);
    expect(statSync(join(fixture.boundary, "caplets")).isFile()).toBe(true);
    expect(lease.sealedSource.path).not.toContain("state.json");
    expect(lease.sealedSource.identities.some((entry) => entry.kind === "directory")).toBe(true);
    expect(lease.sealedSource.identities.some((entry) => entry.kind === "file")).toBe(true);

    const final = await lease.verifyFinalScanAndRehash();
    expect(final.manifestSha256).toBe(lease.sealedSource.manifestSha256);
    expect(final.platformEvidence.coverage).toBe("proven");

    await lease.rollbackBeforeActivation();
    expect(snapshotFixture(fixture.boundary)).toEqual(before);
    expect(lease.state).toBe("rolled-back");
  });

  it("finds a prior process holding a relocated file and restores before tombstones are removed", async () => {
    const fixture = createFixture();
    const before = snapshotFixture(fixture.boundary);
    const child = await holdPath("file", join(fixture.boundary, "caplets", "demo.md"));
    const events: string[] = [];

    await expect(
      acquire(fixture, {
        platformOptions: {
          linux: {
            procRootForTests: createProcFixture(fixture, child.pid!),
            proof: { kind: "offline", allReplicasStopped: true },
          },
        },
        hooks: {
          afterRollbackSourceRestored: () => {
            events.push(`restored:${readFileSync(join(fixture.boundary, "state.json"), "utf8")}`);
          },
          afterRollbackTombstonesRemoved: () => {
            events.push("tombstones-removed");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });

    expect(events).toEqual([`restored:${before.state}`, "tombstones-removed"]);
    expect(snapshotFixture(fixture.boundary)).toEqual(before);
    expect(child.exitCode).toBeNull();
  });

  it("catches a real child racing after namespace closure", async () => {
    const fixture = createFixture();
    const before = snapshotFixture(fixture.boundary);
    const procRoot = createProcFixture(fixture);

    await expect(
      acquire(fixture, {
        platformOptions: {
          linux: {
            procRootForTests: procRoot,
            proof: { kind: "offline", allReplicasStopped: true },
          },
        },
        hooks: {
          afterTombstonesPublished: async ({ sealedSourcePath }) => {
            const child = await holdPath("directory", join(sealedSourcePath, "caplets"));
            addProcFixtureProcess(procRoot, child.pid!);
          },
        },
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });

    expect(snapshotFixture(fixture.boundary)).toEqual(before);
  });

  it("refuses unsafe automatic coverage and lets offline mode proceed only after replicas stop", async () => {
    const fixture = createFixture();
    const child = await holdPath("file", join(fixture.boundary, "state.json"));

    await expect(
      acquireLegacyMigrationExclusion({
        ...baseOptions(fixture),
        mode: "automatic",
        platformOptions: { linux: { proof: { kind: "automatic" } } },
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });

    await expect(
      acquireLegacyMigrationExclusion({
        ...baseOptions(fixture),
        mode: "offline",
        platformOptions: {
          linux: {
            procRootForTests: createProcFixture(fixture, child.pid!),
            proof: { kind: "offline", allReplicasStopped: true },
          },
        },
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });

    await stopChild(child);
    const lease = await acquireLegacyMigrationExclusion({
      ...baseOptions(fixture),
      mode: "offline",
      platformOptions: {
        linux: {
          procRootForTests: createProcFixture(fixture),
          proof: { kind: "offline", allReplicasStopped: true },
        },
      },
    });
    await lease.verifyFinalScanAndRehash();
    await lease.rollbackBeforeActivation();
  });

  it("reconciles the fsynced random-path journal after a relocation crash", async () => {
    const fixture = createFixture();
    const before = snapshotFixture(fixture.boundary);
    const crashedSealedPath = await crashExclusion(fixture, "relocation");

    const lease = await acquire(fixture);
    expect(existsSync(crashedSealedPath)).toBe(false);
    await lease.rollbackBeforeActivation();
    expect(snapshotFixture(fixture.boundary)).toEqual(before);
  });

  it("resumes activated cleanup without restoring the closed namespace", async () => {
    const fixture = createFixture();
    const crashedSealedPath = await crashExclusion(fixture, "activation");

    await expect(acquire(fixture)).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      message: expect.stringContaining("activation"),
    });
    expect(existsSync(crashedSealedPath)).toBe(false);
    expect(statSync(join(fixture.boundary, "state.json")).isDirectory()).toBe(true);
    expect(statSync(join(fixture.boundary, "caplets")).isFile()).toBe(true);
  });

  it("final scan detects changed sealed bytes and rollback repairs the exact source bytes", async () => {
    const fixture = createFixture();
    const before = snapshotFixture(fixture.boundary);
    const lease = await acquire(fixture);
    const sealedFile = join(lease.sealedSource.path, "state.json");
    chmodSync(sealedFile, 0o600);
    writeFileSync(sealedFile, "changed-after-initial-scan\n");

    await expect(lease.verifyFinalScanAndRehash()).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
    await lease.rollbackBeforeActivation();
    expect(snapshotFixture(fixture.boundary)).toEqual(before);
  });

  it("retains durable tombstones but removes raw sealed bytes only after protected recovery is durable", async () => {
    const fixture = createFixture();
    const lease = await acquire(fixture);
    const sealedPath = lease.sealedSource.path;

    await expect(
      lease.completeActivation({ protectedRecoveryDurable: false as true }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    expect(existsSync(sealedPath)).toBe(true);

    await lease.completeActivation({ protectedRecoveryDurable: true });
    expect(existsSync(sealedPath)).toBe(false);
    expect(statSync(join(fixture.boundary, "state.json")).isDirectory()).toBe(true);
    expect(lease.state).toBe("activated");
  });

  it("refuses hard-linked source files before relocation", async () => {
    const fixture = createFixture();
    linkSync(join(fixture.boundary, "state.json"), join(fixture.root, "outside-state.json"));

    await expect(acquire(fixture)).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    expect(existsSync(fixture.boundary)).toBe(true);
  });

  it("pins the exact tombstone boundary through the final scan", async () => {
    const fixture = createFixture();
    const lease = await acquire(fixture);
    const replacement = join(fixture.root, "replacement-tombstones");
    mkdirSync(replacement, { mode: 0o700 });
    mkdirSync(join(replacement, "state.json"), { mode: 0o700 });
    writeFileSync(join(replacement, "caplets"), "replacement\n", { mode: 0o600 });
    renameSync(fixture.boundary, join(fixture.root, "discarded-tombstones"));
    renameSync(replacement, fixture.boundary);

    await expect(lease.verifyFinalScanAndRehash()).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
    await lease.rollbackBeforeActivation();
  });

  it.each(["cwd", "root", "exe", "fd"] as const)(
    "refuses offline coverage when process %s coverage is inaccessible",
    async (inaccessible) => {
      const fixture = createFixture();
      const procRoot = join(fixture.root, "proc");
      const processRoot = join(procRoot, "123");
      mkdirSync(processRoot, { recursive: true });
      if (inaccessible === "fd") {
        writeFileSync(join(processRoot, "fd"), "not a directory");
      } else {
        mkdirSync(join(processRoot, "fd"));
      }
      for (const descriptor of ["cwd", "root", "exe"] as const) {
        symlinkSync(
          descriptor === inaccessible ? descriptor : fixture.root,
          join(processRoot, descriptor),
        );
      }

      await expect(
        acquire(fixture, {
          platformOptions: {
            linux: {
              procRootForTests: procRoot,
              proof: { kind: "offline", allReplicasStopped: true },
            },
          },
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    },
  );

  it("does not accept automatic host and mount coverage from asserted booleans", async () => {
    const fixture = createFixture();
    await expect(
      acquireLegacyMigrationExclusion({
        ...baseOptions(fixture),
        mode: "automatic",
        platformOptions: { linux: { proof: { kind: "automatic" } } },
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("makes unsupported offline multi-root topology explicit without claiming exclusion", async () => {
    const fixture = createFixture();
    const before = snapshotFixture(fixture.boundary);
    await expect(
      acquire(fixture, { additionalSourceBoundaryPaths: [join(fixture.root, "replica-two")] }),
    ).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      message: expect.stringContaining("multi-root"),
    });
    expect(snapshotFixture(fixture.boundary)).toEqual(before);
  });

  it("refuses boundaries with untracked entries or overlapping mutable roots", async () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.boundary, "bootstrap.json"), "owned elsewhere\n");
    await expect(acquire(fixture)).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    expect(readFileSync(join(fixture.boundary, "bootstrap.json"), "utf8")).toBe(
      "owned elsewhere\n",
    );

    rmSync(join(fixture.boundary, "bootstrap.json"));
    await expect(
      acquireLegacyMigrationExclusion({
        ...baseOptions(fixture),
        mutablePaths: [
          { relativePath: "caplets", kind: "directory" },
          { relativePath: "caplets/demo.md", kind: "file" },
          { relativePath: "state.json", kind: "file" },
        ],
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });
  it("seals the real multi-root layout offline while leaving config and project bytes untouched", async () => {
    const fixture = createRealLayoutFixture();
    const untouchedBefore = {
      config: readFileSync(fixture.configPath),
      projectCaplet: readFileSync(fixture.projectCapletPath),
      projectLockfile: readFileSync(fixture.projectLockfilePath),
      bootstrap: readFileSync(fixture.bootstrapPath),
    };
    const mutableBefore = fixture.sources.map((source) => snapshotMutableSource(source.sourcePath));
    const rollbackEvents: string[] = [];
    const procRoot = createProcFixture({ root: fixture.root, boundary: fixture.configRoot });
    const lease = await acquireLegacyMigrationExclusion({
      sourceBoundaryPath: fixture.configRoot,
      mutablePaths: [{ relativePath: "unused", kind: "file" }],
      offlineSourcePaths: fixture.sources,
      mode: "offline",
      platform: "linux",
      platformOptions: {
        linux: {
          procRootForTests: procRoot,
          proof: { kind: "offline", allReplicasStopped: true },
        },
      },
      hooks: {
        afterRollbackSourceRestored: () => {
          expect(fixture.sources.map((source) => snapshotMutableSource(source.sourcePath))).toEqual(
            mutableBefore,
          );
          rollbackEvents.push("all-roots-restored");
        },
        afterRollbackTombstonesRemoved: () => {
          rollbackEvents.push("all-tombstones-removed");
        },
      },
    });

    expect(lease.sealedSource.sources.map((source) => source.logicalPath)).toEqual(
      fixture.sources.map((source) => source.logicalPath).sort(),
    );
    expect(statSync(fixture.globalCapletPath).isDirectory()).toBe(true);
    for (const path of [
      fixture.globalLockfilePath,
      fixture.authPath,
      fixture.runtimePath,
      fixture.controlPlanePath,
    ]) {
      expect(statSync(path).isDirectory()).toBe(true);
    }
    expect(readFileSync(fixture.configPath)).toEqual(untouchedBefore.config);
    expect(readFileSync(fixture.projectCapletPath)).toEqual(untouchedBefore.projectCaplet);
    expect(readFileSync(fixture.projectLockfilePath)).toEqual(untouchedBefore.projectLockfile);
    expect(readFileSync(fixture.bootstrapPath)).toEqual(untouchedBefore.bootstrap);

    const childWriter = spawnSync(
      process.execPath,
      [
        "-e",
        [
          "const fs=require('node:fs');",
          `const paths=${JSON.stringify([
            fixture.globalCapletPath,
            fixture.globalLockfilePath,
            fixture.authPath,
            fixture.runtimePath,
            fixture.controlPlanePath,
          ])};`,
          "let succeeded=0;",
          "for(const path of paths){try{fs.writeFileSync(path,'prior-writer\\n');succeeded+=1}catch{}}",
          "process.exit(succeeded===0?0:1);",
        ].join(""),
      ],
      { env: process.env },
    );
    expect(childWriter.status).toBe(0);
    const final = await lease.verifyFinalScanAndRehash();
    expect(final.manifestSha256).toBe(lease.sealedSource.manifestSha256);

    await lease.rollbackBeforeActivation();
    expect(rollbackEvents).toEqual(["all-roots-restored", "all-tombstones-removed"]);
    expect(fixture.sources.map((source) => snapshotMutableSource(source.sourcePath))).toEqual(
      mutableBefore,
    );
    expect(readFileSync(fixture.configPath)).toEqual(untouchedBefore.config);
    expect(readFileSync(fixture.projectCapletPath)).toEqual(untouchedBefore.projectCaplet);
    expect(readFileSync(fixture.projectLockfilePath)).toEqual(untouchedBefore.projectLockfile);
    expect(readFileSync(fixture.bootstrapPath)).toEqual(untouchedBefore.bootstrap);
  });
  it("reconciles every real-layout path journal after a multi-root tombstone crash", async () => {
    const fixture = createRealLayoutFixture();
    const before = fixture.sources.map((source) => snapshotMutableSource(source.sourcePath));
    await crashOfflineSources(fixture);
    const lease = await acquireLegacyMigrationExclusion({
      sourceBoundaryPath: fixture.configRoot,
      mutablePaths: [{ relativePath: "unused", kind: "file" }],
      offlineSourcePaths: fixture.sources,
      mode: "offline",
      platform: "linux",
      platformOptions: {
        linux: {
          procRootForTests: createProcFixture({ root: fixture.root, boundary: fixture.configRoot }),
          proof: { kind: "offline", allReplicasStopped: true },
        },
      },
    });
    await lease.rollbackBeforeActivation();
    expect(fixture.sources.map((source) => snapshotMutableSource(source.sourcePath))).toEqual(
      before,
    );
  });
  it("rolls forward every real-layout cleanup journal after an activation crash", async () => {
    const fixture = createRealLayoutFixture();
    await crashOfflineSources(fixture, "activation");
    await expect(
      acquireLegacyMigrationExclusion({
        sourceBoundaryPath: fixture.configRoot,
        mutablePaths: [{ relativePath: "unused", kind: "file" }],
        offlineSourcePaths: fixture.sources,
        mode: "offline",
        platform: "linux",
        platformOptions: {
          linux: {
            procRootForTests: createProcFixture({
              root: fixture.root,
              boundary: fixture.configRoot,
            }),
            proof: { kind: "offline", allReplicasStopped: true },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      message: expect.stringContaining("activation"),
    });
    for (const source of fixture.sources) {
      expect(statSync(source.sourcePath).isDirectory()).toBe(true);
      expect(
        readdirSync(dirname(source.sourcePath)).some((name) => name.startsWith(".caplets-sealed-")),
      ).toBe(false);
    }
  });
});

describe.runIf(process.platform === "darwin")("legacy migration macOS exclusion", () => {
  it("uses Apple-signed privileged lsof to reject a live handle and then seal offline", async () => {
    const fixture = createFixture();
    const child = await holdPath("file", join(fixture.boundary, "caplets", "demo.md"));
    const options: AcquireLegacyMigrationExclusionOptions = {
      ...baseOptions(fixture),
      platform: "darwin",
      mode: "offline",
      platformOptions: {
        macos: { proof: { kind: "offline", allReplicasStopped: true } },
      },
    };

    await expect(acquireLegacyMigrationExclusion(options)).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
    await stopChild(child);

    const lease = await acquireLegacyMigrationExclusion(options);
    const verified = await lease.verifyFinalScanAndRehash();
    expect(verified.platformEvidence.gates).toContain("lsof:apple-code-signature-verified");
    expect(verified.platformEvidence.coverage).toBe("proven");
    await lease.rollbackBeforeActivation();
  });

  it("refuses automatic macOS coverage whose reviewed lsof identity is unproven", async () => {
    const fixture = createFixture();
    await expect(
      acquireLegacyMigrationExclusion({
        ...baseOptions(fixture),
        platform: "darwin",
        mode: "automatic",
        platformOptions: {
          macos: { proof: { kind: "automatic" } },
        },
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });
});

type Fixture = { root: string; boundary: string };
type RealLayoutCrashFixture = {
  root: string;
  configRoot: string;
  sources: NonNullable<AcquireLegacyMigrationExclusionOptions["offlineSourcePaths"]>;
};

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "caplets-exclusion-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const boundary = join(root, "legacy");
  mkdirSync(join(boundary, "caplets"), { recursive: true, mode: 0o700 });
  chmodSync(boundary, 0o700);
  writeFileSync(join(boundary, "state.json"), '{"authority":1}\n', { mode: 0o600 });
  writeFileSync(join(boundary, "caplets", "demo.md"), "# Demo\n", { mode: 0o600 });
  return { root, boundary };
}

function createRealLayoutFixture() {
  const root = mkdtempSync(join(tmpdir(), "caplets-real-layout-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const configRoot = join(root, "home", ".config", "caplets");
  const stateRoot = join(root, "home", ".local", "state", "caplets");
  const projectRoot = join(root, "project");
  const globalCapletPath = join(configRoot, "tracked.md");
  const globalLockfilePath = join(stateRoot, "caplets.lock.json");
  const configPath = join(configRoot, "config.json");
  const bootstrapPath = join(configRoot, "bootstrap.json");
  const authPath = join(stateRoot, "auth.json");
  const runtimePath = join(stateRoot, "runtime.json");
  const controlPlanePath = join(stateRoot, "control-plane.json");
  const projectCapletPath = join(projectRoot, ".caplets", "project.md");
  const projectLockfilePath = join(projectRoot, ".caplets.lock.json");
  mkdirSync(configRoot, { recursive: true, mode: 0o700 });
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(projectCapletPath), { recursive: true, mode: 0o700 });
  chmodSync(configRoot, 0o700);
  chmodSync(stateRoot, 0o700);
  writeFileSync(globalCapletPath, "# Global\n", { mode: 0o600 });
  writeFileSync(globalLockfilePath, '{"version":1}\n', { mode: 0o600 });
  writeFileSync(configPath, '{"telemetry":false}\n', { mode: 0o600 });
  writeFileSync(bootstrapPath, '{"bootstrap":true}\n', { mode: 0o600 });
  writeFileSync(authPath, '{"clients":[]}\n', { mode: 0o600 });
  writeFileSync(runtimePath, '{"sessions":[]}\n', { mode: 0o600 });
  writeFileSync(controlPlanePath, '{"authority":1}\n', { mode: 0o600 });
  writeFileSync(projectCapletPath, "# Project\n", { mode: 0o600 });
  writeFileSync(projectLockfilePath, '{"project":true}\n', { mode: 0o600 });
  return {
    root,
    configRoot,
    globalCapletPath,
    globalLockfilePath,
    configPath,
    bootstrapPath,
    authPath,
    runtimePath,
    controlPlanePath,
    projectCapletPath,
    projectLockfilePath,
    sources: [
      { sourcePath: authPath, logicalPath: "auth.json", kind: "file" as const },
      {
        sourcePath: globalLockfilePath,
        logicalPath: "caplets.lock.json",
        kind: "file" as const,
      },
      {
        sourcePath: controlPlanePath,
        logicalPath: "control-plane.json",
        kind: "file" as const,
      },
      {
        sourcePath: globalCapletPath,
        logicalPath: "global-caplets/tracked.md",
        kind: "file" as const,
      },
      { sourcePath: runtimePath, logicalPath: "runtime.json", kind: "file" as const },
    ],
  };
}

function snapshotMutableSource(path: string) {
  const metadata = statSync(path);
  return metadata.isDirectory()
    ? {
        kind: "directory",
        mode: metadata.mode & 0o777,
        entries: readdirSync(path).sort(),
        bytes: readFileSync(join(path, "global.md")),
      }
    : { kind: "file", mode: metadata.mode & 0o777, bytes: readFileSync(path) };
}

function snapshotFixture(boundary: string) {
  return {
    state: readFileSync(join(boundary, "state.json"), "utf8"),
    caplet: readFileSync(join(boundary, "caplets", "demo.md"), "utf8"),
    boundaryMode: statSync(boundary).mode & 0o777,
    stateMode: statSync(join(boundary, "state.json")).mode & 0o777,
    capletsMode: statSync(join(boundary, "caplets")).mode & 0o777,
    capletMode: statSync(join(boundary, "caplets", "demo.md")).mode & 0o777,
  };
}

function baseOptions(fixture: Fixture): AcquireLegacyMigrationExclusionOptions {
  return {
    sourceBoundaryPath: fixture.boundary,
    mutablePaths: [
      { relativePath: "caplets", kind: "directory" },
      { relativePath: "state.json", kind: "file" },
    ],
    mode: "automatic",
    platform: "linux",
  };
}

async function acquire(
  fixture: Fixture,
  overrides: Partial<AcquireLegacyMigrationExclusionOptions> = {},
): Promise<LegacyMigrationExclusion> {
  return acquireLegacyMigrationExclusion({
    ...baseOptions(fixture),
    mode: "offline",
    platformOptions: {
      linux: {
        procRootForTests: createProcFixture(fixture),
        proof: { kind: "offline", allReplicasStopped: true },
      },
    },
    ...overrides,
  });
}

function createProcFixture(fixture: Fixture, ...pids: number[]): string {
  const procRoot = join(fixture.root, `proc-${Math.random().toString(16).slice(2)}`);
  mkdirSync(procRoot, { recursive: true });
  addProcFixtureProcess(procRoot, process.pid);
  for (const pid of pids) addProcFixtureProcess(procRoot, pid);
  return procRoot;
}

function addProcFixtureProcess(procRoot: string, pid: number): void {
  const processRoot = join(procRoot, String(pid));
  mkdirSync(processRoot, { recursive: true });
  symlinkSync(`/proc/${pid}/fd`, join(processRoot, "fd"));
  symlinkSync(`/proc/${pid}/cwd`, join(processRoot, "cwd"));
  symlinkSync(`/proc/${pid}/root`, join(processRoot, "root"));
  symlinkSync(`/proc/${pid}/exe`, join(processRoot, "exe"));
}

async function crashOfflineSources(
  fixture: RealLayoutCrashFixture,
  phase: "tombstones" | "activation" = "tombstones",
): Promise<void> {
  const crashFixture = join(
    dirname(import.meta.filename),
    "fixtures",
    "exclusion-multiroot-crash.ts",
  );
  const child = spawn(
    "pnpm",
    [
      "exec",
      "tsx",
      crashFixture,
      fixture.root,
      fixture.configRoot,
      JSON.stringify(fixture.sources),
      phase,
    ],
    {
      env: { ...process.env, NODE_ENV: "test" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.push(child);
  const ready = Promise.withResolvers<void>();
  const onData = (chunk: Buffer) => {
    if (!chunk.toString("utf8").includes("READY:")) return;
    child.stdout.off("data", onData);
    ready.resolve();
  };
  child.stdout.on("data", onData);
  child.once("error", ready.reject);
  await ready.promise;
  const exited = Promise.withResolvers<void>();
  child.once("exit", () => exited.resolve());
  child.kill("SIGKILL");
  await exited.promise;
  children.splice(children.indexOf(child), 1);
}

async function crashExclusion(
  fixture: Fixture,
  phase: "relocation" | "activation",
): Promise<string> {
  const crashFixture = join(dirname(import.meta.filename), "fixtures", "exclusion-crash.ts");
  const child = spawn("pnpm", ["exec", "tsx", crashFixture, fixture.boundary, phase], {
    env: { ...process.env, NODE_ENV: "test" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const ready = Promise.withResolvers<string>();
  const onData = (chunk: Buffer) => {
    const match = /READY:(.+)\n/u.exec(chunk.toString("utf8"));
    if (!match?.[1]) return;
    child.stdout.off("data", onData);
    ready.resolve(match[1]);
  };
  child.stdout.on("data", onData);
  child.once("error", ready.reject);
  const sealedPath = await ready.promise;
  const exited = Promise.withResolvers<void>();
  child.once("exit", () => exited.resolve());
  child.kill("SIGKILL");
  await exited.promise;
  children.splice(children.indexOf(child), 1);
  return sealedPath;
}

async function holdPath(mode: "file" | "directory", target: string) {
  const fixturePath = join(dirname(import.meta.filename), "fixtures", "exclusion-holder.mjs");
  const child = spawn(process.execPath, [fixturePath, mode, target], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onData = (chunk: Buffer) => {
    if (chunk.toString("utf8").includes("READY")) {
      child.stdout.off("data", onData);
      resolve();
    }
  };
  child.stdout.on("data", onData);
  child.once("error", reject);
  child.once("exit", (code) => reject(new Error(`exclusion holder exited early: ${code}`)));
  await promise;
  return child;
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  const index = children.indexOf(child);
  if (index >= 0) children.splice(index, 1);
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const { promise, resolve } = Promise.withResolvers<void>();
  child.once("exit", () => resolve());
  await promise;
}
