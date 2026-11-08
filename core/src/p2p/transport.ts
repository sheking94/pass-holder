import { fromBase64, toBase64 } from "../encoding.ts";
import { decryptFrames, encryptFrames, MAX_FRAMES } from "./frames.ts";
import type { P2pSyncResponse } from "./host-sync.ts";
import { NoiseKK, P2P_PROLOGUE, type KeyPair } from "./noise.ts";
import type { P2pTransport } from "./sync.ts";

export const P2P_HANDSHAKE_PATH = "/p2p/v2/handshake";
export const P2P_SYNC_PATH = "/p2p/v2/sync";
/** Thrown when the phone does not know the v2 handshake path, i.e. runs an older app. */
export const PHONE_UPDATE_REQUIRED = "Phone app needs an update";

export type FetchJson = (url: string, body: unknown) => Promise<{ status: number; body: unknown }>;

/**
 * POSTs to the P2P host and returns the JSON object of a 200 answer. A non-200 status throws `messages[status]`
 * when given, otherwise an error with the host's error text.
 */
export async function callP2pHost(
  post: FetchJson,
  url: string,
  body: unknown,
  messages: Partial<Record<number, string>> = {},
): Promise<Record<string, unknown>> {
  const res = await post(url, body);
  const b = res.body as Record<string, unknown> | null;
  if (res.status !== 200) {
    const message = messages[res.status];
    if (message !== undefined) throw new Error(message);
    const detail = b && typeof b.error === "string" ? b.error : "no error message";
    throw new Error(`P2P host returned ${res.status}: ${detail}`);
  }
  if (typeof b !== "object" || b === null) throw new Error("P2P host returned a malformed response");
  return b;
}

const str = (v: unknown): string => {
  if (typeof v !== "string") throw new Error("P2P host returned a malformed response");
  return v;
};

/** Noise-over-HTTP client: every call of the returned transport is one handshake plus one sync request. */
export function noiseTransport(o: {
  baseUrl: string;
  deviceId: string;
  staticKey: KeyPair;
  peerPublicKey: Uint8Array;
  post: FetchJson;
}): P2pTransport {
  const base = o.baseUrl.replace(/\/+$/, "");
  return async (request) => {
    const noise = NoiseKK.initiator({ s: o.staticKey, rs: o.peerPublicKey, prologue: P2P_PROLOGUE });
    const first = await noise.writeMessage(new Uint8Array());
    const hs = await callP2pHost(
      o.post,
      `${base}${P2P_HANDSHAKE_PATH}`,
      { deviceId: o.deviceId, message: toBase64(first) },
      { 404: PHONE_UPDATE_REQUIRED },
    );
    await noise.readMessage(fromBase64(str(hs.message)));
    const { send, recv } = noise.split();
    const frames = await encryptFrames(send, request);
    const res = await callP2pHost(o.post, `${base}${P2P_SYNC_PATH}`, { session: str(hs.session), frames });
    const incoming = res.frames;
    if (!Array.isArray(incoming) || incoming.length < 1 || incoming.length > MAX_FRAMES || !incoming.every((f) => typeof f === "string"))
      throw new Error("P2P host returned a malformed response");
    return (await decryptFrames(recv, incoming)) as P2pSyncResponse;
  };
}
