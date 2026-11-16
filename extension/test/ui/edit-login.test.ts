// @vitest-environment happy-dom
import { p2p } from "@passholder/core";
import { afterEach, describe, expect, it } from "vitest";
import { emptyContent } from "../../src/entry-types.ts";
import { byText, click, settle, setupPopup, teardownPopup } from "./fake-chrome.ts";

afterEach(teardownPopup);

const SAVED = "Zapisano lokalnie. Zsynchronizuj, gdy telefon będzie w trybie Synchronizacja.";

/** The element right after the label with this text (an input, a field row or a list editor). */
function after(root: Element, label: string, index = 0): HTMLElement {
  return byText(root, label, index).nextElementSibling as HTMLElement;
}
/** The input of the field under this label. */
function input(root: Element, label: string): HTMLInputElement {
  const el = after(root, label);
  return (
    el.matches("input, textarea") ? el : el.querySelector("input, textarea")
  ) as HTMLInputElement;
}
function fill(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("input"));
}
const customRows = (app: Element) => [...app.querySelectorAll<HTMLElement>(".custom-field")];
function customInputs(row: HTMLElement) {
  const [label, value] = [...row.querySelectorAll<HTMLInputElement>("input:not([type=checkbox])")];
  return {
    label: label!,
    value: value!,
    hidden: row.querySelector<HTMLInputElement>("input[type=checkbox]")!,
  };
}
const tabPressed = (app: Element) =>
  [...app.querySelectorAll(".tabs button")].findIndex(
    (b) => b.getAttribute("aria-pressed") === "true",
  );

function existingLogin(): p2p.EntryContentV3 {
  const l = p2p.emptyLogin("Bank");
  return {
    ...l,
    note: "notatka",
    custom: [
      { label: "Klient", value: "123", hidden: false },
      { label: "PIN", value: "9999", hidden: true },
    ],
    fields: {
      username: "jan",
      password: "stare",
      totp: "JBSWY3DP",
      urls: ["https://bank.pl"],
      androidApps: ["pl.bank"],
    },
  };
}

