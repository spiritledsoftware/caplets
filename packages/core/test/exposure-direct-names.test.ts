import { describe, expect, it } from "vitest";
import {
  decodeDirectResourceUri,
  directPromptName,
  directResourceTemplateUri,
  directResourceUriMatchesTemplate,
  directResourceUri,
  directToolName,
  nativeDirectToolName,
} from "../src/exposure/direct-names";

describe("direct exposure names", () => {
  it("prefixes MCP and native direct operation names without parsing names back", () => {
    expect(directToolName("git_hub", "repos__list")).toBe("git_hub__repos__list");
    expect(directPromptName("git-hub", "summarize")).toBe("git-hub__summarize");
    expect(nativeDirectToolName("git-hub", "repos__list")).toBe("caplets__git-hub__repos__list");
  });

  it("encodes and decodes direct resource URIs", () => {
    const encoded = directResourceUri("docs", "file:///src/README.md?rev=main");
    expect(encoded).toBe("caplets://docs/resources/file%3A%2F%2F%2Fsrc%2FREADME.md%3Frev%3Dmain");
    expect(decodeDirectResourceUri(encoded)).toEqual({
      capletId: "docs",
      downstreamUri: "file:///src/README.md?rev=main",
    });
    expect(directResourceTemplateUri("docs", "file:///src/{path}")).toBe(
      "caplets://docs/resources/{encodedUri}?template=file%3A%2F%2F%2Fsrc%2F%7Bpath%7D",
    );
  });

  it("matches optional URI template query expansions", () => {
    expect(
      directResourceUriMatchesTemplate(
        "https://api.example.com/search",
        "https://api.example.com/search{?q}",
      ),
    ).toBe(true);
    expect(
      directResourceUriMatchesTemplate(
        "https://api.example.com/search?q=caplets",
        "https://api.example.com/search{?q}",
      ),
    ).toBe(true);
  });

  it("does not expand oversized URI template variable lists", () => {
    const variables = Array.from({ length: 13 }, (_value, index) => `v${index}`);

    expect(
      directResourceUriMatchesTemplate(
        `https://api.example.com/search?${variables.map((name) => `${name}=1`).join("&")}`,
        `https://api.example.com/search{?${variables.join(",")}}`,
      ),
    ).toBe(false);
  });
});
