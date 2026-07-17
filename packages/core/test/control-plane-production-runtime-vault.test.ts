import { describe, expect, it, vi } from "vitest";
import type { ControlPlaneSecurityRepository } from "../src/control-plane/security/repository";
import { createSqlVaultResolutionHydrator } from "../src/control-plane/production-runtime";

describe("production SQL Vault hydration", () => {
  it("bounds 2k reveals and reuses the initial hydration for first snapshot composition", async () => {
    const grants = Array.from({ length: 2_000 }, (_, index) => ({
      storedKey: `key-${index}`,
      referenceName: `REF_${index}`,
      capletId: "fixture",
      origin: { kind: "sql" as const, path: "" },
    }));
    let active = 0;
    let maximumActive = 0;
    const listAccess = vi.fn(async () => grants);
    const revealValue = vi.fn(async (storedKey: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return `value:${storedKey}`;
    });
    const security = {
      listAccess,
      revealValue,
    } as unknown as Pick<ControlPlaneSecurityRepository, "listAccess" | "revealValue">;

    const hydration = await createSqlVaultResolutionHydrator(security);

    expect(revealValue).toHaveBeenCalledTimes(2_000);
    expect(maximumActive).toBeLessThanOrEqual(16);
    await hydration.refresh();
    expect(listAccess).toHaveBeenCalledOnce();
    expect(revealValue).toHaveBeenCalledTimes(2_000);
    expect(
      hydration.resolver({
        referenceName: "REF_1999",
        capletId: "fixture",
        origin: { kind: "sql", path: "" },
        path: "mcpServers.fixture.env.REF_1999",
      }),
    ).toEqual({ storedKey: "key-1999", value: "value:key-1999" });

    await hydration.refresh();
    expect(listAccess).toHaveBeenCalledTimes(2);
    expect(revealValue).toHaveBeenCalledTimes(4_000);
    expect(maximumActive).toBeLessThanOrEqual(16);
  });
});