describe("login form", () => {
  it("a new login with an address, app, TOTP and a hidden custom field saves exactly these fields", async () => {
    const { app, store } = await setupPopup();
    const { editView } = await import("../../src/views/edit.ts");
    await editView("login");
    expect(app.querySelector("h1")!.textContent).toBe("Nowy login");
    fill(input(app, "Nazwa"), "  Poczta  ");
    fill(input(app, "Login"), "ola");
    fill(input(app, "Hasło"), "sekret");
    fill(input(app, "TOTP"), "ABCDEF");
    await click(byText(after(app, "Adresy stron"), "+ Dodaj adres"));
    const url = after(app, "Adresy stron").querySelector<HTMLInputElement>("input")!;
    expect(url.type).toBe("text");
    expect(url.inputMode).toBe("url");
    expect(url.getAttribute("aria-label")).toBe("Adres strony");
    fill(url, "https://poczta.pl");
    await click(byText(after(app, "Aplikacje Androida"), "+ Dodaj aplikację"));
    const pkg = after(app, "Aplikacje Androida").querySelector<HTMLInputElement>("input")!;
    expect(pkg.placeholder).toBe("np. pl.mbank");
    expect(pkg.getAttribute("aria-label")).toBe("Nazwa pakietu");
    fill(pkg, "pl.poczta");
    // An added and unfilled address is dropped.
    await click(byText(after(app, "Adresy stron"), "+ Dodaj adres"));
    fill(input(app, "Notatka"), "linia 1\nlinia 2");
    await click(byText(app, "+ Dodaj pole"));
    const c = customInputs(customRows(app)[0]!);
    fill(c.label, "Kod");
    fill(c.value, "4321");
    c.hidden.checked = true;
    c.hidden.dispatchEvent(new Event("change"));
    await click(byText(app, "+ Dodaj pole")); // left empty: dropped

    await click(byText(app, "Zapisz"));
    await settle(() => app.querySelector(".status")?.textContent === SAVED);
    const [saved] = store.listEntries("login");
    expect(saved!.data).toEqual({
      type: "login",
      name: "Poczta",
      note: "linia 1\nlinia 2",
      custom: [{ label: "Kod", value: "4321", hidden: true }],
      fields: {
        username: "ola",
        password: "sekret",
        totp: "ABCDEF",
        urls: ["https://poczta.pl"],
        androidApps: ["pl.poczta"],
      },
    });
    expect(tabPressed(app)).toBe(0);
  }, 30_000);

  it("changing the password of an existing login keeps everything else", async () => {
    const { app, store } = await setupPopup([{ id: "l1", content: existingLogin() }]);
    const { editView } = await import("../../src/views/edit.ts");
    await editView("login", "l1");
    expect(app.querySelector("h1")!.textContent).toBe("Edytuj login");
    expect(input(app, "Nazwa").value).toBe("Bank");
    fill(input(app, "Hasło"), "nowe");
    await click(byText(app, "Zapisz"));
    await settle(() => app.querySelector(".status")?.textContent === SAVED);
    const expected = existingLogin();
    expect(store.getEntry("l1")!.data).toEqual({
      ...expected,
      fields: { ...(expected as p2p.EntryContentV3 & { type: "login" }).fields, password: "nowe" },
    });
  }, 30_000);

  it("a hidden custom field opens masked, copies with a clipboard clear, „ukryte” off reveals it at once", async () => {
    const { app, clipboard, messages } = await setupPopup([{ id: "l1", content: existingLogin() }]);
    const { editView } = await import("../../src/views/edit.ts");
    await editView("login", "l1");
    const [plain, hidden] = customRows(app).map(customInputs);
    expect(plain!.value.type).toBe("text");
    expect(plain!.hidden.checked).toBe(false);
    expect(hidden!.value.type).toBe("password");
    expect(hidden!.hidden.checked).toBe(true);

    const row = customRows(app)[1]!;
    await click(byText(row, "Pokaż"));
    expect(hidden!.value.type).toBe("text");
    await click(byText(row, "Ukryj"));
    await click(byText(row, "Kopiuj"));
    await settle(() => messages.length > 0);
    expect(clipboard).toEqual(["9999"]);
    expect(messages).toEqual([expect.objectContaining({ type: "password-copied" })]);

    hidden!.hidden.checked = false;
    hidden!.hidden.dispatchEvent(new Event("change"));
    expect(hidden!.value.type).toBe("text");
    expect(() => byText(row, "Pokaż")).toThrow();
    hidden!.hidden.checked = true;
    hidden!.hidden.dispatchEvent(new Event("change"));
    expect(hidden!.value.type).toBe("password");
  }, 30_000);

  it("„Generuj” puts in a password of the slider's length and remembers the settings", async () => {
    const { app } = await setupPopup();
    const { editView } = await import("../../src/views/edit.ts");
    await editView("login");
    const slider = app.querySelector<HTMLInputElement>("input[type=range]")!;
    fill(slider, "24");
    await click(byText(app, "Generuj"));
    await settle(() => input(app, "Hasło").value.length === 24);
    expect(input(app, "Hasło").type).toBe("text");
    const stored = await chrome.storage.local.get("generator");
    expect(Object.values(stored)[0]).toEqual(expect.objectContaining({ length: 24 }));
  }, 30_000);

  it("an address with a trailing space saves unchanged", async () => {
    const { app, store } = await setupPopup();
    const { editView } = await import("../../src/views/edit.ts");
    await editView("login");
    fill(input(app, "Nazwa"), "Poczta");
    fill(input(app, "Hasło"), "sekret");
    await click(byText(after(app, "Adresy stron"), "+ Dodaj adres"));
    fill(
      after(app, "Adresy stron").querySelector<HTMLInputElement>("input")!,
      "https://poczta.pl ",
    );
    await click(byText(app, "Zapisz"));
    await settle(() => app.querySelector(".status")?.textContent === SAVED);
    expect((store.listEntries("login")[0]!.data.fields as p2p.LoginFields).urls).toEqual([
      "https://poczta.pl ",
    ]);
  }, 30_000);

  it("a bad Android package name is refused and nothing is saved", async () => {
    const { app, store } = await setupPopup();
    const { editView } = await import("../../src/views/edit.ts");
    await editView("login");
    fill(input(app, "Nazwa"), "Bank");
    fill(input(app, "Hasło"), "sekret");
    await click(byText(after(app, "Aplikacje Androida"), "+ Dodaj aplikację"));
    fill(after(app, "Aplikacje Androida").querySelector<HTMLInputElement>("input")!, "com");
    await click(byText(app, "Zapisz"));
    await settle(
      () =>
        app.querySelector(".status")?.textContent === "Aplikacje Androida: zła nazwa pakietu com",
    );
    expect(app.querySelector(".status")!.classList.contains("error")).toBe(true);
    expect(store.listEntries("login")).toEqual([]);
  }, 30_000);

  it("no password → „Podaj albo wygeneruj hasło”, no name → „Podaj nazwę”", async () => {
    const { app, store } = await setupPopup();
    const { editView } = await import("../../src/views/edit.ts");
    await editView("login");
    await click(byText(app, "Zapisz"));
    await settle(() => app.querySelector(".status")?.textContent === "Podaj nazwę");
    fill(input(app, "Nazwa"), "Bank");
    await click(byText(app, "Zapisz"));
    await settle(() => app.querySelector(".status")?.textContent === "Podaj albo wygeneruj hasło");
    expect(app.querySelector(".status")!.classList.contains("error")).toBe(true);
    expect(store.listEntries("login")).toEqual([]);
  }, 30_000);
});

