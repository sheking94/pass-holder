import type { p2p } from "@passholder/core";
import { SaveCandidates, type Sender } from "../../src/save/candidates.ts";
import type { SaveCandidateMessage } from "../../src/save/messages.ts";
import { STORAGE_KEYS } from "../../src/storage.ts";
import { VaultStore } from "../../src/vault-store.ts";
import { pairedBrowser } from "../fake-phone.ts";

/** Shared by the SaveCandidates tests: a paired vault with two logins and SaveCandidates on fakes. */
export function login(
  name: string,
  urls: string[],
  username = "jan",
  password = "old",
): p2p.EntryContentV3 {
  return {
    type: "login",
    name,
    note: "",
    custom: [],
    fields: { username, password, totp: "", urls, androidApps: [] },
  };
}

export const EXT = "ext-id";
export const PAGE = "https://shop.pl/login";
export const scriptSender = (tabId = 7, url = PAGE, tabUrl = PAGE): Sender => ({
  id: EXT,
  url,
  tab: { id: tabId, url: tabUrl },
});
export const extSender: Sender = { id: EXT, url: `chrome-extension://${EXT}/popup.html` };
export const candidate = (o: Partial<SaveCandidateMessage> = {}): SaveCandidateMessage => ({
  target: "background",
  type: "save-candidate",
  username: "jan",
  password: "new",
  formSignature: "u|p",
  ...o,
});

/** What SaveCandidates asked the question window to do, per tab. */
export type PromptCall =
  | { type: "save-show"; candidateId: string }
  | { type: "save-hide" }
  | { type: "close-window" }
  | { type: "badge" };

export async function setup(
  o: { locked?: boolean; onSend?: (tabId: number, m: PromptCall) => void } = {},
) {
  let t = 1_000_000;
  const b = await pairedBrowser({ now: () => t });
  await b.store.putEntry("l1", login("Bank", ["https://bank.pl"], "jan", "bankpass"));
  await b.store.putEntry("s1", login("Shop", ["https://shop.pl"], "jan", "old"));
  if (o.locked) await b.store.lock();
  const sent: { tabId: number; m: PromptCall }[] = [];
  const record = async (tabId: number, m: PromptCall) => {
    sent.push({ tabId, m });
    o.onSend?.(tabId, m);
  };
  const alarms = new Map<string, number>();
  const cleared: string[] = [];
  const timers: { ms: number; fn: () => void }[] = [];
  let n = 0;
  const sc = new SaveCandidates({
    // A new VaultStore per call, like background.ts: nothing may rely on state from an earlier call.
    store: () => new VaultStore(b.local, b.session, b.makeClient, () => t),
    session: b.session,
    local: b.local,
    selfId: EXT,
    prompt: {
      show: (tabId, candidateId) => record(tabId, { type: "save-show", candidateId }),
      hide: (tabId) => record(tabId, { type: "save-hide" }),
      closeWindow: (tabId) => record(tabId, { type: "close-window" }),
      badge: (tabId) => record(tabId, { type: "badge" }),
    },
    alarms: {
      create: async (name, info) => {
        alarms.set(name, info.when);
      },
      clear: async (name) => {
        cleared.push(name);
        return alarms.delete(name);
      },
    },
    now: () => t,
    newId: () => `id${++n}`,
    later: (ms, fn) => {
      timers.push({ ms, fn });
    },
  });
  const stored = async () =>
    (await b.session.get<
      Record<string, { id: string; url: string; password: string; formSignature: string }>
    >(STORAGE_KEYS.saveCandidates)) ?? {};
  const fresh = async () => {
    const store = new VaultStore(b.local, b.session, b.makeClient, () => t);
    await store.resume({ touch: false });
    return store;
  };
  return {
    ...b,
    fresh,
    sc,
    sent,
    alarms,
    cleared,
    timers,
    stored,
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}
