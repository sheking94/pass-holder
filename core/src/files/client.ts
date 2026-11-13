import { liveEntriesV2, type LocalVaultV2 } from "../p2p/sync.ts";
import { noiseRequest, P2pHostError, P2P_FILE_PATH, PHONE_UPDATE_REQUIRED, type NoiseClientOptions } from "../p2p/transport.ts";
import type { Attachment } from "./attachment.ts";
import { decryptFile, FILE_CORRUPTED, type EncryptedFile } from "./chunks.ts";
import type { P2pFileRequest, P2pFileStatus } from "./host-files.ts";

/** Thrown when the phone answers with another epoch: the entries must be synced (epoch adopted) first. */
export const FILE_SYNC_EPOCH_MISMATCH = "Epoch changed, sync again";
const MALFORMED = "P2P host returned a malformed response";
const MAX_STATUS_IDS = 500;

/** Sends one file request; returns the decrypted 200 answer, or null for a `get` of a chunk the phone lacks. */
export type P2pFileTransport = (request: P2pFileRequest) => Promise<unknown>;

/** Noise-over-HTTP file transport: one handshake plus one /p2p/v2/file request per call. */
export function noiseFileTransport(o: NoiseClientOptions): P2pFileTransport {
  return async (request) => {
    try {
      return await noiseRequest(o, P2P_FILE_PATH, request);
    } catch (e) {
      if (e instanceof P2pHostError && e.status === 404) {
        if (request.op === "get" && e.detail === "chunk not found") return null;
        // An older phone app does not know the path and answers 404 "not found".
        throw new Error(PHONE_UPDATE_REQUIRED);
      }
      throw e;
    }
  };
}

export interface LocalFileState {
  id: string;
  chunks: number;
  /** Indexes of the chunks stored locally, ascending. */
  have: number[];
  /** All chunks are here and decrypted to the descriptor's size and SHA-256. */
  complete: boolean;
  /** Epoch of the phone that has the whole file, null while no phone is known to have it. */
  uploadedEpoch: string | null;
}

/** Plugin-side storage of encrypted chunks (IndexedDB in the extension). */
export interface LocalFileStore {
  state(id: string): Promise<LocalFileState | undefined>;
  ids(): Promise<string[]>;
  getChunk(id: string, index: number): Promise<string | undefined>;
  /** Stores one chunk; a file announced with another chunk count starts over. */
  putChunk(id: string, index: number, chunks: number, blob: string): Promise<void>;
  markComplete(id: string): Promise<void>;
  /** Clears `complete` and replaces `have` with the chunks that are really stored (after a lost chunk). */
  markIncomplete(id: string, have: number[]): Promise<void>;
  markUploaded(id: string, epoch: string): Promise<void>;
  delete(id: string): Promise<void>;
}

interface MemoryFile {
  state: LocalFileState;
  blobs: Map<number, string>;
}

export class MemoryLocalFileStore implements LocalFileStore {
  readonly #files = new Map<string, MemoryFile>();

  async state(id: string): Promise<LocalFileState | undefined> {
    const f = this.#files.get(id);
    return f && { ...f.state, have: [...f.state.have] };
  }

