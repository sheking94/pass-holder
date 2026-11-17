/**
 * Reference host, for tests and scripts only: the phone runs the Kotlin host
 * (android/core/.../files/FileHost.kt). Client code (p2p/sync.ts, files/client.ts) imports only the types and
 * limits from here. The extension's tests drive this host as a fake phone.
 */
import { errorReply, type HostReply } from "../p2p/host-reply.ts";
import { isRecord } from "../strict-json.ts";
import { MAX_FILE_BLOB_LENGTH, MAX_FILE_CHUNKS, UUID_V4 } from "./attachment.ts";

/** Files nobody references and older than this are removed by the host's cleanup. */
export const ORPHAN_FILE_AGE_MS = 24 * 60 * 60_000;
/** Most ids in one `status` request; the client splits longer lists. */
export const MAX_STATUS_IDS = 500;

/** One encrypted chunk as the client sends it: file id, position, the file's chunk count and the blob. */
export interface FileChunk {
  id: string;
  index: number;
  chunks: number;
  blob: string;
}

export interface FileStore {
  /** Chunk count the file was announced with, undefined for an unknown id. */
  chunks(id: string): number | undefined;
  /** Indexes of stored chunks, ascending. */
  have(id: string): number[];
  get(id: string, index: number): string | undefined;
  /** Stores a chunk; `now` becomes the file's creation time when this is its first chunk. */
  put(chunk: FileChunk, now: number): void;
  /** Whether `bytes` more blob characters fit. */
  canStore(bytes: number): boolean;
  /** Time the first chunk of the file was stored. */
  createdAt(id: string): number | undefined;
  ids(): string[];
  delete(id: string): void;
  clear(): void;
}

interface StoredFile {
  chunks: number;
  createdAt: number;
  blobs: Map<number, string>;
}

export class MemoryFileStore implements FileStore {
  readonly #files = new Map<string, StoredFile>();
  readonly #capacity: number;
  #used = 0;

  constructor(capacityBytes = Infinity) {
    this.#capacity = capacityBytes;
  }

  chunks(id: string): number | undefined {
    return this.#files.get(id)?.chunks;
  }

  have(id: string): number[] {
    return [...(this.#files.get(id)?.blobs.keys() ?? [])].sort((a, b) => a - b);
  }

  get(id: string, index: number): string | undefined {
    return this.#files.get(id)?.blobs.get(index);
  }

  put({ id, index, chunks, blob }: FileChunk, now: number): void {
    let file = this.#files.get(id);
    if (!file) {
      file = { chunks, createdAt: now, blobs: new Map() };
      this.#files.set(id, file);
    }
    this.#used += blob.length - (file.blobs.get(index)?.length ?? 0);
    file.blobs.set(index, blob);
  }

  canStore(bytes: number): boolean {
    return bytes <= this.#capacity - this.#used;
  }

  createdAt(id: string): number | undefined {
    return this.#files.get(id)?.createdAt;
  }

  ids(): string[] {
    return [...this.#files.keys()];
  }

  delete(id: string): void {
    const file = this.#files.get(id);
    if (!file) return;
    for (const blob of file.blobs.values()) this.#used -= blob.length;
    this.#files.delete(id);
  }

  clear(): void {
    this.#files.clear();
    this.#used = 0;
  }
}

export type P2pFileRequest =
  | { op: "status"; epoch: string; ids: string[] }
  | ({ op: "put"; epoch: string } & FileChunk)
  | { op: "get"; epoch: string; id: string; index: number };

export interface P2pFileStatus {
  id: string;
  chunks: number;
  have: number[];
  complete: boolean;
}

const MALFORMED = errorReply(400, "malformed file request");
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_V4.test(v);
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** The request as a typed value (extra fields dropped), or undefined when its shape is wrong. */
function parseRequest(request: unknown): P2pFileRequest | undefined {
  if (!isRecord(request) || typeof request.epoch !== "string") return undefined;
  const { epoch, id, index, chunks, blob, ids } = request;
  switch (request.op) {
    case "status":
      if (!Array.isArray(ids) || ids.length > MAX_STATUS_IDS || !ids.every(isUuid))
        return undefined;
      return { op: "status", epoch, ids };
    case "put":
      if (
        !isUuid(id) ||
        !isInt(chunks, 1, MAX_FILE_CHUNKS) ||
        !isInt(index, 0, chunks - 1) ||
        typeof blob !== "string" ||
        blob.length > MAX_FILE_BLOB_LENGTH
      )
        return undefined;
      return { op: "put", epoch, id, index, chunks, blob };
    case "get":
      if (!isUuid(id) || !isInt(index, 0, MAX_FILE_CHUNKS - 1)) return undefined;
      return { op: "get", epoch, id, index };
    default:
      return undefined;
  }
}

/** Handles one decoded /p2p/v2/file request. A 200 body is to be encrypted; other statuses go out in plaintext. */
export function processP2pFile(
  store: FileStore,
  epoch: string,
  request: unknown,
  now: number,
): HostReply {
  const req = parseRequest(request);
  if (!req) return MALFORMED;
  if (req.epoch !== epoch) return { status: 200, body: { epoch } };
  switch (req.op) {
    case "status":
      return fileStatus(store, req.ids);
    case "put":
      return putChunk(store, req, now);
    case "get":
      return getChunk(store, req.id, req.index);
  }
}

function fileStatus(store: FileStore, ids: string[]): HostReply {
  const files: P2pFileStatus[] = ids.map((id) => {
    const chunks = store.chunks(id);
    if (chunks === undefined) return { id, chunks: 0, have: [], complete: false };
    const have = store.have(id);
    return { id, chunks, have, complete: have.length === chunks };
  });
  return { status: 200, body: { files } };
}

/** Stores a new chunk; the same chunk again is accepted without a write, a different one is refused. */
function putChunk(store: FileStore, chunk: FileChunk, now: number): HostReply {
  const known = store.chunks(chunk.id);
  if (known !== undefined && known !== chunk.chunks) return errorReply(400, "chunk count mismatch");
  const existing = store.get(chunk.id, chunk.index);
  if (existing !== undefined) {
    if (existing !== chunk.blob) return errorReply(409, "chunk differs");
  } else {
    if (!store.canStore(chunk.blob.length)) return errorReply(507, "insufficient storage");
    store.put(chunk, now);
  }
  return { status: 200, body: { have: store.have(chunk.id).length } };
}

function getChunk(store: FileStore, id: string, index: number): HostReply {
  const chunks = store.chunks(id);
  const blob = store.get(id, index);
  if (chunks === undefined || blob === undefined) return errorReply(404, "chunk not found");
  return { status: 200, body: { chunks, blob } };
}

/** Ids of stored files that no live entry uses and whose first chunk is older than ORPHAN_FILE_AGE_MS. */
export function orphanFileIds(store: FileStore, used: ReadonlySet<string>, now: number): string[] {
  return store.ids().filter((id) => {
    if (used.has(id)) return false;
    const created = store.createdAt(id);
    return created !== undefined && now - created > ORPHAN_FILE_AGE_MS;
  });
}
