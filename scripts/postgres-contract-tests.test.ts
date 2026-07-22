import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkPostgresContractTests,
  findPostgresContractTests,
} from "./postgres-contract-tests.ts";

const coreTestRoot = resolve("packages/core/test");

async function allTestFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await allTestFiles(path)));
    else if (entry.isFile() && /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(entry.name)) files.push(path);
  }
  return files;
}

async function independentlyGatedTests(): Promise<string[]> {
  const gated: string[] = [];
  for (const path of await allTestFiles(coreTestRoot)) {
    const source = await readFile(path, "utf8");
    if (!source.includes("CAPLETS_TEST_POSTGRES_URL")) continue;
    gated.push(`test/${relative(coreTestRoot, path).split(sep).join("/")}`);
  }
  return gated.sort();
}

describe("PostgreSQL contract selector", () => {
  it("selects every current test file gated by CAPLETS_TEST_POSTGRES_URL", async () => {
    const expected = await independentlyGatedTests();
    expect(expected.length).toBeGreaterThan(0);
    await expect(findPostgresContractTests()).resolves.toEqual(expected);
  });

  it("requires every selected file to fail closed in PostgreSQL CI", async () => {
    const contracts = await checkPostgresContractTests();
    for (const contract of contracts) {
      const source = await readFile(resolve(coreTestRoot, contract.slice("test/".length)), "utf8");
      expect(source, contract).toContain("CAPLETS_REQUIRE_TEST_POSTGRES");
    }
  });
});
