import { fromBase64, randomBytes, toBase64, utf8 } from "../encoding.ts";
import { decryptFrames, encryptFrames, MAX_FRAMES } from "./frames.ts";
import type { SyncStore } from "../protocol.ts";
import { processP2pSync, validateP2pSyncRequest, type P2pSyncRequest } from "./host-sync.ts";
import { processP2pFile, type FileStore } from "../files/host-files.ts";
import { P2P_FILE_PATH, P2P_HANDSHAKE_PATH, P2P_SYNC_PATH } from "./transport.ts";
import { CipherState, NoiseKK, P2P_PROLOGUE, type KeyPair } from "./noise.ts";

export interface PairedDevice {
  deviceId: string;
  name: string;
  staticPublicKey: Uint8Array;
}

export interface P2pHostOptions {
  staticKey: KeyPair;
  devices: () => PairedDevice[];
  store: SyncStore;
  epoch: string;
  addresses: () => string[];
  now?: () => number;
  /** Encrypted file chunk storage; without it the file path answers 404 like an unknown path. */
  files?: FileStore;
}

interface Session {
  deviceId: string;
  staticPublicKey: Uint8Array;
  send: CipherState;
  recv: CipherState;
  expiresAt: number;
}

type Reply = { status: number; body: unknown };

const MAX_BODY_BYTES = 1024 * 1024;
const SESSION_TTL_MS = 60_000;
/** Most sessions alive at once; a handshake beyond that gets 503 until some expire or are used. */
export const MAX_SESSIONS = 32;

const fail = (status: number, error: string): Reply => ({ status, body: { error } });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

function decodeBase64(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return fromBase64(value);
  } catch {
    return undefined;
  }
}

/**
 * Reference P2P host: Noise KK handshake, then exactly one encrypted sync request per session.
 * Calls to handle() may interleave; each session's ciphers are used by one request only.
 */
export class P2pHost {
  readonly #o: P2pHostOptions;
  readonly #sessions = new Map<string, Session>();

  constructor(o: P2pHostOptions) {
    this.#o = o;
  }

  async handle(path: string, body: unknown): Promise<Reply> {
    if (utf8(JSON.stringify(body) ?? "").length > MAX_BODY_BYTES) return fail(413, "body too large");
    this.#prune();
    if (path === P2P_HANDSHAKE_PATH) return this.#handshake(body);
    if (path === P2P_SYNC_PATH) return this.#session(body, (request) => this.#processSync(request));
    if (path === P2P_FILE_PATH && this.#o.files) {
      const files = this.#o.files;
      return this.#session(body, (request) => processP2pFile(files, this.#o.epoch, request, this.#now()));
    }
    // The v1 sync protocol is gone; tell old clients to update instead of pretending the path is unknown.
    if (path === "/p2p/v1/handshake" || path === "/p2p/v1/sync") return fail(410, "update required");
    return fail(404, "not found");
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, s] of this.#sessions) if (s.expiresAt <= now) this.#sessions.delete(id);
  }

  async #handshake(body: unknown): Promise<Reply> {
    if (!isRecord(body) || typeof body.deviceId !== "string" || typeof body.message !== "string")
      return fail(400, "malformed request");
    const device = this.#o.devices().find((d) => d.deviceId === body.deviceId);
    if (!device) return fail(403, "device not paired");
    // handle() already pruned the expired sessions.
    if (this.#sessions.size >= MAX_SESSIONS) return fail(503, "too many sessions");
    const message = decodeBase64(body.message);
    if (!message) return fail(400, "malformed request");
    const noise = NoiseKK.responder({
      s: this.#o.staticKey,
      rs: device.staticPublicKey,
      prologue: P2P_PROLOGUE,
    });
    let reply: Uint8Array;
    try {
      await noise.readMessage(message);
      reply = await noise.writeMessage(new Uint8Array());
    } catch {
      return fail(400, "handshake failed");
    }
    const { send, recv } = noise.split();
    const session = toBase64(randomBytes(16));
    this.#sessions.set(session, {
      deviceId: device.deviceId,
      staticPublicKey: device.staticPublicKey.slice(),
      send,
      recv,
      expiresAt: this.#now() + SESSION_TTL_MS,
    });
    return { status: 200, body: { session, message: toBase64(reply) } };
  }

  /** Common part of the one-request-per-session paths; `process` returns a reply whose 200 body gets encrypted. */
  async #session(body: unknown, process: (request: unknown) => Reply): Promise<Reply> {
    if (
      !isRecord(body) ||
      typeof body.session !== "string" ||
      !Array.isArray(body.frames) ||
      body.frames.length < 1 ||
      body.frames.length > MAX_FRAMES ||
      !body.frames.every((f) => typeof f === "string")
    )
      return fail(400, "malformed request");
    const session = this.#sessions.get(body.session);
    // One attempt per session, whatever the outcome.
    this.#sessions.delete(body.session);
    if (!session || session.expiresAt <= this.#now()) return fail(401, "unknown or expired session");
    // The device may have been removed (or re-paired with another key) after the handshake.
    const stillPaired = this.#o.devices().some(
      (d) => d.deviceId === session.deviceId && sameBytes(d.staticPublicKey, session.staticPublicKey),
    );
    if (!stillPaired) return fail(403, "device not paired");
    let request: unknown;
    try {
      request = await decryptFrames(session.recv, body.frames as string[]);
    } catch {
      return fail(400, "cannot decrypt request");
    }
    try {
      const reply = process(request);
      if (reply.status !== 200) return reply;
      return { status: 200, body: { frames: await encryptFrames(session.send, reply.body) } };
    } catch {
      return fail(500, "internal error");
    }
  }

  #processSync(request: unknown): Reply {
    const sync = request as P2pSyncRequest;
    const invalid = validateP2pSyncRequest(this.#o.store, this.#o.epoch, sync);
    if (invalid !== undefined) return fail(400, invalid);
    return { status: 200, body: processP2pSync(this.#o.store, this.#o.epoch, this.#o.addresses(), sync) };
  }
}
