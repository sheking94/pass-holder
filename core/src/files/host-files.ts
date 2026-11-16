import { MAX_FILE_BLOB_LENGTH, MAX_FILE_CHUNKS, UUID_V4 } from "./attachment.ts";

/** Files nobody references and older than this are removed by the host's cleanup. */
export const ORPHAN_FILE_AGE_MS = 86_400_000;
const MAX_STATUS_IDS = 500;

export interface FileStore {
  /** Chunk count the file was announced with, undefined for an unknown id. */
  chunks(id: string): number | undefined;
  /** Indexes of stored chunks, ascending. */
  have(id: string): number[];
  get(id: string, index: number): string | undefined;
  put(id: string, index: number, chunks: number, blob: string, now: number): void;
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

  put(id: string, index: number, chunks: number, blob: string, now: number): void {
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
  | { op: "put"; epoch: string; id: string; index: number; chunks: number; blob: string }
  | { op: "get"; epoch: string; id: string; index: number };

export interface P2pFileStatus {
  id: string;
  chunks: number;
  have: number[];
  complete: boolean;
}

type Reply = { status: number; body: unknown };

const fail = (status: number, error: string): Reply => ({ status, body: { error } });
const MALFORMED = fail(400, "malformed file request");
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_V4.test(v);
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

function parseRequest(request: unknown): P2pFileRequest | undefined {
  if (!isRecord(request) || typeof request.epoch !== "string") return undefined;
  switch (request.op) {
    case "status":
      if (
        !Array.isArray(request.ids) ||
        request.ids.length > MAX_STATUS_IDS ||
        !request.ids.every(isUuid)
      )
        return undefined;
      return request as unknown as P2pFileRequest;
    case "put":
      if (
        !isUuid(request.id) ||
        !isInt(request.chunks, 1, MAX_FILE_CHUNKS) ||
        !isInt(request.index, 0, request.chunks - 1) ||
        typeof request.blob !== "string" ||
        request.blob.length > MAX_FILE_BLOB_LENGTH
      )
        return undefined;
      return request as unknown as P2pFileRequest;
    case "get":
      if (!isUuid(request.id) || !isInt(request.index, 0, MAX_FILE_CHUNKS - 1)) return undefined;
      return request as unknown as P2pFileRequest;
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
): Reply {
  const req = parseRequest(request);
  if (!req) return MALFORMED;
  if (req.epoch !== epoch) return { status: 200, body: { epoch } };
  switch (req.op) {
    case "status": {
      const files: P2pFileStatus[] = req.ids.map((id) => {
        const chunks = store.chunks(id);
        if (chunks === undefined) return { id, chunks: 0, have: [], complete: false };
        const have = store.have(id);
        return { id, chunks, have, complete: have.length === chunks };
      });
      return { status: 200, body: { files } };
    }
    case "put": {
      const known = store.chunks(req.id);
      if (known !== undefined && known !== req.chunks) return fail(400, "chunk count mismatch");
      const existing = store.get(req.id, req.index);
      if (existing !== undefined) {
        if (existing !== req.blob) return fail(409, "chunk differs");
      } else {
        if (!store.canStore(req.blob.length)) return fail(507, "insufficient storage");
        store.put(req.id, req.index, req.chunks, req.blob, now);
      }
      return { status: 200, body: { have: store.have(req.id).length } };
    }
    case "get": {
      const chunks = store.chunks(req.id);
      const blob = store.get(req.id, req.index);
      if (chunks === undefined || blob === undefined) return fail(404, "chunk not found");
      return { status: 200, body: { chunks, blob } };
    }
  }
}

/** Ids of stored files that no live entry uses and whose first chunk is older than ORPHAN_FILE_AGE_MS. */
export function orphanFileIds(store: FileStore, used: ReadonlySet<string>, now: number): string[] {
  return store.ids().filter((id) => {
    if (used.has(id)) return false;
    const created = store.createdAt(id);
    return created !== undefined && now - created > ORPHAN_FILE_AGE_MS;
  });
}
