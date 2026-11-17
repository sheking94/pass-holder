/**
 * Reference host, for tests and scripts only: the phone runs the Kotlin host
 * (android/core/.../p2p/P2pHost.kt). Client code (p2p/sync.ts, files/client.ts) imports only the types and
 * limits from here. The extension's tests drive this host as a fake phone.
 */
import { fromBase64, randomBytes, sameBytes, toBase64, utf8 } from "../encoding.ts";
import { isRecord } from "../strict-json.ts";
import { errorReply, type HostReply } from "./host-reply.ts";
import { decryptFrames, encryptFrames, MAX_FRAMES } from "./frames.ts";
import type { SyncStore } from "../protocol.ts";
import { InvalidSyncRequestError, processP2pSync } from "./host-sync.ts";
import { processP2pFile, type FileStore } from "../files/host-files.ts";
import { P2P_FILE_PATH, P2P_HANDSHAKE_PATH, P2P_SYNC_PATH } from "./transport.ts";
import { CipherState, NoiseKK, P2P_PROLOGUE, type KeyPair } from "./noise.ts";
import { KEY_BYTES, RANDOM_ID_BYTES } from "../sizes.ts";

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

const MAX_BODY_BYTES = 1024 * 1024;
const SESSION_TTL_MS = 60_000;
/** Most sessions alive at once; a handshake beyond that gets 503 until some expire or are used. */
export const MAX_SESSIONS = 32;
/** Most sessions of one device alive at once, so one device's messages cannot fill the whole table. */
export const MAX_SESSIONS_PER_DEVICE = 4;
/**
 * How many accepted first handshake messages the host remembers (oldest dropped first). A copy of one of them is
 * refused with 400: the message holds nothing fresh from the host, so without this memory every copy would open a
 * session. Only messages that passed Noise (made by a paired device) are kept, so nobody else can flood it.
 */
export const MAX_SEEN_HANDSHAKES = 4096;

