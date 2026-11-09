/**
 * The popup in a real browser for scripts/screenshots.mjs: the same fakes as test/ui/fake-chrome.ts
 * (chrome.* storage on Maps, a FakePhone behind a fake fetch), sample entries of every type with made-up
 * data, and window.__screens to switch views. The page must already hold <main id="app"> and popup.css.
 */
import type { p2p } from "@passholder/core";
import { PhoneClient } from "../../src/phone-client.ts";
import { chromeStore, VaultStore } from "../../src/vault-store.ts";
import { CODE, FakePhone, networkFetch, PASSWORD, PHONE_URL, type Network } from "../fake-phone.ts";

function fakeArea(): chrome.storage.StorageArea {
  const data = new Map<string, unknown>();
  return {
    async get(key: string) {
      return data.has(key) ? { [key]: structuredClone(data.get(key)) } : {};
    },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
    async remove(key: string) {
      data.delete(key);
    },
  } as unknown as chrome.storage.StorageArea;
}

const base = { note: "", custom: [] as p2p.CustomField[] };

/** Obviously fake sample data, two or three entries per type. */
const SAMPLES: { id: string; content: p2p.EntryContentV3 }[] = [
  { id: "l1", content: { ...base, type: "login", name: "Przykładowy sklep", custom: [{ label: "Pytanie kontrolne", value: "Burek z przykładu", hidden: true }], fields: { username: "jan.testowy@example.com", password: "Haslo-Przykladowe-123", totp: "JBSWY3DPEHPK3PXP", urls: ["https://sklep.example.com"], androidApps: ["com.example.shop"] } } },
  { id: "l2", content: { ...base, type: "login", name: "Poczta testowa", fields: { username: "anna.przyklad", password: "nie-prawdziwe", totp: "", urls: ["https://poczta.example.org"], androidApps: [] } } },
  { id: "l3", content: { ...base, type: "login", name: "Forum demo", fields: { username: "demo_user", password: "demo", totp: "", urls: [], androidApps: [] } } },
  { id: "k1", content: { ...base, type: "contact", name: "Jan Testowy", note: "Kolega z przykładu.", fields: { firstName: "Jan", lastName: "Testowy", birthDate: "1990-01-01", phones: [{ label: "komórka", value: "+48 000 000 001" }, { label: "praca", value: "+48 000 000 003" }], emails: [{ label: "dom", value: "jan@example.com" }], addresses: [{ label: "dom", street: "Przykładowa 1", postalCode: "00-000", city: "Testowo", country: "Polska" }] } } },
  { id: "k2", content: { ...base, type: "contact", name: "Anna Przykładowa", fields: { firstName: "Anna", lastName: "Przykładowa", birthDate: "", phones: [{ label: "praca", value: "+48 000 000 002" }], emails: [], addresses: [] } } },
  { id: "c1", content: { ...base, type: "card", name: "Karta testowa Visa", fields: { holder: "JAN TESTOWY", number: "4111 1111 1111 1111", expiry: "12/30", cvc: "123", pin: "0000" } } },
  { id: "c2", content: { ...base, type: "card", name: "Karta demo", fields: { holder: "ANNA PRZYKLADOWA", number: "5500 0000 0000 0004", expiry: "01/29", cvc: "999", pin: "" } } },
  { id: "n1", content: { ...base, type: "note", name: "Lista zakupów (przykład)", note: "Mleko\nChleb\nMasło", fields: {} } },
  { id: "n2", content: { ...base, type: "note", name: "Kod do furtki (fikcyjny)", note: "\nKod: 0000 (przykład)", fields: {} } },
  { id: "d1", content: { ...base, type: "document", name: "Dowód Jana", fields: { kind: "id_card", number: "ABC000000", fullName: "Jan Testowy", issueDate: "2020-01-01", expiryDate: "2030-01-01", issuer: "Urząd Przykładowy" } } },
  { id: "d2", content: { ...base, type: "document", name: "Paszport Anny", fields: { kind: "passport", number: "XX0000000", fullName: "Anna Przykładowa", issueDate: "2021-05-05", expiryDate: "2031-05-05", issuer: "Wojewoda Testowy" } } },
];

async function setup() {
  const local = fakeArea();
  const session = fakeArea();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local, session },
    runtime: { sendMessage: async () => undefined, getURL: (path: string) => `chrome-extension://passholder/${path}` },
    permissions: { contains: async () => true },
  };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => undefined } });

  const phone = await FakePhone.withVault(PASSWORD, [PHONE_URL]);
  const network: Network = new Map([[PHONE_URL, phone]]);
  const fetchFn = networkFetch(network);
  globalThis.fetch = fetchFn;
  const pairing = new VaultStore(chromeStore(local), chromeStore(session), (url) => new PhoneClient(url, fetchFn));
  phone.offerPairing();
  await pairing.pairStart(PHONE_URL, CODE, "Chrome (Linux)");
  await pairing.pairFinish(PASSWORD);
  for (const { id, content } of SAMPLES) await pairing.putEntry(id, content);
  await pairing.sync(); // so the rows carry no „•” of unsynced changes

  // The views read chrome.* when their modules load, so they are imported only now.
  const { store } = await import("../../src/ui/state.ts");
  if (!(await store.resume())) throw new Error("harness: the store did not resume");
  const { listView } = await import("../../src/views/list.ts");
  const { editView } = await import("../../src/views/edit.ts");
  const { transferView } = await import("../../src/views/transfer.ts");
  const firstOf = (type: p2p.EntryType) => SAMPLES.find((s) => s.content.type === type)!.id;
  return {
    /** The import and export screen. */
    openTransfer: () => transferView(),
    /** The list on the tab of this type. */
    show: (type: p2p.EntryType) => listView("", false, type),
    /** The form of the first sample entry of this type. */
    openForm: (type: p2p.EntryType) => editView(type, firstOf(type)),
    /** Clicks „Pokaż” of every hidden custom field. */
    revealCustom: () => {
      for (const row of document.querySelectorAll(".custom-field")) {
        const toggle = [...row.querySelectorAll("button")].find((b) => b.textContent === "Pokaż");
        toggle?.click();
      }
    },
  };
}

(window as unknown as { __screens: Promise<Awaited<ReturnType<typeof setup>>> }).__screens = setup();
