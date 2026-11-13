import { open, seal } from "../cipher.ts";
import { fromUtf8, utf8 } from "../encoding.ts";
import { attachmentJson, parseAttachments, type Attachment } from "../files/attachment.ts";
import { parseHlc, type Hlc } from "./hlc.ts";

export type EntryType = "login" | "contact" | "card" | "note" | "document";
export type DocumentKind = "id_card" | "passport" | "driving_license" | "student_id" | "other";

export interface LabeledValue { label: string; value: string }
export interface PostalAddress { label: string; street: string; postalCode: string; city: string; country: string }
export interface CustomField { label: string; value: string; hidden: boolean }
export interface LoginFields { username: string; password: string; totp: string; urls: string[]; androidApps: string[] }
export interface ContactFields {
  firstName: string;
  lastName: string;
  birthDate: string;
  phones: LabeledValue[];
  emails: LabeledValue[];
  addresses: PostalAddress[];
}
export interface CardFields { holder: string; number: string; expiry: string; cvc: string; pin: string }
export type NoteFields = Record<string, never>;
export interface DocumentFields {
  kind: DocumentKind;
  number: string;
  fullName: string;
  issueDate: string;
  expiryDate: string;
  issuer: string;
}

export type EntryContentV3 = { name: string; note: string; custom: CustomField[]; attachments?: Attachment[] } & (
  | { type: "login"; fields: LoginFields }
  | { type: "contact"; fields: ContactFields }
  | { type: "card"; fields: CardFields }
  | { type: "note"; fields: NoteFields }
  | { type: "document"; fields: DocumentFields }
);
export type EntryDataV3 = EntryContentV3 & { v: 3; hlc: Hlc };

export interface TombstoneDataV2 {
  hlc: Hlc;
}

export const MAX_ENTRY_BLOB_LENGTH = 65536;
export const ENTRY_TOO_LARGE = "Entry too large";
/** Prefix of the error syncVaultV2 throws for a dirty entry whose blob exceeds the host limit; ": <name>" follows. */
export const ENTRY_TOO_LARGE_TO_SYNC = "Entry too large to sync";

const INVALID_ENTRY = "Invalid entry payload";
const INVALID_TOMBSTONE = "Invalid tombstone payload";
const DOCUMENT_KINDS: readonly string[] = ["id_card", "passport", "driving_license", "student_id", "other"];

export function entryAadV2(id: string): string {
  return `passholder/v2/entry/${id}`;
}

function hlcJson(h: Hlc): Hlc {
  return { ms: h.ms, c: h.c, d: h.d };
}

function fieldsJson(data: EntryContentV3): unknown {
  switch (data.type) {
    case "login": {
      const f = data.fields;
      return { username: f.username, password: f.password, totp: f.totp, urls: f.urls, androidApps: f.androidApps };
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
          label: a.label, street: a.street, postalCode: a.postalCode, city: a.city, country: a.country,
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
        kind: f.kind, number: f.number, fullName: f.fullName,
        issueDate: f.issueDate, expiryDate: f.expiryDate, issuer: f.issuer,
      };
    }
  }
}

/** Compact JSON with the fixed key order shared with the Kotlin core. */
export function serializeEntryData(data: EntryDataV3 | TombstoneDataV2): string {
  if (!("v" in data)) return JSON.stringify({ hlc: hlcJson(data.hlc) });
  return JSON.stringify({
    v: 3,
    type: data.type,
    name: data.name,
    note: data.note,
    fields: fieldsJson(data),
    custom: data.custom.map((c) => ({ label: c.label, value: c.value, hidden: c.hidden })),
    // Only a non-empty list is written, so entries without files keep their exact bytes.
    ...(data.attachments && data.attachments.length > 0 ? { attachments: data.attachments.map(attachmentJson) } : {}),
    hlc: hlcJson(data.hlc),
  });
}

/** Length of the Base64 blob, computed without encrypting: 1 + 12 + n + 16 bytes. */
export function entryBlobLength(data: EntryDataV3 | TombstoneDataV2): number {
  return 4 * Math.ceil((29 + utf8(serializeEntryData(data)).length) / 3);
}

export function emptyLogin(name = ""): EntryContentV3 & { type: "login" } {
  return {
    type: "login",
    name,
    note: "",
    custom: [],
    fields: { username: "", password: "", totp: "", urls: [], androidApps: [] },
  };
}

export function encryptPayloadV2(
  vaultKey: Uint8Array,
  id: string,
  data: EntryDataV3 | TombstoneDataV2,
  nonce?: Uint8Array,
): Promise<string> {
  return seal(vaultKey, utf8(serializeEntryData(data)), entryAadV2(id), nonce);
}

export async function decryptPayloadV2(vaultKey: Uint8Array, id: string, blob: string): Promise<unknown> {
  return JSON.parse(fromUtf8(await open(vaultKey, blob, entryAadV2(id))));
}

function fail(): never {
  throw new Error(INVALID_ENTRY);
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const obj = value as Record<string, unknown>;
  const own = Object.keys(obj);
  if (own.length !== keys.length || !keys.every((k) => Object.hasOwn(obj, k))) fail();
  return obj;
}

