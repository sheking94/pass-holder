import { open, seal } from "../cipher.ts";
import { fromUtf8, utf8 } from "../encoding.ts";
import { PassHolderError } from "../errors.ts";
import {
  attachmentJson,
  INVALID_ENTRY,
  invalidEntry,
  parseAttachments,
  type Attachment,
} from "../files/attachment.ts";
import { hasExactKeys, isRecord, requireString, type JsonObject } from "../strict-json.ts";
import { parseHlc, type Hlc } from "./hlc.ts";
import { KIB } from "../sizes.ts";

/** Entry types in tab and export order (logins first). */
export const ENTRY_TYPES = ["login", "contact", "card", "note", "document"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];
export const DOCUMENT_KINDS = [
  "id_card",
  "passport",
  "driving_license",
  "student_id",
  "other",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export function isDocumentKind(value: string): value is DocumentKind {
  return (DOCUMENT_KINDS as readonly string[]).includes(value);
}

export interface LabeledValue {
  label: string;
  value: string;
}
export interface PostalAddress {
  label: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;
}
export interface CustomField {
  label: string;
  value: string;
  hidden: boolean;
}
export interface LoginFields {
  username: string;
  password: string;
  totp: string;
  urls: string[];
  androidApps: string[];
}
export interface ContactFields {
  firstName: string;
  lastName: string;
  birthDate: string;
  phones: LabeledValue[];
  emails: LabeledValue[];
  addresses: PostalAddress[];
}
export interface CardFields {
  holder: string;
  number: string;
  expiry: string;
  cvc: string;
  pin: string;
}
export type NoteFields = Record<string, never>;
export interface DocumentFields {
  kind: DocumentKind;
  number: string;
  fullName: string;
  issueDate: string;
  expiryDate: string;
  issuer: string;
}

export type EntryContent = {
  name: string;
  note: string;
  custom: CustomField[];
  attachments?: Attachment[];
} & (
  | { type: "login"; fields: LoginFields }
  | { type: "contact"; fields: ContactFields }
  | { type: "card"; fields: CardFields }
  | { type: "note"; fields: NoteFields }
  | { type: "document"; fields: DocumentFields }
);
export type EntryData = EntryContent & { v: 3; hlc: Hlc };

export interface TombstoneData {
  hlc: Hlc;
}

export const MAX_ENTRY_BLOB_LENGTH = 64 * KIB;

/** upsertEntry: the entry's blob would exceed MAX_ENTRY_BLOB_LENGTH. */
export function entryTooLarge(): PassHolderError {
  return new PassHolderError("ENTRY_TOO_LARGE", "Entry too large");
}

/** syncVault: a dirty entry's blob exceeds the host limit; `detail` is its name (a tombstone's id). */
export function entryTooLargeToSync(name: string): PassHolderError {
  return new PassHolderError("ENTRY_TOO_LARGE_TO_SYNC", `Entry too large to sync: ${name}`, {
    detail: name,
  });
}

const INVALID_TOMBSTONE = "Invalid tombstone payload";

export function entryAad(id: string): string {
  return `passholder/v2/entry/${id}`;
}

function hlcJson(h: Hlc): Hlc {
  return { ms: h.ms, c: h.c, d: h.d };
}

function fieldsJson(data: EntryContent): unknown {
  switch (data.type) {
    case "login": {
      const f = data.fields;
      return {
        username: f.username,
        password: f.password,
        totp: f.totp,
        urls: f.urls,
        androidApps: f.androidApps,
      };
    }
    case "contact": {
      const f = data.fields;
      return {
        firstName: f.firstName,
        lastName: f.lastName,
        birthDate: f.birthDate,
        phones: f.phones.map((p) => ({ label: p.label, value: p.value })),
        emails: f.emails.map((e) => ({ label: e.label, value: e.value })),
        addresses: f.addresses.map((a) => ({
          label: a.label,
          street: a.street,
          postalCode: a.postalCode,
          city: a.city,
          country: a.country,
        })),
      };
    }
    case "card": {
      const f = data.fields;
      return { holder: f.holder, number: f.number, expiry: f.expiry, cvc: f.cvc, pin: f.pin };
    }
    case "note":
      return {};
    case "document": {
      const f = data.fields;
      return {
        kind: f.kind,
        number: f.number,
        fullName: f.fullName,
        issueDate: f.issueDate,
        expiryDate: f.expiryDate,
        issuer: f.issuer,
      };
    }
  }
}

/** Compact JSON with the fixed key order shared with the Kotlin core. */
export function serializeEntryData(data: EntryData | TombstoneData): string {
  if (!("v" in data)) return JSON.stringify({ hlc: hlcJson(data.hlc) });
  return JSON.stringify({
    v: 3,
    type: data.type,
    name: data.name,
    note: data.note,
    fields: fieldsJson(data),
    custom: data.custom.map((c) => ({ label: c.label, value: c.value, hidden: c.hidden })),
    // Only a non-empty list is written, so entries without files keep their exact bytes.
    ...(data.attachments && data.attachments.length > 0
      ? { attachments: data.attachments.map(attachmentJson) }
      : {}),
    hlc: hlcJson(data.hlc),
  });
}

/** Length of the Base64 blob, computed without encrypting: 1 + 12 + n + 16 bytes. */
export function entryBlobLength(data: EntryData | TombstoneData): number {
  return 4 * Math.ceil((29 + utf8(serializeEntryData(data)).length) / 3);
}

export function emptyLogin(name = ""): EntryContent & { type: "login" } {
  return {
    type: "login",
    name,
    note: "",
    custom: [],
    fields: { username: "", password: "", totp: "", urls: [], androidApps: [] },
  };
}

export function encryptPayload(
  vaultKey: Uint8Array,
  id: string,
  data: EntryData | TombstoneData,
): Promise<string> {
  return seal(vaultKey, utf8(serializeEntryData(data)), entryAad(id));
}

export async function decryptPayload(
  vaultKey: Uint8Array,
  id: string,
  blob: string,
): Promise<unknown> {
  return JSON.parse(fromUtf8(await open(vaultKey, blob, entryAad(id))));
}

function record(value: unknown, keys: readonly string[]): JsonObject {
  if (!hasExactKeys(value, keys)) invalidEntry();
  return value;
}

/** parseHlc ignores extra keys, so entries and tombstones check that the hlc object has exactly ms, c, d. */
function strictHlc(value: unknown, error: string): Hlc {
  if (!hasExactKeys(value, ["ms", "c", "d"])) throw new Error(error);
  return parseHlc(value);
}

function str(value: unknown): string {
  return requireString(value, () => new Error(INVALID_ENTRY));
}

function list<T>(value: unknown, item: (x: unknown) => T): T[] {
  if (!Array.isArray(value)) invalidEntry();
  return value.map(item);
}

function labeled(value: unknown): LabeledValue {
  const o = record(value, ["label", "value"]);
  return { label: str(o.label), value: str(o.value) };
}

function address(value: unknown): PostalAddress {
  const o = record(value, ["label", "street", "postalCode", "city", "country"]);
  return {
    label: str(o.label),
    street: str(o.street),
    postalCode: str(o.postalCode),
    city: str(o.city),
    country: str(o.country),
  };
}

function customField(value: unknown): CustomField {
  const o = record(value, ["label", "value", "hidden"]);
  if (typeof o.hidden !== "boolean") invalidEntry();
  return { label: str(o.label), value: str(o.value), hidden: o.hidden };
}

function parseContent(type: string, raw: unknown): { type: EntryType; fields: unknown } {
  switch (type) {
    case "login": {
      const o = record(raw, ["username", "password", "totp", "urls", "androidApps"]);
      const fields: LoginFields = {
        username: str(o.username),
        password: str(o.password),
        totp: str(o.totp),
        urls: list(o.urls, str),
        androidApps: list(o.androidApps, str),
      };
      return { type, fields };
    }
    case "contact": {
      const o = record(raw, [
        "firstName",
        "lastName",
        "birthDate",
        "phones",
        "emails",
        "addresses",
      ]);
      const fields: ContactFields = {
        firstName: str(o.firstName),
        lastName: str(o.lastName),
        birthDate: str(o.birthDate),
        phones: list(o.phones, labeled),
        emails: list(o.emails, labeled),
        addresses: list(o.addresses, address),
      };
      return { type, fields };
    }
    case "card": {
      const o = record(raw, ["holder", "number", "expiry", "cvc", "pin"]);
      const fields: CardFields = {
        holder: str(o.holder),
        number: str(o.number),
        expiry: str(o.expiry),
        cvc: str(o.cvc),
        pin: str(o.pin),
      };
      return { type, fields };
    }
    case "note":
      record(raw, []);
      return { type, fields: {} };
    case "document": {
      const o = record(raw, ["kind", "number", "fullName", "issueDate", "expiryDate", "issuer"]);
      const kind = str(o.kind);
      if (!isDocumentKind(kind)) invalidEntry();
      const fields: DocumentFields = {
        kind,
        number: str(o.number),
        fullName: str(o.fullName),
        issueDate: str(o.issueDate),
        expiryDate: str(o.expiryDate),
        issuer: str(o.issuer),
      };
      return { type, fields };
    }
    default:
      return invalidEntry();
  }
}

/** Accepts a v3 payload or a legacy v2 login payload (exactly name, username, password, hlc). */
export function parseEntryData(value: unknown): EntryData {
  if (!isRecord(value)) invalidEntry();
  if (!("v" in value)) {
    const o = record(value, ["name", "username", "password", "hlc"]);
    return {
      v: 3,
      type: "login",
      name: str(o.name),
      note: "",
      fields: {
        username: str(o.username),
        password: str(o.password),
        totp: "",
        urls: [],
        androidApps: [],
      },
      custom: [],
      hlc: strictHlc(o.hlc, INVALID_ENTRY),
    };
  }
  const withAttachments = Object.hasOwn(value, "attachments");
  const o = record(value, [
    "v",
    "type",
    "name",
    "note",
    "fields",
    "custom",
    ...(withAttachments ? ["attachments"] : []),
    "hlc",
  ]);
  if (o.v !== 3) invalidEntry();
  const content = contentOf(o);
  if (withAttachments) content.attachments = parseAttachments(o.attachments);
  return { v: 3, ...content, hlc: strictHlc(o.hlc, INVALID_ENTRY) } as EntryData;
}

/** Fields shared by a stored entry and an exported one; the caller has checked the object's own keys. */
function contentOf(o: JsonObject): EntryContent {
  const content = parseContent(str(o.type), o.fields);
  return {
    type: content.type,
    name: str(o.name),
    note: str(o.note),
    fields: content.fields,
    custom: list(o.custom, customField),
  } as EntryContent;
}

/** Entry content without the sync metadata: exactly type, name, note, fields and custom, validated as strictly as a stored v3 entry. */
export function parseEntryContent(value: unknown): EntryContent {
  return contentOf(record(value, ["type", "name", "note", "fields", "custom"]));
}

export function parseTombstoneData(value: unknown): TombstoneData {
  if (!hasExactKeys(value, ["hlc"])) throw new Error(INVALID_TOMBSTONE);
  return { hlc: strictHlc(value.hlc, INVALID_TOMBSTONE) };
}
