import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const PRIOR_VERSION = "0.25.10";
const [priorBin] = process.argv.slice(2);
if (!priorBin) throw new Error("prior Caplets executable is required");

const temporaryRoot =
  process.platform === "win32" ? (process.env.RUNNER_TEMP ?? process.cwd()) : tmpdir();
const root = realpathSync(mkdtempSync(join(temporaryRoot, "caplets-prior-package-")));
let publishedDaemon;
try {
  chmodSync(root, 0o700);
  const home = join(root, "home");
  const configBase = join(home, ".config");
  const stateBase = join(home, ".local", "state");
  const configRoot = join(configBase, "caplets");
  const stateRoot = join(stateBase, "caplets");
  const projectRoot = join(root, "project");
  const sourceRoot = join(root, "source");
  const trackedCaplet = join(configRoot, "tracked.md");
  const lockfile = join(stateRoot, "caplets.lock.json");
  const authState = join(stateRoot, "auth");
  const daemonConfig =
    process.platform === "win32"
      ? join(configBase, "Caplets", "daemon", "default.json")
      : join(configRoot, "daemon", "default.json");
  const port = 40_000 + (randomBytes(2).readUInt16BE(0) % 20_000);

  mkdirSync(configRoot, { recursive: true, mode: 0o700 });
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  mkdirSync(authState, { recursive: true, mode: 0o700 });
  mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
  mkdirSync(join(sourceRoot, "caplets"), { recursive: true, mode: 0o700 });
  const nativeBin = join(root, "native-bin");
  if (process.platform === "linux") {
    mkdirSync(nativeBin, { recursive: true, mode: 0o700 });
    const systemctl = join(nativeBin, "systemctl");
    writeFileSync(systemctl, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(systemctl, 0o700);
  }
  mkdirSync(join(projectRoot, ".caplets"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(sourceRoot, "caplets", "tracked.md"),
    "---\nname: Tracked\ndescription: Prior package fixture.\nmcpServer:\n  command: node\n---\n# Tracked\n",
    { mode: 0o600 },
  );
  writeFileSync(
    join(configRoot, "config.json"),
    `${JSON.stringify({
      telemetry: false,
      mcpServers: {
        fixture: {
          name: "Fixture",
          description: "Prior published daemon fixture.",
          command: process.execPath,
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(configRoot, "bootstrap.md"),
    "---\nname: Bootstrap\ndescription: Filesystem bootstrap fixture.\nmcpServer:\n  command: node\n---\n# Bootstrap\n",
    { mode: 0o600 },
  );
  writeFileSync(
    join(projectRoot, ".caplets", "project.md"),
    "---\nname: Project\ndescription: Project filesystem fixture.\nmcpServer:\n  command: node\n---\n# Project\n",
    { mode: 0o600 },
  );
  writeFileSync(join(projectRoot, ".caplets.lock.json"), '{"version":1}\n', { mode: 0o600 });

  const env = {
    ...process.env,
    PATH: `${process.platform === "linux" ? `${nativeBin}${delimiter}` : ""}${dirname(priorBin)}${delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: configBase,
    XDG_STATE_HOME: stateBase,
    APPDATA: configBase,
    LOCALAPPDATA: stateBase,
    CAPLETS_CONFIG: join(configRoot, "config.json"),
    CAPLETS_DISABLE_TELEMETRY: "1",
    CAPLETS_DISABLE_CATALOG_INDEXING: "1",
    CI: "1",
  };
  const globalCliArgs = ["install", sourceRoot, "tracked", "--global", "--json"];
  const daemonInstallArgs = [
    "daemon",
    "install",
    "--reset",
    "--no-validate",
    "--no-restart",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--json",
  ];

  requireSuccessfulControl(runPrior(globalCliArgs, env, projectRoot), "global CLI");
  const daemonControl = runPrior(
    process.platform === "win32" ? [...daemonInstallArgs, "--dry-run"] : daemonInstallArgs,
    env,
    projectRoot,
  );
  requireSuccessfulControl(daemonControl, "daemon install");
  const daemon =
    process.platform === "win32"
      ? JSON.parse(daemonControl.output.trim()).config
      : JSON.parse(readFileSync(daemonConfig, "utf8"));
  if (process.platform === "win32") {
    mkdirSync(dirname(daemonConfig), { recursive: true, mode: 0o700 });
    writeFileSync(daemonConfig, `${JSON.stringify(daemon)}\n`, { mode: 0o600 });
  }
  if (
    !daemon?.command ||
    typeof daemon.command.executable !== "string" ||
    !Array.isArray(daemon.command.args) ||
    typeof daemon.command.workingDirectory !== "string" ||
    !daemon.command.env ||
    typeof daemon.command.env !== "object"
  ) {
    throw new Error("published daemon install did not persist a runnable command descriptor");
  }
  const descriptorExecutable =
    process.platform === "win32" && /(?:^|[\\/])node(?:\.exe)?$/iu.test(daemon.command.executable)
      ? process.execPath
      : daemon.command.executable;
  const serveArgument = daemon.command.args.indexOf("serve");
  if (serveArgument < 0) {
    throw new Error("published daemon descriptor did not contain the serve command");
  }
  const descriptorVersion = runPriorUsing(
    descriptorExecutable,
    [...daemon.command.args.slice(0, serveArgument), "--version"],
    env,
    projectRoot,
  );
  if (descriptorVersion.status !== 0 || !hasPriorVersion(descriptorVersion.output)) {
    throw new Error("published daemon descriptor did not resolve to caplets@0.25.10");
  }
  const daemonEnv =
    process.platform === "win32"
      ? { ...daemon.command.env, ...env }
      : { ...env, ...daemon.command.env };
  let daemonPath = "";
  for (const [key, value] of Object.entries(daemonEnv)) {
    if (key.toLowerCase() !== "path") continue;
    daemonPath = String(value);
    delete daemonEnv[key];
  }
  daemonEnv.PATH = `${dirname(process.execPath)}${delimiter}${daemonPath}`;
  publishedDaemon = spawn(descriptorExecutable, daemon.command.args, {
    cwd: daemon.command.workingDirectory,
    env: daemonEnv,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    windowsHide: true,
  });
  const daemonOutput = captureOutput(publishedDaemon);
  await waitForPublishedDaemon(publishedDaemon, port, daemonOutput);

  const mutable = [
    { path: trackedCaplet, kind: "file" },
    { path: lockfile, kind: "file" },
    { path: authState, kind: "directory" },
    { path: daemonConfig, kind: "file" },
  ];
  const sealed = mutable.map((source) => {
    const sealedPath = join(
      dirname(source.path),
      `.caplets-prior-sealed-${randomBytes(18).toString("hex")}`,
    );
    renameSync(source.path, sealedPath);
    if (source.kind === "file") mkdirSync(source.path, { mode: 0o700 });
    else writeFileSync(source.path, "caplets legacy migration tombstone\n", { mode: 0o600 });
    return { ...source, sealedPath };
  });
  const before = sealed.map((source) => hashPath(source.sealedPath));
  const phases = [];
  for (const phase of ["final-verification", "activation"]) {
    await waitForPublishedDaemon(publishedDaemon, port, daemonOutput);
    const globalCli = runPrior(globalCliArgs, env, projectRoot);
    requireTombstoneRefusal(globalCli, phase, "global CLI");
    await waitForPublishedDaemon(publishedDaemon, port, daemonOutput);
    const daemonInstall = runPrior(daemonInstallArgs, env, projectRoot);
    requireTombstoneRefusal(daemonInstall, phase, "daemon install");
    await waitForPublishedDaemon(publishedDaemon, port, daemonOutput);
    const after = sealed.map((source) => hashPath(source.sealedPath));
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error(`relocated bytes changed during ${phase}`);
    }
    for (const source of sealed) {
      const tombstone = lstatSync(source.path);
      if (source.kind === "file" ? !tombstone.isDirectory() : !tombstone.isFile()) {
        throw new Error(`live ${phase} tombstone changed type`);
      }
    }
    phases.push({
      phase,
      globalCliExit: globalCli.status,
      daemonInstallExit: daemonInstall.status,
      publishedDaemonRunning: true,
      relocatedSha256: after,
    });
  }

  await stopPublishedDaemon(publishedDaemon);
  publishedDaemon = undefined;
  for (const source of sealed) rmSync(source.sealedPath, { recursive: true, force: true });
  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      package: "caplets",
      version: PRIOR_VERSION,
      phases,
      successControls: [
        "published-global-cli-exact-command",
        process.platform === "win32"
          ? "published-daemon-install-dry-run-exact-command"
          : "published-daemon-install-exact-command",
        "published-daemon-descriptor-version",
        "published-daemon-health-and-liveness",
      ],
      proofs: [
        "published-global-cli-live-tombstone-refusal",
        "published-daemon-install-live-tombstone-refusal",
        "published-daemon-held-through-final-verification-and-activation",
        "final-verification-exact-rehash",
        "activation-tombstones-retained",
      ],
    })}\n`,
  );
} finally {
  if (publishedDaemon) await stopPublishedDaemon(publishedDaemon);
  rmSync(root, { recursive: true, force: true });
}

function runPrior(args, env, cwd) {
  return runPriorUsing(priorBin, args, env, cwd);
}

function runPriorUsing(executable, args, env, cwd) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 20_000,
    shell: process.platform === "win32",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return {
    status: result.status,
    output,
    unsupported: /unknown (?:command|option)|too many arguments/iu.test(output),
  };
}

function requireSuccessfulControl(result, label) {
  if (result.status !== 0 || result.unsupported) {
    throw new Error(`published ${label} success control failed: ${result.output.trim()}`);
  }
}

function requireTombstoneRefusal(result, phase, label) {
  if (result.status === 0) {
    throw new Error(`prior package unexpectedly mutated through a ${phase} ${label} tombstone`);
  }
  if (result.unsupported) {
    throw new Error(
      `prior package fixture did not execute the expected published ${label} surface`,
    );
  }
  if (
    !/already exists|not a file|not a directory|EISDIR|config|lockfile|caplet/iu.test(result.output)
  ) {
    throw new Error(
      `prior package ${label} failed for an unrelated reason during ${phase}: ${result.output.trim()}`,
    );
  }
}

function hasPriorVersion(output) {
  return new RegExp(`(?:^|\\s)${PRIOR_VERSION.replaceAll(".", "\\.")}(?:\\s|$)`, "u").test(output);
}

function captureOutput(child) {
  let output = "";
  const append = (chunk) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-64 * 1024);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return () => output;
}

async function waitForPublishedDaemon(child, port, output) {
  const deadline = Date.now() + 15_000;
  const url = `http://127.0.0.1:${port}/v1/healthz`;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`published daemon exited before health: ${output()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok && (await response.json())?.status === "ok") return;
    } catch {
      // The published daemon is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`published daemon did not become healthy: ${output()}`);
}

async function stopPublishedDaemon(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function hashPath(path) {
  const hash = createHash("sha256");
  visit(path, ".");
  return hash.digest("hex");

  function visit(current, relativePath) {
    const metadata = lstatSync(current);
    hash.update(`${relativePath}\0${metadata.isDirectory() ? "directory" : "file"}\0`);
    if (metadata.isDirectory()) {
      for (const entry of readdirSync(current).sort()) {
        visit(join(current, entry), join(relativePath, entry));
      }
    } else {
      hash.update(readFileSync(current));
    }
  }
}
