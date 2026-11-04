import { open, seal } from "../cipher.ts";
import { fromUtf8, utf8 } from "../encoding.ts";
import { parseHlc, type Hlc } from "./hlc.ts";

export interface EntryDataV2 {
  name: string;
  username: string;
  password: string;
  hlc: Hlc;
}

export interface TombstoneDataV2 {
  hlc: Hlc;
}

export function entryAadV2(id: string): string {
  return `passholder/v2/entry/${id}`;
}

export function encryptPayloadV2(
  vaultKey: Uint8Array,
  id: string,
  data: EntryDataV2 | TombstoneDataV2,
  nonce?: Uint8Array,
): Promise<string> {
  return seal(vaultKey, utf8(JSON.stringify(data)), entryAadV2(id), nonce);
}

export async function decryptPayloadV2(vaultKey: Uint8Array, id: string, blob: string): Promise<unknown> {
  return JSON.parse(fromUtf8(await open(vaultKey, blob, entryAadV2(id))));
}

export function parseEntryDataV2(value: unknown): EntryDataV2 {
  const v = value as Record<string, unknown>;
  if (
    typeof v !== "object" || v === null ||
    typeof v.name !== "string" || typeof v.username !== "string" || typeof v.password !== "string"
  ) {
    throw new Error("Invalid entry payload");
  }
  return { name: v.name, username: v.username, password: v.password, hlc: parseHlc(v.hlc) };
}

export function parseTombstoneDataV2(value: unknown): TombstoneDataV2 {
  const v = value as Record<string, unknown>;
  if (typeof v !== "object" || v === null) throw new Error("Invalid tombstone payload");
  return { hlc: parseHlc(v.hlc) };
}
