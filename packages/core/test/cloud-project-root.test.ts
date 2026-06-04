import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprintProjectRoot, findProjectRoot } from "../src/cloud/project-root";

describe("project root detection", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("finds the nearest .caplets or git root", () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-project-root-"));
    dirs.push(root);
    mkdirSync(join(root, ".caplets"));
    mkdirSync(join(root, "src", "nested"), { recursive: true });

    expect(findProjectRoot(join(root, "src", "nested"))).toBe(root);
  });

  it("creates a stable fingerprint from root path and marker files", () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-project-fingerprint-"));
    dirs.push(root);
    writeFileSync(join(root, "package.json"), '{"name":"demo"}');

    const first = fingerprintProjectRoot(root);
    const second = fingerprintProjectRoot(root);

    expect(first).toMatch(/^sha256:/u);
    expect(second).toBe(first);
  });
});
