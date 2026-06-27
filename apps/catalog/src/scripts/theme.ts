import {
  catalogThemeLabel,
  catalogThemeStorageKey,
  catalogThemeSystemQuery,
  isCatalogThemePreference,
  normalizeCatalogThemePreference,
  resolveCatalogTheme,
  type CatalogThemePreference,
} from "../lib/theme";

const query = window.matchMedia(catalogThemeSystemQuery);
const root = document.querySelector("[data-theme-menu-root]") as HTMLElement | null;
const trigger = document.querySelector("[data-theme-trigger]") as HTMLButtonElement | null;
const menu = document.querySelector("[data-theme-menu]") as HTMLElement | null;
const label = document.querySelector("[data-theme-label]") as HTMLElement | null;
const controls = Array.from(
  document.querySelectorAll("[data-theme-option]"),
) as HTMLButtonElement[];
const currentIcons = Array.from(
  document.querySelectorAll("[data-theme-current-icon]"),
) as HTMLElement[];

function getStoredPreference(): CatalogThemePreference {
  try {
    return normalizeCatalogThemePreference(localStorage.getItem(catalogThemeStorageKey));
  } catch {
    return "system";
  }
}

function storePreference(preference: CatalogThemePreference): void {
  try {
    localStorage.setItem(catalogThemeStorageKey, preference);
  } catch {
    // Storage can be unavailable in hardened browser contexts; keep the in-page selection usable.
  }
}

function applyTheme(preference: CatalogThemePreference): void {
  const theme = resolveCatalogTheme(preference, query.matches);
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = theme;

  for (const control of controls) {
    const selected = control.dataset.themeOption === preference;
    control.setAttribute("aria-checked", String(selected));
    if (selected && label)
      label.textContent = control.dataset.themeLabelValue ?? catalogThemeLabel(preference);
  }

  for (const icon of currentIcons) {
    icon.hidden = icon.dataset.themeCurrentIcon !== preference;
  }
}

function setMenuOpen(open: boolean): void {
  if (!trigger || !menu) return;
  trigger.setAttribute("aria-expanded", String(open));
  menu.hidden = !open;
}

function isMenuOpen(): boolean {
  return trigger?.getAttribute("aria-expanded") === "true";
}

function focusOption(index: number): void {
  controls.at(index)?.focus();
}

function focusedOptionIndex(): number {
  return controls.findIndex((control) => control === document.activeElement);
}

trigger?.addEventListener("click", () => {
  setMenuOpen(!isMenuOpen());
});

trigger?.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  setMenuOpen(true);
  focusOption(event.key === "ArrowDown" ? 0 : controls.length - 1);
});

for (const control of controls) {
  control.addEventListener("click", () => {
    const preference = control.dataset.themeOption ?? null;
    if (!isCatalogThemePreference(preference)) return;
    storePreference(preference);
    applyTheme(preference);
    setMenuOpen(false);
    trigger?.focus();
  });

  control.addEventListener("keydown", (event) => {
    const currentIndex = focusedOptionIndex();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOption((currentIndex + 1) % controls.length);
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusOption((currentIndex - 1 + controls.length) % controls.length);
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusOption(0);
    }
    if (event.key === "End") {
      event.preventDefault();
      focusOption(controls.length - 1);
    }
  });
}

document.addEventListener("click", (event) => {
  if (!isMenuOpen() || root?.contains(event.target as Node)) return;
  setMenuOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !isMenuOpen()) return;
  setMenuOpen(false);
  trigger?.focus();
});

query.addEventListener("change", () => {
  const preference = getStoredPreference();
  if (preference === "system") applyTheme(preference);
});

applyTheme(getStoredPreference());

export {};