/** parseHlc ignores extra keys, so entries and tombstones check that the hlc object has exactly ms, c, d. */
function strictHlc(value: unknown, error: string): Hlc {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(error);
  const keys = Object.keys(value);
  if (keys.length !== 3 || !["ms", "c", "d"].every((k) => keys.includes(k))) throw new Error(error);
  return parseHlc(value);
}

function str(value: unknown): string {
  if (typeof value !== "string") fail();
  return value;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) fail();
  return value.map(str);
}

function list<T>(value: unknown, item: (x: unknown) => T): T[] {
  if (!Array.isArray(value)) fail();
  return value.map(item);
}

function labeled(value: unknown): LabeledValue {
  const o = record(value, ["label", "value"]);
  return { label: str(o.label), value: str(o.value) };
}

function address(value: unknown): PostalAddress {
  const o = record(value, ["label", "street", "postalCode", "city", "country"]);
  return {
    label: str(o.label), street: str(o.street), postalCode: str(o.postalCode), city: str(o.city), country: str(o.country),
  };
}

function customField(value: unknown): CustomField {
  const o = record(value, ["label", "value", "hidden"]);
  if (typeof o.hidden !== "boolean") fail();
  return { label: str(o.label), value: str(o.value), hidden: o.hidden };
}

function parseContent(type: string, raw: unknown): { type: EntryType; fields: unknown } {
  switch (type) {
    case "login": {
      const o = record(raw, ["username", "password", "totp", "urls", "androidApps"]);
      const fields: LoginFields = {
        username: str(o.username), password: str(o.password), totp: str(o.totp),
        urls: strings(o.urls), androidApps: strings(o.androidApps),
      };
      return { type, fields };
    }
    case "contact": {
      const o = record(raw, ["firstName", "lastName", "birthDate", "phones", "emails", "addresses"]);
      const fields: ContactFields = {
        firstName: str(o.firstName), lastName: str(o.lastName), birthDate: str(o.birthDate),
        phones: list(o.phones, labeled), emails: list(o.emails, labeled), addresses: list(o.addresses, address),
      };
      return { type, fields };
    }
    case "card": {
      const o = record(raw, ["holder", "number", "expiry", "cvc", "pin"]);
      const fields: CardFields = {
        holder: str(o.holder), number: str(o.number), expiry: str(o.expiry), cvc: str(o.cvc), pin: str(o.pin),
      };
      return { type, fields };
    }
    case "note":
      record(raw, []);
      return { type, fields: {} };
    case "document": {
      const o = record(raw, ["kind", "number", "fullName", "issueDate", "expiryDate", "issuer"]);
      const kind = str(o.kind);
      if (!DOCUMENT_KINDS.includes(kind)) fail();
      const fields: DocumentFields = {
        kind: kind as DocumentKind, number: str(o.number), fullName: str(o.fullName),
        issueDate: str(o.issueDate), expiryDate: str(o.expiryDate), issuer: str(o.issuer),
      };
      return { type, fields };
    }
    default:
      return fail();
  }
}

/** Accepts a v3 payload or a legacy v2 login payload (exactly name, username, password, hlc). */
export function parseEntryData(value: unknown): EntryDataV3 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const obj = value as Record<string, unknown>;
  if (!("v" in obj)) {
    const o = record(value, ["name", "username", "password", "hlc"]);
    return {
      v: 3,
      type: "login",
      name: str(o.name),
      note: "",
      fields: { username: str(o.username), password: str(o.password), totp: "", urls: [], androidApps: [] },
      custom: [],
      hlc: strictHlc(o.hlc, INVALID_ENTRY),
    };
  }
  const withAttachments = Object.hasOwn(obj, "attachments");
  const o = record(value, ["v", "type", "name", "note", "fields", "custom", ...(withAttachments ? ["attachments"] : []), "hlc"]);
  if (o.v !== 3) fail();
  const content = contentOf(o);
  if (withAttachments) content.attachments = parseAttachments(o.attachments);
  return { v: 3, ...content, hlc: strictHlc(o.hlc, INVALID_ENTRY) } as EntryDataV3;
}

/** Fields shared by a stored entry and an exported one; the caller has checked the object's own keys. */
function contentOf(o: Record<string, unknown>): EntryContentV3 {
  const content = parseContent(str(o.type), o.fields);
  return {
    type: content.type,
    name: str(o.name),
    note: str(o.note),
    fields: content.fields,
    custom: list(o.custom, customField),
  } as EntryContentV3;
}

/** Entry content without the sync metadata: exactly type, name, note, fields and custom, validated as strictly as a stored v3 entry. */
export function parseEntryContent(value: unknown): EntryContentV3 {
  return contentOf(record(value, ["type", "name", "note", "fields", "custom"]));
}

export function parseTombstoneData(value: unknown): TombstoneDataV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(INVALID_TOMBSTONE);
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "hlc") throw new Error(INVALID_TOMBSTONE);
  return { hlc: strictHlc((value as Record<string, unknown>).hlc, INVALID_TOMBSTONE) };
}
