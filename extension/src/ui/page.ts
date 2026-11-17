import { chromeOpenTabApi, openInTab } from "../open-in-tab.ts";
import type { p2p } from "@passholder/core";
import { editQuery, isInTab, modeQuery, pageMode, type TabMode } from "../page-mode.ts";
import { h } from "./dom.ts";

/** Which page this is (popup or one of the tabs); see page-mode.ts. */
export const MODE = pageMode(location.search);
export const IN_TAB = isInTab(MODE);

const PAGE = "popup.html";

/**
 * Shows a view that needs a tab (a permission prompt or a file chooser would close the popup).
 * In any tab the view is shown right here; in the popup a tab in that mode is opened and the popup closes.
 */
export async function showInTab(mode: TabMode, view: () => unknown): Promise<void> {
  if (IN_TAB) {
    await view();
    return;
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL(PAGE + modeQuery(mode)) });
  window.close();
}

/** Opens the form of this entry type (of the saved entry with this id, or a new one) in a tab and closes the popup. */
export async function openEditTab(type: p2p.EntryType, id?: string): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL(PAGE + editQuery(type, id)) });
  window.close();
}

/** Button shown only in the popup: switches to a PassHolder tab (opens one if needed). */
export function openInTabButton() {
  if (IN_TAB) return undefined;
  return h(
    "div",
    { class: "topbar" },
    h(
      "button",
      {
        type: "button",
        class: "small",
        title: "Karta nie zamyka się po kliknięciu na stronie, więc wpisane dane nie znikają",
        onclick: async () => {
          await openInTab(chromeOpenTabApi(), chrome.runtime.getURL(PAGE));
          window.close();
        },
      },
      "Otwórz w karcie ↗",
    ),
  );
}
