import type { FillMessage, FillResult } from "../autofill/fill-tab.ts";
import { isInTab, pageMode } from "../page-mode.ts";

/** The tab the popup was opened over; undefined in a PassHolder tab (it is its own active tab) or without id/url. */
export async function activeTab(): Promise<{ id: number; url: string } | undefined> {
  if (isInTab(pageMode(location.search))) return undefined;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || !tab.url) return undefined;
  return { id: tab.id, url: tab.url };
}

/** Asks the service worker to fill the entry into the tab. */
export async function requestFill(tabId: number, entryId: string): Promise<FillResult> {
  const message: FillMessage = { target: "background", type: "fill", entryId, tabId };
  return (await chrome.runtime.sendMessage(message)) as FillResult;
}
