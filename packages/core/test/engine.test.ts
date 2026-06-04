import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapletsEngine } from "../src/engine";

describe("CapletsEngine", () => {
  const dirs: string[] = [];
  const engines: CapletsEngine[] = [];

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => engine.close()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds, updates, and removes enabled Caplets across successful reloads", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: process.execPath,
        },
        beta: {
          name: "Beta",
          description: "Search beta project documents.",
          command: process.execPath,
          disabled: true,
        },
      },
    });
    dirs.push(dir);
    const engine = new CapletsEngine({ configPath, projectConfigPath, watch: false });
    engines.push(engine);
    const events: Array<{ previous: string[]; next: string[]; invalidated: boolean }> = [];
    engine.onReload(({ previous, next, invalidated }) => {
      events.push({
        previous: Object.keys(previous.mcpServers).sort(),
        next: Object.keys(next.mcpServers).sort(),
        invalidated,
      });
    });

    expect(engine.enabledServers().map((caplet) => caplet.server)).toEqual(["alpha"]);

    writeConfig(configPath, {
      mcpServers: {
        alpha: {
          name: "Alpha Reloaded",
          description: "Search alpha project documents after reload.",
          command: process.execPath,
        },
        gamma: {
          name: "Gamma",
          description: "Search gamma project documents.",
          command: process.execPath,
        },
      },
    });

    await expect(engine.reload()).resolves.toBe(true);
    expect(
      engine
        .enabledServers()
        .map((caplet) => caplet.server)
        .sort(),
    ).toEqual(["alpha", "gamma"]);
    expect(engine.enabledServers().find((caplet) => caplet.server === "alpha")?.name).toBe(
      "Alpha Reloaded",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      previous: ["alpha", "beta"],
      next: ["alpha", "gamma"],
      invalidated: true,
    });

    writeConfig(configPath, {
      mcpServers: {
        gamma: {
          name: "Gamma",
          description: "Search gamma project documents.",
          command: process.execPath,
        },
      },
    });

    await expect(engine.reload()).resolves.toBe(true);
    expect(engine.enabledServers().map((caplet) => caplet.server)).toEqual(["gamma"]);
  });

  it("keeps last known-good config when reload validation fails", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: process.execPath,
        },
      },
    });
    dirs.push(dir);
    const errors: string[] = [];
    const engine = new CapletsEngine({
      configPath,
      projectConfigPath,
      watch: false,
      writeErr: (value) => errors.push(value),
    });
    engines.push(engine);
    const listener = vi.fn();
    engine.onReload(listener);

    writeFileSync(configPath, "{ invalid json");

    await expect(engine.reload()).resolves.toBe(false);
    expect(engine.enabledServers().map((caplet) => caplet.server)).toEqual(["alpha"]);
    expect(listener).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("Caplets config reload failed");
  });

  it("continues notifying reload listeners when one listener throws", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: process.execPath,
        },
      },
    });
    dirs.push(dir);
    const errors: string[] = [];
    const engine = new CapletsEngine({
      configPath,
      projectConfigPath,
      watch: false,
      writeErr: (value) => errors.push(value),
    });
    engines.push(engine);
    const secondListener = vi.fn();
    engine.onReload(() => {
      throw new Error("listener boom");
    });
    engine.onReload(secondListener);

    writeConfig(configPath, {
      mcpServers: {
        beta: {
          name: "Beta",
          description: "Search beta project documents.",
          command: process.execPath,
        },
      },
    });

    await expect(engine.reload()).resolves.toBe(true);
    expect(secondListener).toHaveBeenCalledOnce();
    expect(errors.join("")).toContain("Caplets reload listener failed");
    expect(errors.join("")).toContain("listener boom");
  });

  it("runs a follow-up reload when another reload is requested mid-flight", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: process.execPath,
        },
      },
    });
    dirs.push(dir);
    const engine = new CapletsEngine({ configPath, projectConfigPath, watch: false });
    engines.push(engine);
    let calls = 0;

    (engine as unknown as { reloadOnce: () => Promise<boolean> }).reloadOnce = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        void engine.reload();
      }
      return true;
    });

    await engine.reload();
    expect(calls).toBe(2);
  });

  it("watches config and Caplet paths when watch is enabled", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: process.execPath,
        },
      },
    });
    dirs.push(dir);
    const engine = new CapletsEngine({ configPath, projectConfigPath, watchDebounceMs: 10 });
    engines.push(engine);
    let reloads = 0;
    (engine as unknown as { reload: () => Promise<boolean> }).reload = vi.fn(async () => {
      reloads += 1;
      return true;
    });

    await watcherReady();
    writeConfig(configPath, {
      mcpServers: {
        beta: {
          name: "Beta",
          description: "Search beta project documents.",
          command: process.execPath,
        },
      },
    });

    await eventually(() => expect(reloads).toBeGreaterThan(0));
  });

  it("watches nested Caplet files when the config dir is also the Caplets root", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: process.execPath,
        },
      },
    });
    dirs.push(dir);
    const nestedFile = join(dir, "user", "nested", "notes.md");
    mkdirSync(join(dir, "user", "nested"), { recursive: true });
    writeFileSync(nestedFile, "before");
    const engine = new CapletsEngine({ configPath, projectConfigPath, watchDebounceMs: 10 });
    engines.push(engine);
    let reloads = 0;
    (engine as unknown as { reload: () => Promise<boolean> }).reload = vi.fn(async () => {
      reloads += 1;
      return true;
    });

    await watcherReady();
    writeFileSync(nestedFile, "after");

    await eventually(() => expect(reloads).toBeGreaterThan(0));
  });

  it("watches project Caplet files without explicit trust", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: process.execPath,
        },
      },
    });
    dirs.push(dir);
    const projectFile = join(dir, "project", ".caplets", "notes.txt");
    writeFileSync(projectFile, "before");
    const engine = new CapletsEngine({ configPath, projectConfigPath, watchDebounceMs: 10 });
    engines.push(engine);
    let reloads = 0;
    (engine as unknown as { reload: () => Promise<boolean> }).reload = vi.fn(async () => {
      reloads += 1;
      return true;
    });

    await watcherReady();
    writeFileSync(projectFile, "after");

    await eventually(() => expect(reloads).toBeGreaterThan(0));
  });

  function tempConfig(config: unknown): {
    dir: string;
    configPath: string;
    projectConfigPath: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "caplets-engine-"));
    const userRoot = join(dir, "user");
    const projectRoot = join(dir, "project", ".caplets");
    mkdirSync(userRoot, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    const configPath = join(userRoot, "config.json");
    const projectConfigPath = join(projectRoot, "config.json");
    writeConfig(configPath, config);
    return { dir, configPath, projectConfigPath };
  }
});

function writeConfig(path: string, config: unknown): void {
  writeFileSync(path, JSON.stringify(config));
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    assertion();
  } catch {
    throw lastError;
  }
}

async function watcherReady(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
