import { describe, expect, it } from "vitest";
import { resolveExposure } from "../src/exposure/policy";

describe("exposure policy", () => {
  it("uses the global default when a Caplet has no override", () => {
    expect(resolveExposure(undefined, "code_mode")).toEqual({
      value: "code_mode",
      direct: false,
      progressive: false,
      codeMode: true,
    });
  });

  it("lets a Caplet override the global default", () => {
    expect(resolveExposure("direct_and_code_mode", "progressive")).toEqual({
      value: "direct_and_code_mode",
      direct: true,
      progressive: false,
      codeMode: true,
    });
  });
});
