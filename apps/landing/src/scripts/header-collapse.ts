const siteHeader = document.querySelector<HTMLElement>("[data-site-header]");
const collapsedFocusTargets = siteHeader
  ? Array.from(
      siteHeader.querySelectorAll<HTMLElement>(
        ".site-header__section-link, .site-header__docs-link",
      ),
    )
  : [];

let headerFrame = 0;
let lastScrollY = window.scrollY;
let isHeaderCollapsed = false;

function setHeaderCollapsed(collapsed: boolean) {
  if (!siteHeader || isHeaderCollapsed === collapsed) return;

  isHeaderCollapsed = collapsed;
  siteHeader.classList.toggle("is-header-collapsed", collapsed);

  for (const target of collapsedFocusTargets) {
    if (collapsed) {
      target.setAttribute("aria-hidden", "true");
      target.setAttribute("tabindex", "-1");
    } else {
      target.removeAttribute("aria-hidden");
      target.removeAttribute("tabindex");
    }
  }
}

function updateHeaderState() {
  headerFrame = 0;
  if (!siteHeader) return;

  const scrollY = window.scrollY;
  const delta = scrollY - lastScrollY;
  lastScrollY = scrollY;

  if (scrollY <= 72) {
    setHeaderCollapsed(false);
    return;
  }

  if (delta > 4) {
    setHeaderCollapsed(true);
    return;
  }

  if (delta < -4) {
    setHeaderCollapsed(false);
  }
}

function requestHeaderStateUpdate() {
  if (headerFrame) return;
  headerFrame = window.requestAnimationFrame(updateHeaderState);
}

if (siteHeader) {
  updateHeaderState();
  window.addEventListener("scroll", requestHeaderStateUpdate, { passive: true });
  window.addEventListener("resize", requestHeaderStateUpdate);
}

export {};
