export const catalogThemeStorageKey = "caplets.catalog.theme";
export const catalogThemeSystemQuery = "(prefers-color-scheme: dark)";

export const catalogThemePreferences = ["light", "dark", "system"] as const;

export type CatalogThemePreference = (typeof catalogThemePreferences)[number];
export type CatalogResolvedTheme = Exclude<CatalogThemePreference, "system">;

export function isCatalogThemePreference(
  value: string | null | undefined,
): value is CatalogThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function normalizeCatalogThemePreference(
  value: string | null | undefined,
): CatalogThemePreference {
  return isCatalogThemePreference(value) ? value : "system";
}

export function resolveCatalogTheme(
  preference: CatalogThemePreference,
  systemPrefersDark: boolean,
): CatalogResolvedTheme {
  if (preference !== "system") return preference;
  return systemPrefersDark ? "dark" : "light";
}

export function catalogThemeLabel(preference: CatalogThemePreference): string {
  return preference === "light" ? "Light" : preference === "dark" ? "Dark" : "System";
}
