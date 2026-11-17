import { isMainTab, modeQuery, pageMode } from "./page-mode.ts";

/**
 * Opening the extension page in a normal browser tab.
 *
 * The toolbar popup closes as soon as it loses focus (a click on the web page, another window,
 * a permission prompt), and everything typed into it is lost. A tab stays open, so the user
 * can switch between the page and PassHolder without losing a half-filled form.
 */

/** The parts of the chrome.* API used here, so tests can pass a fake. */
export interface OpenTabApi {
  /** URLs and tab ids of the extension's own pages that are open in tabs. */
  openTabs(): Promise<{ tabId: number; windowId: number; url: string }[]>;
  focus(tabId: number, windowId: number): Promise<void>;
  create(url: string): Promise<void>;
}

export function chromeOpenTabApi(): OpenTabApi {
  return {
    async openTabs() {
      // runtime.getContexts lists the extension's own pages without the "tabs" permission.
      const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
      return contexts.map((c) => ({
        tabId: c.tabId,
        windowId: c.windowId,
        url: c.documentUrl ?? "",
      }));
    },
    async focus(tabId, windowId) {
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(windowId, { focused: true });
    },
    async create(url) {
      await chrome.tabs.create({ url });
    },
  };
}

/**
 * Switches to a PassHolder tab if one is already open, otherwise opens a new one.
 * `pageUrl` is the full URL of popup.html, e.g. chrome.runtime.getURL("popup.html").
 */
export async function openInTab(api: OpenTabApi, pageUrl: string): Promise<void> {
  const existing = (await api.openTabs()).find(
    (t) => t.url.startsWith(pageUrl) && isMainTab(pageMode(new URL(t.url).search)),
  );
  if (existing) return api.focus(existing.tabId, existing.windowId);
  await api.create(`${pageUrl}${modeQuery("tab")}`);
}
