import { processSync, type ChangeRequest, type RemoteRecord, type SyncStore } from "../protocol.ts";

export interface P2pSyncRequest {
  epoch: string;
  sinceRevision: number;
  changes: ChangeRequest[];
}

export interface P2pSyncResponse {
  epoch: string;
  currentRevision: number;
  accepted: { id: string; revision: number }[];
  conflicts: RemoteRecord[];
  changes: RemoteRecord[];
  addresses: string[];
}

export const MAX_ENTRY_ID_LENGTH = 128;

const isRevision = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * Checks a decrypted sync request before anything is written. Returns the error text for a 400, or undefined.
 * Every change is checked against the store first, so a bad change never leaves earlier ones applied.
 */
export function validateP2pSyncRequest(store: SyncStore, epoch: string, request: unknown): string | undefined {
  if (typeof request !== "object" || request === null || Array.isArray(request)) return "malformed sync request";
  const r = request as Record<string, unknown>;
  if (typeof r.epoch !== "string" || !isRevision(r.sinceRevision) || !Array.isArray(r.changes))
    return "malformed sync request";
  const ids = new Set<string>();
  for (const c of r.changes as unknown[]) {
    if (typeof c !== "object" || c === null || Array.isArray(c)) return "malformed change";
    const { id, baseRevision, deleted, blob } = c as Record<string, unknown>;
    if (
      typeof id !== "string" || id.length < 1 || id.length > MAX_ENTRY_ID_LENGTH ||
      !isRevision(baseRevision) || typeof deleted !== "boolean" || typeof blob !== "string"
    )
      return "malformed change";
    if (ids.has(id)) return "duplicate change";
    ids.add(id);
  }
  // A request from another epoch is not processed, so its base revisions do not matter.
  if (r.epoch !== epoch) return undefined;
  for (const c of r.changes as ChangeRequest[]) {
    if (c.baseRevision !== 0 && store.get(c.id) === undefined) return "unknown base revision";
  }
  return undefined;
}

/**
 * Host side of P2P sync. A request from another epoch is not processed: the client only learns the epoch.
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
  if (request.epoch !== epoch) {
    return { epoch, currentRevision: store.currentRevision(), accepted: [], conflicts: [], changes: [], addresses };
  }
  const { sinceRevision, changes } = request;
  return { ...processSync(store, { sinceRevision, changes }), epoch, addresses };
}
