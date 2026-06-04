import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProjectBindingWorkspaceStore,
  projectBindingWorkspacePaths,
  projectBindingWorkspaceRoot,
} from "../src/project-binding/workspaces";

const baseNow = new Date("2026-06-02T12:00:00.000Z");
const fingerprint = "sha256_abc";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("project binding workspace layout", () => {
  it("uses XDG_STATE_HOME for self-hosted workspace roots", () => {
    const root = projectBindingWorkspaceRoot({
      env: { XDG_STATE_HOME: "/state" },
      platform: "linux",
      homedir: "/home/alice",
    });
    expect(root).toBe("/state/caplets/workspaces");
  });

  it("falls back to ~/.local/state on Unix platforms", () => {
    const root = projectBindingWorkspaceRoot({
      env: {},
      platform: "linux",
      homedir: "/home/alice",
    });
    expect(root).toBe("/home/alice/.local/state/caplets/workspaces");
  });

  it("uses LOCALAPPDATA for Windows self-hosted workspace roots", () => {
    const root = projectBindingWorkspaceRoot({
      env: { LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local" },
      platform: "win32",
      homedir: "C:\\Users\\Alice",
    });
    expect(root).toBe(
      win32.join("C:\\Users\\Alice\\AppData\\Local", "Caplets", "State", "workspaces"),
    );
  });

  it("derives per-fingerprint project, metadata, lease, and receipt paths", () => {
    const paths = projectBindingWorkspacePaths(fingerprint, { root: "/state/caplets/workspaces" });
    expect(paths.root).toBe("/state/caplets/workspaces/sha256_abc");
    expect(paths.project).toBe("/state/caplets/workspaces/sha256_abc/project");
    expect(paths.metadata).toBe("/state/caplets/workspaces/sha256_abc/metadata.json");
    expect(paths.lease("bind_123")).toBe(
      "/state/caplets/workspaces/sha256_abc/leases/bind_123.json",
    );
    expect(paths.setupReceipts).toBe("/state/caplets/workspaces/sha256_abc/setup/receipts.json");
  });

  it("derives Windows per-fingerprint project paths", () => {
    const paths = projectBindingWorkspacePaths(fingerprint, {
      env: { LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local" },
      platform: "win32",
      homedir: "C:\\Users\\Alice",
    });
    expect(paths.project).toBe(
      win32.join(
        "C:\\Users\\Alice\\AppData\\Local",
        "Caplets",
        "State",
        "workspaces",
        fingerprint,
        "project",
      ),
    );
  });

  it("creates metadata, lease, and setup receipt directories", async () => {
    const root = tempRoot();
    const store = new ProjectBindingWorkspaceStore({ root, now: () => baseNow });

    const paths = await store.ensureWorkspace({
      projectFingerprint: fingerprint,
      projectRoot: "/repo",
    });
    await store.writeLease({
      bindingId: "bind_123",
      projectFingerprint: fingerprint,
      state: "ready",
      active: true,
      updatedAt: baseNow.toISOString(),
    });
    await store.writeSetupReceipts(fingerprint, [{ capletId: "repo-cli", status: "succeeded" }]);

    expect(existsSync(paths.project)).toBe(true);
    expect(JSON.parse(readFileSync(paths.metadata, "utf8"))).toMatchObject({
      projectFingerprint: fingerprint,
      projectRoot: "/repo",
      lastActiveAt: baseNow.toISOString(),
    });
    expect(JSON.parse(readFileSync(paths.lease("bind_123"), "utf8"))).toMatchObject({
      bindingId: "bind_123",
      active: true,
    });
    expect(JSON.parse(readFileSync(paths.setupReceipts, "utf8"))).toEqual([
      { capletId: "repo-cli", status: "succeeded" },
    ]);
  });
});

describe("project binding workspace cleanup", () => {
  it("keeps active leases and their workspaces even when old", async () => {
    const root = tempRoot();
    const store = new ProjectBindingWorkspaceStore({
      root,
      now: () => baseNow,
    });
    await workspace(store, "active-old", 60);
    await store.writeLease({
      bindingId: "bind_active",
      projectFingerprint: "active-old",
      state: "ready",
      active: true,
      updatedAt: daysAgo(60),
    });

    const result = await store.cleanup();

    expect(result.deletedWorkspaces).toEqual([]);
    expect(existsSync(join(root, "active-old"))).toBe(true);
    expect(existsSync(join(root, "active-old", "leases", "bind_active.json"))).toBe(true);
  });

  it("expires inactive stale leases after two minutes", async () => {
    const root = tempRoot();
    const store = new ProjectBindingWorkspaceStore({
      root,
      now: () => baseNow,
    });
    await workspace(store, "lease-stale", 1);
    await store.writeLease({
      bindingId: "bind_stale",
      projectFingerprint: "lease-stale",
      state: "offline",
      active: false,
      updatedAt: new Date(baseNow.getTime() - 121_000).toISOString(),
    });

    const result = await store.cleanup();

    expect(result.expiredLeases).toEqual([join(root, "lease-stale", "leases", "bind_stale.json")]);
    expect(existsSync(join(root, "lease-stale", "leases", "bind_stale.json"))).toBe(false);
    expect(existsSync(join(root, "lease-stale"))).toBe(true);
  });

  it("deletes inactive workspaces after thirty days", async () => {
    const root = tempRoot();
    const store = new ProjectBindingWorkspaceStore({
      root,
      now: () => baseNow,
    });
    await workspace(store, "recent", 29);
    await workspace(store, "old", 31);

    const result = await store.cleanup();

    expect(result.deletedWorkspaces).toEqual([join(root, "old")]);
    expect(existsSync(join(root, "recent"))).toBe(true);
    expect(existsSync(join(root, "old"))).toBe(false);
  });

  it("applies the soft disk cap by deleting oldest inactive workspaces first", async () => {
    const root = tempRoot();
    const sizes = new Map<string, number>();
    const store = new ProjectBindingWorkspaceStore({
      root,
      now: () => baseNow,
      softDiskCapBytes: 100,
      workspaceSizeBytes: (paths) => sizes.get(paths.projectFingerprint) ?? 0,
    });
    await workspace(store, "oldest", 5);
    await workspace(store, "middle", 3);
    await workspace(store, "newest", 1);
    sizes.set("oldest", 60);
    sizes.set("middle", 50);
    sizes.set("newest", 40);

    const result = await store.cleanup();

    expect(result.deletedWorkspaces).toEqual([join(root, "oldest")]);
    expect(existsSync(join(root, "oldest"))).toBe(false);
    expect(existsSync(join(root, "middle"))).toBe(true);
    expect(existsSync(join(root, "newest"))).toBe(true);
  });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "caplets-project-binding-"));
  tempDirs.push(dir);
  return dir;
}

async function workspace(
  store: ProjectBindingWorkspaceStore,
  projectFingerprint: string,
  inactiveDays: number,
) {
  await store.ensureWorkspace({
    projectFingerprint,
    projectRoot: `/repos/${projectFingerprint}`,
    lastActiveAt: daysAgo(inactiveDays),
  });
  writeFileSync(join(store.paths(projectFingerprint).project, "CAPLET.md"), "# Test\n");
}

function daysAgo(days: number): string {
  return new Date(baseNow.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}
