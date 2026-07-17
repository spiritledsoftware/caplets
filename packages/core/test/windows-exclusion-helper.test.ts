import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireLegacyMigrationExclusionWithWindowsArtifactForTests,
  resumeWindowsLegacyMigrationExclusionWithArtifactForTests,
} from "../src/control-plane/migration/exclusion";
import {
  openWindowsExclusionHelper,
  packagedWindowsExclusionHelperManifestPath,
  verifyWindowsExclusionHelperFixture,
} from "../src/control-plane/migration/exclusion/windows";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await stopWindowsChild(child);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("packaged Windows exclusion helper trust", () => {
  it("resolves the published manifest inside dist/native", () => {
    const packageRoot = join(tmpdir(), "installed-caplets-core");
    const bundledModule = pathToFileURL(
      join(packageRoot, "dist", "control-plane", "migration", "exclusion.js"),
    ).href;
    expect(packagedWindowsExclusionHelperManifestPath(bundledModule)).toBe(
      join(packageRoot, "dist", "native", "windows-exclusion-helper", "manifest.json"),
    );
  });
  it("uses the Windows pnpm command shim in package and platform gates", () => {
    const scriptsRoot = join(dirname(import.meta.filename), "..", "..", "..", "scripts");
    for (const script of ["storage-package-check.mjs", "storage-platform-check.mjs"]) {
      const source = readFileSync(join(scriptsRoot, script), "utf8");
      expect(source).toContain('"pnpm.cmd"');
      expect(source).toContain('=== "win32" ?');
    }
  });

  it("accepts only the declared checksum and Authenticode publisher", async () => {
    const fixture = createHelperFixture();
    await expect(
      verifyWindowsExclusionHelperFixture({
        architecture: "x64",
        manifestPath: fixture.manifestPath,
        helperPath: fixture.helperPath,
        signatureInspector: async () => ({ status: "Valid", publisher: fixture.publisher }),
      }),
    ).resolves.toMatchObject({
      architecture: "win32-x64",
      sha256: fixture.sha256,
      publisher: fixture.publisher,
    });
  });

  it("relocates before holding every reviewed object with no sharing and pins link identity", () => {
    const source = readFileSync(
      join(dirname(import.meta.filename), "..", "native", "windows-exclusion-helper", "Program.cs"),
      "utf8",
    );
    expect(source.indexOf("MoveDirectoryDurably(source, sealedPath)")).toBeLessThan(
      source.indexOf("relocatedPaths.Select(path => HeldPath.OpenNoShare"),
    );
    expect(source).toContain(
      "CreateFileW(path.AbsolutePath, GenericRead, 0, IntPtr.Zero, OpenExisting",
    );
    expect(source).toContain('path.Kind == "file" && identity.LinkCount != 1');
    expect(source).toContain("identity.LinkCount != LinkCount");
    expect(source).toContain("var relocatedPaths = EnumerateReviewedPaths(sealedPath)");
    expect(source).toContain("heldTombstones = tombstoneReviewedPaths");
    expect(source).toContain("ValidateTombstoneShape(tombstoneReviewedPaths, mutable)");
    expect(source.indexOf('new ExclusionJournal(1, "prepared"')).toBeLessThan(
      source.indexOf("MoveDirectoryDurably(source, sealedPath)"),
    );
    expect(source).toContain('new ExclusionJournal(1, "activation-cleanup"');
    expect(source).toContain("ReconcileJournal(source, journalPath)");
    expect(source).toContain(
      '"resume" when lease is null && securePath is null => (lease = Lease.Resume(payload)).Describe()',
    );
    expect(source).toContain('new ExclusionJournal(1, "exclusion-durable"');
    expect(source).toContain('journal.Phase != "exclusion-durable"');
    expect(source).toContain("lease?.Dispose();");
    expect(source).not.toContain("try { lease.Rollback(); }");
    expect(source).toContain('"create-directory" when lease is null && securePath is null');
    expect(source).toContain('"hold-path" when lease is null && securePath is null');
    expect(source).toContain("security.AreAccessRulesProtected");
    expect(source).toContain("FileFlagOpenReparsePoint");
    expect(source).toContain("HeldPathChain.OpenDeleteDenied");
  });

  it("rejects absent and checksum-tampered helpers before signature inspection", async () => {
    const fixture = createHelperFixture();
    let inspected = false;
    writeFileSync(fixture.helperPath, "tampered-helper");
    await expect(
      verifyWindowsExclusionHelperFixture({
        architecture: "x64",
        manifestPath: fixture.manifestPath,
        helperPath: fixture.helperPath,
        signatureInspector: async () => {
          inspected = true;
          return { status: "Valid", publisher: fixture.publisher };
        },
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    expect(inspected).toBe(false);

    rmSync(fixture.helperPath);
    await expect(
      verifyWindowsExclusionHelperFixture({
        architecture: "x64",
        manifestPath: fixture.manifestPath,
        helperPath: fixture.helperPath,
        signatureInspector: async () => ({ status: "Valid", publisher: fixture.publisher }),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("rejects unsigned and wrong-publisher helpers even with valid bytes", async () => {
    const fixture = createHelperFixture();
    await expect(
      verifyWindowsExclusionHelperFixture({
        architecture: "x64",
        manifestPath: fixture.manifestPath,
        helperPath: fixture.helperPath,
        signatureInspector: async () => ({ status: "NotSigned" }),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });

    await expect(
      verifyWindowsExclusionHelperFixture({
        architecture: "x64",
        manifestPath: fixture.manifestPath,
        helperPath: fixture.helperPath,
        signatureInspector: async () => ({ status: "Valid", publisher: "CN=Wrong Publisher" }),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("rejects undeclared architectures and non-canonical manifests", async () => {
    const fixture = createHelperFixture();
    await expect(
      verifyWindowsExclusionHelperFixture({
        architecture: "arm64",
        manifestPath: fixture.manifestPath,
        helperPath: fixture.helperPath,
        signatureInspector: async () => ({ status: "Valid", publisher: fixture.publisher }),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });

    writeFileSync(
      fixture.manifestPath,
      JSON.stringify({
        version: 1,
        protocolVersion: 1,
        architectures: {
          "win32-x64": {
            file: "helper.exe",
            sha256: fixture.sha256,
            publisher: fixture.publisher,
            uncheckedFallback: true,
          },
        },
      }),
    );
    await expect(
      verifyWindowsExclusionHelperFixture({
        architecture: "x64",
        manifestPath: fixture.manifestPath,
        helperPath: fixture.helperPath,
        signatureInspector: async () => ({ status: "Valid", publisher: fixture.publisher }),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });
  it("executes the pack and publish guard for valid, absent, unsigned, mismatched, and tampered assets", () => {
    const valid = createPublishFixture("Valid", "CN=Caplets Exclusion Test Publisher");
    expect(runBuildGuard(valid, "--verify-fixture").status).toBe(0);
    if (process.platform !== "win32") {
      expect(runBuildGuard(valid, "--verify-publish").status).toBe(0);
    }
    expect(runBuildGuardFromEnvironment(valid).status).toBe(0);

    const packRoot = join(valid.root, "packed");
    expect(runBuildGuard(valid, "--copy-packaged", ["--dist-root", packRoot]).status).toBe(0);
    expect(existsSync(join(packRoot, "manifest.json"))).toBe(true);
    expect(existsSync(join(packRoot, "caplets-windows-exclusion-helper-win32-x64.exe"))).toBe(true);

    const absent = createPublishFixture("Valid", "CN=Caplets Exclusion Test Publisher");
    rmSync(absent.helperPath);
    expect(runBuildGuard(absent, "--verify-fixture").status).not.toBe(0);

    const absentManifest = createPublishFixture("Valid", "CN=Caplets Exclusion Test Publisher");
    rmSync(absentManifest.manifestPath);
    expect(runBuildGuard(absentManifest, "--verify-fixture").status).not.toBe(0);
    expect(
      runBuildGuard(absentManifest, "--copy-packaged", [], {
        CAPLETS_REQUIRE_WINDOWS_EXCLUSION_HELPER: "1",
      }).status,
    ).not.toBe(0);

    const unsigned = createPublishFixture("NotSigned", "CN=Caplets Exclusion Test Publisher");
    expect(runBuildGuard(unsigned, "--verify-fixture").status).not.toBe(0);

    const wrongPublisher = createPublishFixture("Valid", "CN=Wrong Publisher");
    expect(runBuildGuard(wrongPublisher, "--verify-fixture").status).not.toBe(0);

    const tampered = createPublishFixture("Valid", "CN=Caplets Exclusion Test Publisher");
    writeFileSync(tampered.helperPath, "tampered-after-manifest");
    expect(runBuildGuard(tampered, "--verify-fixture").status).not.toBe(0);
    expect(runBuildGuard(tampered, "--copy-packaged").status).not.toBe(0);
  });

  describe.runIf(
    process.platform === "win32" && Boolean(process.env.CAPLETS_WINDOWS_HELPER_ARTIFACT_ROOT),
  )("Windows exclusion helper integration", () => {
    it("uses real Restart Manager/share-deny handles and restores after a prior process stops", async () => {
      const artifactRoot = process.env.CAPLETS_WINDOWS_HELPER_ARTIFACT_ROOT!;
      const root = mkdtempSync(join(tmpdir(), "caplets-windows-exclusion-"));
      roots.push(root);
      const boundary = join(root, "legacy");
      mkdirSync(join(boundary, "caplets"), { recursive: true });
      writeFileSync(join(boundary, "state.json"), '{"authority":1}\n');
      writeFileSync(join(boundary, "caplets", "demo.md"), "# Demo\n");
      const sid = currentWindowsSid();
      hardenWindowsAcl(root, sid);
      const child = await holdWindowsFile(join(boundary, "state.json"));
      const options = {
        sourceBoundaryPath: boundary,
        mutablePaths: [
          { relativePath: "caplets", kind: "directory" as const },
          { relativePath: "state.json", kind: "file" as const },
        ],
        mode: "offline" as const,
        platform: "win32" as const,
        platformOptions: {
          windows: {
            proof: { kind: "offline" as const, allReplicasStopped: true as const },
            expectedOwnerSid: sid,
            expectedServices: [],
          },
        },
      };
      const acquire = () =>
        acquireLegacyMigrationExclusionWithWindowsArtifactForTests(options, {
          manifestPath: join(artifactRoot, "manifest.json"),
        });

      await expect(acquire()).rejects.toMatchObject({
        code: "REQUEST_INVALID",
      });
      expect(readFileSync(join(boundary, "state.json"), "utf8")).toBe('{"authority":1}\n');
      await stopWindowsChild(child);

      const lease = await acquire();
      await lease.verifyFinalScanAndRehash();
      await lease.rollbackBeforeActivation();
      await lease.release();
      expect(readFileSync(join(boundary, "caplets", "demo.md"), "utf8")).toBe("# Demo\n");
    }, 30_000);

    it("resumes durable exclusion after helper loss and completes cleanup idempotently", async () => {
      const artifactRoot = process.env.CAPLETS_WINDOWS_HELPER_ARTIFACT_ROOT!;
      const root = mkdtempSync(join(tmpdir(), "caplets-windows-resume-"));
      roots.push(root);
      const boundary = join(root, "legacy");
      mkdirSync(join(boundary, "caplets"), { recursive: true });
      writeFileSync(join(boundary, "state.json"), '{"authority":1}\n');
      writeFileSync(join(boundary, "caplets", "demo.md"), "# Demo\n");
      const sid = currentWindowsSid();
      hardenWindowsAcl(root, sid);
      const options = {
        sourceBoundaryPath: boundary,
        mutablePaths: [
          { relativePath: "caplets", kind: "directory" as const },
          { relativePath: "state.json", kind: "file" as const },
        ],
        mode: "offline" as const,
        platform: "win32" as const,
        platformOptions: {
          windows: {
            proof: { kind: "offline" as const, allReplicasStopped: true as const },
            expectedOwnerSid: sid,
            expectedServices: [],
          },
        },
      };
      const artifacts = { manifestPath: join(artifactRoot, "manifest.json") };
      const helper = await openWindowsExclusionHelper({
        options,
        windows: options.platformOptions.windows,
        artifacts,
      });
      const cleanupId = helper.cleanupId;
      const sealedPath = helper.sealedSourcePath;
      await helper.close();
      expect(existsSync(sealedPath)).toBe(true);
      expect(() => readFileSync(join(boundary, "state.json"), "utf8")).toThrow();

      await expect(
        resumeWindowsLegacyMigrationExclusionWithArtifactForTests(
          options,
          `${cleanupId.slice(0, -1)}0`,
          artifacts,
        ),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
      expect(existsSync(sealedPath)).toBe(true);

      const resumed = await resumeWindowsLegacyMigrationExclusionWithArtifactForTests(
        options,
        cleanupId,
        artifacts,
      );
      await resumed.verifyFinalScanAndRehash();
      await resumed.completeActivation({ protectedRecoveryDurable: true });
      await resumed.release();
      expect(existsSync(sealedPath)).toBe(false);

      const repeated = await resumeWindowsLegacyMigrationExclusionWithArtifactForTests(
        options,
        cleanupId,
        artifacts,
      );
      await repeated.completeActivation({ protectedRecoveryDurable: true });
      await repeated.release();
      expect(existsSync(sealedPath)).toBe(false);
    }, 30_000);
  });
});

function createHelperFixture() {
  const root = mkdtempSync(join(tmpdir(), "caplets-windows-helper-"));
  roots.push(root);
  const helperPath = join(root, "helper.exe");
  const manifestPath = join(root, "manifest.json");
  const publisher = "CN=Caplets Exclusion Test Publisher";
  const bytes = Buffer.from("reviewed-helper-fixture\0", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(helperPath, bytes);
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      version: 1,
      protocolVersion: 1,
      architectures: {
        "win32-x64": { file: "helper.exe", sha256, publisher },
      },
    })}\n`,
  );
  return { root, helperPath, manifestPath, publisher, sha256 };
}

type PublishFixture = {
  root: string;
  helperPath: string;
  manifestPath: string;
  signatureEvidence: string;
  publisher: string;
};

function createPublishFixture(status: string, signedPublisher: string): PublishFixture {
  const root = mkdtempSync(join(tmpdir(), "caplets-windows-publish-"));
  roots.push(root);
  const file = "caplets-windows-exclusion-helper-win32-x64.exe";
  const helperPath = join(root, file);
  const manifestPath = join(root, "manifest.json");
  const signatureEvidence = join(root, "signature-evidence.json");
  const publisher = "CN=Caplets Exclusion Test Publisher";
  const bytes = Buffer.from("reviewed-publish-helper-fixture\0", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(helperPath, bytes);
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      version: 1,
      protocolVersion: 1,
      architectures: { "win32-x64": { file, sha256, publisher } },
    })}\n`,
  );
  writeFileSync(
    signatureEvidence,
    `${JSON.stringify({ [file]: { status, publisher: signedPublisher, sha256 } })}\n`,
  );
  return { root, helperPath, manifestPath, signatureEvidence, publisher };
}

function runBuildGuard(
  fixture: PublishFixture,
  action: "--verify-fixture" | "--verify-publish" | "--copy-packaged",
  additionalArgs: string[] = [],
  environment: NodeJS.ProcessEnv = {},
) {
  const script = join(
    dirname(import.meta.filename),
    "..",
    "scripts",
    "build-windows-exclusion-helper.mjs",
  );
  return spawnSync(
    process.execPath,
    [
      script,
      action,
      "--artifact-root",
      fixture.root,
      "--publisher",
      fixture.publisher,
      ...(action === "--verify-fixture" ? ["--signature-evidence", fixture.signatureEvidence] : []),
      ...additionalArgs,
    ],
    { encoding: "utf8", env: { ...process.env, ...environment } },
  );
}

function runBuildGuardFromEnvironment(fixture: PublishFixture) {
  const script = join(
    dirname(import.meta.filename),
    "..",
    "scripts",
    "build-windows-exclusion-helper.mjs",
  );
  return spawnSync(process.execPath, [script, "--verify-publish"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CAPLETS_WINDOWS_HELPER_ARTIFACT_ROOT: fixture.root,
      CAPLETS_WINDOWS_HELPER_PUBLISHER: fixture.publisher,
      CAPLETS_WINDOWS_HELPER_TEST_FIXTURE: "1",
    },
  });
}

function currentWindowsSid(): string {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::Out.Write([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("Windows SID fixture failed.");
  return result.stdout.trim();
}

function hardenWindowsAcl(path: string, sid: string): void {
  const grants = [`*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"];
  const result = spawnSync(
    "icacls.exe",
    [path, "/inheritance:r", "/grant:r", ...grants, "/T", "/C", "/Q"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error("Windows ACL fixture failed.");
}

async function holdWindowsFile(path: string): Promise<ChildProcessWithoutNullStreams> {
  const fixture = join(dirname(import.meta.filename), "fixtures", "exclusion-holder.mjs");
  const child = spawn(process.execPath, [fixture, "file", path], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  child.stdout.on("data", (chunk: Buffer) => {
    if (chunk.toString("utf8").includes("READY")) resolve();
  });
  child.once("error", reject);
  child.once("exit", (code) => reject(new Error(`Windows holder exited early: ${code}`)));
  await promise;
  return child;
}

async function stopWindowsChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  const index = children.indexOf(child);
  if (index >= 0) children.splice(index, 1);
  if (child.exitCode !== null || child.signalCode !== null) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  child.once("exit", () => resolve());
  child.kill();
  await promise;
}
