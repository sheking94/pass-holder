import type { RemoteRecord } from "../protocol.ts";
import {
  decryptPayloadV2,
  encryptPayloadV2,
  parseEntryDataV2,
  parseTombstoneDataV2,
  type EntryDataV2,
  type TombstoneDataV2,
} from "./entry.ts";
import { compareHlc, type HlcClock } from "./hlc.ts";
import type { P2pSyncRequest, P2pSyncResponse } from "./host-sync.ts";

export type LocalEntryV2 =
  | { id: string; revision: number; dirty: boolean; deleted: false; data: EntryDataV2 }
  | { id: string; revision: number; dirty: boolean; deleted: true; data: TombstoneDataV2 };

export interface LocalVaultV2 {
  /** Epoch of the phone this vault is synced with, null until the first sync. */
  epoch: string | null;
  lastSyncRevision: number;
  entries: Map<string, LocalEntryV2>;
  /** Host addresses learned from the phone, without duplicates. */
  addresses: string[];
}

export function emptyVaultV2(): LocalVaultV2 {
  return { epoch: null, lastSyncRevision: 0, entries: new Map(), addresses: [] };
}

export function upsertEntryV2(
  vault: LocalVaultV2,
  clock: HlcClock,
  id: string,
  data: Omit<EntryDataV2, "hlc">,
): void {
  const revision = vault.entries.get(id)?.revision ?? 0;
  vault.entries.set(id, { id, revision, dirty: true, deleted: false, data: { ...data, hlc: clock.tick() } });
}

export function deleteEntryV2(vault: LocalVaultV2, clock: HlcClock, id: string): void {
  const existing = vault.entries.get(id);
  if (!existing) return;
  if (existing.revision === 0) {
    // Never reached the phone, nothing to tell it.
    vault.entries.delete(id);
    return;
  }
  vault.entries.set(id, {
    id,
    revision: existing.revision,
    dirty: true,
    deleted: true,
    data: { hlc: clock.tick() },
  });
}

export function liveEntriesV2(vault: LocalVaultV2): (LocalEntryV2 & { deleted: false })[] {
  return [...vault.entries.values()].filter((e): e is LocalEntryV2 & { deleted: false } => !e.deleted);
}

async function buildRequest(vault: LocalVaultV2, vaultKey: Uint8Array): Promise<P2pSyncRequest> {
  const dirty = [...vault.entries.values()].filter((e) => e.dirty);
  const changes = await Promise.all(
    dirty.map(async (e) => ({
      id: e.id,
      baseRevision: e.revision,
      deleted: e.deleted,
      blob: await encryptPayloadV2(vaultKey, e.id, e.data),
    })),
  );
  // An unknown epoch is sent as "" and only serves to learn the phone's epoch.
  return { epoch: vault.epoch ?? "", sinceRevision: vault.lastSyncRevision, changes };
}

async function decodeRemote(vaultKey: Uint8Array, record: RemoteRecord): Promise<LocalEntryV2> {
  const payload = await decryptPayloadV2(vaultKey, record.id, record.blob);
  return record.deleted
    ? { id: record.id, revision: record.revision, dirty: false, deleted: true, data: parseTombstoneDataV2(payload) }
    : { id: record.id, revision: record.revision, dirty: false, deleted: false, data: parseEntryDataV2(payload) };
}

function adoptEpoch(vault: LocalVaultV2, epoch: string): void {
  vault.epoch = epoch;
  vault.lastSyncRevision = 0;
  // The new phone knows none of our records: send everything, including tombstones.
  for (const [id, entry] of vault.entries) vault.entries.set(id, { ...entry, revision: 0, dirty: true });
}

function addAddresses(vault: LocalVaultV2, addresses: string[]): void {
  for (const address of addresses) if (!vault.addresses.includes(address)) vault.addresses.push(address);
}

/**
 * Applies the phone's answer (same epoch). Conflicts are resolved by HLC: a dirty local change wins only when
 * its HLC is greater. Returns true when a local change won a conflict and must be pushed again.
 */
async function applyResponse(
  vault: LocalVaultV2,
  clock: HlcClock,
  response: P2pSyncResponse,
  vaultKey: Uint8Array,
): Promise<boolean> {
  for (const { id, revision } of response.accepted) {
    const entry = vault.entries.get(id);
    if (entry) vault.entries.set(id, { ...entry, revision, dirty: false });
  }

  let needsResync = false;
  for (const record of [...response.conflicts, ...response.changes]) {
    const remote = await decodeRemote(vaultKey, record);
    clock.observe(remote.data.hlc);
    const local = vault.entries.get(record.id);
    if (local?.dirty && compareHlc(local.data.hlc, remote.data.hlc) > 0) {
      vault.entries.set(record.id, { ...local, revision: record.revision });
      needsResync = true;
    } else {
      vault.entries.set(record.id, remote);
    }
  }

  vault.lastSyncRevision = response.currentRevision;
  addAddresses(vault, response.addresses);
  return needsResync;
}

export type P2pTransport = (request: P2pSyncRequest) => Promise<P2pSyncResponse>;

/**
 * Full sync with the phone: push local changes, pull remote ones, repeat while local changes win conflicts.
 * An epoch change (including learning the first epoch) restarts the loop with a fresh round budget, once.
 */
export async function syncVaultV2(
  vault: LocalVaultV2,
  vaultKey: Uint8Array,
  clock: HlcClock,
  send: P2pTransport,
  maxRounds = 3,
): Promise<void> {
  let epochChanged = false;
  let rounds = 0;
  while (rounds < maxRounds) {
    const response = await send(await buildRequest(vault, vaultKey));
    if (response.epoch !== vault.epoch) {
      if (epochChanged) throw new Error("Epoch changed twice during sync");
      epochChanged = true;
      adoptEpoch(vault, response.epoch);
      addAddresses(vault, response.addresses);
      continue;
    }
    if (!(await applyResponse(vault, clock, response, vaultKey))) return;
    rounds++;
  }
  throw new Error("Sync did not settle, try again");
}
