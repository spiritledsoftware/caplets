import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempCwd = mkdtempSync(join(repoRoot, ".tmp-package-runtime-"));

async function main() {
  const versionResult = spawnSync(
    process.execPath,
    [join(repoRoot, "packages/cli/dist/index.js"), "--version"],
    {
      cwd: tempCwd,
      encoding: "utf8",
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
    },
  );

  if (versionResult.status !== 0) {
    process.stderr.write("Built Caplets CLI failed to start with --version.\n");
    if (versionResult.stdout) process.stderr.write(versionResult.stdout);
    if (versionResult.stderr) process.stderr.write(versionResult.stderr);
    process.exit(versionResult.status ?? 1);
  }

  const version = versionResult.stdout.trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(version)) {
    process.stderr.write(
      `Built Caplets CLI printed an invalid version: ${JSON.stringify(version)}\n`,
    );
    process.exit(1);
  }

  const port = await availablePort();
  const child = spawn(
    process.execPath,
    [
      join(repoRoot, "packages/cli/dist/index.js"),
      "serve",
      "--transport",
      "http",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--allow-unauthenticated-http",
    ],
    {
      cwd: tempCwd,
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  try {
    const dashboard = await waitForResponse(`http://127.0.0.1:${port}/dashboard`);
    const dashboardHtml = await dashboard.text();
    if (dashboardHtml.includes("Dashboard assets have not been built yet")) {
      process.stderr.write("Packaged dashboard still falls back to the build-missing shell.\n");
      process.exit(1);
    }

    const icon = await fetch(`http://127.0.0.1:${port}/dashboard/favicon.png`);
    if (!icon.ok || icon.headers.get("content-type") !== "image/png") {
      process.stderr.write(
        "Packaged dashboard favicon is missing or has the wrong content type.\n",
      );
      process.exit(1);
    }
  } catch (error) {
    process.stderr.write("Built Caplets CLI failed dashboard runtime smoke check.\n");
    if (stdout) process.stderr.write(stdout);
    if (stderr) process.stderr.write(stderr);
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
}

await main().finally(() => {
  rmSync(tempCwd, { recursive: true, force: true });
});

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not determine runtime-check port.")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForResponse(url) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // retry until deadline
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
