document.documentElement.classList.add("js-enabled");

function settleHashAnchor() {
  if (!window.location.hash) return;
  const targetId = window.location.hash.slice(1);
  const target = targetId ? document.getElementById(targetId) : null;
  if (target instanceof HTMLElement) {
    target.scrollIntoView({ block: "start", behavior: "instant" });
  }
}

window.addEventListener("load", () => {
  window.requestAnimationFrame(() => {
    settleHashAnchor();
    window.setTimeout(settleHashAnchor, 320);
  });
});

const canAnimate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (canAnimate && "IntersectionObserver" in window) {
  const revealTargets = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));

  if (revealTargets.length > 0) {
    let hasIntersectionUpdate = false;

    const revealObserver = new IntersectionObserver(
      (entries) => {
        hasIntersectionUpdate = true;

        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            revealObserver.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "0px 0px -10%", threshold: 0.12 },
    );

    for (const target of revealTargets) {
      revealObserver.observe(target);
    }

    document.documentElement.classList.add("motion-ready");
    window.setTimeout(() => {
      if (hasIntersectionUpdate) return;

      revealTargets.forEach((target) => target.classList.add("is-visible"));
      revealObserver.disconnect();
    }, 100);
  }
}

export {};
