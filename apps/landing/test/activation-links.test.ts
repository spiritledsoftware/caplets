import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { Window } from "happy-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import Activation from "../src/components/landing/Activation.astro";
import Hero from "../src/components/landing/Hero.astro";
import { initializeStarwindTabs } from "../src/components/starwind/tabs/tabs-client";

let container: AstroContainer;

beforeAll(async () => {
  container = await AstroContainer.create();
});

beforeEach(() => {
  const browserWindow = new Window({ url: "https://caplets.dev/" });
  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal("document", browserWindow.document);
  vi.stubGlobal("localStorage", browserWindow.localStorage);
  vi.stubGlobal("CustomEvent", browserWindow.CustomEvent);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function requiredElement<TElement extends Element>(selector: string): TElement {
  const element = document.querySelector<TElement>(selector);
  expect(element, `Expected rendered element ${selector}`).not.toBeNull();
  if (!element) throw new Error(`Landing test element ${selector} was not rendered.`);
  return element;
}
const syncedTabsMarkup = `
  <div class="starwind-tabs" data-default-value="Manual" data-sync-key="setup-test">
    <div data-tabs-list>
      <button data-tabs-trigger data-value="Manual">Manual</button>
      <button data-tabs-trigger data-value="Agent">Agent</button>
    </div>
    <section data-tabs-content data-value="Manual">Manual instructions</section>
    <section data-tabs-content data-value="Agent">Agent instructions</section>
  </div>
`;

describe("activation links", () => {
  it("renders the secondary shared-Caplets action for the public catalog", async () => {
    document.body.innerHTML = await container.renderToString(Hero);

    const catalogLink = requiredElement<HTMLAnchorElement>('a[href="https://catalog.caplets.dev"]');
    expect(catalogLink.textContent?.trim()).toBe("Browse shared Caplets");
    expect(catalogLink.dataset.ctaCategory).toBe("secondary");
  });

  it("switches the rendered setup instructions from manual to agent mode", async () => {
    document.body.innerHTML = await container.renderToString(Activation);
    initializeStarwindTabs(document);

    const manualTrigger = requiredElement<HTMLButtonElement>(
      '#setup [data-tabs-trigger][data-value="Manual"]',
    );
    const agentTrigger = requiredElement<HTMLButtonElement>(
      '#setup [data-tabs-trigger][data-value="Agent"]',
    );
    const manualPanel = requiredElement<HTMLElement>(
      '#setup [data-tabs-content][data-value="Manual"]',
    );
    const agentPanel = requiredElement<HTMLElement>(
      '#setup [data-tabs-content][data-value="Agent"]',
    );

    expect(manualTrigger.getAttribute("aria-selected")).toBe("true");
    expect(manualPanel.hidden).toBe(false);
    expect(manualPanel.textContent).toContain("caplets setup");
    expect(agentPanel.hidden).toBe(true);

    agentTrigger.click();

    expect(agentTrigger.getAttribute("aria-selected")).toBe("true");
    expect(manualTrigger.getAttribute("aria-selected")).toBe("false");
    expect(manualPanel.hidden).toBe(true);
    expect(agentPanel.hidden).toBe(false);
    expect(agentPanel.textContent).toContain("Read bootstrap skill");
    expect(agentPanel.textContent).not.toContain("Read and follow this Caplets bootstrap skill");
  });

  it("keeps synced tabs usable when Web Storage is unavailable", () => {
    document.body.innerHTML = syncedTabsMarkup;
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("Storage is blocked.", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("Storage is blocked.", "SecurityError");
      },
    });

    expect(() => initializeStarwindTabs(document)).not.toThrow();
    const manualTrigger = requiredElement<HTMLButtonElement>(
      '[data-tabs-trigger][data-value="Manual"]',
    );
    const agentTrigger = requiredElement<HTMLButtonElement>(
      '[data-tabs-trigger][data-value="Agent"]',
    );
    expect(manualTrigger.getAttribute("aria-selected")).toBe("true");

    expect(() => agentTrigger.click()).not.toThrow();
    expect(agentTrigger.getAttribute("aria-selected")).toBe("true");
  });

  it("removes tab synchronization listeners before an Astro page swap", () => {
    document.body.innerHTML = syncedTabsMarkup;
    initializeStarwindTabs(document);
    const manualTrigger = requiredElement<HTMLButtonElement>(
      '[data-tabs-trigger][data-value="Manual"]',
    );

    document.dispatchEvent(new CustomEvent("astro:before-swap"));
    document.dispatchEvent(
      new CustomEvent("starwind-tabs-sync:setup-test", { detail: { value: "Agent" } }),
    );

    expect(manualTrigger.getAttribute("aria-selected")).toBe("true");
  });
});
