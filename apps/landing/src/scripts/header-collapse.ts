const siteHeader = document.querySelector<HTMLElement>("[data-site-header]");

let headerFrame = 0;
let lastScrollY = window.scrollY;

function updateHeaderState() {
  headerFrame = 0;
  if (!siteHeader) return;

  const scrollY = window.scrollY;
  const delta = scrollY - lastScrollY;
  lastScrollY = scrollY;

  if (scrollY <= 72) {
    siteHeader.classList.remove("is-header-collapsed");
    return;
  }

  if (delta > 4) {
    siteHeader.classList.add("is-header-collapsed");
    return;
  }

  if (delta < -4) {
    siteHeader.classList.remove("is-header-collapsed");
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
