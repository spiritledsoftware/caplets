import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProjectSyncCoordinator, projectSyncFiles, projectSyncManifest } from "../src/cloud/sync";

describe("ProjectSyncCoordinator", () => {
  it("serializes mutating calls per project target", async () => {
    const events: string[] = [];
    const coordinator = new ProjectSyncCoordinator();

    await Promise.all([
      coordinator.runMutating("project_1", async () => {
        events.push("first:start");
        await Promise.resolve();
        events.push("first:end");
      }),
      coordinator.runMutating("project_1", async () => {
        events.push("second:start");
        events.push("second:end");
      }),
    ]);

    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("allows independent project targets to run independently", async () => {
    const coordinator = new ProjectSyncCoordinator();
    const task = vi.fn(async () => undefined);

    await Promise.all([coordinator.runMutating("a", task), coordinator.runMutating("b", task)]);

    expect(task).toHaveBeenCalledTimes(2);
  });

  it("builds hosted upload scope from the Project Binding sync filter", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-sync-"));
    const external = mkdtempSync(join(tmpdir(), "caplets-sync-external-"));
    try {
      mkdirSync(join(dir, "src"));
      mkdirSync(join(dir, "dist"));
      mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
      mkdirSync(join(dir, "secrets"));
      mkdirSync(join(dir, ".git", "info"), { recursive: true });
      writeFileSync(join(dir, ".gitignore"), "dist\n*.env\n!important.env\n", "utf8");
      writeFileSync(join(dir, ".git", "info", "exclude"), "tmp\n", "utf8");
      writeFileSync(join(dir, ".capletsignore"), "secrets\n", "utf8");
      writeFileSync(join(dir, "src/app.ts"), "app", "utf8");
      writeFileSync(join(dir, "dist/app.js"), "build", "utf8");
      writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "pkg", "utf8");
      writeFileSync(join(dir, "secrets/token"), "secret", "utf8");
      writeFileSync(join(dir, ".env"), "secret", "utf8");
      writeFileSync(join(dir, ".env.example"), "SAFE=\n", "utf8");
      writeFileSync(join(dir, "deploy.pem"), "secret", "utf8");
      writeFileSync(join(dir, "important.env"), "ok", "utf8");
      mkdirSync(join(dir, "tmp"));
      writeFileSync(join(dir, "tmp/cache"), "cache", "utf8");
      writeFileSync(join(external, "secret.txt"), "secret", "utf8");
      symlinkSync(join(external, "secret.txt"), join(dir, "linked-secret"));
      symlinkSync(external, join(dir, "linked-dir"));

      expect(projectSyncManifest(dir)).toEqual([
        ".capletsignore",
        ".env.example",
        ".gitignore",
        "important.env",
        "src/app.ts",
      ]);
      expect(projectSyncFiles(dir)).toEqual([
        { path: ".capletsignore", content: "secrets\n" },
        { path: ".env.example", content: "SAFE=\n" },
        { path: ".gitignore", content: "dist\n*.env\n!important.env\n" },
        { path: "important.env", content: "ok" },
        { path: "src/app.ts", content: "app" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });
});
