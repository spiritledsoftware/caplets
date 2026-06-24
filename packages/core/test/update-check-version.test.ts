import { describe, expect, it } from "vitest";
import { findAvailableUpdate, type PackageVersionMetadata } from "../src/update-check";

function metadata(versions: string[], latest = versions.at(-1) ?? "0.0.0"): PackageVersionMetadata {
  return {
    packageName: "caplets",
    distTags: { latest },
    versions,
  };
}

describe("update-check version selection", () => {
  it("finds newer stable releases for stable builds", () => {
    expect(findAvailableUpdate("0.22.0", metadata(["0.22.0", "0.23.0"]))).toMatchObject({
      available: true,
      latestVersion: "0.23.0",
    });
  });

  it("does not report current or older stable releases", () => {
    expect(findAvailableUpdate("0.23.0", metadata(["0.22.0", "0.23.0"]))).toEqual({
      available: false,
      reason: "no-eligible-version",
    });
  });

  it("does not prompt stable users to install prereleases", () => {
    expect(findAvailableUpdate("0.23.0", metadata(["0.23.0", "0.24.0-beta.1"], "0.23.0"))).toEqual({
      available: false,
      reason: "no-eligible-version",
    });
  });

  it("compares prereleases only within the same base version and identifier", () => {
    expect(
      findAvailableUpdate(
        "0.24.0-beta.1",
        metadata(["0.24.0-alpha.9", "0.24.0-beta.1", "0.24.0-beta.2", "0.25.0-beta.1"]),
      ),
    ).toMatchObject({ available: true, latestVersion: "0.24.0-beta.2" });

    expect(
      findAvailableUpdate("0.24.0-beta.1", metadata(["0.24.0-alpha.9", "0.25.0-beta.1"])),
    ).toEqual({
      available: false,
      reason: "no-eligible-version",
    });
  });

  it("rejects missing or invalid running versions", () => {
    expect(findAvailableUpdate(undefined, metadata(["0.23.0"]))).toEqual({
      available: false,
      reason: "invalid-running-version",
    });
    expect(findAvailableUpdate("not-a-version", metadata(["0.23.0"]))).toEqual({
      available: false,
      reason: "invalid-running-version",
    });
  });
});
