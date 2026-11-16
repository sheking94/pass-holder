import { describe, expect, it } from "vitest";
import type { p2p } from "@passholder/core";
import type { FillPlan } from "@passholder/core/autofill";
import {
  CANNOT_FILL_ENTRY,
  CARD_NEEDS_HTTPS,
  fillTab,
  LOCKED,
  NO_FIELDS,
  NOT_MATCHING,
  onFillCommand,
  UNSUPPORTED_PAGE,
  type TabApi,
} from "../../src/autofill/fill-tab.ts";
import { STORAGE_KEYS } from "../../src/storage.ts";
import { pairedBrowser } from "../fake-phone.ts";

function login(name: string, urls: string[]): p2p.EntryContentV3 {
  return {
    type: "login",
    name,
    note: "",
    custom: [],
    fields: { username: "jan", password: "s3cret", totp: "", urls, androidApps: [] },
  };
}
const card: p2p.EntryContentV3 = {
  type: "card",
  name: "Visa",
  note: "",
  custom: [],
  fields: {
    holder: "Jan",
    number: "4111 1111 1111 1111",
    expiry: "12/30",
    cvc: "123",
    pin: "1234",
  },
};
const contact: p2p.EntryContentV3 = {
  type: "contact",
  name: "Anna",
  note: "",
  custom: [],
  fields: {
    firstName: "Anna",
    lastName: "Nowak",
    birthDate: "",
    phones: [],
    emails: [],
    addresses: [],
  },
};

function fakeTabs(url: string | undefined, filled = 1) {
  const injected: FillPlan[] = [];
  const origins: string[] = [];
  const api: TabApi = {
    get: async (id) => ({ id, url }),
    inject: async (_id, plan, origin) => {
      injected.push(plan);
      origins.push(origin);
      return filled;
    },
  };
  return { api, injected, origins };
}

async function setup() {
  const b = await pairedBrowser();
  await b.store.putEntry("l1", login("Bank", ["https://bank.pl"]));
  await b.store.putEntry("c1", card);
  await b.store.putEntry("p1", contact);
  return b;
}

describe("fillTab", () => {
  it("fills a matching login", async () => {
    const { store } = await setup();
    const { api, injected } = fakeTabs("https://bank.pl/login");
    expect(await fillTab(store, api, 7, "l1")).toEqual({ ok: true });
    expect(injected).toEqual([{ kind: "login", username: "jan", password: "s3cret" }]);
  }, 30_000);

  it("pins the origin of the checked URL for the injected script", async () => {
    const { store } = await setup();
    const { api, origins } = fakeTabs("https://shop.pl:8443/pay?x=1#y");
    await fillTab(store, api, 7, "p1");
    expect(origins).toEqual(["https://shop.pl:8443"]);
  }, 30_000);

  it("refuses a login when the tab moved to another site", async () => {
    const { store } = await setup();
    const { api, injected } = fakeTabs("https://evil.example/login");
    expect(await fillTab(store, api, 7, "l1")).toEqual({ ok: false, error: NOT_MATCHING });
    expect(injected).toEqual([]);
  }, 30_000);

  it("refuses a card on http and allows it on http://localhost", async () => {
    const { store } = await setup();
    const http = fakeTabs("http://shop.pl/pay");
    expect(await fillTab(store, http.api, 7, "c1")).toEqual({ ok: false, error: CARD_NEEDS_HTTPS });
    expect(http.injected).toEqual([]);
    const local = fakeTabs("http://localhost:3000/pay");
    expect(await fillTab(store, local.api, 7, "c1")).toEqual({ ok: true });
    expect(local.injected[0]!.kind).toBe("card");
    const https = fakeTabs("https://shop.pl/pay");
    expect(await fillTab(store, https.api, 7, "c1")).toEqual({ ok: true });
  }, 30_000);

  it("fills a contact on any http(s) page", async () => {
    const { store } = await setup();
    const { api } = fakeTabs("http://shop.pl/");
    expect(await fillTab(store, api, 7, "p1")).toEqual({ ok: true });
  }, 30_000);

  it("refuses chrome:// pages and tabs without an address", async () => {
    const { store } = await setup();
    for (const url of ["chrome://extensions", undefined]) {
      const { api, injected } = fakeTabs(url);
      expect(await fillTab(store, api, 7, "p1")).toEqual({ ok: false, error: UNSUPPORTED_PAGE });
      expect(injected).toEqual([]);
    }
  }, 30_000);

  it("reports an unsupported page when injection throws", async () => {
    const { store } = await setup();
    const api: TabApi = {
      get: async (id) => ({ id, url: "https://bank.pl/" }),
      inject: async () => {
        throw new Error("no access");
      },
    };
    expect(await fillTab(store, api, 7, "l1")).toEqual({ ok: false, error: UNSUPPORTED_PAGE });
  }, 30_000);

  it("reports a locked vault", async () => {
    const { store, session } = await setup();
    await session.remove(STORAGE_KEYS.sessionKeys);
    const { api, injected } = fakeTabs("https://bank.pl/");
    expect(await fillTab(store, api, 7, "l1")).toEqual({ ok: false, error: LOCKED });
    expect(injected).toEqual([]);
  }, 30_000);

  it("reports a missing entry", async () => {
    const { store } = await setup();
    const { api, injected } = fakeTabs("https://bank.pl/");
    expect(await fillTab(store, api, 7, "nope")).toEqual({ ok: false, error: CANNOT_FILL_ENTRY });
    expect(injected).toEqual([]);
  }, 30_000);

  it("refuses an entry type that has no fill plan (note)", async () => {
    const { store } = await setup();
    await store.putEntry("n1", {
      type: "note",
      name: "Notka",
      note: "tekst",
      custom: [],
      fields: {},
    } as p2p.EntryContentV3);
    const { api, injected } = fakeTabs("https://bank.pl/");
    expect(await fillTab(store, api, 7, "n1")).toEqual({ ok: false, error: CANNOT_FILL_ENTRY });
    expect(injected).toEqual([]);
  }, 30_000);

  it("reports no fields with the text for the kind", async () => {
    const { store } = await setup();
    const { api } = fakeTabs("https://bank.pl/", 0);
    expect(await fillTab(store, api, 7, "l1")).toEqual({ ok: false, error: NO_FIELDS.login });
    expect(await fillTab(store, api, 7, "c1")).toEqual({ ok: false, error: NO_FIELDS.card });
    expect(await fillTab(store, api, 7, "p1")).toEqual({ ok: false, error: NO_FIELDS.contact });
  }, 30_000);
});

