const traceRoot = document.querySelector<HTMLElement>("[data-agent-trace]");
const traceFill = document.querySelector<HTMLElement>("[data-agent-trace-fill]");
const traceSteps = Array.from(
  document.querySelectorAll<HTMLAnchorElement>("[data-agent-trace-step]"),
);

const traceSections = traceSteps
  .map((step) => {
    const targetId = step.hash.slice(1);
    const section = targetId ? document.getElementById(targetId) : null;
    return section instanceof HTMLElement ? { section, step } : null;
  })
  .filter((entry): entry is { section: HTMLElement; step: HTMLAnchorElement } => Boolean(entry));

let traceFrame = 0;

function setTraceIndex(index: number) {
  for (const [stepIndex, { step }] of traceSections.entries()) {
    const isActive = stepIndex === index;
    step.classList.toggle("is-active", isActive);
    step.setAttribute("aria-current", isActive ? "true" : "false");
  }
}

function setTraceHashIndex(hash = window.location.hash) {
  const hashIndex = traceSections.findIndex(({ step }) => step.hash === hash);
  if (hashIndex >= 0) setTraceIndex(hashIndex);
}

function updateAgentTrace() {
  traceFrame = 0;
  if (!traceRoot || traceSections.length === 0) return;

  const viewportAnchor = window.scrollY + window.innerHeight * 0.38;
  const firstTop = traceSections[0].section.offsetTop;
  const lastTop = traceSections[traceSections.length - 1].section.offsetTop;
  const range = Math.max(1, lastTop - firstTop);
  const progress = Math.min(1, Math.max(0, (viewportAnchor - firstTop) / range));
  const activeIndex = traceSections.reduce((current, entry, index) => {
    return entry.section.offsetTop <= viewportAnchor ? index : current;
  }, 0);
  const railRect = traceFill?.parentElement?.getBoundingClientRect();
  const isMobileTrace = window.matchMedia("(max-width: 720px)").matches;
  const signalTravel = Math.max(
    0,
    isMobileTrace ? (railRect?.width ?? 0) : (railRect?.height ?? 0),
  );

  traceRoot.style.setProperty("--agent-trace-progress", `${progress}`);
  traceRoot.style.setProperty("--agent-trace-signal", `${progress * signalTravel}px`);
  setTraceIndex(activeIndex);
}

function requestAgentTraceUpdate() {
  if (traceFrame) return;
  traceFrame = window.requestAnimationFrame(updateAgentTrace);
}

if (traceRoot && traceSections.length > 0) {
  updateAgentTrace();
  setTraceHashIndex();

  for (const [index, { step }] of traceSections.entries()) {
    step.addEventListener("click", () => setTraceIndex(index));
  }

  window.addEventListener("scroll", requestAgentTraceUpdate, { passive: true });
  window.addEventListener("resize", requestAgentTraceUpdate);
  window.addEventListener("hashchange", () => setTraceHashIndex());
}
