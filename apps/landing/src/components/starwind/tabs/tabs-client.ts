type TabValue = string;

interface TabsSyncEventDetail {
  value: TabValue;
}

interface TabsSyncEvent extends CustomEvent<TabsSyncEventDetail> {
  type: `starwind-tabs-sync:${string}`;
}

class TabsHandler {
  private tabs: HTMLElement;
  private triggers: HTMLButtonElement[];
  private contents: HTMLElement[];
  private currentTabIndex = 0;
  private tabsId: string;
  private syncKey?: string;
  private storageKey: string;
  private valueToTriggerMap: Map<string, HTMLButtonElement>;
  private valueToContentMap: Map<string, HTMLElement>;

  constructor(tabs: HTMLElement, index: number) {
    this.tabs = tabs;
    this.triggers = Array.from(
      tabs.querySelectorAll(":scope > [data-tabs-list] > [data-tabs-trigger]"),
    );
    this.contents = Array.from(tabs.querySelectorAll(":scope > [data-tabs-content]"));
    this.tabsId = `starwind-tabs${index}`;
    this.syncKey = tabs.dataset.syncKey;
    this.storageKey = this.syncKey
      ? `starwind-tabs-${this.syncKey}`
      : `starwind-tabs-${this.tabsId}`;
    this.valueToTriggerMap = new Map(
      this.triggers.map((trigger) => [trigger.getAttribute("data-value") ?? "", trigger]),
    );
    this.valueToContentMap = new Map(
      this.contents.map((content) => [content.getAttribute("data-value") ?? "", content]),
    );

    this.setupIds();
    this.initializeTab();
    this.addEventListeners();

    if (this.syncKey) this.setupSyncListener();
  }

  private initializeTab(): void {
    const value = this.syncKey
      ? (localStorage.getItem(this.storageKey) ?? this.tabs.dataset.defaultValue)
      : this.tabs.dataset.defaultValue;
    const resolvedValue =
      value && this.valueToTriggerMap.has(value)
        ? value
        : this.triggers.find((trigger) => !trigger.disabled)?.getAttribute("data-value");

    if (!resolvedValue) return;

    this.showTab(resolvedValue);
    this.currentTabIndex = this.triggers.findIndex(
      (trigger) => trigger.getAttribute("data-value") === resolvedValue,
    );
    this.setTabIndex();
  }

  private setupSyncListener(): void {
    document.addEventListener(`starwind-tabs-sync:${this.syncKey}`, ((event: TabsSyncEvent) => {
      const value = event.detail.value;
      const trigger = this.valueToTriggerMap.get(value);
      const index = trigger ? this.triggers.indexOf(trigger) : -1;

      if (index !== -1) {
        this.showTab(value);
        this.currentTabIndex = index;
        this.setTabIndex();
      }
    }) as EventListener);
  }

  private setupIds(): void {
    this.triggers.forEach((trigger, index) => {
      const triggerId = `${this.tabsId}-t${index}`;
      const contentId = `${this.tabsId}-c${index}`;
      const value = trigger.getAttribute("data-value");
      trigger.id = triggerId;

      if (!value) return;
      trigger.setAttribute("aria-controls", contentId);
      const content = this.valueToContentMap.get(value);
      if (content) {
        content.id = contentId;
        content.setAttribute("aria-labelledby", triggerId);
      }
    });
  }

  private setTabIndex(): void {
    this.triggers.forEach((trigger, index) => {
      trigger.setAttribute("tabindex", index === this.currentTabIndex ? "0" : "-1");
    });
  }

  private dispatchSyncEvent(value: TabValue): void {
    if (!this.syncKey) return;

    document.dispatchEvent(
      new CustomEvent(`starwind-tabs-sync:${this.syncKey}`, { detail: { value } }),
    );
    localStorage.setItem(this.storageKey, value);
  }

  private handleKeyNavigation = (event: KeyboardEvent): void => {
    let newIndex = this.currentTabIndex;

    switch (event.key) {
      case "ArrowRight": {
        for (let offset = 1; offset < this.triggers.length; offset++) {
          const index = (this.currentTabIndex + offset) % this.triggers.length;
          if (!this.triggers[index].disabled) {
            newIndex = index;
            break;
          }
        }
        break;
      }
      case "ArrowLeft": {
        for (let offset = 1; offset < this.triggers.length; offset++) {
          const index =
            (this.currentTabIndex - offset + this.triggers.length) % this.triggers.length;
          if (!this.triggers[index].disabled) {
            newIndex = index;
            break;
          }
        }
        break;
      }
      case "Home": {
        for (let index = 0; index < this.triggers.length; index++) {
          if (!this.triggers[index].disabled) {
            newIndex = index;
            break;
          }
        }
        break;
      }
      case "End": {
        for (let index = this.triggers.length - 1; index >= 0; index--) {
          if (!this.triggers[index].disabled) {
            newIndex = index;
            break;
          }
        }
        break;
      }
      default:
        return;
    }

    event.preventDefault();
    const newTrigger = this.triggers[newIndex];
    const value = newTrigger.getAttribute("data-value");
    if (!value) return;

    this.showTab(value);
    this.currentTabIndex = newIndex;
    this.setTabIndex();
    newTrigger.focus();
    this.dispatchSyncEvent(value);
  };

  private handleClick(trigger: HTMLElement, index: number): void {
    const value = trigger.getAttribute("data-value");
    if (!value) return;

    this.showTab(value);
    this.currentTabIndex = index;
    this.setTabIndex();
    trigger.focus();
    this.dispatchSyncEvent(value);
  }

  private addEventListeners(): void {
    this.triggers.forEach((trigger, index) => {
      trigger.addEventListener("click", () => this.handleClick(trigger, index));
      trigger.addEventListener("keydown", (event) => this.handleKeyNavigation(event));
    });
  }

  private showTab(value: TabValue): void {
    const trigger = this.valueToTriggerMap.get(value);
    const content = this.valueToContentMap.get(value);
    if (!trigger || !content) return;

    this.triggers.forEach((candidate) => {
      const isActive = candidate === trigger;
      candidate.setAttribute("data-state", isActive ? "active" : "inactive");
      candidate.setAttribute("aria-selected", isActive.toString());
    });
    this.contents.forEach((candidate) => {
      const isActive = candidate === content;
      candidate.setAttribute("data-state", isActive ? "active" : "inactive");
      candidate.hidden = !isActive;
    });

    const nestedTabs = content.querySelectorAll<HTMLElement>(".starwind-tabs");
    nestedTabs.forEach((nestedTab) => {
      if (!tabInstances.has(nestedTab)) {
        const handler = new TabsHandler(nestedTab, tabCounter++);
        tabInstances.set(nestedTab, handler);
      }
    });
  }
}

const tabInstances = new WeakMap<HTMLElement, TabsHandler>();
let tabCounter = 0;

/** Initializes top-level Starwind tabs in rendered content once per element. */
export function initializeStarwindTabs(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>(".starwind-tabs").forEach((tabs) => {
    const isNested = Boolean(tabs.closest("[data-tabs-content]"));
    if (!isNested && !tabInstances.has(tabs)) {
      tabInstances.set(tabs, new TabsHandler(tabs, tabCounter++));
    }
  });
}
