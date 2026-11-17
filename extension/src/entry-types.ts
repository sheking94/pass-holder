import { CARD_EXPIRY, isCalendarDate, p2p, transfer } from "@passholder/core";

type EntryType = p2p.EntryType;
type Content = p2p.EntryContent;

export const TYPE_INFO: Record<
  EntryType,
  { icon: string; tab: string; newTitle: string; editTitle: string }
> = {
  login: { icon: "🔑", tab: "Loginy", newTitle: "Nowy login", editTitle: "Edytuj login" },
  contact: { icon: "👤", tab: "Kontakty", newTitle: "Nowy kontakt", editTitle: "Edytuj kontakt" },
  card: { icon: "💳", tab: "Karty", newTitle: "Nowa karta", editTitle: "Edytuj kartę" },
  note: { icon: "📝", tab: "Notatki", newTitle: "Nowa notatka", editTitle: "Edytuj notatkę" },
  document: {
    icon: "🪪",
    tab: "Dokumenty",
    newTitle: "Nowy dokument",
    editTitle: "Edytuj dokument",
  },
};

const ANDROID_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

export function emptyContent(type: EntryType): Content {
  const base = { name: "", note: "", custom: [] };
  switch (type) {
    case "login":
      return p2p.emptyLogin();
    case "contact":
      return {
        ...base,
        type,
        fields: {
          firstName: "",
          lastName: "",
          birthDate: "",
          phones: [],
          emails: [],
          addresses: [],
        },
      };
    case "card":
      return { ...base, type, fields: { holder: "", number: "", expiry: "", cvc: "", pin: "" } };
    case "note":
      return { ...base, type, fields: {} };
    case "document":
      return {
        ...base,
        type,
        fields: {
          kind: "id_card",
          number: "",
          fullName: "",
          issueDate: "",
          expiryDate: "",
          issuer: "",
        },
      };
  }
}

/** Short description shown under the entry name in the list. */
export function entrySummary(content: Content): string {
  switch (content.type) {
    case "login":
      return content.fields.username;
    case "card": {
      const digits = content.fields.number.replace(/\s/g, "");
      return digits ? `•••• ${digits.slice(-4)}` : "";
    }
    case "document":
      return transfer.DOCUMENT_KIND_NAMES[content.fields.kind] ?? "";
    case "contact":
      return content.fields.phones[0]?.value ?? "";
    case "note":
      return content.note.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  }
}

export function matchesQuery(content: Content, query: string): boolean {
  return `${content.name} ${entrySummary(content)}`.toLowerCase().includes(query.toLowerCase());
}

/** Trims the name, drops list items whose text fields are all empty and empty custom fields. */
export function tidyContent(content: Content): Content {
  const out = { ...content, name: content.name.trim() } as Content;
  out.custom = content.custom.filter((c) => c.label !== "" || c.value !== "");
  if (out.type === "login") {
    out.fields = {
      ...out.fields,
      urls: out.fields.urls.filter((u) => u !== ""),
      androidApps: out.fields.androidApps.filter((a) => a !== ""),
    };
  } else if (out.type === "contact") {
    out.fields = {
      ...out.fields,
      phones: out.fields.phones.filter((p) => p.label !== "" || p.value !== ""),
      emails: out.fields.emails.filter((e) => e.label !== "" || e.value !== ""),
      addresses: out.fields.addresses.filter(
        (a) =>
          a.label !== "" ||
          a.street !== "" ||
          a.postalCode !== "" ||
          a.city !== "" ||
          a.country !== "",
      ),
    };
  }
  return out;
}

function validDate(value: string, original: string | undefined): boolean {
  return value === "" || value === original || isCalendarDate(value);
}

/** Returns the first form error, or undefined. Only values changed against `original` are format-checked. */
export function validateContent(content: Content, original?: Content): string | undefined {
  if (content.name.trim() === "") return "Podaj nazwę";
  const before = original?.type === content.type ? original : undefined;
  switch (content.type) {
    case "login": {
      if (content.fields.password === "") return "Podaj albo wygeneruj hasło";
      const known = before?.type === "login" ? before.fields.androidApps : [];
      for (const app of content.fields.androidApps) {
        if (app !== "" && !known.includes(app) && !ANDROID_PACKAGE.test(app)) {
          return `Aplikacje Androida: zła nazwa pakietu ${app}`;
        }
      }
      return undefined;
    }
    case "contact": {
      const o = before?.type === "contact" ? before.fields : undefined;
      if (!validDate(content.fields.birthDate, o?.birthDate))
        return "Data urodzenia: wpisz datę RRRR-MM-DD";
      return undefined;
    }
    case "document": {
      const o = before?.type === "document" ? before.fields : undefined;
      if (!validDate(content.fields.issueDate, o?.issueDate))
        return "Data wydania: wpisz datę RRRR-MM-DD";
      if (!validDate(content.fields.expiryDate, o?.expiryDate))
        return "Data ważności: wpisz datę RRRR-MM-DD";
      return undefined;
    }
    case "card": {
      const e = content.fields.expiry;
      const o = before?.type === "card" ? before.fields.expiry : undefined;
      if (e !== "" && e !== o && !CARD_EXPIRY.test(e)) return "Ważność: wpisz MM/RR";
      return undefined;
    }
    case "note":
      return undefined;
  }
}
