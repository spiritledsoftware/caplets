import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const PRIOR_PACKAGE_VERSION = "0.25.10";
const platform = process.platform;
const expected = process.env.CAPLETS_STORAGE_PLATFORM_EXPECT;
if (expected && expected !== platform)
  fail("Storage platform gate ran on an unexpected operating system.");
if (!new Set(["linux", "darwin", "win32"]).has(platform)) {
  fail("Storage platform gate does not support this operating system.");
}

const resultDir = resolve(process.env.CAPLETS_STORAGE_RESULT_DIR ?? "storage-results");
mkdirSync(resultDir, { recursive: true });
const pnpm = platform === "win32" ? "pnpm.cmd" : "pnpm";
const focusedTests = [
  "test/control-plane-migration-exclusion.test.ts",
  "test/windows-exclusion-helper.test.ts",
];
const test = spawnSync(
  pnpm,
  ["--filter", "@caplets/core", "exec", "vitest", "run", ...focusedTests],
  { stdio: "inherit", env: process.env, shell: platform === "win32" },
);
if (test.status !== 0) fail("Storage platform focused tests failed.");

const priorPackage = runPriorPackageProof();

let helper;
if (platform === "win32") {
  const artifactRoot = resolve(
    process.env.CAPLETS_WINDOWS_HELPER_ARTIFACT_ROOT ??
      "packages/core/native/windows-exclusion-helper/artifacts",
  );
  const verify = spawnSync(
    process.execPath,
    [
      "packages/core/scripts/build-windows-exclusion-helper.mjs",
      "--verify-publish",
      "--artifact-root",
      artifactRoot,
      "--publisher",
      required(process.env.CAPLETS_WINDOWS_HELPER_PUBLISHER, "Windows helper publisher"),
    ],
    { stdio: "inherit", env: process.env },
  );
  if (verify.status !== 0) fail("Windows helper publish gate failed.");
  const manifestBytes = readFileSync(join(artifactRoot, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  helper = {
    architectures: Object.keys(manifest.architectures),
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    publisher: manifest.architectures["win32-x64"].publisher,
  };
}

const platforms = {
  linux:
    platform === "linux"
      ? {
          status: "passed",
          evidence: [
            "dedicated-boundary-atomic-rename",
            "relocated-file-and-directory-inodes",
            "proc-real-child-open-handle",
            "unsafe-coverage-refusal",
            "offline-replica-stop-required",
            "final-scan-and-rehash",
            ...(priorPackage.status === "passed"
              ? ["caplets-0.25.10-cli-and-daemon-live-tombstones"]
              : []),
            "exact-rollback-before-tombstone-removal",
          ],
        }
      : unavailable("Linux /proc and namespace proofs require a Linux runner."),
  darwin:
    platform === "darwin"
      ? {
          status: "passed",
          evidence: [
            "apple-signed-lsof-whole-host-coverage",
            "real-child-open-handle-refusal-and-offline-success",
            "passwordless-elevated-enumeration",
            ...(priorPackage.status === "passed"
              ? ["caplets-0.25.10-cli-and-daemon-live-tombstones"]
              : []),
          ],
        }
      : unavailable("macOS lsof coverage requires a macOS runner."),
  win32:
    platform === "win32"
      ? {
          status: "passed",
          evidence: [
            "restart-manager-and-share-deny-helper",
            "service-and-owner-sid-verification",
            "authenticode-checksum-publisher",
            "absent-unsigned-mismatched-publish-guard",
            ...(priorPackage.status === "passed"
              ? ["caplets-0.25.10-cli-and-daemon-live-tombstones"]
              : []),
          ],
          helper,
        }
      : unavailable("Windows Restart Manager and Authenticode require a Windows runner."),
};

const result = {
  version: 1,
  platform,
  node: process.version,
  supportedWindowsHelperArchitectures: ["win32-x64"],
  focusedTests,
  priorPackage,
  platforms,
};
validateResult(result);
const path = join(resultDir, `storage-platform-${platform}.json`);
writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ result: path, priorPackage, platforms })}\n`);

function runPriorPackageProof() {
  const executable = process.env.CAPLETS_PRIOR_CAPLETS_BIN;
  const requiredInCi = process.env.CAPLETS_REQUIRE_PRIOR_PACKAGE === "1";
  if (!executable) {
    if (requiredInCi) fail("Pinned prior Caplets package executable is required.");
    return unavailable(
      `Published caplets@${PRIOR_PACKAGE_VERSION} is not installed locally; external proof was not run.`,
    );
  }
  const version = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    env: process.env,
    shell: platform === "win32",
  });
  const versionOutput = `${version.stdout ?? ""}\n${version.stderr ?? ""}`;
  if (
    version.status !== 0 ||
    !new RegExp(`(?:^|\\s)${PRIOR_PACKAGE_VERSION.replaceAll(".", "\\.")}(?:\\s|$)`, "u").test(
      versionOutput,
    )
  ) {
    fail(`Prior package executable is not pinned caplets@${PRIOR_PACKAGE_VERSION}.`);
  }
  const fixture = spawnSync(
    process.execPath,
    ["packages/core/test/fixtures/prior-package-tombstones.mjs", executable],
    { encoding: "utf8", env: process.env },
  );
  if (fixture.status !== 0) {
    if (fixture.stdout) process.stderr.write(fixture.stdout);
    if (fixture.stderr) process.stderr.write(fixture.stderr);
    fail("Published prior package could access or mutate live migration tombstones.");
  }
  const finalLine = fixture.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  let proof;
  try {
    proof = JSON.parse(finalLine ?? "");
  } catch {
    fail("Published prior package fixture returned malformed evidence.");
  }
  if (
    proof?.status !== "passed" ||
    proof.package !== "caplets" ||
    proof.version !== PRIOR_PACKAGE_VERSION ||
    !Array.isArray(proof.phases) ||
    proof.phases.map((phase) => phase.phase).join(",") !== "final-verification,activation" ||
    proof.phases.some(
      (phase) =>
        phase.globalCliExit === 0 ||
        phase.daemonInstallExit === 0 ||
        phase.publishedDaemonRunning !== true,
    ) ||
    !Array.isArray(proof.successControls) ||
    proof.successControls.join(",") !==
      "published-global-cli-exact-command,published-daemon-install-exact-command,published-daemon-descriptor-version,published-daemon-health-and-liveness" ||
    !Array.isArray(proof.proofs) ||
    !proof.proofs.includes("published-daemon-held-through-final-verification-and-activation")
  ) {
    fail("Published prior package fixture evidence is incomplete.");
  }
  return proof;
}

function unavailable(reason) {
  return { status: "unavailable", reason };
}

function validateResult(value) {
  if (value.version !== 1 || value.platforms[value.platform]?.status !== "passed") {
    fail("Storage platform evidence is incomplete for the current operating system.");
  }
  for (const name of ["linux", "darwin", "win32"]) {
    const record = value.platforms[name];
    if (!record || !new Set(["passed", "unavailable"]).has(record.status)) {
      fail("Storage platform evidence contains an invalid status.");
    }
    if (name !== value.platform && record.status !== "unavailable") {
      fail("Storage platform evidence claimed an OS-only proof on the wrong runner.");
    }
  }
}

function required(value, name) {
  if (!value) fail(`${name} is required.`);
  return value;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
