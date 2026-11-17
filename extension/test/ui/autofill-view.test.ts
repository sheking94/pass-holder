// @vitest-environment happy-dom
import { p2p } from "@passholder/core";
import { afterEach, describe, expect, it } from "vitest";
import { NO_FIELDS } from "../../src/autofill/fill-tab.ts";
import { emptyContent } from "../../src/entry-types.ts";
import { byText, click, settle, setupPopup, teardownPopup } from "./fake-chrome.ts";

afterEach(() => {
  teardownPopup();
  history.replaceState({}, "", "/");
});

function login(name: string, url: string): p2p.EntryContent {
  const l = p2p.emptyLogin(name);
  return { ...l, fields: { ...l.fields, username: "jan", password: "x", urls: [url] } };
}
const card = (name: string) => ({ ...emptyContent("card"), name }) as p2p.EntryContent;
const contact = (name: string) => ({ ...emptyContent("contact"), name }) as p2p.EntryContent;
const note = (name: string) => ({ ...emptyContent("note"), name }) as p2p.EntryContent;
const doc = (name: string) => ({ ...emptyContent("document"), name }) as p2p.EntryContent;

const ENTRIES = [
  { id: "l1", content: login("Bank", "bank.pl") },
  { id: "l2", content: login("Poczta", "google.com") },
  { id: "c1", content: card("Visa") },
  { id: "c2", content: card("Master") },
  { id: "k1", content: contact("Anna") },
  { id: "n1", content: note("Notka") },
  { id: "d1", content: doc("Dowód") },
];
const TAB = { id: 7, url: "https://mail.google.com/inbox" };

const tabs = (app: Element) => [...app.querySelectorAll<HTMLButtonElement>(".tabs button")];
const fillButtons = (root: Element) =>
  [...root.querySelectorAll("button")].filter((b) => b.textContent === "Wypełnij");
const status = (app: Element) => app.querySelector(".status")!;

const shownMatches = async (app: Element) =>
  (await settle(() => app.querySelector(".matches:not([hidden])")))!;

async function open(options: Parameters<typeof setupPopup>[1]) {
  const popup = await setupPopup(ENTRIES, options);
  const { listView } = await import("../../src/views/list.ts");
  listView();
  return popup;
}

describe("autofill in the list view", () => {
  it("shows matching logins above the list", async () => {
    const { app } = await open({ activeTab: TAB });
    const section = await shownMatches(app);
    expect(section.querySelector("h2")!.textContent).toBe("Pasujące do tej strony");
    expect(
      [...section.querySelectorAll(".name")].map((n) => n.textContent!.replace(/ •$/, "")),
    ).toEqual(["Poczta"]);
    expect(fillButtons(section)).toHaveLength(1);
    expect(
      [...app.querySelectorAll("#app > .entries .name")].map((n) =>
        n.textContent!.replace(/ •$/, ""),
      ),
    ).toEqual(["Bank", "Poczta"]);
  }, 30_000);

  it("hides the section when nothing matches", async () => {
    const { app } = await open({ activeTab: { id: 7, url: "https://example.org/" } });
    await click(app);
    expect(app.querySelector(".matches:not([hidden])")).toBeNull();
    expect(app.textContent).not.toContain("Pasujące do tej strony");
  }, 30_000);

  it("cards and contacts get a fill button in every row", async () => {
    const { app } = await open({ activeTab: TAB });
    await click(tabs(app)[2]!);
    expect(fillButtons(app.querySelector("#app > .entries")!)).toHaveLength(2);
    expect(app.querySelector(".matches:not([hidden])")).toBeNull();
    await click(tabs(app)[1]!);
    expect(fillButtons(app.querySelector("#app > .entries")!)).toHaveLength(1);
    await click(tabs(app)[3]!);
    expect(fillButtons(app)).toHaveLength(0);
    await click(tabs(app)[4]!);
    expect(fillButtons(app)).toHaveLength(0);
  }, 30_000);

  it("no fill buttons in tab mode", async () => {
    history.replaceState({}, "", "/?tab");
    const { app } = await open({ activeTab: TAB });
    await click(app);
    expect(app.querySelector(".matches:not([hidden])")).toBeNull();
    expect(fillButtons(app)).toHaveLength(0);
    await click(tabs(app)[2]!);
    expect(fillButtons(app)).toHaveLength(0);
  }, 30_000);

  it("fill sends entry and tab id, closes the popup on success", async () => {
    const { app, messages, close } = await open({ activeTab: TAB });
    const section = await shownMatches(app);
    await click(byText(section, "Wypełnij"));
    await settle(() => close.mock.calls.length > 0);
    expect(messages).toContainEqual({
      target: "background",
      type: "fill",
      entryId: "l2",
      tabId: 7,
    });
  }, 30_000);

  it("fill shows the error and keeps the popup open", async () => {
    const { app, close } = await open({
      activeTab: TAB,
      fillResult: { ok: false, error: NO_FIELDS.card },
    });
    await click(tabs(app)[2]!);
    await click(fillButtons(app)[0]!);
    await settle(() => status(app).textContent === NO_FIELDS.card);
    expect(status(app).classList.contains("error")).toBe(true);
    expect(close).not.toHaveBeenCalled();
  }, 30_000);

  it("a sync refreshes the matching-logins section", async () => {
    const { app, phone } = await open({ activeTab: TAB });
    const section = await shownMatches(app);
    expect(section.querySelectorAll(".name")).toHaveLength(1);
    await phone.addContent("l3", login("Gmail", "mail.google.com"));
    await click(byText(app, "Synchronizuj"));
    await settle(() => app.querySelector(".matches")!.querySelectorAll(".name").length === 2);
  }, 30_000);
});
