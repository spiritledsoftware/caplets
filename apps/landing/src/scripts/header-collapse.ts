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
let keepExpandedForHash = Boolean(window.location.hash);

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

  if (keepExpandedForHash) {
    setHeaderCollapsed(false);
    return;
  }

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

function allowHeaderCollapseAfterUserScroll() {
  keepExpandedForHash = false;
}

if (siteHeader) {
  updateHeaderState();
  window.addEventListener("scroll", requestHeaderStateUpdate, { passive: true });
  window.addEventListener("resize", requestHeaderStateUpdate);
  window.addEventListener("hashchange", () => {
    keepExpandedForHash = Boolean(window.location.hash);
    setHeaderCollapsed(false);
    requestHeaderStateUpdate();
  });
  window.addEventListener("wheel", allowHeaderCollapseAfterUserScroll, { passive: true });
  window.addEventListener("touchstart", allowHeaderCollapseAfterUserScroll, { passive: true });
  window.addEventListener("keydown", (event) => {
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "PageDown" ||
      event.key === "PageUp" ||
      event.key === "Home" ||
      event.key === "End" ||
      event.key === " "
    ) {
      allowHeaderCollapseAfterUserScroll();
    }
  });
}

export {};