describe("onFillCommand", () => {
  const popup = () => {
    const calls = { n: 0 };
    return { calls, open: async () => void calls.n++ };
  };

  it("fills the only matching login", async () => {
    const { store } = await setup();
    const { api, injected } = fakeTabs("https://bank.pl/");
    const p = popup();
    await onFillCommand(store, api, { id: 7, url: "https://bank.pl/" }, p.open);
    expect(injected).toHaveLength(1);
    expect(p.calls.n).toBe(0);
  }, 30_000);

  it("opens the popup for zero or several matches", async () => {
    const { store } = await setup();
    const none = popup();
    const t1 = fakeTabs("https://other.pl/");
    await onFillCommand(store, t1.api, { id: 7, url: "https://other.pl/" }, none.open);
    expect(none.calls.n).toBe(1);
    expect(t1.injected).toEqual([]);

    await store.putEntry("l2", login("Bank 2", ["https://bank.pl"]));
    const many = popup();
    const t2 = fakeTabs("https://bank.pl/");
    await onFillCommand(store, t2.api, { id: 7, url: "https://bank.pl/" }, many.open);
    expect(many.calls.n).toBe(1);
    expect(t2.injected).toEqual([]);
  }, 30_000);

  it("opens the popup when the only login matches as a subdomain (review V3-S2)", async () => {
    const { store } = await setup();
    const p = popup();
    const t = fakeTabs("https://x.bank.pl/");
    await onFillCommand(store, t.api, { id: 7, url: "https://x.bank.pl/" }, p.open);
    expect(p.calls.n).toBe(1);
    expect(t.injected).toEqual([]);
    // The popup's „Wypełnij” still fills it: the user chose the login.
    expect(await fillTab(store, t.api, 7, "l1")).toEqual({ ok: true });
  }, 30_000);

  it("fills the only exact login even with subdomain matches next to it", async () => {
    const { store } = await setup();
    await store.putEntry("l2", login("Bank X", ["https://x.bank.pl"]));
    const p = popup();
    const t = fakeTabs("https://x.bank.pl/");
    await onFillCommand(store, t.api, { id: 7, url: "https://x.bank.pl/" }, p.open);
    expect(p.calls.n).toBe(0);
    expect(t.injected).toHaveLength(1);
  }, 30_000);

  it("opens the popup when locked or the tab is unknown, and when the fill fails", async () => {
    const { store, session } = await setup();
    const unknown = popup();
    await onFillCommand(store, fakeTabs(undefined).api, undefined, unknown.open);
    expect(unknown.calls.n).toBe(1);

    const failing = popup();
    await onFillCommand(
      store,
      fakeTabs("https://bank.pl/", 0).api,
      { id: 7, url: "https://bank.pl/" },
      failing.open,
    );
    expect(failing.calls.n).toBe(1);

    await session.remove(STORAGE_KEYS.sessionKeys);
    const locked = popup();
    const t = fakeTabs("https://bank.pl/");
    await onFillCommand(store, t.api, { id: 7, url: "https://bank.pl/" }, locked.open);
    expect(locked.calls.n).toBe(1);
    expect(t.injected).toEqual([]);
  }, 30_000);
});
