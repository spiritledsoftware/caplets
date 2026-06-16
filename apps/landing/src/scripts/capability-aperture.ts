const canAnimate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const apertureRoot = document.querySelector<HTMLElement>("[data-aperture]");
const apertureStage = document.querySelector<HTMLElement>("[data-aperture-stage]");
const apertureCanvas = document.querySelector<HTMLCanvasElement>("[data-aperture-canvas]");

function canUseWebGl() {
  const canvas = document.createElement("canvas");
  const context =
    canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true }) ??
    canvas.getContext("webgl", { failIfMajorPerformanceCaveat: true });
  if (!context) return false;

  context.getExtension("WEBGL_lose_context")?.loseContext();
  return true;
}

if (apertureRoot && apertureStage && apertureCanvas) {
  const bootApertureScene = async () => {
    if (!canAnimate) {
      apertureRoot.classList.add("is-aperture-fallback");
      return;
    }

    if (!canUseWebGl()) {
      apertureRoot.classList.add("is-aperture-fallback");
      return;
    }

    try {
      const { initApertureScene } = await import("./aperture-scene");
      initApertureScene({
        canvas: apertureCanvas,
        canAnimate,
        root: apertureRoot,
        stage: apertureStage,
      });
    } catch {
      apertureRoot.classList.add("is-aperture-fallback");
    }
  };

  const scheduleApertureBoot = () => {
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(() => void bootApertureScene(), { timeout: 600 });
      return;
    }

    globalThis.setTimeout(() => void bootApertureScene(), 80);
  };

  scheduleApertureBoot();
}

export {};