  async ids(): Promise<string[]> {
    return [...this.#files.keys()];
  }

  async getChunk(id: string, index: number): Promise<string | undefined> {
    return this.#files.get(id)?.blobs.get(index);
  }

  async putChunk(id: string, index: number, chunks: number, blob: string): Promise<void> {
    let f = this.#files.get(id);
    if (!f || f.state.chunks !== chunks) {
      f = { state: { id, chunks, have: [], complete: false, uploadedEpoch: null }, blobs: new Map() };
      this.#files.set(id, f);
    }
    f.blobs.set(index, blob);
    f.state.have = [...f.blobs.keys()].sort((a, b) => a - b);
  }

  async markComplete(id: string): Promise<void> {
    const f = this.#files.get(id);
    if (f) f.state.complete = true;
  }

  async markIncomplete(id: string, have: number[]): Promise<void> {
    const f = this.#files.get(id);
    if (!f) return;
    f.state.complete = false;
    f.state.have = [...have].sort((a, b) => a - b);
  }

  async markUploaded(id: string, epoch: string): Promise<void> {
    const f = this.#files.get(id);
    if (f) f.state.uploadedEpoch = epoch;
  }

  async delete(id: string): Promise<void> {
    this.#files.delete(id);
  }
}

/** Saves a freshly encrypted file as complete and not yet uploaded. */
export async function storeEncryptedFile(files: LocalFileStore, f: EncryptedFile): Promise<void> {
  const { id, chunks } = f.attachment;
  for (let i = 0; i < f.blobs.length; i++) await files.putChunk(id, i, chunks, f.blobs[i]!);
  await files.markComplete(id);
}

/** Attachments of live entries by id (the first descriptor wins when two entries share an id). */
export function usedAttachments(vault: LocalVaultV2): Map<string, Attachment> {
  const used = new Map<string, Attachment>();
  for (const e of liveEntriesV2(vault)) {
    for (const a of e.data.attachments ?? []) if (!used.has(a.id)) used.set(a.id, a);
  }
  return used;
}

export interface FileSyncResult {
  uploaded: number;
  downloaded: number;
  /**
   * Files that could not be finished this run: neither side has them complete yet (e.g. added on another plugin
   * that has not synced), or a chunk went missing (locally or on the phone).
   */
  pending: number;
  /** Names of downloaded files that did not match their descriptor; their local chunks were removed. */
  corrupted: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIndex = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** Sends a request and returns its answer, throwing FILE_SYNC_EPOCH_MISMATCH when the phone names another epoch. */
async function call(send: P2pFileTransport, request: P2pFileRequest): Promise<Record<string, unknown> | null> {
  const res = await send(request);
  if (res === null && request.op === "get") return null;
  if (!isRecord(res)) throw new Error(MALFORMED);
  if (typeof res.epoch === "string") throw new Error(FILE_SYNC_EPOCH_MISMATCH);
  return res;
}

async function phoneStatus(send: P2pFileTransport, epoch: string, ids: string[]): Promise<Map<string, P2pFileStatus>> {
  const status = new Map<string, P2pFileStatus>();
  for (let i = 0; i < ids.length; i += MAX_STATUS_IDS) {
    const res = await call(send, { op: "status", epoch, ids: ids.slice(i, i + MAX_STATUS_IDS) });
    const list = res!.files;
    if (!Array.isArray(list)) throw new Error(MALFORMED);
    for (const f of list) {
      if (
        !isRecord(f) ||
        typeof f.id !== "string" ||
        !isIndex(f.chunks) ||
        !Array.isArray(f.have) ||
        !f.have.every(isIndex) ||
        typeof f.complete !== "boolean"
      )
        throw new Error(MALFORMED);
      status.set(f.id, f as unknown as P2pFileStatus);
    }
  }
  return status;
}

/**
 * Puts the chunks the phone lacks, then records the upload. A local chunk that turns out to be missing marks the
 * file incomplete (so a later run can download it) and yields "pending".
 */
async function upload(
  files: LocalFileStore,
  send: P2pFileTransport,
  epoch: string,
  a: Attachment,
  phoneHas: number[],
): Promise<"done" | "pending"> {
  const have = new Set(phoneHas);
  for (let index = 0; index < a.chunks; index++) {
    if (have.has(index)) continue;
    const blob = await files.getChunk(a.id, index);
    if (blob === undefined) {
      const present: number[] = [];
      for (let i = 0; i < a.chunks; i++) if ((await files.getChunk(a.id, i)) !== undefined) present.push(i);
      await files.markIncomplete(a.id, present);
      return "pending";
    }
    await call(send, { op: "put", epoch, id: a.id, index, chunks: a.chunks, blob });
  }
  await files.markUploaded(a.id, epoch);
  return "done";
}

/**
 * Gets the chunks missing locally (each stored as it arrives, so an interrupted run resumes), then checks the
 * whole file. Returns "pending" when the phone lost a chunk meanwhile.
 */
async function download(
  files: LocalFileStore,
  send: P2pFileTransport,
  epoch: string,
  a: Attachment,
): Promise<"done" | "pending" | "corrupted"> {
  const corrupted = async () => {
    await files.delete(a.id);
    return "corrupted" as const;
  };
  const local = await files.state(a.id);
  const have = new Set(local?.chunks === a.chunks ? local.have : []);
  for (let index = 0; index < a.chunks; index++) {
    if (have.has(index)) continue;
    const res = await call(send, { op: "get", epoch, id: a.id, index });
    if (res === null) return "pending";
    if (typeof res.blob !== "string" || !isIndex(res.chunks)) throw new Error(MALFORMED);
    // The phone's file has another shape than the descriptor: it can never decrypt.
    if (res.chunks !== a.chunks) return corrupted();
    await files.putChunk(a.id, index, a.chunks, res.blob);
  }
  const blobs: string[] = [];
  for (let index = 0; index < a.chunks; index++) {
    const blob = await files.getChunk(a.id, index);
    if (blob === undefined) return "pending";
    blobs.push(blob);
  }
  try {
    await decryptFile(a, blobs);
  } catch (e) {
    if (!(e instanceof Error) || e.message !== FILE_CORRUPTED) throw e;
    return corrupted();
  }
  await files.markComplete(a.id);
  // Came from this phone, so it has the whole file already.
  await files.markUploaded(a.id, epoch);
  return "done";
}

/**
 * File phase after an entry sync: uploads complete local files the phone (of the vault's epoch) does not have yet,
 * then downloads used files that are complete on the phone but not here. No retries: a transport error is thrown
 * after whatever was already stored, and the next run resumes from the missing chunks. A per-file refusal during
 * upload (host status 409 or 400) only counts the file as pending.
 */
export async function syncFiles(
  vault: LocalVaultV2,
  files: LocalFileStore,
  send: P2pFileTransport,
  onProgress?: (done: number, total: number) => void,
): Promise<FileSyncResult> {
  const result: FileSyncResult = { uploaded: 0, downloaded: 0, pending: 0, corrupted: [] };
  // An unknown epoch is sent as "" and makes the phone answer with its own (FILE_SYNC_EPOCH_MISMATCH).
  const epoch = vault.epoch ?? "";
  // Only files that may need work: not complete here, or complete but not yet on this epoch's phone.
  const candidates: { a: Attachment; local: LocalFileState | undefined }[] = [];
  for (const a of usedAttachments(vault).values()) {
    const local = await files.state(a.id);
    if (local?.complete && local.uploadedEpoch === epoch) continue;
    candidates.push({ a, local });
  }
  if (candidates.length === 0) return result;
  const status = await phoneStatus(send, epoch, candidates.map((c) => c.a.id));

  const uploads: { a: Attachment; phoneHas: number[] }[] = [];
  const downloads: Attachment[] = [];
  for (const { a, local } of candidates) {
    const phone = status.get(a.id);
    if (local?.complete) {
      if (phone?.complete) {
        // Nothing to send: the phone already has it (e.g. another plugin uploaded the same file).
        await files.markUploaded(a.id, epoch);
        continue;
      }
      uploads.push({ a, phoneHas: phone?.have ?? [] });
    } else if (phone?.complete) {
      downloads.push(a);
    } else {
      result.pending++;
    }
  }

  const total = uploads.length + downloads.length;
  let done = 0;
  for (const { a, phoneHas } of uploads) {
    let outcome: "done" | "pending";
    try {
      outcome = await upload(files, send, epoch, a, phoneHas);
    } catch (e) {
      // The phone refused this file (chunk differs / chunk count mismatch): leave it for later, go on with the rest.
      if (!(e instanceof P2pHostError && (e.status === 409 || e.status === 400))) throw e;
      outcome = "pending";
    }
    if (outcome === "done") result.uploaded++;
    else result.pending++;
    onProgress?.(++done, total);
  }
  for (const a of downloads) {
    const outcome = await download(files, send, epoch, a);
    if (outcome === "done") result.downloaded++;
    else if (outcome === "pending") result.pending++;
    else result.corrupted.push(a.name);
    onProgress?.(++done, total);
  }
  return result;
}

/** Removes local files no live entry uses; returns how many were removed. */
export async function pruneLocalFiles(vault: LocalVaultV2, files: LocalFileStore): Promise<number> {
  const used = usedAttachments(vault);
  let removed = 0;
  for (const id of await files.ids()) {
    if (used.has(id)) continue;
    await files.delete(id);
    removed++;
  }
  return removed;
}
