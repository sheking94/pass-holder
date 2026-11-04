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

/** Host side of P2P sync. A request from another epoch is not processed: the client only learns the epoch. */
export function processP2pSync(
  store: SyncStore,
  epoch: string,
  addresses: string[],
  request: P2pSyncRequest,
): P2pSyncResponse {
  if (request.epoch !== epoch) {
    return { epoch, currentRevision: store.currentRevision(), accepted: [], conflicts: [], changes: [], addresses };
  }
  const { sinceRevision, changes } = request;
  return { ...processSync(store, { sinceRevision, changes }), epoch, addresses };
}
