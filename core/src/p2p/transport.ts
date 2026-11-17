import { fromBase64, toBase64 } from "../encoding.ts";
import { PassHolderError, type ErrorCode } from "../errors.ts";
import { decryptFrames, encryptFrames, MAX_FRAMES } from "./frames.ts";
import type { P2pSyncResponse } from "./host-sync.ts";
import { NoiseKK, P2P_PROLOGUE, type KeyPair } from "./noise.ts";
import type { P2pTransport } from "./sync.ts";

export const P2P_HANDSHAKE_PATH = "/p2p/v2/handshake";
export const P2P_SYNC_PATH = "/p2p/v2/sync";
export const P2P_FILE_PATH = "/p2p/v2/file";

export type FetchJson = (url: string, body: unknown) => Promise<{ status: number; body: unknown }>;

/** The host's error text for a device it does not know (403 on the sync and file paths). */
const DEVICE_NOT_PAIRED_DETAIL = "device not paired";

/**
 * A non-200 answer of the P2P host: code DEVICE_NOT_PAIRED for a 403 "device not paired", otherwise HOST_ERROR.
 * `detail` is the host's error text, or "no error message".
 */
export class P2pHostError extends PassHolderError {
  override readonly name = "P2pHostError";
  readonly status: number;
  override readonly detail: string;

  constructor(status: number, detail: string) {
    super(
      status === 403 && detail === DEVICE_NOT_PAIRED_DETAIL ? "DEVICE_NOT_PAIRED" : "HOST_ERROR",
      `P2P host returned ${status}: ${detail}`,
      { detail },
    );
    this.status = status;
    this.detail = detail;
  }
}

/** The host's answer is not what a PassHolder phone sends. */
export function malformedResponse(cause?: unknown): PassHolderError {
  return new PassHolderError("HOST_MALFORMED", "P2P host returned a malformed response", { cause });
}

/**
 * POSTs to the P2P host and returns the JSON object of a 200 answer. A non-200 status throws a PassHolderError
 * with `codes[status]` when given, otherwise a P2pHostError with the host's error text.
 */
export async function callP2pHost(
  post: FetchJson,
  url: string,
  body: unknown,
  codes: Partial<Record<number, ErrorCode>> = {},
): Promise<Record<string, unknown>> {
  const res = await post(url, body);
  const b = res.body as Record<string, unknown> | null;
  if (res.status !== 200) {
    const code = codes[res.status];
    if (code !== undefined) throw new PassHolderError(code, `P2P host returned ${res.status}`);
    throw new P2pHostError(
      res.status,
      b && typeof b.error === "string" ? b.error : "no error message",
    );
  }
  if (typeof b !== "object" || b === null) throw malformedResponse();
  return b;
}

const str = (v: unknown): string => {
  if (typeof v !== "string") throw malformedResponse();
  return v;
};

export interface NoiseClientOptions {
  baseUrl: string;
  deviceId: string;
  staticKey: KeyPair;
  peerPublicKey: Uint8Array;
  post: FetchJson;
}

/**
 * One Noise handshake plus one encrypted request to `path`; returns the decrypted 200 payload. A non-200 answer
 * on `path` throws a P2pHostError; a 404 on the handshake throws code PHONE_UPDATE_REQUIRED.
 */
export async function noiseRequest(
  o: NoiseClientOptions,
  path: string,
  request: unknown,
): Promise<unknown> {
  const base = o.baseUrl.replace(/\/+$/, "");
  const noise = NoiseKK.initiator({ s: o.staticKey, rs: o.peerPublicKey, prologue: P2P_PROLOGUE });
  const first = await noise.writeMessage(new Uint8Array());
  const hs = await callP2pHost(
    o.post,
    `${base}${P2P_HANDSHAKE_PATH}`,
    { deviceId: o.deviceId, message: toBase64(first) },
    { 404: "PHONE_UPDATE_REQUIRED" },
  );
  await noise.readMessage(fromBase64(str(hs.message)));
  const { send, recv } = noise.split();
  const frames = await encryptFrames(send, request);
  const res = await callP2pHost(o.post, `${base}${path}`, { session: str(hs.session), frames });
  const incoming = res.frames;
  if (
    !Array.isArray(incoming) ||
    incoming.length < 1 ||
    incoming.length > MAX_FRAMES ||
    !incoming.every((f) => typeof f === "string")
  )
    throw malformedResponse();
  return decryptFrames(recv, incoming);
}

/** Noise-over-HTTP client: every call of the returned transport is one handshake plus one sync request. */
export function noiseTransport(o: NoiseClientOptions): P2pTransport {
  return async (request) => (await noiseRequest(o, P2P_SYNC_PATH, request)) as P2pSyncResponse;
}
