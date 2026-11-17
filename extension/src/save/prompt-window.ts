/**
 * The save question in its own small window (chrome.windows, type "popup") plus a badge on the toolbar icon of
 * the tab. Not a frame in the page: the page can neither see, cover nor click it (review V3-S1).
 */
import { STORAGE_KEYS, type KeyValueStore } from "../storage.ts";

export const PROMPT_WIDTH = 380;
export const PROMPT_HEIGHT = 420;
/** Gap between the prompt and the right edge of the tab's window. */
const PROMPT_RIGHT_MARGIN = 16;
/** Distance from the top of the window, below the tab strip and the address bar. */
const PROMPT_TOP_OFFSET = 80;
/** Badge text while the tab has a question waiting; clicking the icon shows it in the popup. */
export const PROMPT_BADGE = "?";

export interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WindowApi {
  /** Bounds of the browser window holding the tab; undefined when unknown. */
  tabWindow(tabId: number): Promise<Partial<Bounds> | undefined>;
  /** Opens a focused popup window; its id. */
  open(url: string, bounds: Bounds): Promise<number | undefined>;
  /** Loads another url in the window's only tab. */
  navigate(windowId: number, url: string): Promise<void>;
  close(windowId: number): Promise<void>;
  badge(tabId: number, text: string): Promise<void>;
}

type Open = Record<string, { windowId: number; candidateId: string }>;

/** The tab and window the prompt is placed against: top right of the tab's window, like the old panel. */
export function promptBounds(of: Partial<Bounds> | undefined): Bounds {
  const left =
    (of?.left ?? 0) + Math.max(0, (of?.width ?? PROMPT_WIDTH) - PROMPT_WIDTH - PROMPT_RIGHT_MARGIN);
  return {
    left,
    top: (of?.top ?? 0) + PROMPT_TOP_OFFSET,
    width: PROMPT_WIDTH,
    height: PROMPT_HEIGHT,
  };
}

export class PromptWindows {
  constructor(
    private readonly api: WindowApi,
    /** chrome.storage.session: which window shows which tab's question survives a stopped service worker. */
    private readonly session: KeyValueStore,
    private readonly url: (candidateId: string) => string,
  ) {}

  private async all(): Promise<Open> {
    return (await this.session.get<Open>(STORAGE_KEYS.savePromptWindows)) ?? {};
  }

  private async write(all: Open): Promise<void> {
    if (Object.keys(all).length > 0) await this.session.set(STORAGE_KEYS.savePromptWindows, all);
    else await this.session.remove(STORAGE_KEYS.savePromptWindows);
  }

  /** Shows the candidate's question: opens the window, or points the open one at a newer candidate. */
  async show(tabId: number, candidateId: string): Promise<void> {
    await this.badge(tabId);
    const all = await this.all();
    const open = all[String(tabId)];
    if (open) {
      if (open.candidateId === candidateId) return;
      try {
        await this.api.navigate(open.windowId, this.url(candidateId));
        all[String(tabId)] = { ...open, candidateId };
        await this.write(all);
        return;
      } catch {
        // The window is gone (closed while the service worker was stopped): open a new one.
      }
    }
    const windowId = await this.api
      .open(
        this.url(candidateId),
        promptBounds(await this.api.tabWindow(tabId).catch(() => undefined)),
      )
      .catch(() => undefined);
    if (windowId === undefined) return; // the badge still leads to the question in the popup
    all[String(tabId)] = { windowId, candidateId };
    await this.write(all);
  }

  /** Only the badge: the question waits in the popup (the user closed the window, or it failed to open). */
  async badge(tabId: number): Promise<void> {
    await this.api.badge(tabId, PROMPT_BADGE).catch(() => undefined);
  }

  /** Closes the tab's window, keeps the badge. */
  async closeWindow(tabId: number): Promise<void> {
    const all = await this.all();
    const open = all[String(tabId)];
    if (!open) return;
    // Forget it first: onRemoved for this window must not look like the user closing it.
    delete all[String(tabId)];
    await this.write(all);
    await this.api.close(open.windowId).catch(() => undefined);
  }

  /** No more question for the tab: closes the window and clears the badge. */
  async hide(tabId: number): Promise<void> {
    await this.api.badge(tabId, "").catch(() => undefined);
    await this.closeWindow(tabId);
  }

  /** A window was closed; the tab whose question it showed, when it was one of ours closed by the user. */
  async closedByUser(windowId: number): Promise<number | undefined> {
    const all = await this.all();
    const entry = Object.entries(all).find(([, o]) => o.windowId === windowId);
    if (!entry) return undefined;
    delete all[entry[0]];
    await this.write(all);
    return Number(entry[0]);
  }
}

export function chromeWindowApi(): WindowApi {
  return {
    async tabWindow(tabId) {
      const tab = await chrome.tabs.get(tabId);
      const w = await chrome.windows.get(tab.windowId);
      return { left: w.left, top: w.top, width: w.width, height: w.height };
    },
    async open(url, bounds) {
      let w: chrome.windows.Window | undefined;
      try {
        w = await chrome.windows.create({ url, type: "popup", focused: true, ...bounds });
      } catch {
        // "Bounds must be at least 50% within visible screen space" (the tab's window reaches off screen):
        // let Chrome place it.
        w = await chrome.windows.create({
          url,
          type: "popup",
          focused: true,
          width: bounds.width,
          height: bounds.height,
        });
      }
      return w?.id;
    },
    async navigate(windowId, url) {
      const [tab] = await chrome.tabs.query({ windowId });
      if (tab?.id === undefined) throw new Error("no tab");
      await chrome.tabs.update(tab.id, { url });
    },
    close: (windowId) => chrome.windows.remove(windowId),
    badge: (tabId, text) => chrome.action.setBadgeText({ tabId, text }),
  };
}
