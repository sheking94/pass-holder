// Subpath import: the @passholder/core root pulls crypto libraries into the page bundle.
import { MAX_FILE_CHUNKS, type LocalFileState, type LocalFileStore } from "@passholder/core/files";

/** File record without `have`: that is computed from the keys of the `chunks` store. */
type FileRecord = Omit<LocalFileState, "have">;

/** The largest chunk index a file can have. */
const MAX_CHUNK_INDEX = MAX_FILE_CHUNKS - 1;

const request = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });

/** Every chunk key of one file. */
const chunkRange = (id: string) => IDBKeyRange.bound([id, 0], [id, MAX_CHUNK_INDEX]);

/** Encrypted file chunks in IndexedDB; chunks are stored one by one, so an interrupted sync resumes. */
export class IdbFileStore implements LocalFileStore {
  private readonly db: Promise<IDBDatabase>;

  constructor(factory: IDBFactory = indexedDB, dbName = "passholder-files") {
    this.db = new Promise((resolve, reject) => {
      const open = factory.open(dbName, 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("files", { keyPath: "id" });
        open.result.createObjectStore("chunks");
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    // Each operation awaits db and re-raises the failure; this only keeps a store nobody uses from
    // reporting an unhandled rejection.
    this.db.catch(() => undefined);
  }

  private async tx(
    mode: IDBTransactionMode,
  ): Promise<{ tx: IDBTransaction; files: IDBObjectStore; chunks: IDBObjectStore }> {
    const tx = (await this.db).transaction(["files", "chunks"], mode);
    return { tx, files: tx.objectStore("files"), chunks: tx.objectStore("chunks") };
  }

  async state(id: string): Promise<LocalFileState | undefined> {
    const { files, chunks } = await this.tx("readonly");
    const [record, keys] = await Promise.all([
      request<FileRecord | undefined>(files.get(id)),
      request(chunks.getAllKeys(chunkRange(id))),
    ]);
    if (!record) return undefined;
    return { ...record, have: keys.map((k) => (k as [string, number])[1]).sort((a, b) => a - b) };
  }

  async ids(): Promise<string[]> {
    const { files } = await this.tx("readonly");
    return (await request(files.getAllKeys())) as string[];
  }

  async getChunk(id: string, index: number): Promise<string | undefined> {
    const { chunks } = await this.tx("readonly");
    return request<string | undefined>(chunks.get([id, index]));
  }

  async putChunk(id: string, index: number, chunks: number, blob: string): Promise<void> {
    const t = await this.tx("readwrite");
    const existing = await request<FileRecord | undefined>(t.files.get(id));
    if (!existing || existing.chunks !== chunks) {
      t.chunks.delete(chunkRange(id));
      t.files.put({ id, chunks, complete: false, uploadedEpoch: null } satisfies FileRecord);
    }
    t.chunks.put(blob, [id, index]);
    await done(t.tx);
  }

  async markComplete(id: string): Promise<void> {
    await this.update(id, (f) => ({ ...f, complete: true }));
  }

  async markIncomplete(id: string, have: number[]): Promise<void> {
    const t = await this.tx("readwrite");
    const f = await request<FileRecord | undefined>(t.files.get(id));
    if (f) {
      t.files.put({ ...f, complete: false });
      // `have` is derived from the stored chunks, so drop those the caller does not list.
      const keys = await request(t.chunks.getAllKeys(chunkRange(id)));
      const keep = new Set(have);
      for (const k of keys) if (!keep.has((k as [string, number])[1])) t.chunks.delete(k);
    }
    await done(t.tx);
  }

  async markUploaded(id: string, epoch: string): Promise<void> {
    await this.update(id, (f) => ({ ...f, uploadedEpoch: epoch }));
  }

  async delete(id: string): Promise<void> {
    const t = await this.tx("readwrite");
    t.files.delete(id);
    t.chunks.delete(chunkRange(id));
    await done(t.tx);
  }

  private async update(id: string, change: (f: FileRecord) => FileRecord): Promise<void> {
    const t = await this.tx("readwrite");
    const f = await request<FileRecord | undefined>(t.files.get(id));
    if (f) t.files.put(change(f));
    await done(t.tx);
  }
}
