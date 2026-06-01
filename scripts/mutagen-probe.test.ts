import { describe, expect, it } from "vitest";
import { mutagenBuildIsAllowed, parseMutagenVersionOutput } from "./mutagen-probe";

describe("mutagen probe", () => {
  it("parses version output with license metadata", () => {
    const output = ["Mutagen version 0.18.1", "Build type: release", "License profile: mit"].join(
      "\n",
    );

    expect(parseMutagenVersionOutput(output)).toEqual({
      version: "0.18.1",
      licenseProfile: "mit",
    });
  });

  it("rejects SSPL builds for bundled hosted product use", () => {
    expect(mutagenBuildIsAllowed({ version: "0.18.1", licenseProfile: "sspl" })).toBe(false);
  });

  it("accepts MIT-only builds", () => {
    expect(mutagenBuildIsAllowed({ version: "0.18.1", licenseProfile: "mit" })).toBe(true);
  });
});
