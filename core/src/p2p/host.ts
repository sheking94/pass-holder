import { fromBase64, randomBytes, toBase64, utf8 } from "../encoding.ts";
import { decryptFrames, encryptFrames, MAX_FRAMES } from "./frames.ts";
import type { SyncStore } from "../protocol.ts";
import { processP2pSync, type P2pSyncRequest } from "./host-sync.ts";
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
}

interface Session {
  send: CipherState;
  recv: CipherState;
  expiresAt: number;
}

type Reply = { status: number; body: unknown };

const MAX_BODY_BYTES = 1024 * 1024;
const SESSION_TTL_MS = 60_000;

const fail = (status: number, error: string): Reply => ({ status, body: { error } });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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
    if (path === "/p2p/v1/handshake") return this.#handshake(body);
    if (path === "/p2p/v1/sync") return this.#sync(body);
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
    this.#sessions.set(session, { send, recv, expiresAt: this.#now() + SESSION_TTL_MS });
    return { status: 200, body: { session, message: toBase64(reply) } };
  }

  async #sync(body: unknown): Promise<Reply> {
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
    let request: P2pSyncRequest;
    try {
      request = (await decryptFrames(session.recv, body.frames as string[])) as P2pSyncRequest;
    } catch {
      return fail(400, "cannot decrypt request");
    }
    if (!isRecord(request) || typeof request.epoch !== "string" || typeof request.sinceRevision !== "number" || !Array.isArray(request.changes))
      return fail(400, "malformed sync request");
    try {
      const response = processP2pSync(this.#o.store, this.#o.epoch, this.#o.addresses(), request);
      return { status: 200, body: { frames: await encryptFrames(session.send, response) } };
    } catch {
      return fail(500, "internal error");
    }
  }
}
