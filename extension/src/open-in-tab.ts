/**
 * Opening the extension page in a normal browser tab.
 *
 * The toolbar popup closes as soon as it loses focus (a click on the web page, another window,
 * a permission prompt), and everything typed into it is lost. A tab stays open, so the user
 * can switch between the page and PassHolder without losing a half-filled form.
 */

/** Query parameter that marks the page as opened in a tab by the "Otwórz w karcie" button. */
export const TAB_PARAM = "tab";
/** Query parameter of the connect form tab (see openSetupTab in popup.ts). */
export const SETUP_PARAM = "setup";

/** True when the page was opened in a tab, not in the toolbar popup. */
export function isTabPage(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has(TAB_PARAM) || params.has(SETUP_PARAM);
}

/** The parts of the chrome.* API used here, so tests can pass a fake. */
export interface TabApi {
  /** URLs and tab ids of the extension's own pages that are open in tabs. */
  openTabs(): Promise<{ tabId: number; windowId: number; url: string }[]>;
  focus(tabId: number, windowId: number): Promise<void>;
  create(url: string): Promise<void>;
}

export function chromeTabApi(): TabApi {
  return {
    async openTabs() {
      // runtime.getContexts lists the extension's own pages without the "tabs" permission.
      const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
      return contexts.map((c) => ({ tabId: c.tabId, windowId: c.windowId, url: c.documentUrl ?? "" }));
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
export async function openInTab(api: TabApi, pageUrl: string): Promise<void> {
  const existing = (await api.openTabs()).find((t) => t.url.startsWith(pageUrl) && isTabPage(new URL(t.url).search));
  if (existing) return api.focus(existing.tabId, existing.windowId);
  await api.create(`${pageUrl}?${TAB_PARAM}`);
}
