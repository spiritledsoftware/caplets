import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli";

describe("Code Mode CLI", () => {
  const originalMode = process.env.CAPLETS_MODE;
  const originalConfigPath = process.env.CAPLETS_CONFIG;
  const originalProjectConfigPath = process.env.CAPLETS_PROJECT_CONFIG;

  beforeEach(() => {
    process.env.CAPLETS_MODE = "local";
    delete process.env.CAPLETS_PROJECT_CONFIG;
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.CAPLETS_MODE;
    } else {
      process.env.CAPLETS_MODE = originalMode;
    }
    if (originalConfigPath === undefined) {
      delete process.env.CAPLETS_CONFIG;
    } else {
      process.env.CAPLETS_CONFIG = originalConfigPath;
    }
    if (originalProjectConfigPath === undefined) {
      delete process.env.CAPLETS_PROJECT_CONFIG;
    } else {
      process.env.CAPLETS_PROJECT_CONFIG = originalProjectConfigPath;
    }
  });

  it("runs inline code and prints the JSON envelope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-cli-"));
    const out: string[] = [];
    try {
      process.env.CAPLETS_CONFIG = writeConfig(dir, {});

      await runCli(["code-mode", "return { ok: true };", "--json"], {
        writeOut: (value) => out.push(value),
      });

      expect(JSON.parse(out.join(""))).toMatchObject({
        ok: true,
        value: { ok: true },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads --file paths relative to the current working directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-cli-"));
    const cwd = process.cwd();
    const out: string[] = [];
    try {
      process.env.CAPLETS_CONFIG = writeConfig(dir, {});
      const project = join(dir, "project");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, "workflow.ts"), "return { source: 'file' };\n");
      process.chdir(project);

      await runCli(["code-mode", "--file", "workflow.ts", "--json"], {
        writeOut: (value) => out.push(value),
      });

      expect(JSON.parse(out.join(""))).toMatchObject({
        ok: true,
        value: { source: "file" },
      });
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads stdin when inline code and file input are absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-cli-"));
    const out: string[] = [];
    try {
      process.env.CAPLETS_CONFIG = writeConfig(dir, {});

      await runCli(["code-mode", "--json"], {
        writeOut: (value) => out.push(value),
        readStdin: async () => "return { source: 'stdin' };",
      });

      expect(JSON.parse(out.join(""))).toMatchObject({
        ok: true,
        value: { source: "stdin" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints generated declaration text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-cli-"));
    const out: string[] = [];
    try {
      process.env.CAPLETS_CONFIG = writeConfig(dir, {
        mcpServers: {
          github: {
            name: "GitHub",
            description: "GitHub repo operations.",
            command: "node",
          },
        },
      });

      await runCli(["code-mode", "types"], {
        writeOut: (value) => out.push(value),
      });

      expect(out.join("")).toContain('github:CapletHandle<"github">;');
      expect(out.join("")).toContain("GitHub repo operations.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints generated declaration metadata as JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-cli-"));
    const out: string[] = [];
    try {
      process.env.CAPLETS_CONFIG = writeConfig(dir, {
        mcpServers: {
          github: {
            name: "GitHub",
            description: "GitHub repo operations.",
            command: "node",
          },
        },
      });

      await runCli(["code-mode", "types", "--json"], {
        writeOut: (value) => out.push(value),
      });

      expect(JSON.parse(out.join(""))).toMatchObject({
        callableCount: 1,
        runtimeScope: "local",
      });
      expect(JSON.parse(out.join("")).declarationHash).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function writeConfig(dir: string, config: Record<string, unknown>): string {
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify(
      Object.keys(config).length > 0
        ? config
        : {
            mcpServers: {
              placeholder: {
                name: "Placeholder",
                description: "Disabled placeholder.",
                command: "node",
                disabled: true,
              },
            },
          },
    ),
  );
  return path;
}
