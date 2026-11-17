// @vitest-environment happy-dom
import { p2p } from "@passholder/core";
import { afterEach, describe, expect, it } from "vitest";
import { emptyContent } from "../../src/entry-types.ts";
import { byText, click, settle, setupPopup, teardownPopup } from "./fake-chrome.ts";

afterEach(teardownPopup);

function login(name: string, username: string, password: string): p2p.EntryContent {
  const l = p2p.emptyLogin(name);
  return { ...l, fields: { ...l.fields, username, password } };
}

function card(name: string, number: string): p2p.EntryContent {
  const c = emptyContent("card") as p2p.EntryContent & { type: "card" };
  return { ...c, name, fields: { ...c.fields, number } };
}

function contact(name: string, phone: string): p2p.EntryContent {
  const c = emptyContent("contact") as p2p.EntryContent & { type: "contact" };
  return { ...c, name, fields: { ...c.fields, phones: [{ label: "", value: phone }] } };
}

const ENTRIES = [
  { id: "l1", content: login("Bank", "jan", "tajne") },
  { id: "l2", content: login("Poczta", "ola", "x") },
  { id: "c1", content: card("Visa", "1234 5678 9012 3456") },
  { id: "c2", content: card("Master", "5555 4444 3333 1111") },
  { id: "k1", content: contact("Anna", "600 100 200") },
  { id: "k2", content: contact("Piotr", "700 300 400") },
];

const tabs = (app: Element) => [...app.querySelectorAll<HTMLButtonElement>(".tabs button")];
const names = (app: Element) =>
  [...app.querySelectorAll(".entries .name")].map((n) => n.textContent!.replace(/ •$/, ""));
const summaries = (app: Element) =>
  [...app.querySelectorAll(".entries .user")].map((n) => n.textContent);
const search = (app: Element) => app.querySelector<HTMLInputElement>("input[type=search]")!;
function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

describe("list view tabs", () => {
  it("has five tabs with aria-pressed, Loginy first and pressed", async () => {
    const { app } = await setupPopup(ENTRIES);
    const { listView } = await import("../../src/views/list.ts");
    listView();
    const t = tabs(app);
    expect(t.map((b) => b.textContent)).toEqual([
      "🔑Loginy",
      "👤Kontakty",
      "💳Karty",
      "📝Notatki",
      "🪪Dokumenty",
    ]);
    expect(t.map((b) => b.getAttribute("aria-pressed"))).toEqual([
      "true",
      "false",
      "false",
      "false",
      "false",
    ]);
    expect(names(app)).toEqual(["Bank", "Poczta"]);
  }, 30_000);

  it("Karty shows only cards with the masked number; search is per tab", async () => {
    const { app } = await setupPopup(ENTRIES);
    const { listView } = await import("../../src/views/list.ts");
    listView();
    type(search(app), "bank");
    expect(names(app)).toEqual(["Bank"]);

    await click(tabs(app)[2]!);
    expect(tabs(app)[2]!.getAttribute("aria-pressed")).toBe("true");
    expect(search(app).value).toBe("");
    expect(names(app)).toEqual(["Master", "Visa"]);
    expect(summaries(app)).toEqual(["•••• 1111", "•••• 3456"]);
    type(search(app), "3456");
    expect(names(app)).toEqual(["Visa"]);

    await click(tabs(app)[0]!);
    expect(search(app).value).toBe("");
    expect(names(app)).toEqual(["Bank", "Poczta"]);
  }, 30_000);

  it("Kontakty filters by phone", async () => {
    const { app } = await setupPopup(ENTRIES);
    const { listView } = await import("../../src/views/list.ts");
    listView();
    await click(tabs(app)[1]!);
    expect(summaries(app)).toEqual(["600 100 200", "700 300 400"]);
    type(search(app), "300");
    expect(names(app)).toEqual(["Piotr"]);
  }, 30_000);

  it("an empty tab says so", async () => {
    const { app } = await setupPopup(ENTRIES);
    const { listView } = await import("../../src/views/list.ts");
    listView();
    await click(tabs(app)[4]!);
    expect(app.querySelector(".entries .empty")?.textContent).toBe("Brak wpisów. Dodaj pierwszy.");
  }, 30_000);

  it("listView(type) opens that tab and listView() remembers the last one", async () => {
    const { app } = await setupPopup(ENTRIES);
    const { listView } = await import("../../src/views/list.ts");
    listView("", false, "card");
    expect(names(app)).toEqual(["Master", "Visa"]);
    await click(tabs(app)[1]!);
    listView();
    expect(tabs(app)[1]!.getAttribute("aria-pressed")).toBe("true");
    expect(names(app)).toEqual(["Anna", "Piotr"]);
  }, 30_000);

  it("„+ Dodaj” in Notatki opens „Nowa notatka”; saving returns to Notatki", async () => {
    const { app, store } = await setupPopup(ENTRIES);
    const { listView } = await import("../../src/views/list.ts");
    listView();
    await click(tabs(app)[3]!);
    await click(byText(app, "+ Dodaj"));
    await settle(() => app.querySelector("h1")?.textContent === "Nowa notatka");
    const [name] = [...app.querySelectorAll<HTMLInputElement>("input[type=text]")];
    name!.value = "Wi-Fi";
    app.querySelector("textarea")!.value = "hasło: abc";
    await click(byText(app, "Zapisz"));
    await settle(() => names(app).includes("Wi-Fi"));
    expect(tabs(app)[3]!.getAttribute("aria-pressed")).toBe("true");
    expect(summaries(app)).toEqual(["hasło: abc"]);
    expect(store.listEntries("note").map((e) => e.data.name)).toEqual(["Wi-Fi"]);
  }, 30_000);

  it("clicking a row opens „Edytuj …” of that entry; Anuluj returns to its tab", async () => {
    const { app } = await setupPopup(ENTRIES);
    const { listView } = await import("../../src/views/list.ts");
    listView();
    await click(tabs(app)[2]!);
    await click(app.querySelectorAll(".entries .entry-open")[1]!);
    await settle(() => app.querySelector("h1")?.textContent === "Edytuj kartę");
    expect(app.querySelector<HTMLInputElement>("input[type=text]")!.value).toBe("Visa");
    await click(byText(app, "Anuluj"));
    expect(tabs(app)[2]!.getAttribute("aria-pressed")).toBe("true");

    await click(tabs(app)[0]!);
    await click(app.querySelector(".entries .entry-open")!);
    await settle(() => app.querySelector("h1")?.textContent === "Edytuj login");
    expect(app.querySelector<HTMLInputElement>("input[type=text]")!.value).toBe("Bank");
  }, 30_000);

  it("a login row copies login and password (with clipboard clear) and marks unsynced entries", async () => {
    const { app, clipboard, messages } = await setupPopup(ENTRIES);
    const { listView } = await import("../../src/views/list.ts");
    listView();
    const row = app.querySelector(".entries li")!;
    expect(row.querySelector(".entry-open")!.textContent).toContain("🔑");
    expect(row.querySelector(".name")!.textContent).toBe("Bank •");
    await click(byText(row, "Login"));
    expect(messages).toEqual([]);
    await click(byText(row, "Hasło"));
    await settle(() => messages.length > 0);
    expect(clipboard).toEqual(["jan", "tajne"]);
    expect(messages).toEqual([expect.objectContaining({ type: "password-copied" })]);
    await click(tabs(app)[2]!);
    expect(() => byText(app.querySelector(".entries")!, "Hasło")).toThrow();
  }, 30_000);
});
