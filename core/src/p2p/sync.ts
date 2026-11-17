import { MAX_ATTACHMENTS_PARSED, parseAttachments } from "../files/attachment.ts";
import { PassHolderError } from "../errors.ts";
import { mergeAttachments } from "../files/merge.ts";
import type { RemoteRecord } from "../protocol.ts";
import {
  decryptPayload,
  encryptPayload,
  entryTooLarge,
  entryTooLargeToSync,
  entryBlobLength,
  MAX_ENTRY_BLOB_LENGTH,
  parseEntryData,
  parseTombstoneData,
  type EntryContent,
  type EntryData,
  type TombstoneData,
} from "./entry.ts";
import { compareHlc, HlcClock, type Hlc } from "./hlc.ts";
import {
  MAX_BLOB_BYTES_PER_ROUND,
  MAX_CHANGES_PER_REQUEST,
  type P2pSyncRequest,
  type P2pSyncResponse,
} from "./host-sync.ts";

/** Safety limit on requests in one syncVault call, paging included. */
export const MAX_SYNC_ROUNDS = 1000;
/** Resyncs after a conflict (a local change must be pushed again) before syncVault gives up. */
const MAX_CONFLICT_RESYNCS = 3;

export type LocalEntry =
  | { id: string; revision: number; dirty: boolean; deleted: false; data: EntryData }
  | { id: string; revision: number; dirty: boolean; deleted: true; data: TombstoneData };

export interface LocalVault {
  /**
   * Epoch of the phone this vault is synced with, null until the first sync.
   * Never assign it directly: use applyVaultInfo (pairing) or let syncVault change it, so the reset runs.
   */
  epoch: string | null;
  lastSyncRevision: number;
  entries: Map<string, LocalEntry>;
  /** Host addresses learned from the phone, without duplicates. Replaced whenever the epoch changes. */
  addresses: string[];
}

export function emptyVault(): LocalVault {
  return { epoch: null, lastSyncRevision: 0, entries: new Map(), addresses: [] };
}

export function upsertEntry(
  vault: LocalVault,
  clock: HlcClock,
  id: string,
  input: EntryContent,
): void {
  // An empty list is dropped (a plugin may save one); a bad or over-long list throws before anything changes.
  const { attachments, ...rest } = input;
  const content: EntryContent =
    attachments === undefined || attachments.length === 0
      ? (rest as EntryContent)
      : ({ ...rest, attachments: parseAttachments(attachments) } as EntryContent);
  const existing = vault.entries.get(id);
  // Size check on a copy of the clock first: a rejected entry changes neither the vault nor the clock.
  const probe = clock.clone();
  if (existing) probe.observe(existing.data.hlc);
  if (entryBlobLength({ ...content, v: 3, hlc: probe.tick() }) > MAX_ENTRY_BLOB_LENGTH)
    throw entryTooLarge();
  // A restarted clock must still order this edit after the version it overwrites.
  if (existing) clock.observe(existing.data.hlc);
  const revision = existing?.revision ?? 0;
  vault.entries.set(id, {
    id,
    revision,
    dirty: true,
    deleted: false,
    data: { ...content, v: 3, hlc: clock.tick() },
  });
}

