import { describe, expect, it } from "vitest";
import type { p2p } from "@passholder/core";
import { LOCKED } from "../../src/autofill/fill-tab.ts";
import {
  neverList, removeFromNever, SAVE_ALARM_PREFIX, SAVE_TTL_MS, SAVED_HIDE_MS, SaveCandidates, type Sender,
} from "../../src/save/candidates.ts";
import type { SaveCandidateMessage, ToWatchMessage } from "../../src/save/messages.ts";
import { STORAGE_KEYS, memoryStore } from "../../src/storage.ts";
import { pairedBrowser } from "../fake-phone.ts";

function login(name: string, urls: string[], username = "jan", password = "old"): p2p.EntryContentV3 {
  return { type: "login", name, note: "", custom: [], fields: { username, password, totp: "", urls, androidApps: [] } };
}

const EXT = "ext-id";
const PAGE = "https://shop.pl/login";
const scriptSender = (tabId = 7, url = PAGE, tabUrl = PAGE): Sender => ({ id: EXT, url, tab: { id: tabId, url: tabUrl } });
const extSender: Sender = { id: EXT, url: `chrome-extension://${EXT}/popup.html` };
const candidate = (o: Partial<SaveCandidateMessage> = {}): SaveCandidateMessage => ({
  target: "background", type: "save-candidate", username: "jan", password: "new", formSignature: "u|p", ...o,
});

async function setup(o: { locked?: boolean } = {}) {
  let t = 1_000_000;
  const b = await pairedBrowser({ now: () => t });
  await b.store.putEntry("l1", login("Bank", ["https://bank.pl"], "jan", "bankpass"));
  await b.store.putEntry("s1", login("Shop", ["https://shop.pl"], "jan", "old"));
  if (o.locked) await b.store.lock();
  const sent: { tabId: number; m: ToWatchMessage }[] = [];
  const alarms = new Map<string, number>();
  const cleared: string[] = [];
  const timers: { ms: number; fn: () => void }[] = [];
  let n = 0;
  const sc = new SaveCandidates({
    store: () => b.store,
    session: b.session,
    local: b.local,
    selfId: EXT,
    sendToTab: async (tabId, m) => { sent.push({ tabId, m }); },
    alarms: {
      create: async (name, info) => { alarms.set(name, info.when); },
      clear: async (name) => { cleared.push(name); return alarms.delete(name); },
    },
    now: () => t,
    newId: () => `id${++n}`,
    later: (ms, fn) => { timers.push({ ms, fn }); },
  });
  const stored = async () => (await b.session.get<Record<string, { id: string; url: string; password: string; formSignature: string }>>(STORAGE_KEYS.saveCandidates)) ?? {};
  return { ...b, sc, sent, alarms, cleared, timers, stored, advance: (ms: number) => { t += ms; }, now: () => t };
}

