import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProjectBoundCwd } from "../src/project-binding/execution-context";

describe("Project Binding execution context", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults project-bound process cwd to the bound project root", () => {
    const root = tempRoot();

    expect(
      resolveProjectBoundCwd({
        caplet: { server: "repo-tools", projectBinding: { required: true } },
        context: contextFor(root),
      }),
    ).toBe(root);
  });

  it("resolves relative project-bound cwd under the bound project root", () => {
    const root = tempRoot();
    mkdirSync(join(root, "tools"));

    expect(
      resolveProjectBoundCwd({
        caplet: { server: "repo-tools", projectBinding: { required: true } },
        configuredCwd: "tools",
        context: contextFor(root),
      }),
    ).toBe(join(root, "tools"));
  });

  it("rejects symlink escapes from the bound project root", () => {
    const root = tempRoot();
    const outside = tempRoot();
    symlinkSync(outside, join(root, "outside-link"));

    expect(() =>
      resolveProjectBoundCwd({
        caplet: { server: "repo-tools", projectBinding: { required: true } },
        configuredCwd: "outside-link",
        context: contextFor(root),
      }),
    ).toThrow("Project Binding cwd escapes bound root");
  });

  it("leaves non-project-bound cwd unchanged", () => {
    expect(
      resolveProjectBoundCwd({
        caplet: { server: "global-tools" },
        configuredCwd: "relative-to-config",
      }),
    ).toBe("relative-to-config");
  });

  function tempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "caplets-project-binding-"));
    dirs.push(dir);
    return dir;
  }

  function contextFor(root: string) {
    return {
      sessionId: "session_1",
      bindingId: "binding_1",
      projectRoot: root,
      projectFingerprint: "sha256:root",
    };
  }
});
