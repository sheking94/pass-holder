import { fromUtf8, open, p2p, seal, utf8 } from "@passholder/core";

export const LOCAL_VAULT_AAD = "passholder/v2/local-vault";

/** An entry of any type that is not deleted, as the typed screens list and edit it; data has no `v` or `hlc`. */
export interface StoredEntry {
  id: string;
  dirty: boolean;
  data: p2p.EntryContent;
}

export function storedView(e: p2p.LocalEntry): StoredEntry | undefined {
  if (e.deleted) return undefined;
  const { v, hlc, ...data } = e.data;
  return { id: e.id, dirty: e.dirty, data: data as p2p.EntryContent };
}

function serializeVault(vault: p2p.LocalVault): string {
  return JSON.stringify({
    epoch: vault.epoch,
    lastSyncRevision: vault.lastSyncRevision,
    addresses: vault.addresses,
    entries: [...vault.entries.values()],
  });
}

function deserializeVault(json: string): p2p.LocalVault {
  const parsed = JSON.parse(json) as {
    epoch: string | null;
    lastSyncRevision: number;
    addresses: string[];
    entries: { id: string; revision: number; dirty: boolean; deleted: boolean; data: unknown }[];
  };
  // A vault saved by an older version holds v2 data (name, username, password, hlc): parseEntryData makes it a v3 login.
  const entries = parsed.entries.map((e): p2p.LocalEntry =>
    e.deleted
      ? {
          id: e.id,
          revision: e.revision,
          dirty: e.dirty,
          deleted: true,
          data: p2p.parseTombstoneData(e.data),
        }
      : {
          id: e.id,
          revision: e.revision,
          dirty: e.dirty,
          deleted: false,
          data: p2p.parseEntryData(e.data),
        },
  );
  return {
    epoch: parsed.epoch,
    lastSyncRevision: parsed.lastSyncRevision,
    addresses: parsed.addresses,
    entries: new Map(entries.map((e) => [e.id, e])),
  };
}

/** The vault as it is kept on disk: JSON sealed with the vault key (LOCAL_VAULT_AAD). */
export function sealVault(vaultKey: Uint8Array, vault: p2p.LocalVault): Promise<string> {
  return seal(vaultKey, utf8(serializeVault(vault)), LOCAL_VAULT_AAD);
}

export async function openVault(vaultKey: Uint8Array, blob: string): Promise<p2p.LocalVault> {
  return deserializeVault(fromUtf8(await open(vaultKey, blob, LOCAL_VAULT_AAD)));
}
