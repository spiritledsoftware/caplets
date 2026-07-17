import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeSecureJsonExclusive } from "../src/control-plane/secure-state";
import type { ApprovedPendingLogin } from "../src/remote/server-credential-store";
import type { ControlPlaneSecurityRepository } from "../src/control-plane/security/repository";
import {
  approvePendingLoginThroughHostLocalAuthority,
  startHostLocalCredentialAuthority,
  type HostLocalCredentialAuthorityDescriptor,
} from "../src/serve/host-local-credential-authority";

const roots: string[] = [];
const hostId = "host_01J00000000000000000000000";
const storeId = "store_01J00000000000000000000000";

async function setupStateRoot() {
  const root = await mkdtemp(join(tmpdir(), "caplets-host-local-authority-"));
  roots.push(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  await writeSecureJsonExclusive(join(root, "authority.json"), {
    version: 1,
    state: "bound",
    logicalHostId: hostId,
    owner: { kind: "posix", uid: process.getuid!() },
    authorityGeneration: 1,
    authorityToken: "authority_01J00000000000000000000000",
    storeId,
    operationNamespace: "operations_01J00000000000000000000000",
  });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("host-local live credential authority", () => {
  it("approves through the loopback-only live repository and rejects wrong, stale, and old-instance capabilities", async () => {
    const stateRoot = await setupStateRoot();
    const approved: ApprovedPendingLogin = {
      flowId: "rlogin_01J00000000000000000000000",
      status: "approved",
      clientLabel: "Browser",
      requestedRole: "operator",
      grantedRole: "operator",
    };
    const approvePendingLogin = vi.fn(async () => approved);
    const first = await startHostLocalCredentialAuthority({
      stateRoot,
      logicalHostId: hostId,
      storeId,
      authority: { approvePendingLogin } as unknown as ControlPlaneSecurityRepository,
      rotationIntervalMs: 60_000,
    });
    expect(first.address.address).toBe("127.0.0.1");
    expect(first.address.port).toBeGreaterThan(0);

    const oldDescriptor = await descriptor(first.descriptorPath);
    const wrong = await fetch(oldDescriptor.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-caplets-host-capability": "x".repeat(43),
        "x-caplets-host-instance": oldDescriptor.instanceNonce,
      },
      body: JSON.stringify({ version: 1, operatorCode: "cap_login_wrong" }),
    });
    expect(wrong.status).toBe(401);
    await expect(wrong.json()).resolves.toEqual({ error: "unauthorized" });
    expect(approvePendingLogin).not.toHaveBeenCalled();

    await expect(
      approvePendingLoginThroughHostLocalAuthority({
        stateRoot,
        operatorCode: "cap_login_correct",
        grantedRole: "operator",
      }),
    ).resolves.toEqual(approved);
    expect(approvePendingLogin).toHaveBeenCalledOnce();

    const rotatedDescriptor = await descriptor(first.descriptorPath);
    expect(rotatedDescriptor.capability).not.toBe(oldDescriptor.capability);
    const stale = await fetch(oldDescriptor.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-caplets-host-capability": oldDescriptor.capability,
        "x-caplets-host-instance": oldDescriptor.instanceNonce,
      },
      body: JSON.stringify({ version: 1, operatorCode: "cap_login_replay" }),
    });
    expect(stale.status).toBe(401);
    expect(approvePendingLogin).toHaveBeenCalledOnce();

    await first.close();
    expect(existsSync(first.descriptorPath)).toBe(false);

    const second = await startHostLocalCredentialAuthority({
      stateRoot,
      logicalHostId: hostId,
      storeId,
      authority: { approvePendingLogin } as unknown as ControlPlaneSecurityRepository,
      rotationIntervalMs: 60_000,
    });
    const currentDescriptor = await descriptor(second.descriptorPath);
    const oldInstance = await fetch(currentDescriptor.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-caplets-host-capability": oldDescriptor.capability,
        "x-caplets-host-instance": oldDescriptor.instanceNonce,
      },
      body: JSON.stringify({ version: 1, operatorCode: "cap_login_old_instance" }),
    });
    expect(oldInstance.status).toBe(401);
    expect(currentDescriptor.instanceNonce).not.toBe(oldDescriptor.instanceNonce);
    await second.close();
  });

  it("fails closed when the Current Host is stopped", async () => {
    const stateRoot = await setupStateRoot();
    await expect(
      approvePendingLoginThroughHostLocalAuthority({
        stateRoot,
        operatorCode: "cap_login_stopped",
      }),
    ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
  });
});

async function descriptor(path: string): Promise<HostLocalCredentialAuthorityDescriptor> {
  return JSON.parse(await readFile(path, "utf8")) as HostLocalCredentialAuthorityDescriptor;
}
