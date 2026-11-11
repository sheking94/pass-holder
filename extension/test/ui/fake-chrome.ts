/**
 * Popup views under happy-dom: a fake chrome.* and a vault paired with a FakePhone, so a test can render
 * a view and click through it. Every UI test file starts with // @vitest-environment happy-dom and calls
 * teardownPopup() in afterEach. click() only lets quick handlers finish: await anything slower (saving,
 * syncing) with settle().
 */
import type { p2p } from "@passholder/core";
import { vi } from "vitest";
import type { FillResult } from "../../src/autofill/fill-tab.ts";
import type { SaveAnswerResponse, SavePromptInfo } from "../../src/save/messages.ts";
import { PhoneClient } from "../../src/phone-client.ts";
import { chromeStore, VaultStore } from "../../src/vault-store.ts";
import { CODE, FakePhone, networkFetch, PASSWORD, PHONE_URL, type Network } from "../fake-phone.ts";

/** chrome.storage.local / session on a Map (only the calls chromeStore makes). */
function fakeArea(): chrome.storage.StorageArea {
  const data = new Map<string, unknown>();
  const area = {
    async get(key: string) {
      return data.has(key) ? { [key]: structuredClone(data.get(key)) } : {};
    },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
    async remove(key: string) {
      data.delete(key);
    },
  };
  return area as unknown as chrome.storage.StorageArea;
}

/** An object whose missing properties throw, so a view reaching an API the stub lacks fails loudly. */
function strict<T extends object>(name: string, api: T): T {
  return new Proxy(api, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop in target) return Reflect.get(target, prop, receiver);
      throw new Error(`${name}.${prop} is not available in the fake chrome`);
    },
  });
}

/** navigator.clipboard as it was before the first setupPopup (saved is undefined when it had none). */
let clipboardDescriptor: { saved: PropertyDescriptor | undefined } | undefined;

/** Undoes setupPopup: restores chrome, fetch and navigator.clipboard, and empties the page. */
export function teardownPopup(): void {
  vi.unstubAllGlobals();
  if (clipboardDescriptor) {
    if (clipboardDescriptor.saved) Object.defineProperty(navigator, "clipboard", clipboardDescriptor.saved);
    else delete (navigator as unknown as Record<string, unknown>).clipboard;
    clipboardDescriptor = undefined;
  }
  document.body.replaceChildren();
}

/**
 * Creates <main id="app">, installs the fake chrome (storage, runtime.sendMessage into messages,
 * runtime.getURL, permissions.contains → true, tabs.query → options.activeTab, window.close → close; a "fill" message gets options.fillResult, "save-info" options.saveInfo, "save-answer" options.saveAnswer), navigator.clipboard (writes into clipboard) and a fetch
 * that reaches the fake phone; pairs with a FakePhone, adds entries, then loads the view modules afresh
 * and resumes their store, which it returns.
 */
export async function setupPopup(
  entries: { id: string; content: p2p.EntryContentV3 }[] = [],
  options: {
    activeTab?: { id: number; url: string };
    fillResult?: FillResult;
    /** The answer to "save-info" (an Error makes sendMessage reject) and to "save-answer" (default ok). */
    saveInfo?: SavePromptInfo | Error;
    saveAnswer?: SaveAnswerResponse;
    /** Host permissions: held (default: everything is allowed) and what permissions.request answers. */
    permissions?: { held?: string[]; requestResult?: boolean };
  } = {},
) {
  document.body.replaceChildren();
  const app = document.createElement("main");
  app.id = "app";
  document.body.append(app);

  const clipboard: string[] = [];
  const messages: unknown[] = [];
  const local = fakeArea();
  const session = fakeArea();
  const held = options.permissions?.held;
  const permissions = { requests: [] as string[][], removed: [] as string[][] };
  const permissionsApi = {
    contains: async ({ origins = [] }: { origins?: string[] }) => !held || origins.every((o) => held.includes(o)),
    request: (request: { origins?: string[] }, callback?: (granted: boolean) => void) => {
      permissions.requests.push(request.origins ?? []);
      const granted = options.permissions?.requestResult ?? true;
      if (granted && held) held.push(...(request.origins ?? []));
      setTimeout(() => callback?.(granted), 0);
    },
    remove: async ({ origins = [] }: { origins?: string[] }) => {
      permissions.removed.push(origins);
      if (held) for (const o of origins) held.splice(0, held.length, ...held.filter((x) => x !== o));
      return true;
    },
  };
  vi.stubGlobal("chrome", strict("chrome", {
    storage: strict("chrome.storage", { local, session }),
    runtime: strict("chrome.runtime", {
      sendMessage: async (message: unknown) => {
        messages.push(message);
        const type = (message as { type?: string }).type;
        if (type === "fill") return options.fillResult ?? { ok: true };
        if (type === "save-info") {
          if (options.saveInfo instanceof Error) throw options.saveInfo;
          return options.saveInfo;
        }
        if (type === "save-answer") return options.saveAnswer ?? { ok: true };
        return undefined;
      },
      getURL: (path: string) => `chrome-extension://passholder/${path}`,
      lastError: undefined,
    }),
    tabs: strict("chrome.tabs", {
      query: async () => (options.activeTab ? [options.activeTab] : []),
    }),
    permissions: strict("chrome.permissions", permissionsApi),
  }));
  const close = vi.fn();
  vi.stubGlobal("close", close);
  clipboardDescriptor ??= { saved: Object.getOwnPropertyDescriptor(navigator, "clipboard") };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void clipboard.push(text) },
  });

  const phone = await FakePhone.withVault(PASSWORD, [PHONE_URL]);
  const network: Network = new Map([[PHONE_URL, phone]]);
  const fetchFn = networkFetch(network);
  // The views' store builds its PhoneClients with the global fetch.
  vi.stubGlobal("fetch", fetchFn);
  const pairing = new VaultStore(chromeStore(local), chromeStore(session), (url) => new PhoneClient(url, fetchFn));
  phone.offerPairing();
  await pairing.pairStart(PHONE_URL, CODE, "Chrome (Linux)");
  await pairing.pairFinish(PASSWORD);
  for (const { id, content } of entries) await pairing.putEntry(id, content);

  vi.resetModules();
  const { store } = await import("../../src/ui/state.ts");
  if (!(await store.resume())) throw new Error("setupPopup: the views' store did not resume");
  return { app, store, clipboard, messages, phone, close, permissions };
}

/**
 * Clicks and lets quick handlers finish (microtasks and a few timer turns, e.g. a copy). A result that
 * takes longer (encryption on save, a sync) must be awaited with settle().
 */
export async function click(el: Element): Promise<void> {
  (el as HTMLElement).click();
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Waits until predicate returns something truthy (and does not throw); fails after timeout ms. */
export async function settle<T>(predicate: () => T, timeout = 5_000): Promise<T> {
  return vi.waitFor(() => {
    const value = predicate();
    if (!value) throw new Error("settle: not yet");
    return value;
  }, { timeout, interval: 5 });
}

/**
 * The index-th (from 0) visible (not inside [hidden]) button or label whose text is exactly text;
 * throws when there is none.
 */
export function byText(root: Element, text: string, index = 0): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>("button, label")]
    .filter((el) => !el.closest("[hidden]") && el.textContent?.trim() === text)[index];
  if (!found) throw new Error(`No button or label „${text}” #${index}`);
  return found;
}
