// @vitest-environment happy-dom
import { p2p } from "@passholder/core";
import { afterEach, describe, expect, it } from "vitest";
import { emptyContent } from "../../src/entry-types.ts";
import { byText, click, settle, setupPopup, teardownPopup } from "./fake-chrome.ts";

afterEach(teardownPopup);

const SAVED = "Zapisano lokalnie. Zsynchronizuj, gdy telefon będzie w trybie Synchronizacja.";

function after(root: Element, label: string, index = 0): HTMLElement {
  return byText(root, label, index).nextElementSibling as HTMLElement;
}
function input(root: Element, label: string): HTMLInputElement {
  const el = after(root, label);
  return (el.matches("input, textarea, select") ? el : el.querySelector("input, textarea, select")) as HTMLInputElement;
}
function fill(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("input"));
}
const status = (app: Element) => app.querySelector(".status")?.textContent;

async function save(app: Element) {
  await click(byText(app, "Zapisz"));
  await settle(() => status(app) === SAVED);
}

describe("contact form", () => {
  it("saves every field; an added and unfilled phone is dropped", async () => {
    const { app, store } = await setupPopup();
    const { editView } = await import("../../src/views/edit.ts");
    await editView("contact");
    expect(app.querySelector("h1")!.textContent).toBe("Nowy kontakt");
    fill(input(app, "Nazwa"), "Ola K.");
    fill(input(app, "Imię"), "Ola");
    fill(input(app, "Nazwisko"), "Kowalska");
    const birth = input(app, "Data urodzenia");
    expect(birth.placeholder).toBe("RRRR-MM-DD");
    fill(birth, "1990-02-01");
    await click(byText(after(app, "Telefony"), "+ Dodaj telefon"));
    const [phoneLabel, phoneValue] = after(app, "Telefony").querySelectorAll<HTMLInputElement>("input");
    fill(phoneLabel!, "dom");
    fill(phoneValue!, "123 456");
    await click(byText(after(app, "Telefony"), "+ Dodaj telefon")); // left empty
    await click(byText(after(app, "E-maile"), "+ Dodaj e-mail"));
    const [mailLabel, mailValue] = after(app, "E-maile").querySelectorAll<HTMLInputElement>("input");
    fill(mailLabel!, "praca");
    fill(mailValue!, "ola@firma.pl");
    await click(byText(after(app, "Adresy"), "+ Dodaj adres"));
    const addr = [...after(app, "Adresy").querySelectorAll<HTMLInputElement>("input")];
    expect(addr).toHaveLength(5);
    ["dom", "Długa 1", "00-001", "Warszawa", "Polska"].forEach((v, i) => fill(addr[i]!, v));
    await click(byText(after(app, "Adresy"), "+ Dodaj adres")); // left empty
    await save(app);
    expect(store.listEntries("contact").map((e) => e.data)).toEqual([{
      type: "contact", name: "Ola K.", note: "", custom: [],
      fields: {
        firstName: "Ola", lastName: "Kowalska", birthDate: "1990-02-01",
        phones: [{ label: "dom", value: "123 456" }],
        emails: [{ label: "praca", value: "ola@firma.pl" }],
        addresses: [{ label: "dom", street: "Długa 1", postalCode: "00-001", city: "Warszawa", country: "Polska" }],
      },
    }]);
  }, 30_000);

  it("labels every list input; an e-mail with surrounding spaces saves unchanged", async () => {
    const { app, store } = await setupPopup();
    const { editView } = await import("../../src/views/edit.ts");
    await editView("contact");
    fill(input(app, "Nazwa"), "Ola");
    await click(byText(after(app, "Telefony"), "+ Dodaj telefon"));
    await click(byText(after(app, "E-maile"), "+ Dodaj e-mail"));
    await click(byText(after(app, "Adresy"), "+ Dodaj adres"));
    const aria = (label: string) =>
      [...after(app, label).querySelectorAll<HTMLInputElement>("input")].map((i) => i.getAttribute("aria-label"));
    expect(aria("Telefony")).toEqual(["Etykieta", "Numer telefonu"]);
    expect(aria("E-maile")).toEqual(["Etykieta", "Adres e-mail"]);
    expect(aria("Adresy")).toEqual(["Etykieta", "Ulica", "Kod pocztowy", "Miasto", "Kraj"]);
    const phone = after(app, "Telefony").querySelectorAll<HTMLInputElement>("input")[1]!;
    expect(phone.placeholder).toBe("Numer telefonu");
    expect(phone.inputMode).toBe("tel");
    const mail = after(app, "E-maile").querySelectorAll<HTMLInputElement>("input")[1]!;
    expect(mail.placeholder).toBe("Adres e-mail");
    expect(mail.type).toBe("text");
    expect(mail.inputMode).toBe("email");
    fill(mail, " ola@firma.pl ");
    await save(app);
    expect((store.listEntries("contact")[0]!.data.fields as p2p.ContactFields).emails).toEqual([{ label: "", value: " ola@firma.pl " }]);
  }, 30_000);

  it("only an added, unfilled phone saves phones: []", async () => {
    const { app, store } = await setupPopup();
    const { editView } = await import("../../src/views/edit.ts");
    await editView("contact");
    fill(input(app, "Nazwa"), "Pusty");
    await click(byText(after(app, "Telefony"), "+ Dodaj telefon"));
    await save(app);
    expect((store.listEntries("contact")[0]!.data.fields as p2p.ContactFields).phones).toEqual([]);
  }, 30_000);

  it("a birth date in another notation saves unchanged; a changed impossible date is refused", async () => {
    const c = emptyContent("contact") as p2p.EntryContentV3 & { type: "contact" };
    const contact: p2p.EntryContentV3 = { ...c, name: "Jan", fields: { ...c.fields, birthDate: "01.02.1990" } };
    const { app, store } = await setupPopup([{ id: "k1", content: contact }]);
    const { editView } = await import("../../src/views/edit.ts");
    await editView("contact", "k1");
    expect(input(app, "Data urodzenia").value).toBe("01.02.1990");
    await save(app);
    expect(store.getEntry("k1")!.data).toEqual(contact);

    await editView("contact", "k1");
    fill(input(app, "Data urodzenia"), "1990-02-30");
    await click(byText(app, "Zapisz"));
    await settle(() => status(app) === "Data urodzenia: wpisz datę RRRR-MM-DD");
    expect(store.getEntry("k1")!.data).toEqual(contact);
  }, 30_000);
});

