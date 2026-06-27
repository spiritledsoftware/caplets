import {
  catalogThemeLabel,
  normalizeCatalogThemePreference,
  resolveCatalogTheme,
} from "../src/lib/theme";
import { describe, expect, it } from "vitest";

describe("catalog theme preferences", () => {
  it("normalizes invalid stored preferences to system", () => {
    expect(normalizeCatalogThemePreference("dark")).toBe("dark");
    expect(normalizeCatalogThemePreference("light")).toBe("light");
    expect(normalizeCatalogThemePreference("system")).toBe("system");
    expect(normalizeCatalogThemePreference("sepia")).toBe("system");
    expect(normalizeCatalogThemePreference(null)).toBe("system");
  });

  it("resolves system against the current media query", () => {
    expect(resolveCatalogTheme("system", true)).toBe("dark");
    expect(resolveCatalogTheme("system", false)).toBe("light");
    expect(resolveCatalogTheme("dark", false)).toBe("dark");
    expect(resolveCatalogTheme("light", true)).toBe("light");
  });

  it("labels theme menu options consistently", () => {
    expect(catalogThemeLabel("light")).toBe("Light");
    expect(catalogThemeLabel("dark")).toBe("Dark");
    expect(catalogThemeLabel("system")).toBe("System");
  });
});
