import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version as packageJsonVersion } from "../package.json";
import { initConfig, installCaplets, normalizeGitRepo, runCli, starterConfig } from "../src/cli.js";
import { parseConfig, TRUST_PROJECT_CAPLETS_ENV } from "../src/config.js";
import { CapletsError } from "../src/errors.js";
import { writeTokenBundle } from "../src/auth.js";

describe("cli init", () => {
  const originalConfigPath = process.env.CAPLETS_CONFIG;
  const originalTrustProjectCaplets = process.env[TRUST_PROJECT_CAPLETS_ENV];

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalConfigPath === undefined) {
      delete process.env.CAPLETS_CONFIG;
    } else {
      process.env.CAPLETS_CONFIG = originalConfigPath;
    }
    if (originalTrustProjectCaplets === undefined) {
      delete process.env[TRUST_PROJECT_CAPLETS_ENV];
    } else {
      process.env[TRUST_PROJECT_CAPLETS_ENV] = originalTrustProjectCaplets;
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

  it("prints the package version", async () => {
    const out: string[] = [];

    await runCli(["--version"], { writeOut: (value) => out.push(value) });

    expect(out.join("")).toBe(`${packageJsonVersion}\n`);
  });

  it("lists enabled Caplets by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-list-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeInspectionConfig(configPath);
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["list"], { writeOut: (value) => out.push(value) });

      const text = out.join("");
      expect(text).toContain("server");
      expect(text).toContain("filesystem");
      expect(text).toContain("mcp");
      expect(text).toContain("not_started");
      expect(text).toContain("Project Files");
      expect(text).toContain("users");
      expect(text).toContain("openapi");
      expect(text).toContain("catalog");
      expect(text).toContain("graphql");
      expect(text).not.toContain("disabled_remote");
      expect(text).not.toContain("secret-access-token");
      expect(text).not.toContain("openapi-client");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("can include disabled Caplets in the list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-list-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeInspectionConfig(configPath);
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["list", "--all"], { writeOut: (value) => out.push(value) });

      const text = out.join("");
      expect(text).toContain("disabled_remote");
      expect(text).toContain("disabled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints listed Caplets as JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-list-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeInspectionConfig(configPath);
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["list", "--json"], { writeOut: (value) => out.push(value) });

      const rows = JSON.parse(out.join("")) as Array<{
        server: string;
        backend: string;
        name: string;
        description: string;
        disabled: boolean;
        status: string;
      }>;
      expect(rows).toEqual([
        expect.objectContaining({
          server: "catalog",
          backend: "graphql",
          disabled: false,
          status: "not_started",
        }),
        expect.objectContaining({
          server: "filesystem",
          backend: "mcp",
          disabled: false,
          status: "not_started",
        }),
        expect.objectContaining({
          server: "users",
          backend: "openapi",
          disabled: false,
          status: "not_started",
        }),
      ]);
      expect(out.join("")).not.toContain("secret-access-token");
      expect(out.join("")).not.toContain("openapi-client");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints the effective config path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-config-path-"));
    const configPath = join(dir, "custom.json");
    const out: string[] = [];
    try {
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["config", "path"], { writeOut: (value) => out.push(value) });

      expect(out.join("")).toBe(`${configPath}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints resolved config paths as JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-config-paths-"));
    const configPath = join(dir, "custom.json");
    const authDir = join(dir, "auth");
    const out: string[] = [];
    try {
      process.env.CAPLETS_CONFIG = configPath;
      process.env[TRUST_PROJECT_CAPLETS_ENV] = "yes";

      await runCli(["config", "paths", "--json"], {
        writeOut: (value) => out.push(value),
        authDir,
      });

      expect(JSON.parse(out.join(""))).toEqual({
        userConfig: configPath,
        projectConfig: join(process.cwd(), ".caplets", "config.json"),
        userRoot: dir,
        projectRoot: join(process.cwd(), ".caplets"),
        authDir,
        envConfig: configPath,
        projectCapletsTrusted: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs all Caplets from a local repo caplets directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-"));
    const repo = join(dir, "repo");
    const configPath = join(dir, "user", "config.json");
    const out: string[] = [];
    try {
      writeInstallableRepo(repo);
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["install", repo], { writeOut: (value) => out.push(value) });

      expect(readFileSync(join(dir, "user", "filesystem.md"), "utf8")).toContain(
        "name: Project Files",
      );
      expect(readFileSync(join(dir, "user", "github", "CAPLET.md"), "utf8")).toContain(
        "name: GitHub",
      );
      expect(out.join("")).toContain("Installed filesystem");
      expect(out.join("")).toContain("Installed github");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs selected Caplets from a local repo caplets directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-"));
    const repo = join(dir, "repo");
    const configPath = join(dir, "user", "config.json");
    const out: string[] = [];
    try {
      writeInstallableRepo(repo);
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["install", repo, "github"], { writeOut: (value) => out.push(value) });

      expect(existsSync(join(dir, "user", "github", "CAPLET.md"))).toBe(true);
      expect(existsSync(join(dir, "user", "filesystem.md"))).toBe(false);
      expect(out.join("")).toBe(`Installed github to ${join(dir, "user", "github")}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs a selected Caplet when an unrelated Caplet is invalid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-"));
    const repo = join(dir, "repo");
    const configPath = join(dir, "user", "config.json");
    try {
      writeInstallableRepo(repo);
      writeFileSync(join(repo, "caplets", "broken.md"), "not frontmatter\n");
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["install", repo, "github"], { writeOut: () => {} });

      expect(existsSync(join(dir, "user", "github", "CAPLET.md"))).toBe(true);
      expect(existsSync(join(dir, "user", "broken.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite installed Caplets without force", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-"));
    const repo = join(dir, "repo");
    const configPath = join(dir, "user", "config.json");
    try {
      writeInstallableRepo(repo);
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["install", repo, "github"], { writeOut: () => {} });

      await expect(runCli(["install", repo, "github"], { writeOut: () => {} })).rejects.toThrow(
        expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError,
      );

      await runCli(["install", repo, "github", "--force"], { writeOut: () => {} });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preflights selected installs before copying any Caplets", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-"));
    const repo = join(dir, "repo");
    const destinationRoot = join(dir, "user");
    try {
      writeInstallableRepo(repo);
      mkdirSync(join(destinationRoot, "github"), { recursive: true });
      writeFileSync(join(destinationRoot, "github", "CAPLET.md"), "existing\n");

      expect(() => installCaplets(repo, { destinationRoot })).toThrow(
        expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError,
      );

      expect(existsSync(join(destinationRoot, "filesystem.md"))).toBe(false);
      expect(readFileSync(join(destinationRoot, "github", "CAPLET.md"), "utf8")).toBe("existing\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns stable install source identifiers", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-"));
    const repo = join(dir, "repo");
    const destinationRoot = join(dir, "user");
    try {
      writeInstallableRepo(repo);

      const result = installCaplets(repo, { capletIds: ["github"], destinationRoot });

      expect(result.installed).toEqual([
        {
          id: "github",
          source: `${repo}#caplets/github`,
          destination: join(destinationRoot, "github"),
          kind: "directory",
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects selected Caplets that are not in the repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-"));
    const repo = join(dir, "repo");
    const configPath = join(dir, "user", "config.json");
    try {
      writeInstallableRepo(repo);
      process.env.CAPLETS_CONFIG = configPath;

      await expect(runCli(["install", repo, "missing"], { writeOut: () => {} })).rejects.toThrow(
        expect.objectContaining({ code: "CONFIG_NOT_FOUND" }) as CapletsError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes GitHub shorthand repos without double appending git suffixes", () => {
    expect(normalizeGitRepo("spiritledsoftware/caplets")).toBe(
      "https://github.com/spiritledsoftware/caplets.git",
    );
    expect(normalizeGitRepo("spiritledsoftware/caplets.git")).toBe(
      "https://github.com/spiritledsoftware/caplets.git",
    );
    expect(normalizeGitRepo("https://github.com/spiritledsoftware/caplets.git")).toBe(
      "https://github.com/spiritledsoftware/caplets.git",
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
          openapiEndpoints: {
            users: {
              name: "Users API",
              description: "Manage users through the internal HTTP API.",
              specPath: "/tmp/users-openapi.json",
              auth: { type: "oauth2", clientId: "openapi-client" },
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
      expect(text).toContain("users\tmissing");
      expect(text).not.toContain("stdio");
      expect(text).not.toContain("secret-access-token");
      expect(text).not.toContain("openapi-client");
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

  it("logs out configured OpenAPI OAuth endpoints", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-"));
    const authDir = join(dir, "auth");
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          openapiEndpoints: {
            users: {
              name: "Users API",
              description: "Manage users through the internal HTTP API.",
              specPath: "/tmp/users-openapi.json",
              auth: { type: "oidc", issuer: "https://issuer.example" },
            },
          },
        }),
      );
      process.env.CAPLETS_CONFIG = configPath;
      writeTokenBundle({ server: "users", accessToken: "secret-access-token" }, authDir);

      await runCli(["auth", "logout", "users"], {
        writeOut: (value) => out.push(value),
        authDir,
      });

      expect(out.join("")).toBe("Deleted OAuth credentials for users\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function writeInspectionConfig(path: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: {
        filesystem: {
          name: "Project Files",
          description: "Read and search local project files.",
          command: "node",
          env: {
            TOKEN: "secret-access-token",
          },
        },
        disabled_remote: {
          name: "Disabled Remote",
          description: "A disabled remote server for testing.",
          transport: "http",
          url: "https://disabled.example.com/mcp",
          disabled: true,
        },
      },
      openapiEndpoints: {
        users: {
          name: "Users API",
          description: "Manage users through the internal HTTP API.",
          specPath: "/tmp/users-openapi.json",
          auth: { type: "oauth2", clientId: "openapi-client" },
        },
      },
      graphqlEndpoints: {
        catalog: {
          name: "Catalog GraphQL",
          description: "Query and update catalog data through GraphQL.",
          endpointUrl: "https://api.example.com/graphql",
          schemaPath: "/tmp/catalog.graphql",
          auth: { type: "none" },
        },
      },
    }),
  );
}

function writeInstallableRepo(repo: string): void {
  const root = join(repo, "caplets");
  mkdirSync(join(root, "github"), { recursive: true });
  writeFileSync(
    join(root, "filesystem.md"),
    [
      "---",
      "name: Project Files",
      "description: Read and search local project files.",
      "mcpServer:",
      "  command: npx",
      "  args:",
      "    - -y",
      "    - '@modelcontextprotocol/server-filesystem'",
      "    - .",
      "---",
      "# Project Files",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "github", "CAPLET.md"),
    [
      "---",
      "name: GitHub",
      "description: Work with GitHub repositories and pull requests.",
      "mcpServer:",
      "  command: npx",
      "  args:",
      "    - -y",
      "    - github-mcp-server",
      "---",
      "# GitHub",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "github", "README.md"),
    "Extra files are copied with directory Caplets.\n",
  );
}
