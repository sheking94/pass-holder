import { matchLogins, planFor, type FillPlan } from "@passholder/core/autofill";
import type { VaultStore } from "../vault-store.ts";

export const LOCKED = "Sejf jest zablokowany. Odblokuj go i spróbuj ponownie";
export const NOT_MATCHING = "Ta strona nie pasuje do loginu";
export const CARD_NEEDS_HTTPS = "Kartę wypełniam tylko na stronach https";
export const UNSUPPORTED_PAGE = "Na tej stronie nie można wypełniać";
export const CANNOT_FILL_ENTRY = "Nie można wypełnić tym wpisem";
export const NO_FIELDS = {
  login: "Nie znaleziono pól logowania",
  card: "Nie znaleziono pól karty (mogą być w ramce operatora płatności), skopiuj dane ręcznie",
  contact: "Nie znaleziono pól adresu",
} as const;

export interface TabApi {
  get(tabId: number): Promise<{ id?: number; url?: string }>;
  /** Runs the page script in the tab and returns how many fields it filled (all frames summed). */
  inject(tabId: number, plan: FillPlan): Promise<number>;
}

export type FillMessage = { target: "background"; type: "fill"; entryId: string; tabId: number };
export type FillResult = { ok: true } | { ok: false; error: string };

export function chromeTabApi(): TabApi {
  return {
    get: (tabId) => chrome.tabs.get(tabId),
    async inject(tabId, plan) {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["autofill-content.js"] });
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (p: FillPlan) => (globalThis as { passholderFill?: (p: FillPlan) => { filled: number } }).passholderFill?.(p).filled ?? 0,
        args: [plan],
      });
      return results.reduce((sum, r) => sum + (typeof r.result === "number" ? r.result : 0), 0);
    },
  };
}

const fail = (error: string): FillResult => ({ ok: false, error });

function pageUrl(raw: string | undefined): URL | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Fills the tab with one entry, re-checking in here (not trusting the popup) that the page is allowed. */
export async function fillTab(store: VaultStore, tabs: TabApi, tabId: number, entryId: string): Promise<FillResult> {
  if (!(await store.resume())) return fail(LOCKED);
  const entry = store.getEntry(entryId);
  const plan = entry && planFor(entry.data);
  if (!entry || !plan) return fail(CANNOT_FILL_ENTRY);

  const tab = await tabs.get(tabId);
  const url = pageUrl(tab.url);
  if (!url) return fail(UNSUPPORTED_PAGE);

  if (entry.data.type === "login") {
    const { urls } = entry.data.fields;
    if (matchLogins(url.href, [entry], () => ({ name: entry.data.name, urls })).length === 0) return fail(NOT_MATCHING);
  } else if (plan.kind === "card" && url.protocol !== "https:" && url.hostname !== "localhost") {
    return fail(CARD_NEEDS_HTTPS);
  }

  let filled: number;
  try {
    filled = await tabs.inject(tabId, plan);
  } catch {
    return fail(UNSUPPORTED_PAGE);
  }
  return filled > 0 ? { ok: true } : fail(NO_FIELDS[plan.kind]);
}

/** The Ctrl+Shift+L shortcut: fills when exactly one login matches the page, otherwise shows the popup. */
export async function onFillCommand(
  store: VaultStore,
  tabs: TabApi,
  tab: { id?: number; url?: string } | undefined,
  openPopup: () => Promise<void>,
): Promise<void> {
  if (tab?.id === undefined || !tab.url || !(await store.resume())) return openPopup();
  const matches = matchLogins(tab.url, store.listEntries("login"), (e) => ({ name: e.data.name, urls: e.data.type === "login" ? e.data.fields.urls : [] }));
  if (matches.length !== 1) return openPopup();
  const result = await fillTab(store, tabs, tab.id, matches[0]!.id);
  if (!result.ok) await openPopup();
}
