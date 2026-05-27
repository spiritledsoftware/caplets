import { describe, expect, it } from "vitest";
import { compactCallToolResultContent, compactJsonText } from "../src/result-content";

describe("result content helpers", () => {
  it("compacts undefined JSON values without throwing", () => {
    expect(compactJsonText(undefined)).toBe("undefined");
  });

  it("includes compact HTTP response body previews in tool result content", () => {
    expect(
      compactCallToolResultContent({
        content: [],
        structuredContent: {
          status: 200,
          statusText: "OK",
          body: { vulns: [] },
          elapsedMs: 12,
        },
      }),
    ).toEqual([{ type: "text", text: 'status 200; OK; body {"vulns":[]}' }]);
  });
});
