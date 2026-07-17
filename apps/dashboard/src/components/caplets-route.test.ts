import { describe, expect, it } from "vitest";
import {
  capletDetailHref,
  capletsListHref,
  capletsLocationFromPath,
  safeCapletsReturnHref,
} from "./caplets-route";

describe("Caplets dashboard routing", () => {
  it("parses list and encoded detail locations under a mounted dashboard", () => {
    expect(capletsLocationFromPath("/team/dashboard/caplets")).toEqual({ mode: "list" });
    expect(capletsLocationFromPath("/team/dashboard/caplets/github%2Fissues")).toEqual({
      mode: "detail",
      capletId: "github/issues",
    });
    expect(capletsListHref("/team/dashboard/caplets/github%2Fissues")).toBe(
      "/team/dashboard/caplets",
    );
    expect(capletDetailHref("github/issues", "/team/dashboard/caplets")).toBe(
      "/team/dashboard/caplets/github%2Fissues",
    );
  });

  it("rejects malformed and traversal-like detail segments", () => {
    expect(capletsLocationFromPath("/dashboard/caplets/%E0%A4%A")).toEqual({ mode: "list" });
    expect(capletsLocationFromPath("/dashboard/caplets/..")).toEqual({ mode: "list" });
    expect(capletsLocationFromPath("/dashboard/caplets/a/b")).toEqual({ mode: "list" });
  });

  it("accepts only same-dashboard return paths", () => {
    expect(
      safeCapletsReturnHref(
        "/team/dashboard/caplets/github%2Fissues?source=effective",
        "/team/dashboard/caplets",
      ),
    ).toBe("/team/dashboard/caplets/github%2Fissues?source=effective");
    expect(safeCapletsReturnHref("https://attacker.example/", "/dashboard/caplets")).toBe(
      "/dashboard/caplets",
    );
    expect(safeCapletsReturnHref("/dashboard/vault", "/dashboard/caplets")).toBe(
      "/dashboard/caplets",
    );
  });
});
