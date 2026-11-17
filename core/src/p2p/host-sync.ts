/**
 * Reference host, for tests and scripts only: the phone runs the Kotlin host
 * (android/core/.../p2p/HostSync.kt). Client code (p2p/sync.ts, files/client.ts) imports only the types and
 * limits from here. The extension's tests drive this host as a fake phone.
 */
import { MAX_ENTRY_BLOB_LENGTH } from "./entry.ts";
import { isRecord } from "../strict-json.ts";
import { processSync, type ChangeRequest, type RemoteRecord, type SyncStore } from "../protocol.ts";
import { KIB } from "../sizes.ts";

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
export const MAX_BLOB_BYTES_PER_ROUND = 512 * KIB;

export const MAX_ENTRY_ID_LENGTH = 128;

const isRevision = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** A decrypted sync request the host refuses; the message is the error text of the 400 answer. */
export class InvalidSyncRequestError extends Error {}

const invalid = (error: string): never => {
  throw new InvalidSyncRequestError(error);
};

/**
 * Checks the shape of a decrypted sync request and returns it as a typed request. Extra fields are dropped.
 * Throws InvalidSyncRequestError.
 */
export function parseP2pSyncRequest(request: unknown): P2pSyncRequest {
  if (!isRecord(request)) return invalid("malformed sync request");
  const { epoch, sinceRevision, changes } = request;
  if (typeof epoch !== "string" || !isRevision(sinceRevision) || !Array.isArray(changes))
    return invalid("malformed sync request");
  if (changes.length > MAX_CHANGES_PER_REQUEST) return invalid("too many changes");
  const ids = new Set<string>();
  const parsed = (changes as unknown[]).map((c): ChangeRequest => {
    const change = parseChange(c);
    if (ids.has(change.id)) return invalid("duplicate change");
    ids.add(change.id);
    return change;
  });
  return { epoch, sinceRevision, changes: parsed };
}

function parseChange(c: unknown): ChangeRequest {
  if (!isRecord(c)) return invalid("malformed change");
  const { id, baseRevision, deleted, blob } = c;
  if (
    typeof id !== "string" ||
    id.length < 1 ||
    id.length > MAX_ENTRY_ID_LENGTH ||
    !isRevision(baseRevision) ||
    typeof deleted !== "boolean" ||
    typeof blob !== "string"
  )
    return invalid("malformed change");
  if (blob.length > MAX_ENTRY_BLOB_LENGTH) return invalid("blob too large");
  return { id, baseRevision, deleted, blob };
}

/**
 * Whether the host processes the request's changes. A request from another epoch, or with sinceRevision ahead of
 * the store (the phone was restored, the client resets itself, see syncVault), only learns the epoch and revision.
 */
function isProcessed(store: SyncStore, epoch: string, request: P2pSyncRequest): boolean {
  return request.epoch === epoch && request.sinceRevision <= store.currentRevision();
}

/** Every change with a base revision must name a record the store has. Throws InvalidSyncRequestError. */
function checkBaseRevisions(store: SyncStore, request: P2pSyncRequest): void {
  for (const c of request.changes) {
    if (c.baseRevision !== 0 && store.get(c.id) === undefined) invalid("unknown base revision");
  }
}

/**
 * Host side of P2P sync: parses the decrypted request (once), checks it against the store and answers.
 * Throws InvalidSyncRequestError before any write when the request is refused.
 */
export function processP2pSync(
  store: SyncStore,
  epoch: string,
  addresses: string[],
  rawRequest: unknown,
): P2pSyncResponse {
  const request = parseP2pSyncRequest(rawRequest);
  if (!isProcessed(store, epoch, request)) {
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
  checkBaseRevisions(store, request);
  const result = processSync(store, request);
  const page = pageRecords(result.conflicts, result.changes);
  // Records skipped below this revision were answered in accepted or conflicts, so nothing is lost. Omitted
  // conflicts leave their changes dirty on the client, which sends them again.
  const currentRevision = !page.more
    ? result.currentRevision
    : (page.changes.at(-1)?.revision ?? request.sinceRevision);
  return {
    epoch,
    currentRevision,
    accepted: result.accepted,
    conflicts: page.conflicts,
    changes: page.changes,
    addresses,
    more: page.more,
  };
}

/**
 * Cuts the answer to the round budget: conflicts first, then changes by revision (at most MAX_CHANGES_PER_RESPONSE).
 * The first record always goes in, then each one while the running sum of blob characters fits
 * MAX_BLOB_BYTES_PER_ROUND. `more` tells whether anything was left out.
 */
function pageRecords(
  allConflicts: RemoteRecord[],
  allChanges: RemoteRecord[],
): { conflicts: RemoteRecord[]; changes: RemoteRecord[]; more: boolean } {
  const sorted = [...allChanges].sort((a, b) => a.revision - b.revision);
  let budget = MAX_BLOB_BYTES_PER_ROUND;
  let included = 0;
  const fits = (r: RemoteRecord): boolean => {
    if (included > 0 && r.blob.length > budget) return false;
    budget -= r.blob.length;
    included++;
    return true;
  };
  const conflicts = takeWhile(allConflicts, fits);
  const changes =
    conflicts.length === allConflicts.length
      ? takeWhile(sorted.slice(0, MAX_CHANGES_PER_RESPONSE), fits)
      : [];
  const more = conflicts.length < allConflicts.length || changes.length < sorted.length;
  return { conflicts, changes, more };
}

function takeWhile<T>(items: T[], accept: (item: T) => boolean): T[] {
  const taken: T[] = [];
  for (const item of items) {
    if (!accept(item)) break;
    taken.push(item);
  }
  return taken;
}