export function deleteEntry(vault: LocalVault, clock: HlcClock, id: string): void {
  const existing = vault.entries.get(id);
  if (!existing) return;
  clock.observe(existing.data.hlc);
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

export function liveEntries(vault: LocalVault): (LocalEntry & { deleted: false })[] {
  return [...vault.entries.values()].filter(
    (e): e is LocalEntry & { deleted: false } => !e.deleted,
  );
}

/** A clock that continues after every HLC already in the vault (for a device whose clock was not persisted). */
export function clockForVault(vault: LocalVault, deviceId: string, now?: () => number): HlcClock {
  const clock = new HlcClock(deviceId, now);
  let max: Hlc | undefined;
  for (const e of vault.entries.values())
    if (!max || compareHlc(e.data.hlc, max) > 0) max = e.data.hlc;
  if (max) clock.observe(max);
  return clock;
}

interface BuiltRequest {
  request: P2pSyncRequest;
  /** HLC of each change as it was sent, to tell whether the entry changed while the request was in flight. */
  sent: Map<string, Hlc>;
  /** More dirty entries are waiting than fit in this request. */
  capped: boolean;
}

async function buildRequest(vault: LocalVault, vaultKey: Uint8Array): Promise<BuiltRequest> {
  const allDirty = [...vault.entries.values()].filter((e) => e.dirty);
  // The host rejects a whole request holding an oversized blob, so it would never get through: say which entry it is.
  // (An entry saved before v3 can grow past the limit when it is serialized as v3.)
  for (const e of allDirty) {
    if (entryBlobLength(e.data) > MAX_ENTRY_BLOB_LENGTH) {
      throw entryTooLargeToSync(e.deleted ? e.id : e.data.name);
    }
  }
  // Up to MAX_CHANGES_PER_REQUEST entries and MAX_BLOB_BYTES_PER_ROUND blob characters; the first always goes in.
  const dirty: LocalEntry[] = [];
  let budget = MAX_BLOB_BYTES_PER_ROUND;
  for (const e of allDirty) {
    if (dirty.length >= MAX_CHANGES_PER_REQUEST) break;
    const length = entryBlobLength(e.data);
    if (dirty.length > 0 && length > budget) break;
    budget -= length;
    dirty.push(e);
  }
  const sent = new Map(dirty.map((e) => [e.id, { ...e.data.hlc }]));
  const changes = await Promise.all(
    dirty.map(async (e) => ({
      id: e.id,
      baseRevision: e.revision,
      deleted: e.deleted,
      blob: await encryptPayload(vaultKey, e.id, e.data),
    })),
  );
  // An unknown epoch is sent as "" and only serves to learn the phone's epoch.
  return {
    request: { epoch: vault.epoch ?? "", sinceRevision: vault.lastSyncRevision, changes },
    sent,
    capped: allDirty.length > dirty.length,
  };
}

async function decodeRemote(vaultKey: Uint8Array, record: RemoteRecord): Promise<LocalEntry> {
  const payload = await decryptPayload(vaultKey, record.id, record.blob);
  return record.deleted
    ? {
        id: record.id,
        revision: record.revision,
        dirty: false,
        deleted: true,
        data: parseTombstoneData(payload),
      }
    : {
        id: record.id,
        revision: record.revision,
        dirty: false,
        deleted: false,
        data: parseEntryData(payload),
      };
}

/** Starts over with a phone that knows none of our records (new epoch, or the phone's state went backwards). */
function adoptEpoch(vault: LocalVault, epoch: string): void {
  vault.epoch = epoch;
  vault.lastSyncRevision = 0;
  // The new phone knows none of our records: send everything, including tombstones.
  for (const [id, entry] of vault.entries)
    vault.entries.set(id, { ...entry, revision: 0, dirty: true });
}

/**
 * Applies the vault info received during pairing. A different epoch (also the first one) goes through the same
 * reset as an epoch change during sync; the addresses are always replaced.
 */
export function applyVaultInfo(
  vault: LocalVault,
  info: { epoch: string; addresses: string[] },
): void {
  if (vault.epoch !== info.epoch) adoptEpoch(vault, info.epoch);
  vault.addresses = [...new Set(info.addresses)];
}

function addAddresses(vault: LocalVault, addresses: string[]): void {
  for (const address of addresses)
    if (!vault.addresses.includes(address)) vault.addresses.push(address);
}

/**
 * Applies the phone's answer (same epoch). Conflicts are resolved by HLC: a dirty local change wins only when
 * its HLC is greater, and a remote version older than the local one is never taken. Returns true when something local must be pushed again: a local change won a conflict, or
 * the attachment lists were merged and the merged entry was saved as a new local change (even if the remote won).
 */
async function applyResponse(
  vault: LocalVault,
  clock: HlcClock,
  response: P2pSyncResponse,
  sent: Map<string, Hlc>,
  vaultKey: Uint8Array,
): Promise<boolean> {
  for (const { id, revision } of response.accepted) {
    const entry = vault.entries.get(id);
    const sentHlc = sent.get(id);
    if (!entry) {
      // Deleted while its first push was in flight: the phone now has it, so it needs a tombstone.
      vault.entries.set(id, {
        id,
        revision,
        dirty: true,
        deleted: true,
        data: { hlc: clock.tick() },
      });
    } else {
      // Changed while in flight: the phone has the older version, keep the newer one dirty.
      const unchanged = sentHlc !== undefined && compareHlc(entry.data.hlc, sentHlc) === 0;
      vault.entries.set(id, { ...entry, revision, dirty: !unchanged });
    }
  }

  let needsResync = false;
  for (const record of [...response.conflicts, ...response.changes]) {
    const remote = await decodeRemote(vaultKey, record);
    clock.observe(remote.data.hlc);
    const local = vault.entries.get(record.id);
    const localWins = local?.dirty === true && compareHlc(local.data.hlc, remote.data.hlc) > 0;
    // Both versions live and the local one unsent: the HLC picks the entry, but the attachment lists are merged.
    const merged =
      local?.dirty && !local.deleted && !remote.deleted
        ? localWins
          ? mergeEntryAttachments(local.data, remote.data, clock)
          : mergeEntryAttachments(remote.data, local.data, clock)
        : undefined;
    if (localWins) {
      vault.entries.set(
        record.id,
        merged
          ? { id: record.id, revision: record.revision, dirty: true, deleted: false, data: merged }
          : { ...local!, revision: record.revision },
      );
      needsResync = true;
    } else if (merged) {
      // The remote version wins but lacks some local files: keep it with the merged list as a new local change.
      vault.entries.set(record.id, {
        id: record.id,
        revision: record.revision,
        dirty: true,
        deleted: false,
        data: merged,
      });
      needsResync = true;
    } else if (local && compareHlc(remote.data.hlc, local.data.hlc) < 0) {
      // Security review V3-I2: an older version than the one known here (an old ciphertext replayed under a new
      // revision) is ignored. Every edit observes the HLC it overwrites, so a real newer version never has a
      // smaller one. The entry keeps its revision: a later local edit meets a conflict and wins it by HLC.
      continue;
    } else {
      vault.entries.set(record.id, remote);
    }
  }

  vault.lastSyncRevision = response.currentRevision;
  addAddresses(vault, response.addresses);
  return needsResync;
}

/**
 * The winning entry with the merged attachment list and a fresh HLC when the merge adds files to it, otherwise
 * undefined. The winner's list stays unchanged when the merge would exceed MAX_ATTACHMENTS_PARSED or make the
 * entry too large to sync. The merged list always holds the winner's files, so it is never empty.
 */
function mergeEntryAttachments(
  winner: EntryData,
  loser: EntryData,
  clock: HlcClock,
): EntryData | undefined {
  const merged = mergeAttachments(winner.attachments, loser.attachments);
  // The merge only appends, so an unchanged length means an unchanged id sequence.
  if (merged.length === (winner.attachments?.length ?? 0) || merged.length > MAX_ATTACHMENTS_PARSED)
    return undefined;
  // Measure with a throwaway tick; the real clock moves only when the merge is accepted.
  const probe: EntryData = { ...winner, attachments: merged, hlc: clock.clone().tick() };
  if (entryBlobLength(probe) > MAX_ENTRY_BLOB_LENGTH) return undefined;
  return { ...probe, hlc: clock.tick() };
}

export type P2pTransport = (request: P2pSyncRequest) => Promise<P2pSyncResponse>;

/**
 * Full sync with the phone: push local changes, pull remote ones, repeat while something local must be pushed
 * again (a local change won a conflict, or merged attachment lists were saved as a new local change).
 * Changes go out at most MAX_CHANGES_PER_REQUEST (and MAX_BLOB_BYTES_PER_ROUND blob characters) per request and
 * come back in pages (`more`); those extra rounds, including rounds that need a resync but the
 * answer was cut, do not use the MAX_CONFLICT_RESYNCS budget, but all rounds together are capped at MAX_SYNC_ROUNDS.
 * An epoch change (including learning the first epoch) restarts the loop with a fresh round budget, once.
 * A phone whose revision went backwards within the same epoch is treated the same way.
 */
export async function syncVault(
  vault: LocalVault,
  vaultKey: Uint8Array,
  clock: HlcClock,
  send: P2pTransport,
): Promise<void> {
  let epochChanged = false;
  let resyncs = 0;
  for (let round = 0; round < MAX_SYNC_ROUNDS; round++) {
    const { request, sent, capped } = await buildRequest(vault, vaultKey);
    const response = await send(request);
    // Same epoch but the phone is behind what we already saw: its state was restored. Upload everything.
    const wentBack =
      response.epoch === vault.epoch && response.currentRevision < vault.lastSyncRevision;
    if (response.epoch !== vault.epoch || wentBack) {
      if (epochChanged)
        throw new PassHolderError("SYNC_EPOCH_CHANGED_TWICE", "Epoch changed twice during sync");
      epochChanged = true;
      adoptEpoch(vault, response.epoch);
      vault.addresses = [...new Set(response.addresses)];
      resyncs = 0;
      continue;
    }
    const needsResync = await applyResponse(vault, clock, response, sent, vaultKey);
    // A round whose answer was cut (more) resolves at least one record, so it is paging, not a conflict ping-pong.
    if (needsResync && !response.more && ++resyncs >= MAX_CONFLICT_RESYNCS)
      throw new PassHolderError("SYNC_NOT_SETTLED", "Sync did not settle, try again");
    if (!needsResync && !capped && !response.more) return;
  }
  throw new PassHolderError("SYNC_ROUND_LIMIT", "Sync exceeded the round limit");
}
