/**
 * Popup views under happy-dom: a fake chrome.* and a vault paired with a FakePhone, so a test can render
 * a view and click through it. UI test files start with: // @vitest-environment happy-dom
 */
import type { p2p } from "@passholder/core";
import { vi } from "vitest";
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

/**
 * Creates <main id="app">, installs the fake chrome (storage, runtime.sendMessage into messages,
 * runtime.getURL, permissions.contains → true), navigator.clipboard (writes into clipboard) and a fetch
 * that reaches the fake phone; pairs with a FakePhone, adds entries, then loads the view modules afresh
 * and resumes their store, which it returns.
 */
export async function setupPopup(entries: { id: string; content: p2p.EntryContentV3 }[] = []) {
  document.body.replaceChildren();
  const app = document.createElement("main");
  app.id = "app";
  document.body.append(app);

  const clipboard: string[] = [];
  const messages: unknown[] = [];
  const local = fakeArea();
  const session = fakeArea();
  vi.stubGlobal("chrome", strict("chrome", {
    storage: strict("chrome.storage", { local, session }),
    runtime: strict("chrome.runtime", {
      sendMessage: async (message: unknown) => void messages.push(message),
      getURL: (path: string) => `chrome-extension://passholder/${path}`,
    }),
    permissions: strict("chrome.permissions", { contains: async () => true }),
  }));
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
  return { app, store, clipboard, messages, phone };
}

/**
 * Clicks and lets the handler's promises settle: microtasks and a few timer turns, enough for local work
 * such as crypto.subtle or storage. For a sync with the phone wait for its result with vi.waitFor.
 */
export async function click(el: Element): Promise<void> {
  (el as HTMLElement).click();
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The first visible (not inside [hidden]) button or label whose text is exactly text; throws when there is none. */
export function byText(root: Element, text: string): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>("button, label")].find((el) => !el.closest("[hidden]") && el.textContent?.trim() === text);
  if (!found) throw new Error(`No button or label „${text}”`);
  return found;
}
