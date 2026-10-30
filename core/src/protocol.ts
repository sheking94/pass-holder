/** Wire format of POST /api/v1/sync. See docs/SPEC.md. */

export interface RemoteRecord {
  id: string;
  revision: number;
  deleted: boolean;
  blob: string;
}

export interface ChangeRequest {
  id: string;
  /** Revision the client last saw for this entry, 0 for a new entry. */
  baseRevision: number;
  deleted: boolean;
  blob: string;
}

export interface SyncRequest {
  sinceRevision: number;
  changes: ChangeRequest[];
}

export interface SyncResponse {
  currentRevision: number;
  accepted: { id: string; revision: number }[];
  /** Server's version of each entry whose baseRevision was out of date. */
  conflicts: RemoteRecord[];
  /** Records changed after sinceRevision, except those in accepted and conflicts. */
  changes: RemoteRecord[];
}

/** Storage the server needs. The Raspberry Pi server implements it with SQLite. */
export interface SyncStore {
  get(id: string): RemoteRecord | undefined;
  put(record: RemoteRecord): void;
  listSince(revision: number): RemoteRecord[];
  currentRevision(): number;
}

/** Server-side sync logic. The server cannot read entries; it only orders revisions and detects conflicts. */
export function processSync(store: SyncStore, request: SyncRequest): SyncResponse {
  const accepted: SyncResponse["accepted"] = [];
  const conflicts: RemoteRecord[] = [];
  const handled = new Set<string>();
  for (const change of request.changes) {
    if (handled.has(change.id)) throw new Error(`Duplicate change for ${change.id}`);
    handled.add(change.id);
    const existing = store.get(change.id);
    if ((existing?.revision ?? 0) !== change.baseRevision) {
      if (existing) conflicts.push(existing);
      else throw new Error(`Unknown base revision for ${change.id}`);
      continue;
    }
    const revision = store.currentRevision() + 1;
    store.put({ id: change.id, revision, deleted: change.deleted, blob: change.blob });
    accepted.push({ id: change.id, revision });
  }
  const changes = store.listSince(request.sinceRevision).filter((r) => !handled.has(r.id));
  return { currentRevision: store.currentRevision(), accepted, conflicts, changes };
}

export class MemorySyncStore implements SyncStore {
  private records = new Map<string, RemoteRecord>();
  private revision = 0;

  get(id: string) {
    return this.records.get(id);
  }

  put(record: RemoteRecord) {
    this.records.set(record.id, { ...record });
    this.revision = Math.max(this.revision, record.revision);
  }

  listSince(revision: number) {
    return [...this.records.values()].filter((r) => r.revision > revision).sort((a, b) => a.revision - b.revision);
  }

  currentRevision() {
    return this.revision;
  }
}
