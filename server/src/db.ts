import { DatabaseSync } from "node:sqlite";
import type { KdfParams, RemoteRecord, SyncStore } from "@passholder/core";

export interface VaultMeta {
  kdf: KdfParams;
  authHash: Uint8Array;
  wrappedVaultKey: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  kdf TEXT NOT NULL,
  auth_hash BLOB NOT NULL,
  wrapped_vault_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL UNIQUE,
  deleted INTEGER NOT NULL,
  blob TEXT NOT NULL
);
`;

interface EntryRow {
  id: string;
  revision: number;
  deleted: number;
  blob: string;
}

function toRecord(row: EntryRow): RemoteRecord {
  return { id: row.id, revision: row.revision, deleted: row.deleted === 1, blob: row.blob };
}

/** SQLite storage for the single vault. Implements the SyncStore that processSync from core works on. */
export class Database implements SyncStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // WAL + FULL sync: a power cut (the Pi is switched off by hand) loses at most the last transaction.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.db.exec(SCHEMA);
  }

  getMeta(): VaultMeta | undefined {
    const row = this.db.prepare("SELECT kdf, auth_hash, wrapped_vault_key FROM meta WHERE id = 1").get() as
      | { kdf: string; auth_hash: Uint8Array; wrapped_vault_key: string }
      | undefined;
    if (!row) return undefined;
    return { kdf: JSON.parse(row.kdf) as KdfParams, authHash: new Uint8Array(row.auth_hash), wrappedVaultKey: row.wrapped_vault_key };
  }

  initialize(meta: VaultMeta, now = Date.now()): void {
    this.db
      .prepare("INSERT INTO meta (id, kdf, auth_hash, wrapped_vault_key, created_at) VALUES (1, ?, ?, ?, ?)")
      .run(JSON.stringify(meta.kdf), meta.authHash, meta.wrappedVaultKey, now);
  }

  get(id: string): RemoteRecord | undefined {
    const row = this.db.prepare("SELECT id, revision, deleted, blob FROM entries WHERE id = ?").get(id) as EntryRow | undefined;
    return row && toRecord(row);
  }

  put(record: RemoteRecord): void {
    this.db
      .prepare(
        `INSERT INTO entries (id, revision, deleted, blob) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, deleted = excluded.deleted, blob = excluded.blob`,
      )
      .run(record.id, record.revision, record.deleted ? 1 : 0, record.blob);
  }

  listSince(revision: number): RemoteRecord[] {
    const rows = this.db
      .prepare("SELECT id, revision, deleted, blob FROM entries WHERE revision > ? ORDER BY revision")
      .all(revision) as unknown as EntryRow[];
    return rows.map(toRecord);
  }

  currentRevision(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(revision), 0) AS r FROM entries").get() as { r: number };
    return row.r;
  }

  /** Runs fn atomically: everything it wrote is rolled back if it throws. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
