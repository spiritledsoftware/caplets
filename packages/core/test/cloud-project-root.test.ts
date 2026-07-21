import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findProjectRoot } from "../src/cloud/project-root";

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
});
