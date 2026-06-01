import { describe, expect, it, vi } from "vitest";
import {
  checkMutagenBinary,
  mutagenDoctorLine,
  parseMutagenVersionOutput,
} from "../src/cloud/mutagen";

describe("managed Mutagen adapter", () => {
  it("reports available MIT-only Mutagen", async () => {
    const run = vi.fn(async () => "Mutagen version 0.18.1\nLicense profile: mit\n");

    await expect(checkMutagenBinary("/bin/mutagen", run)).resolves.toEqual({
      available: true,
      path: "/bin/mutagen",
      version: "0.18.1",
      licenseProfile: "mit",
    });
  });

  it("rejects unsupported license profiles", async () => {
    const run = vi.fn(async () => "Mutagen version 0.18.1\nLicense profile: sspl\n");

    await expect(checkMutagenBinary("/bin/mutagen", run)).resolves.toEqual({
      available: false,
      path: "/bin/mutagen",
      reason: "unsupported license profile sspl",
    });
  });

  it("formats doctor output", () => {
    expect(
      mutagenDoctorLine({
        available: true,
        path: "/bin/mutagen",
        version: "0.18.1",
        licenseProfile: "mit",
      }),
    ).toBe("Mutagen: available 0.18.1 (/bin/mutagen)");
  });

  it("parses unknown version output conservatively", () => {
    expect(parseMutagenVersionOutput("mutagen dev build")).toEqual({
      version: "unknown",
      licenseProfile: "unknown",
    });
  });
});
