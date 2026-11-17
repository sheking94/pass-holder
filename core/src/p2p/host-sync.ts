/**
 * Reference host, for tests and scripts only: the phone runs the Kotlin host
 * (android/core/.../p2p/HostSync.kt). Client code (p2p/sync.ts, files/client.ts) imports only the types and
 * limits from here. The extension's tests drive this host as a fake phone.
 */
import { MAX_ENTRY_BLOB_LENGTH } from "./entry.ts";
import { isRecord } from "../strict-json.ts";
import { processSync, type ChangeRequest, type RemoteRecord, type SyncStore } from "../protocol.ts";

export interface P2pSyncRequest {
  epoch: string;
  sinceRevision: number;
  changes: ChangeRequest[];
}

export interface P2pSyncResponse {
  epoch: string;
  /**
   * With more = true: the revision of the last record in changes (the request's sinceRevision when none was
   * included), so the next sinceRevision continues there.
   */
  currentRevision: number;
  accepted: { id: string; revision: number }[];
  conflicts: RemoteRecord[];
  changes: RemoteRecord[];
  addresses: string[];
  /** True when conflicts or changes were cut (MAX_CHANGES_PER_RESPONSE or MAX_BLOB_BYTES_PER_ROUND): ask again. */
  more: boolean;
}

/** Most records in a response's changes (ordered by revision). */
export const MAX_CHANGES_PER_RESPONSE = 500;
/** Most changes in one request; the client sends the rest in later rounds. */
export const MAX_CHANGES_PER_REQUEST = 500;

/**
 * Most blob characters (conflicts plus changes) in one response and in one request. The first record always goes
 * in, even when it alone is larger. Kept below 768 KiB because a request body is Base64 of the frames (x4/3)
 * and must stay under MAX_BODY_BYTES.
 */
export const MAX_BLOB_BYTES_PER_ROUND = 524288;

export const MAX_ENTRY_ID_LENGTH = 128;

const isRevision = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * Checks a decrypted sync request before anything is written. Returns the error text for a 400, or undefined.
 * Every change is checked against the store first, so a bad change never leaves earlier ones applied.
 */
export function validateP2pSyncRequest(
  store: SyncStore,
  epoch: string,
  request: unknown,
): string | undefined {
  if (!isRecord(request)) return "malformed sync request";
  const r = request;
  if (typeof r.epoch !== "string" || !isRevision(r.sinceRevision) || !Array.isArray(r.changes))
    return "malformed sync request";
  if (r.changes.length > MAX_CHANGES_PER_REQUEST) return "too many changes";
  const ids = new Set<string>();
  for (const c of r.changes as unknown[]) {
    if (!isRecord(c)) return "malformed change";
    const { id, baseRevision, deleted, blob } = c;
    if (
      typeof id !== "string" ||
      id.length < 1 ||
      id.length > MAX_ENTRY_ID_LENGTH ||
      !isRevision(baseRevision) ||
      typeof deleted !== "boolean" ||
      typeof blob !== "string"
    )
      return "malformed change";
    if (blob.length > MAX_ENTRY_BLOB_LENGTH) return "blob too large";
    if (ids.has(id)) return "duplicate change";
    ids.add(id);
  }
  // A request from another epoch is not processed, so its base revisions do not matter.
  if (r.epoch !== epoch) return undefined;
  // A client ahead of this store sees a restored phone and starts over; its changes are not processed either.
  if ((r.sinceRevision as number) > store.currentRevision()) return undefined;
  for (const c of r.changes as ChangeRequest[]) {
    if (c.baseRevision !== 0 && store.get(c.id) === undefined) return "unknown base revision";
  }
  return undefined;
}

/**
 * Host side of P2P sync. A request from another epoch, or with sinceRevision ahead of the store, is not processed:
 * the client only learns the epoch and revision.
 * Throws (before any write) when validateP2pSyncRequest rejects the request.
 */
export function processP2pSync(
  store: SyncStore,
  epoch: string,
  addresses: string[],
  request: P2pSyncRequest,
): P2pSyncResponse {
  const error = validateP2pSyncRequest(store, epoch, request);
  if (error !== undefined) throw new Error(error);
  // sinceRevision ahead of the store: the phone was restored, so the client resets itself (see syncVault).
  if (request.epoch !== epoch || request.sinceRevision > store.currentRevision()) {
    return {
      epoch,
      currentRevision: store.currentRevision(),
      accepted: [],
      conflicts: [],
      changes: [],
      addresses,
      more: false,
    };
  }
  const { sinceRevision, changes } = request;
  const result = processSync(store, { sinceRevision, changes });
  const sorted = [...result.changes].sort((a, b) => a.revision - b.revision);
  // Conflicts first, then changes; the first record always goes in, then while the running sum fits the budget.
  let budget = MAX_BLOB_BYTES_PER_ROUND;
  let included = 0;
  const fits = (r: RemoteRecord): boolean => {
    if (included > 0 && r.blob.length > budget) return false;
    budget -= r.blob.length;
    included++;
    return true;
  };
  const conflicts: RemoteRecord[] = [];
  for (const r of result.conflicts) {
    if (!fits(r)) break;
    conflicts.push(r);
  }
  const page: RemoteRecord[] = [];
  if (conflicts.length === result.conflicts.length) {
    for (const r of sorted) {
      if (page.length >= MAX_CHANGES_PER_RESPONSE || !fits(r)) break;
      page.push(r);
    }
  }
  if (conflicts.length === result.conflicts.length && page.length === sorted.length) {
    return { ...result, conflicts, changes: page, epoch, addresses, more: false };
  }
  // Records skipped below this revision were answered in accepted or conflicts, so nothing is lost. Omitted
  // conflicts leave their changes dirty on the client, which sends them again.
  const currentRevision = page.length > 0 ? page[page.length - 1]!.revision : sinceRevision;
  return { ...result, conflicts, changes: page, currentRevision, epoch, addresses, more: true };
}
