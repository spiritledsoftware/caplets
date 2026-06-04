import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";

import type { CloudAuthCredentials } from "../../src/cloud-auth/store";

export const fixedNow = "2026-06-03T12:00:00.000Z";
export const fixedLater = "2999-01-01T00:00:00.000Z";

export function tempCloudAuthPath(): string {
  return join(mkdtempSync(join(tmpdir(), "caplets-cloud-auth-")), "cloud-auth.json");
}

export function hostedCredentials(
  overrides: Partial<CloudAuthCredentials> = {},
): CloudAuthCredentials {
  return {
    version: 2,
    cloudUrl: "https://cloud.caplets.dev",
    workspaceId: "workspace_personal",
    workspaceSlug: "personal",
    accessToken: "cap_access_secret",
    refreshToken: "cap_refresh_secret",
    expiresAt: fixedLater,
    scope: ["project_binding:read", "project_binding:write"],
    tokenType: "Bearer",
    credentialFamilyId: "family_123",
    deviceName: "Test Device",
    createdAt: fixedNow,
    lastRefreshAt: fixedNow,
    ...overrides,
  };
}

export function assertNoSecrets(output: string): void {
  expect(output).not.toContain("cap_access_secret");
  expect(output).not.toContain("cap_refresh_secret");
  expect(output).not.toContain("Authorization");
  expect(output).not.toContain("one_time_code_secret");
}
