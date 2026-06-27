import {
  catalogThemeStorageKey,
  catalogThemeSystemQuery,
  normalizeCatalogThemePreference,
  resolveCatalogTheme,
} from "../lib/theme";

try {
  const preference = normalizeCatalogThemePreference(localStorage.getItem(catalogThemeStorageKey));
  const theme = resolveCatalogTheme(preference, window.matchMedia(catalogThemeSystemQuery).matches);
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = theme;
} catch {
  const theme = window.matchMedia(catalogThemeSystemQuery).matches ? "dark" : "light";
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.themePreference = "system";
  document.documentElement.style.colorScheme = theme;
}

export {};
