import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const renderConfigPath = fileURLToPath(
  new URL("../../../deploy/postgres/render-config.mjs", import.meta.url),
);

describe("PostgreSQL deployment config", () => {
  it("renders a runtime connection from a file-backed generic role credential", () => {
    const config = renderRuntimeConfig({
      credential: "CAPLETS_POSTGRES_PASSWORD",
      password: "file-backed password",
      user: "caplets",
    });
    const connection = new URL(config.storage.connectionString);
    expect({
      type: config.storage.type,
      username: connection.username,
      password: connection.password,
      hostname: connection.hostname,
      database: connection.pathname,
      schema: config.storage.schema,
    }).toEqual({
      type: "postgres",
      username: "caplets",
      password: "file-backed%20password",
      hostname: "caplets-postgres",
      database: "/caplets",
      schema: "caplets",
    });
  });

  it("renders the hardened runtime role from its secret file", () => {
    const config = renderRuntimeConfig({
      credential: "CAPLETS_POSTGRES_RUNTIME_PASSWORD",
      password: "runtime secret",
    });
    const connection = new URL(config.storage.connectionString);
    expect({
      username: connection.username,
      password: connection.password,
    }).toEqual({
      username: "caplets_runtime",
      password: "runtime%20secret",
    });
  });
});

function renderRuntimeConfig(input: { credential: string; password: string; user?: string }): {
  storage: { connectionString: string; schema: string; type: string };
} {
  const directory = mkdtempSync(join(tmpdir(), "caplets-postgres-config-"));
  const passwordPath = join(directory, "password");
  const configPath = join(directory, "config.json");
  writeFileSync(passwordPath, `${input.password}\n`, { mode: 0o600 });

  try {
    execFileSync(process.execPath, [renderConfigPath, "runtime"], {
      env: {
        CAPLETS_CONFIG: configPath,
        ...(input.user ? { CAPLETS_POSTGRES_USER: input.user } : {}),
        [`${input.credential}_FILE`]: passwordPath,
      },
    });
    return JSON.parse(readFileSync(configPath, "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
