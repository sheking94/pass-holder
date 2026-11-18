import { UNLOCK_AND_RETRY } from "../error-messages.ts";
import type { ActionResult } from "../result.ts";
import { planFor, type FillPlan } from "@passholder/core/autofill";
import { webUrl } from "../web-url.ts";
import { matchSavedLogins } from "./saved-logins.ts";
import type { VaultStore } from "../vault-store.ts";

export const NOT_MATCHING = "Ta strona nie pasuje do loginu";
export const CARD_NEEDS_HTTPS = "Kartę wypełniam tylko na stronach https";
export const UNSUPPORTED_PAGE = "Na tej stronie nie można wypełniać";
export const CANNOT_FILL_ENTRY = "Nie można wypełnić tym wpisem";
export const NO_FIELDS = {
  login: "Nie znaleziono pól logowania",
  card: "Nie znaleziono pól karty (mogą być w ramce operatora płatności), skopiuj dane ręcznie",
  contact: "Nie znaleziono pól adresu",
} as const;

export interface FillTabApi {
  get(tabId: number): Promise<{ id?: number; url?: string }>;
  /**
   * Runs the page script in the tab and returns how many fields it filled (all frames summed).
   * Frames whose top origin is not expectedOrigin (the tab navigated after the check) fill nothing.
   */
  inject(tabId: number, plan: FillPlan, expectedOrigin: string): Promise<number>;
}

export type FillMessage = { target: "background"; type: "fill"; entryId: string; tabId: number };

export function chromeFillTabApi(): FillTabApi {
  return {
    get: (tabId) => chrome.tabs.get(tabId),
    async inject(tabId, plan, expectedOrigin) {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["autofill-content.js"],
      });
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (p: FillPlan, origin: string) =>
          (
            globalThis as { passholderFill?: (p: FillPlan, origin: string) => { filled: number } }
          ).passholderFill?.(p, origin).filled ?? 0,
        args: [plan, expectedOrigin],
      });
      return results.reduce((sum, r) => sum + (typeof r.result === "number" ? r.result : 0), 0);
    },
  };
}

const fail = (error: string): ActionResult => ({ ok: false, error });

/** Fills the tab with one entry, re-checking in here (not trusting the popup) that the page is allowed. */
export async function fillTab(
  store: VaultStore,
  tabs: FillTabApi,
  tabId: number,
  entryId: string,
): Promise<ActionResult> {
  if (!(await store.resume())) return fail(UNLOCK_AND_RETRY);
  const entry = store.getEntry(entryId);
  const plan = entry && planFor(entry.data);
  if (!entry || !plan) return fail(CANNOT_FILL_ENTRY);

  const tab = await tabs.get(tabId);
  const url = webUrl(tab.url);
  if (!url) return fail(UNSUPPORTED_PAGE);

  if (entry.data.type === "login") {
    if (matchSavedLogins(url.href, [entry]).length === 0) return fail(NOT_MATCHING);
  } else if (plan.kind === "card" && url.protocol !== "https:" && url.hostname !== "localhost") {
    return fail(CARD_NEEDS_HTTPS);
  }

  let filled: number;
  try {
    filled = await tabs.inject(tabId, plan, url.origin);
  } catch {
    return fail(UNSUPPORTED_PAGE);
  }
  return filled > 0 ? { ok: true } : fail(NO_FIELDS[plan.kind]);
}

/**
 * The Ctrl+Shift+L shortcut: fills when exactly one login is saved for the page's exact host, otherwise shows the popup
 * (a subdomain match always needs a choice there, review V3-S2).
 */
export async function onFillCommand(
  store: VaultStore,
  tabs: FillTabApi,
  tab: { id?: number; url?: string } | undefined,
  openPopup: () => Promise<void>,
): Promise<void> {
  if (tab?.id === undefined || !tab.url || !(await store.resume())) return openPopup();
  const matches = matchSavedLogins(tab.url, store.listEntries("login"), { exactOnly: true });
  if (matches.length !== 1) return openPopup();
  const result = await fillTab(store, tabs, tab.id, matches[0]!.id);
  if (!result.ok) await openPopup();
}
