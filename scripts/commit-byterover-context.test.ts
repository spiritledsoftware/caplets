import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

import {
  buildCommitArgs,
  checkByteRoverStatus,
  formatCheckWarning,
} from "./commit-byterover-context";

test("ByteRover status check reports clean when git returns no .brv changes", () => {
  expect(checkByteRoverStatus("")).toEqual({ hasChanges: false });
});

test("ByteRover status check reports changes from porcelain output", () => {
  expect(checkByteRoverStatus(" M .brv/context.md\n?? .brv/new.md\n")).toEqual({
    hasChanges: true,
  });
});

test("ByteRover check warning is advisory and includes manual commit command", () => {
  expect(formatCheckWarning()).toContain("ByteRover context has uncommitted changes");
  expect(formatCheckWarning()).toContain("pnpm exec tsx ./scripts/commit-byterover-context.ts");
});

test("ByteRover context commits use a conventional docs commit message", () => {
  expect(buildCommitArgs()).toEqual(["commit", "-m", "docs(agents): byterover context"]);
});

test("ByteRover context script has a Node shebang for direct hook execution", async () => {
  const script = await readFile(new URL("./commit-byterover-context.ts", import.meta.url), "utf8");
  expect(script.startsWith("#!/usr/bin/env node\n")).toBe(true);
});
