import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initConfig, runCli, starterConfig } from "../src/cli.js";
import { parseConfig } from "../src/config.js";
import { CapletsError } from "../src/errors.js";
import { writeTokenBundle } from "../src/auth.js";

describe("cli init", () => {
  const originalConfigPath = process.env.CAPLETS_CONFIG;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalConfigPath === undefined) {
      delete process.env.CAPLETS_CONFIG;
    } else {
      process.env.CAPLETS_CONFIG = originalConfigPath;
    }
  });

  it("writes a valid starter config and creates parent directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-init-"));
    const path = join(dir, "nested", "config.json");
    try {
      expect(initConfig({ path })).toBe(path);
      expect(existsSync(path)).toBe(true);

      const raw = readFileSync(path, "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      const config = parseConfig(JSON.parse(raw));
      expect(config.mcpServers.example).toMatchObject({
        server: "example",
        name: "Example MCP Server",
        transport: "stdio",
        disabled: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not overwrite existing config unless forced", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-init-"));
    const path = join(dir, "config.json");
    try {
      writeFileSync(path, '{"existing":true}\n');

      expect(() => initConfig({ path })).toThrow(
        expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError,
      );
      expect(readFileSync(path, "utf8")).toBe('{"existing":true}\n');

      initConfig({ path, force: true });
      expect(JSON.parse(readFileSync(path, "utf8"))).toHaveProperty("mcpServers.example");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the starter template parseable", () => {
    expect(() => parseConfig(JSON.parse(starterConfig()))).not.toThrow();
  });

  it("uses CAPLETS_CONFIG when run through the CLI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-init-"));
    const path = join(dir, "custom.json");
    const out: string[] = [];
    try {
      process.env.CAPLETS_CONFIG = path;

      await runCli(["init"], { writeOut: (value) => out.push(value) });

      expect(existsSync(path)).toBe(true);
      expect(out.join("")).toBe(`Created Caplets config at ${path}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported init arguments", async () => {
    await expect(runCli(["init", "--typo"], { writeErr: () => {} })).rejects.toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
    );
  });

  it("rejects the removed auth server alias", async () => {
    await expect(runCli(["auth", "remote"], { writeErr: () => {} })).rejects.toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
    );
  });

  it("lists configured OAuth servers without printing token values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-"));
    const authDir = join(dir, "auth");
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            remote: {
              name: "Remote",
              description: "A useful remote OAuth server.",
              transport: "http",
              url: "https://example.com/mcp",
              auth: { type: "oauth2", clientId: "client" },
            },
            expired: {
              name: "Expired",
              description: "Another useful remote OAuth server.",
              transport: "http",
              url: "https://expired.example.com/mcp",
              auth: { type: "oauth2", clientId: "client" },
            },
            stdio: {
              name: "Stdio",
              description: "A useful local server.",
              command: "node",
            },
          },
        }),
      );
      process.env.CAPLETS_CONFIG = configPath;
      writeTokenBundle(
        {
          server: "remote",
          accessToken: "secret-access-token",
          tokenType: "Bearer",
          expiresAt: "2999-01-01T00:00:00.000Z",
          scope: "mcp:tools",
        },
        authDir,
      );
      writeTokenBundle(
        {
          server: "expired",
          accessToken: "expired-secret-access-token",
          expiresAt: "2000-01-01T00:00:00.000Z",
        },
        authDir,
      );

      await runCli(["auth", "list"], { writeOut: (value) => out.push(value), authDir });

      const text = out.join("");
      expect(text).toContain("remote\tauthenticated\texpires 2999-01-01T00:00:00.000Z");
      expect(text).toContain("expired\texpired\texpires 2000-01-01T00:00:00.000Z");
      expect(text).not.toContain("stdio");
      expect(text).not.toContain("secret-access-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs out configured OAuth servers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-"));
    const authDir = join(dir, "auth");
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            remote: {
              name: "Remote",
              description: "A useful remote OAuth server.",
              transport: "http",
              url: "https://example.com/mcp",
              auth: { type: "oauth2", clientId: "client" },
            },
          },
        }),
      );
      process.env.CAPLETS_CONFIG = configPath;
      writeTokenBundle({ server: "remote", accessToken: "secret-access-token" }, authDir);

      await runCli(["auth", "logout", "remote"], {
        writeOut: (value) => out.push(value),
        authDir,
      });

      expect(out.join("")).toBe("Deleted OAuth credentials for remote\n");
      out.length = 0;

      await runCli(["auth", "logout", "remote"], {
        writeOut: (value) => out.push(value),
        authDir,
      });

      expect(out.join("")).toBe("No OAuth credentials found for remote\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
