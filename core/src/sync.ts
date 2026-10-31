import type { RemoteRecord, SyncRequest, SyncResponse } from "./protocol.ts";
import {
  decryptPayload,
  encryptPayload,
  parseEntryData,
  parseTombstoneData,
  type EntryData,
  type TombstoneData,
} from "./vault.ts";

/** An entry as a client keeps it on the device (decrypted in memory, encrypted at rest by the client). */
export type LocalEntry =
  | { id: string; revision: number; dirty: boolean; deleted: false; data: EntryData }
  | { id: string; revision: number; dirty: boolean; deleted: true; data: TombstoneData };

export interface LocalVault {
  lastSyncRevision: number;
  entries: Map<string, LocalEntry>;
}

export function emptyVault(): LocalVault {
  return { lastSyncRevision: 0, entries: new Map() };
}

export function upsertEntry(vault: LocalVault, id: string, data: Omit<EntryData, "modifiedAt">, now = Date.now()): void {
  const revision = vault.entries.get(id)?.revision ?? 0;
  vault.entries.set(id, { id, revision, dirty: true, deleted: false, data: { ...data, modifiedAt: now } });
}

export function deleteEntry(vault: LocalVault, id: string, now = Date.now()): void {
  const existing = vault.entries.get(id);
  if (!existing) return;
  if (existing.revision === 0) {
    // Never reached the server, nothing to tell it.
    vault.entries.delete(id);
    return;
  }
  vault.entries.set(id, { id, revision: existing.revision, dirty: true, deleted: true, data: { modifiedAt: now } });
}

export function liveEntries(vault: LocalVault): (LocalEntry & { deleted: false })[] {
  return [...vault.entries.values()].filter((e): e is LocalEntry & { deleted: false } => !e.deleted);
}

export async function buildSyncRequest(vault: LocalVault, vaultKey: Uint8Array): Promise<SyncRequest> {
  const dirty = [...vault.entries.values()].filter((e) => e.dirty);
  const changes = await Promise.all(
    dirty.map(async (e) => ({
      id: e.id,
      baseRevision: e.revision,
      deleted: e.deleted,
      blob: await encryptPayload(vaultKey, e.id, e.data),
    })),
  );
  return { sinceRevision: vault.lastSyncRevision, changes };
}

async function decodeRemote(vaultKey: Uint8Array, record: RemoteRecord): Promise<LocalEntry> {
  const payload = await decryptPayload(vaultKey, record.id, record.blob);
  return record.deleted
    ? { id: record.id, revision: record.revision, dirty: false, deleted: true, data: parseTombstoneData(payload) }
    : { id: record.id, revision: record.revision, dirty: false, deleted: false, data: parseEntryData(payload) };
}

/**
 * Applies the server's answer. Conflicts are resolved by last write wins on modifiedAt; on a tie the
 * server's version wins, so every device reaches the same result.
 * Returns true when a local change won a conflict and must be pushed again.
 */
export async function applySyncResponse(
  vault: LocalVault,
  response: SyncResponse,
  vaultKey: Uint8Array,
): Promise<boolean> {
  for (const { id, revision } of response.accepted) {
    const entry = vault.entries.get(id);
    if (entry) vault.entries.set(id, { ...entry, revision, dirty: false });
  }

  let needsResync = false;
  for (const record of [...response.conflicts, ...response.changes]) {
    const remote = await decodeRemote(vaultKey, record);
    const local = vault.entries.get(record.id);
    if (local?.dirty && local.data.modifiedAt > remote.data.modifiedAt) {
      vault.entries.set(record.id, { ...local, revision: record.revision });
      needsResync = true;
    } else {
      vault.entries.set(record.id, remote);
    }
  }

  vault.lastSyncRevision = response.currentRevision;
  return needsResync;
}

export type SyncTransport = (request: SyncRequest) => Promise<SyncResponse>;

/** Full sync: push local changes, pull remote ones, repeat while local changes win conflicts. */
export async function syncVault(
  vault: LocalVault,
  vaultKey: Uint8Array,
  send: SyncTransport,
  maxRounds = 3,
): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    const response = await send(await buildSyncRequest(vault, vaultKey));
    if (!(await applySyncResponse(vault, response, vaultKey))) return;
  }
  throw new Error("Sync did not settle, try again");
}
