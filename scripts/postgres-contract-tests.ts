import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreTestRoot = resolve(repositoryRoot, "packages/core/test");
const postgresUrlVariable = "CAPLETS_TEST_POSTGRES_URL";
const requirePostgresVariable = "CAPLETS_REQUIRE_TEST_POSTGRES";

async function testFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await testFiles(path)));
    else if (entry.isFile() && /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(entry.name)) files.push(path);
  }
  return files;
}

export async function findPostgresContractTests(): Promise<string[]> {
  const contracts: string[] = [];
  for (const path of await testFiles(coreTestRoot)) {
    const source = await readFile(path, "utf8");
    if (!source.includes(postgresUrlVariable)) continue;
    contracts.push(`test/${relative(coreTestRoot, path).split(sep).join("/")}`);
  }
  if (contracts.length === 0) {
    throw new Error(`No tests gated by ${postgresUrlVariable} were found.`);
  }
  return contracts;
}

export async function checkPostgresContractTests(): Promise<string[]> {
  const contracts = await findPostgresContractTests();
  const missingRequireGuard: string[] = [];
  for (const contract of contracts) {
    const source = await readFile(resolve(coreTestRoot, contract.slice("test/".length)), "utf8");
    if (!source.includes(requirePostgresVariable)) missingRequireGuard.push(contract);
  }
  if (missingRequireGuard.length > 0) {
    throw new Error(
      `PostgreSQL contract tests missing ${requirePostgresVariable} guards:\n${missingRequireGuard.join("\n")}`,
    );
  }
  return contracts;
}

function printContracts(contracts: string[]): void {
  process.stdout.write(`${contracts.join("\n")}\n`);
}

function runContracts(contracts: string[]): void {
  if (process.env[requirePostgresVariable] !== "1") {
    throw new Error(`${requirePostgresVariable}=1 is required to run PostgreSQL contracts.`);
  }
  if (!process.env[postgresUrlVariable]) {
    throw new Error(`${postgresUrlVariable} is required to run PostgreSQL contracts.`);
  }

  const result = spawnSync("pnpm", ["--filter", "@caplets/core", "test", ...contracts], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`PostgreSQL contract tests terminated by ${result.signal}.`);
  process.exitCode = result.status ?? 1;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const [mode, ...extraArguments] = process.argv.slice(2);
  if (extraArguments.length > 0 || (mode && mode !== "--check" && mode !== "--list")) {
    throw new Error("Usage: tsx scripts/postgres-contract-tests.ts [--check|--list]");
  }
  const contracts = await checkPostgresContractTests();
  if (mode === "--check") {
    process.stdout.write(
      `Selected ${contracts.length} PostgreSQL contract test files; every file has a fail-closed guard.\n`,
    );
    printContracts(contracts);
  } else if (mode === "--list") {
    printContracts(contracts);
  } else {
    runContracts(contracts);
  }
}
