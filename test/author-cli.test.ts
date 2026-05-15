import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authorCliCaplet } from "../src/cli/author.js";
import {
  addCliCaplet,
  addGraphqlCaplet,
  addHttpCaplet,
  addMcpCaplet,
  addOpenApiCaplet,
} from "../src/cli/add.js";
import { validateCapletFile } from "../src/caplet-files.js";
import { CapletsError } from "../src/errors.js";

describe("CLI Caplet authoring", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generates a valid repo workflow Caplet to stdout text", () => {
    const repo = tempRepo({
      packageManager: "pnpm@11.0.9",
      scripts: { test: "vitest run", lint: "oxlint ." },
    });

    const result = authorCliCaplet("repo-tools", { repo, include: "git,package" });

    expect(result.path).toBeUndefined();
    expect(result.text).toContain("cliTools:");
    expect(result.text).toContain("git_status:");
    expect(result.text).toContain("package_test:");
    expect(result.text).toContain("readOnlyHint: false");
    const path = join(repo, "CAPLET.md");
    writeFileSync(path, result.text);
    expect(() => validateCapletFile(path)).not.toThrow();
  });

  it("writes generated Caplets to an explicit output path", () => {
    const repo = tempRepo({ scripts: { build: "tsc" } });
    const output = join(repo, "repo-tools.md");

    const result = authorCliCaplet("repo-tools", { repo, include: "package", output });

    expect(result.path).toBe(output);
    expect(existsSync(output)).toBe(true);
    expect(readFileSync(output, "utf8")).toContain("package_build:");
  });

  it("supports git and gh single command templates", () => {
    const repo = tempRepo({ scripts: { test: "vitest run" } });

    const git = authorCliCaplet("git-tools", { repo, command: "git" }).text;
    expect(git).toContain("git_current_branch:");
    expect(git).not.toContain("package_test:");
    expect(authorCliCaplet("gh-tools", { repo, command: "gh", include: "" }).text).toContain(
      "gh_pr_status:",
    );
  });

  it("adds generated CLI Caplets to the project root by default", () => {
    const repo = tempRepo({ scripts: { test: "vitest run" } });
    const project = mkdtempSync(join(tmpdir(), "caplets-add-project-"));
    dirs.push(project);

    const result = addCliCaplet("repo-tools", {
      repo,
      include: "package",
      destinationRoot: join(project, ".caplets"),
    });

    const output = join(project, ".caplets", "repo-tools.md");
    expect(result.path).toBe(output);
    expect(readFileSync(output, "utf8")).toContain("package_test:");
    expect(() => validateCapletFile(output)).not.toThrow();
  });

  it("adds generated CLI Caplets to an explicit output path", () => {
    const repo = tempRepo({ scripts: { build: "tsc" } });
    const output = join(repo, "nested", "repo-tools.md");

    const result = addCliCaplet("repo-tools", {
      repo,
      include: "package",
      output,
      destinationRoot: join(repo, ".caplets"),
    });

    expect(result.path).toBe(output);
    expect(readFileSync(output, "utf8")).toContain("package_build:");
  });

  it("rejects explicit output paths that are directories even with force", () => {
    const repo = tempRepo({ scripts: { build: "tsc" } });
    const output = join(repo, "nested");
    mkdirSync(output, { recursive: true });

    expect(() =>
      addCliCaplet("repo-tools", {
        repo,
        include: "package",
        output,
        destinationRoot: join(repo, ".caplets"),
        force: true,
      }),
    ).toThrow(expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError);
  });

  it("prints generated CLI Caplets without writing", () => {
    const repo = tempRepo({ scripts: { test: "vitest run" } });

    const result = addCliCaplet("repo-tools", {
      repo,
      include: "package",
      print: true,
      destinationRoot: join(repo, ".caplets"),
    });

    expect(result.path).toBeUndefined();
    expect(result.text).toContain("package_test:");
    expect(existsSync(join(repo, ".caplets", "repo-tools.md"))).toBe(false);
  });

  it("refuses to overwrite added CLI Caplets unless forced", () => {
    const repo = tempRepo({ scripts: { test: "vitest run" } });
    const destinationRoot = join(repo, ".caplets");

    addCliCaplet("repo-tools", { repo, include: "package", destinationRoot });

    expect(() => addCliCaplet("repo-tools", { repo, include: "package", destinationRoot })).toThrow(
      expect.objectContaining({ code: "CONFIG_EXISTS" }),
    );
    expect(() =>
      addCliCaplet("repo-tools", { repo, include: "package", destinationRoot, force: true }),
    ).not.toThrow();
  });

  it("refuses default file output when a directory Caplet exists for the same ID", () => {
    const repo = tempRepo({ scripts: { test: "vitest run" } });
    const destinationRoot = join(repo, ".caplets");
    mkdirSync(join(destinationRoot, "repo-tools"), { recursive: true });
    writeFileSync(join(destinationRoot, "repo-tools", "CAPLET.md"), "existing");

    expect(() =>
      addCliCaplet("repo-tools", {
        repo,
        include: "package",
        destinationRoot,
        force: true,
      }),
    ).toThrow(expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError);
  });

  it("rejects invalid Caplet IDs before writing default destinations", () => {
    const repo = tempRepo({ scripts: { test: "vitest run" } });
    const project = mkdtempSync(join(tmpdir(), "caplets-add-invalid-"));
    dirs.push(project);

    expect(() =>
      addCliCaplet("bad name", {
        repo,
        include: "package",
        destinationRoot: join(project, ".caplets"),
      }),
    ).toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
    expect(() =>
      addCliCaplet("../escape", {
        repo,
        include: "package",
        destinationRoot: join(project, ".caplets"),
      }),
    ).toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
    expect(existsSync(join(project, ".caplets"))).toBe(false);
  });

  it("generates valid MCP Caplets for stdio and remote servers", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-mcp-"));
    dirs.push(dir);

    const stdio = addMcpCaplet("local-tools", {
      command: "node",
      arg: ["server.js", "--verbose"],
      cwd: dir,
      env: ["API_TOKEN=dev"],
      print: true,
      destinationRoot: join(dir, ".caplets"),
    });
    const remote = addMcpCaplet("remote-tools", {
      url: "https://mcp.example.com/mcp",
      transport: "http",
      tokenEnv: "MCP_TOKEN",
      print: true,
      destinationRoot: join(dir, ".caplets"),
    });

    expect(stdio.text).toContain('command: "node"');
    expect(stdio.text).toContain('- "server.js"');
    expect(stdio.text).toContain('API_TOKEN: "dev"');
    expect(remote.text).toContain('url: "https://mcp.example.com/mcp"');
    expect(remote.text).toContain('token: "$env:MCP_TOKEN"');
    expect(remote.text).not.toContain("Bearer");
  });

  it("generates valid OpenAPI, GraphQL, and HTTP Caplets", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-backends-"));
    dirs.push(dir);

    const openapi = addOpenApiCaplet("petstore", {
      spec: "https://api.example.com/openapi.json",
      baseUrl: "https://api.example.com/v1",
      tokenEnv: "PETSTORE_TOKEN",
      print: true,
      destinationRoot: join(dir, ".caplets"),
    });
    const graphql = addGraphqlCaplet("catalog", {
      endpointUrl: "https://api.example.com/graphql",
      schema: "./schema.graphql",
      print: true,
      destinationRoot: join(dir, ".caplets"),
    });
    const http = addHttpCaplet("status-api", {
      baseUrl: "https://api.example.com",
      action: ["get_status:GET:/status", "restart:POST:/restart"],
      print: true,
      destinationRoot: join(dir, ".caplets"),
    });

    expect(openapi.text).toContain("openapiEndpoint:");
    expect(openapi.text).toContain('specUrl: "https://api.example.com/openapi.json"');
    expect(openapi.text).toContain('token: "$env:PETSTORE_TOKEN"');
    expect(graphql.text).toContain("graphqlEndpoint:");
    expect(graphql.text).toContain(`schemaPath: ${JSON.stringify(resolve("./schema.graphql"))}`);
    expect(http.text).toContain("httpApi:");
    expect(http.text).toContain("get_status:");
    expect(http.text).toContain('method: "GET"');
  });

  it("rejects invalid generated backend shapes", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-invalid-shapes-"));
    dirs.push(dir);
    const destinationRoot = join(dir, ".caplets");

    expect(() =>
      addMcpCaplet("bad-mcp", {
        command: "node",
        url: "https://mcp.example.com/mcp",
        transport: "http",
        print: true,
        destinationRoot,
      }),
    ).toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
    expect(() =>
      addHttpCaplet("bad-http", {
        baseUrl: "https://api.example.com",
        action: ["missing-parts"],
        print: true,
        destinationRoot,
      }),
    ).toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
    expect(() =>
      addHttpCaplet("duplicate-http", {
        baseUrl: "https://api.example.com",
        action: ["get_status:GET:/status", "get_status:POST:/status"],
        print: true,
        destinationRoot,
      }),
    ).toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
    expect(() =>
      addGraphqlCaplet("bad-graphql", {
        endpointUrl: "https://api.example.com/graphql",
        schema: "./schema.graphql",
        introspection: true,
        print: true,
        destinationRoot,
      }),
    ).toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
  });

  it("refuses to overwrite added non-CLI Caplets unless forced", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-backend-overwrite-"));
    dirs.push(dir);
    const destinationRoot = join(dir, ".caplets");

    addHttpCaplet("status-api", {
      baseUrl: "https://api.example.com",
      action: ["get_status:GET:/status"],
      destinationRoot,
    });

    expect(() =>
      addHttpCaplet("status-api", {
        baseUrl: "https://api.example.com",
        action: ["get_status:GET:/status"],
        destinationRoot,
      }),
    ).toThrow(expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError);
    expect(() =>
      addHttpCaplet("status-api", {
        baseUrl: "https://api.example.com",
        action: ["get_status:GET:/status"],
        destinationRoot,
        force: true,
      }),
    ).not.toThrow();
  });

  function tempRepo(packageJson: { packageManager?: string; scripts?: Record<string, string> }) {
    const dir = mkdtempSync(join(tmpdir(), "caplets-author-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "fixture",
          ...packageJson,
        },
        null,
        2,
      ),
    );
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    return dir;
  }
});