describe("SaveCandidates", () => {
  it("stores a candidate and shows the panel", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const c = (await s.stored())["7"]!;
    expect(c.password).toBe("new");
    expect(await s.local.get(STORAGE_KEYS.saveCandidates)).toBeUndefined();
    expect(s.sent).toEqual([{ tabId: 7, m: { target: "save-watch", type: "save-show", candidateId: c.id } }]);
    expect(s.alarms.get(`${SAVE_ALARM_PREFIX}7`)).toBe(s.now() + SAVE_TTL_MS);
  }, 30_000);

  it("takes the address from sender.url, not the message", async () => {
    const s = await setup();
    await s.sc.onCandidate({ ...candidate(), url: "https://evil.example" } as SaveCandidateMessage, scriptSender());
    const c = (await s.stored())["7"]!;
    expect(c.url).toBe("shop.pl");
    expect(c.formSignature).toBe("https://shop.pl|u|p");
  }, 30_000);

  it("ignores messages without a tab or from another extension", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), { id: EXT, url: PAGE });
    await s.sc.onCandidate(candidate(), { ...scriptSender(), id: "other" });
    await s.sc.onCandidate(candidate(), scriptSender(7, "chrome-extension://x/a.html", "chrome-extension://x/a.html"));
    expect(await s.stored()).toEqual({});
    expect(s.sent).toEqual([]);
  }, 30_000);

  it("ignores a frame from another origin than the tab", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender(7, "https://ads.example/frame", PAGE));
    expect(await s.stored()).toEqual({});
    expect(s.sent).toEqual([]);
  }, 30_000);

  it("skips hosts on the never list", async () => {
    const s = await setup();
    await s.local.set(STORAGE_KEYS.saveNever, ["shop.pl"]);
    await s.sc.onCandidate(candidate(), scriptSender());
    expect(await s.stored()).toEqual({});
    expect(s.sent).toEqual([]);
  }, 30_000);

  it("skips when the same login and password exist", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate({ password: "old" }), scriptSender());
    expect(await s.stored()).toEqual({});
    expect(s.sent).toEqual([]);
  }, 30_000);

  it("newer candidate replaces the older in the same tab, another tab keeps its own", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate({ password: "first" }), scriptSender(7));
    await s.sc.onCandidate(candidate({ password: "other" }), scriptSender(8));
    await s.sc.onCandidate(candidate({ password: "second" }), scriptSender(7));
    const all = await s.stored();
    expect(all["7"]!.password).toBe("second");
    expect(all["8"]!.password).toBe("other");
  }, 30_000);

  it("pending shows the panel within two minutes", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    s.advance(SAVE_TTL_MS - 1);
    expect(await s.sc.onPending({ target: "background", type: "save-pending", emptyLoginForms: [] }, scriptSender(7, "https://shop.pl/home"))).toEqual({ candidateId: id });
  }, 30_000);

  it("pending shows nothing after two minutes and drops the candidate", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    s.advance(SAVE_TTL_MS);
    expect(await s.sc.onPending({ target: "background", type: "save-pending", emptyLoginForms: [] }, scriptSender())).toEqual({});
    expect(await s.stored()).toEqual({});
  }, 30_000);

  it("pending from another origin still shows the panel", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    const other = scriptSender(7, "https://sso.example/done", "https://sso.example/done");
    expect(await s.sc.onPending({ target: "background", type: "save-pending", emptyLoginForms: ["u|p"] }, other)).toEqual({ candidateId: id });
  }, 30_000);

  it("pending hides the panel when the same form came back empty", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const r = await s.sc.onPending({ target: "background", type: "save-pending", emptyLoginForms: ["x|y", "u|p"] }, scriptSender());
    expect(r).toEqual({});
    expect(Object.keys(await s.stored())).toEqual(["7"]);
  }, 30_000);

  it("pending without a candidate answers nothing", async () => {
    const s = await setup();
    expect(await s.sc.onPending({ target: "background", type: "save-pending", emptyLoginForms: [] }, scriptSender())).toEqual({});
  }, 30_000);

  it("info has no password and reports create or update", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate({ username: "anna" }), scriptSender(7));
    await s.sc.onCandidate(candidate(), scriptSender(8));
    const c7 = (await s.stored())["7"]!;
    const create = await s.sc.info({ target: "background", type: "save-info", candidateId: c7.id }, extSender);
    expect(create).toEqual({ id: c7.id, host: "shop.pl", username: "anna", decision: "create", locked: false });
    const update = await s.sc.info({ target: "background", type: "save-info", tabId: 8 }, extSender);
    expect(update).toMatchObject({ host: "shop.pl", username: "jan", decision: "update", locked: false });
    expect(JSON.stringify([create, update])).not.toContain("new");
  }, 30_000);

  it("info of a locked vault has no decision", async () => {
    const s = await setup({ locked: true });
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    expect(await s.sc.info({ target: "background", type: "save-info", candidateId: id }, extSender)).toEqual({
      id, host: "shop.pl", username: "jan", decision: null, locked: true,
    });
  }, 30_000);

  it("info drops the candidate when after unlocking the login already exists", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    await s.store.putEntry("s1", login("Shop", ["https://shop.pl"], "jan", "new"));
    expect(await s.sc.info({ target: "background", type: "save-info", candidateId: id }, extSender)).toBeUndefined();
    expect(await s.stored()).toEqual({});
  }, 30_000);

  it("info and answer only from extension pages", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    const web: Sender = { id: EXT, url: PAGE, tab: { id: 7, url: PAGE } };
    expect(await s.sc.info({ target: "background", type: "save-info", candidateId: id }, web)).toBeUndefined();
    expect(await s.sc.info({ target: "background", type: "save-info", candidateId: id }, { ...extSender, id: "other" })).toBeUndefined();
    expect((await s.sc.answer({ target: "background", type: "save-answer", candidateId: id, answer: "save" }, web)).ok).toBe(false);
    expect(s.store.pendingCount()).toBe(2);
  }, 30_000);

  it("answer save creates a login and hides the panel after SAVED_HIDE_MS", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate({ username: "anna" }), scriptSender());
    const id = (await s.stored())["7"]!.id;
    const before = s.store.pendingCount();
    s.sent.length = 0;
    expect(await s.sc.answer({ target: "background", type: "save-answer", candidateId: id, answer: "save" }, extSender)).toEqual({ ok: true });
    expect(s.store.pendingCount()).toBe(before + 1);
    const created = s.store.listEntries("login").find((e) => e.data.type === "login" && e.data.fields.username === "anna")!;
    expect(created.data).toMatchObject({ name: "shop.pl", fields: { password: "new", urls: ["shop.pl"] } });
    expect(await s.stored()).toEqual({});
    expect(s.sent).toEqual([]);
    expect(s.timers.map((t) => t.ms)).toEqual([SAVED_HIDE_MS]);
    s.timers[0]!.fn();
    expect(s.sent).toEqual([{ tabId: 7, m: { target: "save-watch", type: "save-hide" } }]);
  }, 30_000);

  it("answer save updates only the password", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    expect(await s.sc.answer({ target: "background", type: "save-answer", candidateId: id, answer: "save" }, extSender)).toEqual({ ok: true });
    const shop = s.store.getEntry("s1")!;
    expect(shop.data).toMatchObject({ name: "Shop", fields: { username: "jan", password: "new", urls: ["https://shop.pl"] } });
    expect(s.store.listEntries("login")).toHaveLength(2);
  }, 30_000);

  it("answer save does nothing when the login appeared meanwhile", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    await s.store.putEntry("s1", login("Shop", ["https://shop.pl"], "jan", "new"));
    const before = s.store.pendingCount();
    expect(await s.sc.answer({ target: "background", type: "save-answer", candidateId: id, answer: "save" }, extSender)).toEqual({ ok: true });
    expect(s.store.pendingCount()).toBe(before);
    expect(await s.stored()).toEqual({});
  }, 30_000);

  it("answer later removes the candidate and hides at once", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    s.sent.length = 0;
    expect(await s.sc.answer({ target: "background", type: "save-answer", candidateId: id, answer: "later" }, extSender)).toEqual({ ok: true });
    expect(await s.stored()).toEqual({});
    expect(s.sent).toEqual([{ tabId: 7, m: { target: "save-watch", type: "save-hide" } }]);
    expect(s.cleared).toContain(`${SAVE_ALARM_PREFIX}7`);
  }, 30_000);

  it("answer never adds the host to the list", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    s.sent.length = 0;
    expect(await s.sc.answer({ target: "background", type: "save-answer", candidateId: id, answer: "never" }, extSender)).toEqual({ ok: true });
    expect(await neverList(s.local)).toEqual(["shop.pl"]);
    expect(await s.stored()).toEqual({});
    expect(s.sent).toEqual([{ tabId: 7, m: { target: "save-watch", type: "save-hide" } }]);
    await removeFromNever(s.local, "shop.pl");
    expect(await neverList(s.local)).toEqual([]);
  }, 30_000);

  it("answer save when locked fails and keeps the candidate", async () => {
    const s = await setup({ locked: true });
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    expect(await s.sc.answer({ target: "background", type: "save-answer", candidateId: id, answer: "save" }, extSender)).toEqual({ ok: false, error: LOCKED });
    expect(Object.keys(await s.stored())).toEqual(["7"]);
  }, 30_000);

  it("answer for an unknown candidate fails", async () => {
    const s = await setup();
    const r = await s.sc.answer({ target: "background", type: "save-answer", candidateId: "nope", answer: "later" }, extSender);
    expect(r.ok).toBe(false);
  }, 30_000);

  it("alarm and closed tab remove the candidate", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender(7));
    await s.sc.onCandidate(candidate(), scriptSender(8));
    await s.sc.onAlarm(`${SAVE_ALARM_PREFIX}7`);
    expect(Object.keys(await s.stored())).toEqual(["8"]);
    await s.sc.onAlarm("other");
    expect(Object.keys(await s.stored())).toEqual(["8"]);
    await s.sc.onTabRemoved(8);
    expect(await s.stored()).toEqual({});
  }, 30_000);
});