describe("entry form shell", () => {
  it("a note saves its text in note and fields: {}", async () => {
    const { app, store } = await setupPopup();
    const { editView } = await import("../../src/views/edit.ts");
    await editView("note");
    expect(app.querySelector("h1")!.textContent).toBe("Nowa notatka");
    expect(() => byText(app, "Notatka")).toThrow();
    expect(app.querySelectorAll("textarea")).toHaveLength(1);
    fill(input(app, "Nazwa"), "Wi-Fi");
    fill(input(app, "Treść"), "SSID: dom\nhasło: abc");
    await click(byText(app, "Zapisz"));
    await settle(() => app.querySelector(".status")?.textContent === SAVED);
    expect(store.listEntries("note").map((e) => e.data)).toEqual([
      { type: "note", name: "Wi-Fi", note: "SSID: dom\nhasło: abc", custom: [], fields: {} },
    ]);
    expect(tabPressed(app)).toBe(3);
  }, 30_000);

  it("renaming a card keeps the fields and custom fields the form does not edit", async () => {
    const c = emptyContent("card") as p2p.EntryContentV3 & { type: "card" };
    const card: p2p.EntryContentV3 = {
      ...c,
      name: "Visa",
      custom: [{ label: "Bank", value: "PKO", hidden: false }],
      fields: {
        ...c.fields,
        holder: "JAN KOWALSKI",
        number: "4111 1111 1111 1111",
        expiry: "2/2030",
        cvc: "123",
        pin: "0000",
      },
    };
    const { app, store } = await setupPopup([{ id: "c1", content: card }]);
    const { editView } = await import("../../src/views/edit.ts");
    await editView("card", "c1");
    expect(app.querySelector("h1")!.textContent).toBe("Edytuj kartę");
    fill(input(app, "Nazwa"), "Visa PKO");
    await click(byText(app, "Zapisz"));
    await settle(() => app.querySelector(".status")?.textContent === SAVED);
    expect(store.getEntry("c1")!.data).toEqual({ ...card, name: "Visa PKO" });
    expect(tabPressed(app)).toBe(2);
  }, 30_000);

  it("„Usuń” twice deletes the entry and returns to its tab", async () => {
    const note: p2p.EntryContentV3 = { ...emptyContent("note"), name: "Kod", note: "1234" };
    const { app, store } = await setupPopup([{ id: "n1", content: note }]);
    const { editView } = await import("../../src/views/edit.ts");
    await editView("note", "n1");
    const remove = app.querySelector<HTMLButtonElement>("button.danger")!;
    expect(remove.textContent).toBe("Usuń");
    await click(remove);
    expect(store.getEntry("n1")).toBeDefined();
    await click(remove);
    await settle(() => app.querySelector(".status")?.textContent?.startsWith("Usunięto lokalnie"));
    expect(store.getEntry("n1")).toBeUndefined();
    expect(tabPressed(app)).toBe(3);
  }, 30_000);

  it("a new entry has no „Usuń”", async () => {
    const { app } = await setupPopup();
    const { editView } = await import("../../src/views/edit.ts");
    await editView("contact");
    expect(app.querySelector("h1")!.textContent).toBe("Nowy kontakt");
    expect(app.querySelector("button.danger")).toBeNull();
  }, 30_000);
});