describe("card form", () => {
  it("saves the fields; number, CVC and PIN open masked", async () => {
    const { app, store } = await setupPopup();
    const { editView } = await import("../../src/views/edit.ts");
    await editView("card");
    expect(app.querySelector("h1")!.textContent).toBe("Nowa karta");
    fill(input(app, "Nazwa"), "Visa");
    fill(input(app, "Posiadacz"), "JAN KOWALSKI");
    const number = input(app, "Numer");
    expect(number.type).toBe("password");
    expect(number.inputMode).toBe("numeric");
    fill(number, "4111 1111 1111 1111");
    expect(input(app, "Ważność").placeholder).toBe("MM/RR");
    fill(input(app, "Ważność"), "12/27");
    expect(input(app, "CVC").type).toBe("password");
    expect(input(app, "PIN").type).toBe("password");
    fill(input(app, "CVC"), "123");
    fill(input(app, "PIN"), "0000");
    await save(app);
    expect(store.listEntries("card").map((e) => e.data)).toEqual([{
      type: "card", name: "Visa", note: "", custom: [],
      fields: { holder: "JAN KOWALSKI", number: "4111 1111 1111 1111", expiry: "12/27", cvc: "123", pin: "0000" },
    }]);
  }, 30_000);

  it("„Kopiuj” at CVC sends password-copied", async () => {
    const { app, clipboard, messages } = await setupPopup();
    const { editView } = await import("../../src/views/edit.ts");
    await editView("card");
    fill(input(app, "CVC"), "123");
    await click(byText(after(app, "CVC"), "Kopiuj"));
    await settle(() => messages.length > 0);
    expect(clipboard).toEqual(["123"]);
    expect(messages).toEqual([expect.objectContaining({ type: "password-copied" })]);
  }, 30_000);

  it("expiry 13/27 → „Ważność: wpisz MM/RR”", async () => {
    const { app, store } = await setupPopup();
    const { editView } = await import("../../src/views/edit.ts");
    await editView("card");
    fill(input(app, "Nazwa"), "Visa");
    fill(input(app, "Ważność"), "13/27");
    await click(byText(app, "Zapisz"));
    await settle(() => status(app) === "Ważność: wpisz MM/RR");
    expect(store.listEntries("card")).toEqual([]);
  }, 30_000);
});

describe("document form", () => {
  it("saves the fields; the kind defaults to Dowód osobisty and can be changed to Paszport", async () => {
    const { app, store } = await setupPopup();
    const { editView } = await import("../../src/views/edit.ts");
    await editView("document");
    expect(app.querySelector("h1")!.textContent).toBe("Nowy dokument");
    fill(input(app, "Nazwa"), "Paszport Oli");
    const kind = input(app, "Rodzaj") as unknown as HTMLSelectElement;
    expect(kind.value).toBe("id_card");
    expect([...kind.options].map((o) => o.textContent)).toEqual(["Dowód osobisty", "Paszport", "Prawo jazdy", "Legitymacja", "Inny"]);
    kind.value = "passport";
    kind.dispatchEvent(new Event("change"));
    fill(input(app, "Numer"), "AB1234567");
    fill(input(app, "Imię i nazwisko"), "Ola Kowalska");
    fill(input(app, "Data wydania"), "2020-01-15");
    fill(input(app, "Data ważności"), "2030-01-14");
    fill(input(app, "Wystawca"), "Wojewoda");
    await save(app);
    expect(store.listEntries("document").map((e) => e.data)).toEqual([{
      type: "document", name: "Paszport Oli", note: "", custom: [],
      fields: {
        kind: "passport", number: "AB1234567", fullName: "Ola Kowalska",
        issueDate: "2020-01-15", expiryDate: "2030-01-14", issuer: "Wojewoda",
      },
    }]);
  }, 30_000);

  it("a bad issue date is refused with its label", async () => {
    const { app, store } = await setupPopup();
    const { editView } = await import("../../src/views/edit.ts");
    await editView("document");
    fill(input(app, "Nazwa"), "Dowód");
    fill(input(app, "Data wydania"), "2020-13-01");
    await click(byText(app, "Zapisz"));
    await settle(() => status(app) === "Data wydania: wpisz datę RRRR-MM-DD");
    expect(store.listEntries("document")).toEqual([]);
  }, 30_000);
});
