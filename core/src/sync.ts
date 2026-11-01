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

export const INCONSISTENT_RECORD =
  "Serwer zwrócił wpis, którego flaga usunięcia nie zgadza się z zaszyfrowaną treścią. Synchronizacja przerwana, dane na tym urządzeniu są bez zmian.";

/**
 * The deleted flag comes from the server in plain text; the payload must agree with it (see
 * parseTombstoneData), so a server cannot turn an entry into a tombstone.
 */
async function decodeRemote(vaultKey: Uint8Array, record: RemoteRecord): Promise<LocalEntry> {
  const payload = await decryptPayload(vaultKey, record.id, record.blob);
  try {
    return record.deleted
      ? { id: record.id, revision: record.revision, dirty: false, deleted: true, data: parseTombstoneData(payload) }
      : { id: record.id, revision: record.revision, dirty: false, deleted: false, data: parseEntryData(payload) };
  } catch {
    throw new Error(INCONSISTENT_RECORD);
  }
}

/**
 * Applies the server's answer. Conflicts are resolved by last write wins on modifiedAt; on a tie the
 * server's version wins, so every device reaches the same result.
 *
 * Last write wins applies to every record, not only to local changes: a remote version older than the
 * local one is refused and the local one is pushed again. Otherwise a server could send back an old
 * ciphertext of an entry (e.g. from before a password change) under a new revision, and every client
 * would accept it, because it decrypts fine (S2 of the security review).
 *
 * Everything is decrypted and checked before anything changes, so a bad record leaves the vault as it was.
 * Returns true when a local version won and must be pushed again.
 */
export async function applySyncResponse(
  vault: LocalVault,
  response: SyncResponse,
  vaultKey: Uint8Array,
): Promise<boolean> {
  const remotes = await Promise.all([...response.conflicts, ...response.changes].map((r) => decodeRemote(vaultKey, r)));

  for (const { id, revision } of response.accepted) {
    const entry = vault.entries.get(id);
    if (entry) vault.entries.set(id, { ...entry, revision, dirty: false });
  }

  let needsResync = false;
  for (const remote of remotes) {
    const local = vault.entries.get(remote.id);
    if (local && local.data.modifiedAt > remote.data.modifiedAt) {
      vault.entries.set(remote.id, { ...local, revision: remote.revision, dirty: true });
      needsResync = true;
    } else {
      vault.entries.set(remote.id, remote);
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