/** Paths of the removed v1 sync protocol; the host answers them with 410 so old clients ask for an update. */
const LEGACY_SYNC_PATHS: readonly string[] = ["/p2p/v1/handshake", "/p2p/v1/sync"];

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
  readonly #options: P2pHostOptions;
  readonly #sessions = new Map<string, Session>();
  /** Ephemeral keys (first KEY_BYTES bytes) of accepted handshakes, in insertion order. */
  readonly #seen = new Set<string>();

  constructor(o: P2pHostOptions) {
    this.#options = o;
  }

  async handle(path: string, body: unknown): Promise<HostReply> {
    if (utf8(JSON.stringify(body) ?? "").length > MAX_BODY_BYTES)
      return errorReply(413, "body too large");
    this.#prune();
    if (path === P2P_HANDSHAKE_PATH) return this.#handshake(body);
    if (path === P2P_SYNC_PATH)
      return this.#runSession(body, (request) => this.#processSync(request));
    if (path === P2P_FILE_PATH && this.#options.files) {
      const files = this.#options.files;
      return this.#runSession(body, (request) =>
        processP2pFile(files, this.#options.epoch, request, this.#now()),
      );
    }
    // The v1 sync protocol is gone; tell old clients to update instead of pretending the path is unknown.
    if (LEGACY_SYNC_PATHS.includes(path)) return errorReply(410, "update required");
    return errorReply(404, "not found");
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, s] of this.#sessions) if (s.expiresAt <= now) this.#sessions.delete(id);
  }

  async #handshake(body: unknown): Promise<HostReply> {
    if (!isRecord(body) || typeof body.deviceId !== "string" || typeof body.message !== "string")
      return errorReply(400, "malformed request");
    const device = this.#options.devices().find((d) => d.deviceId === body.deviceId);
    if (!device) return errorReply(403, "device not paired");
    const message = decodeBase64(body.message);
    if (!message) return errorReply(400, "malformed request");
    const ephemeral = toBase64(message.subarray(0, KEY_BYTES));
    if (this.#seen.has(ephemeral)) return errorReply(400, "replayed handshake");
    // handle() already pruned the expired sessions.
    const refused = this.#sessionLimitReply(device.deviceId);
    if (refused) return refused;
    const noise = NoiseKK.responder({
      s: this.#options.staticKey,
      rs: device.staticPublicKey,
      prologue: P2P_PROLOGUE,
    });
    let reply: Uint8Array;
    try {
      await noise.readMessage(message);
      reply = await noise.writeMessage(new Uint8Array());
    } catch {
      return errorReply(400, "handshake failed");
    }
    // Other calls may have run during the awaits: check again, then record without awaiting in between.
    if (this.#seen.has(ephemeral)) return errorReply(400, "replayed handshake");
    const refusedNow = this.#sessionLimitReply(device.deviceId);
    if (refusedNow) return refusedNow;
    this.#remember(ephemeral);
    const { send, recv } = noise.split();
    const session = toBase64(randomBytes(RANDOM_ID_BYTES));
    this.#sessions.set(session, {
      deviceId: device.deviceId,
      staticPublicKey: device.staticPublicKey.slice(),
      send,
      recv,
      expiresAt: this.#now() + SESSION_TTL_MS,
    });
    return { status: 200, body: { session, message: toBase64(reply) } };
  }

  /** A 503 reply when the table, or this device's share of it, is full; undefined when there is room. */
  #sessionLimitReply(deviceId: string): HostReply | undefined {
    if (this.#sessions.size >= MAX_SESSIONS) return errorReply(503, "too many sessions");
    let own = 0;
    for (const s of this.#sessions.values()) if (s.deviceId === deviceId) own++;
    return own >= MAX_SESSIONS_PER_DEVICE ? errorReply(503, "too many sessions") : undefined;
  }

  #remember(ephemeral: string): void {
    this.#seen.add(ephemeral);
    if (this.#seen.size > MAX_SEEN_HANDSHAKES)
      this.#seen.delete(this.#seen.values().next().value as string);
  }

  /** Common part of the one-request-per-session paths; `process` returns a reply whose 200 body gets encrypted. */
  async #runSession(body: unknown, process: (request: unknown) => HostReply): Promise<HostReply> {
    if (
      !isRecord(body) ||
      typeof body.session !== "string" ||
      !Array.isArray(body.frames) ||
      body.frames.length < 1 ||
      body.frames.length > MAX_FRAMES ||
      !body.frames.every((f) => typeof f === "string")
    )
      return errorReply(400, "malformed request");
    const session = this.#sessions.get(body.session);
    // One attempt per session, whatever the outcome.
    this.#sessions.delete(body.session);
    if (!session || session.expiresAt <= this.#now())
      return errorReply(401, "unknown or expired session");
    // The device may have been removed (or re-paired with another key) after the handshake.
    const stillPaired = this.#options
      .devices()
      .some(
        (d) =>
          d.deviceId === session.deviceId && sameBytes(d.staticPublicKey, session.staticPublicKey),
      );
    if (!stillPaired) return errorReply(403, "device not paired");
    let request: unknown;
    try {
      request = await decryptFrames(session.recv, body.frames as string[]);
    } catch {
      return errorReply(400, "cannot decrypt request");
    }
    try {
      const reply = process(request);
      if (reply.status !== 200) return reply;
      return { status: 200, body: { frames: await encryptFrames(session.send, reply.body) } };
    } catch {
      return errorReply(500, "internal error");
    }
  }

  #processSync(request: unknown): HostReply {
    const { store, epoch } = this.#options;
    try {
      return {
        status: 200,
        body: processP2pSync(store, epoch, this.#options.addresses(), request),
      };
    } catch (error) {
      if (error instanceof InvalidSyncRequestError) return errorReply(400, error.message);
      throw error;
    }
  }
}
