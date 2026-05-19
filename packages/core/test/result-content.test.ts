import { describe, expect, it } from "vitest";
import { compactJsonText } from "../src/result-content";

describe("result content helpers", () => {
  it("compacts undefined JSON values without throwing", () => {
    expect(compactJsonText(undefined)).toBe("undefined");
  });
});
