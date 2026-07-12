import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import corePackage from "../package.json";

const execFile = promisify(execFileCallback);
const coreRoot = resolve(import.meta.dirname, "..");
const optionalProviderPackages = [
  "@aws-sdk/client-s3",
  "better-sqlite3",
  "drizzle-orm",
  "postgres",
] as const;

type PackedFixture = {
  root: string;
  project: string;
};

describe("fresh packed @caplets/core boundaries", () => {
  let fixture: PackedFixture;

  beforeAll(async () => {
    fixture = await installPackedCore();
  }, 180_000);

  afterAll(async () => {
    if (fixture) await rm(fixture.root, { recursive: true, force: true });
  });

  it("imports the root and filesystem entrypoints without evaluating optional providers", async () => {
    const loader = join(fixture.project, "deny-optional-providers.mjs");
    const probe = join(fixture.project, "filesystem-probe.mjs");
    await writeFile(loader, optionalProviderDenyLoader(), "utf8");
    await writeFile(
      probe,
      `import * as core from "@caplets/core";
import { FilesystemCapletSource } from "@caplets/core/caplet-source/filesystem";

if (typeof core.createAsyncCapletsRuntime !== "function") throw new Error("root export missing");
const source = new FilesystemCapletSource(process.cwd());
const files = await source.listFiles();
console.log(JSON.stringify({ files: files.length }));
`,
      "utf8",
    );

    const result = await runNode(fixture.project, ["--loader", loader, probe]);
    expect(result.stdout).toMatch(/"files":\d+/);
  });

  it("resolves every provider dependency from the installed package", async () => {
    const probe = join(fixture.project, "dependency-probe.mjs");
    await writeFile(
      probe,
      `import { createRequire } from "node:module";
const require = createRequire(new URL("./node_modules/@caplets/core/package.json", import.meta.url));
const dependencies = ${JSON.stringify(optionalProviderPackages)};
const resolved = [];
for (const dependency of dependencies) {
  resolved.push([dependency, require.resolve(dependency)]);
}
console.log(JSON.stringify(resolved));
`,
      "utf8",
    );

    const result = await runNode(fixture.project, [probe]);
    const resolved = JSON.parse(result.stdout.trim()) as Array<[string, string]>;
    expect(resolved.map(([dependency]) => dependency)).toEqual([...optionalProviderPackages]);
    for (const [, target] of resolved) expect(target).toContain("node_modules");
  });

  it("declares Node 22+ and runs the boundary probe on installed Node 22/24 binaries", async () => {
    expect(corePackage.engines?.node).toBe(">=22");
    for (const binary of await availableRuntimeBinaries()) {
      const loader = join(fixture.project, `deny-${basenameForBinary(binary)}.mjs`);
      const probe = join(fixture.project, `runtime-${basenameForBinary(binary)}.mjs`);
      await writeFile(loader, optionalProviderDenyLoader(), "utf8");
      await writeFile(
        probe,
        `import { FilesystemCapletSource } from "@caplets/core/caplet-source/filesystem";
const source = new FilesystemCapletSource(process.cwd());
await source.listFiles();
console.log("ok");
`,
        "utf8",
      );
      const result = await runNode(fixture.project, ["--loader", loader, probe], binary);
      expect(result.stdout).toContain("ok");
    }
  });
});

async function installPackedCore(): Promise<PackedFixture> {
  const root = await mkdtemp(join(tmpdir(), "caplets-core-packed-"));
  const packDirectory = join(root, "pack");
  const project = join(root, "consumer");
  await mkdir(packDirectory, { recursive: true });
  await mkdir(project, { recursive: true });

  await execFile("pnpm", ["pack", "--pack-destination", packDirectory], {
    cwd: coreRoot,
    env: {
      ...process.env,
      CI: "true",
      PNPM_PACKAGE_NAME: undefined,
      npm_config_recursive: undefined,
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  const tarballName = (await readdir(packDirectory)).find((entry) => entry.endsWith(".tgz"));
  if (!tarballName) throw new Error("pnpm pack did not produce a tarball");
  const tarball = join(packDirectory, tarballName);

  await writeFile(
    join(project, "package.json"),
    `${JSON.stringify(
      {
        name: "caplets-packed-consumer",
        private: true,
        type: "module",
        dependencies: { "@caplets/core": `file:${tarball}` },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(project, "pnpm-workspace.yaml"),
    "allowBuilds:\n  better-sqlite3: true\n",
    "utf8",
  );
  await execFile("pnpm", ["install", "--no-frozen-lockfile"], {
    cwd: project,
    env: {
      ...process.env,
      CI: "true",
      PNPM_PACKAGE_NAME: undefined,
      npm_config_recursive: undefined,
    },
    maxBuffer: 16 * 1024 * 1024,
  });

  const installedPackage = JSON.parse(
    await readFile(join(project, "node_modules", "@caplets", "core", "package.json"), "utf8"),
  ) as { name?: string };
  if (installedPackage.name !== "@caplets/core") {
    throw new Error("packed install resolved an unexpected package");
  }
  return { root, project };
}

function optionalProviderDenyLoader(): string {
  return `const blocked = /^(?:@aws-sdk\\/client-s3|better-sqlite3|drizzle-orm(?:\\/|$)|postgres)(?:\\/|$)/;
export async function resolve(specifier, context, nextResolve) {
  if (blocked.test(specifier)) throw new Error("optional provider evaluated: " + specifier);
  return nextResolve(specifier, context, nextResolve);
}
`;
}
async function availableRuntimeBinaries(): Promise<string[]> {
  const candidates = [process.env.CAPLETS_NODE_22, process.env.CAPLETS_NODE_24, "node22", "node24"];
  const available: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await execFile(candidate, ["--version"]);
      available.push(candidate);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        continue;
      throw error;
    }
  }
  return available;
}

async function runNode(
  cwd: string,
  args: string[],
  binary = process.execPath,
): Promise<{ stdout: string; stderr: string }> {
  return await execFile(binary, args, {
    cwd,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });
}

function basenameForBinary(binary: string): string {
  return binary.replace(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "") || "node";
}
