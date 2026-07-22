import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attachProjectOnce } from "../src/project-binding/attach";
import { bootstrapProjectBindingGitignore } from "../src/project-binding/gitignore";
import { FileRemoteProfileStore } from "../src/remote/profile-store";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Project Binding gitignore bootstrap", () => {
  it("creates only .caplets/.gitignore with private-state ignore rules", () => {
    const projectRoot = tempProjectRoot();

    const result = bootstrapProjectBindingGitignore(projectRoot);

    expect(result).toEqual({ path: join(projectRoot, ".caplets", ".gitignore"), changed: true });
    expect(readFileSync(result.path, "utf8")).toBe("*\n!.gitignore\n");
    expect(existsSync(join(projectRoot, ".caplets", "config.json"))).toBe(false);
    expect(existsSync(join(projectRoot, ".capletsignore"))).toBe(false);
  });

  it("is idempotent and preserves existing ignore entries", () => {
    const projectRoot = tempProjectRoot();
    const gitignorePath = join(projectRoot, ".caplets", ".gitignore");
    bootstrapProjectBindingGitignore(projectRoot);
    writeFileSync(gitignorePath, `${readFileSync(gitignorePath, "utf8")}custom\n`, "utf8");

    const result = bootstrapProjectBindingGitignore(projectRoot);

    expect(result.changed).toBe(false);
    expect(readFileSync(gitignorePath, "utf8")).toBe("*\n!.gitignore\ncustom\n");
  });

  it("bootstraps .caplets/.gitignore during attach once", async () => {
    const projectRoot = tempProjectRoot();
    const authDir = tempAuthDir();
    await saveRemoteProfile(authDir, "http://127.0.0.1:8787");

    await attachProjectOnce({
      projectRoot,
      remoteUrl: "http://127.0.0.1:8787",
      authDir,
      fetch: async () => Response.json({ error: "websocket_upgrade_required" }, { status: 426 }),
    });

    expect(readFileSync(join(projectRoot, ".caplets", ".gitignore"), "utf8")).toBe(
      "*\n!.gitignore\n",
    );
    expect(existsSync(join(projectRoot, ".caplets", "config.json"))).toBe(false);
    expect(existsSync(join(projectRoot, ".capletsignore"))).toBe(false);
  });
});

function tempProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "caplets-project-binding-"));
  tempDirs.push(root);
  return root;
}

function tempAuthDir(): string {
  const root = mkdtempSync(join(tmpdir(), "caplets-project-binding-auth-"));
  tempDirs.push(root);
  return root;
}

async function saveRemoteProfile(authDir: string, origin: string): Promise<void> {
  await new FileRemoteProfileStore({
    root: join(authDir, "remote-profiles"),
  }).saveRemoteProfile({
    origin,
    clientId: "rcli_123",
    clientLabel: "Test Device",
    credentials: {
      accessToken: "profile-access-token",
      refreshToken: "profile-refresh-token",
      tokenType: "Bearer",
      expiresAt: "2999-01-01T00:00:00.000Z",
    },
  });
}
