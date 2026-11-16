// Extension side of pairing with the phone over HTTP (/p2p/v1/pair/hello, start, finish).
// The extension is the CPace initiator; its `ad` is the UTF-8 of its own deviceId.
import { fromBase64, toBase64, utf8 } from "../encoding.ts";
import { cpaceFinish, cpaceStart, PAIRING_CI } from "./cpace.ts";
import {
  openPairingMessage,
  pairingKey,
  sealPairingMessage,
  type DeviceIdentity,
  type VaultInfo,
} from "./pairing.ts";
import { callP2pHost, type FetchJson } from "./transport.ts";

/** "pair": the phone has a vault; "restore": the phone waits for the extension's vault ("Odtwórz z wtyczki"). */
export type PhoneMode = "pair" | "restore";

const NO_PAIRING = "Telefon nie czeka na parowanie albo kod wygasł.";
const WRONG_CODE = "Zły kod parowania. Poproś telefon o nowy kod.";
const RESTORE_EXPECTED = "Telefon czeka na odtworzenie sejfu z wtyczki";
const BAD_CODE_FORMAT = "Kod parowania to 8 cyfr.";
const MALFORMED = "P2P host returned a malformed response";
const SID_LENGTH = 16;

const base = (baseUrl: string): string => baseUrl.replace(/\/+$/, "");

function str(v: unknown): string {
  if (typeof v !== "string") throw new Error(MALFORMED);
  return v;
}

function base64(v: unknown, length?: number): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(str(v));
  } catch {
    throw new Error(MALFORMED);
  }
  if (length !== undefined && bytes.length !== length) throw new Error(MALFORMED);
  return bytes;
}

/** Checks the phone is reachable and answers as a PassHolder host. */
export async function pingPhone(baseUrl: string, post: FetchJson): Promise<void> {
  const res = await callP2pHost(post, `${base(baseUrl)}/p2p/v1/ping`, {});
  if (res.ok !== true) throw new Error(MALFORMED);
}

/** The phone's current pairing offer; 404 (no offer, or it expired) throws the "not waiting" message. */
export async function phoneHello(
  baseUrl: string,
  post: FetchJson,
): Promise<{ sid: string; mode: PhoneMode }> {
  const res = await callP2pHost(
    post,
    `${base(baseUrl)}/p2p/v1/pair/hello`,
    {},
    { 404: NO_PAIRING },
  );
  const sid = str(res.sid);
  base64(sid, SID_LENGTH);
  if (res.mode !== "pair" && res.mode !== "restore") throw new Error(MALFORMED);
  return { sid, mode: res.mode };
}

/**
 * Pairs with the phone using the code it shows: hello, start (spends the code), finish.
 * In restore mode `restore` (the extension's vault info) is required and is checked before /start, so a missing
 * vault does not spend the code; in pair mode it is not sent (the phone already has a vault).
 * Returns the phone's identity and vault info (its epoch, KDF, wrapped vault key and addresses).
 */
export async function pairWithPhone(o: {
  baseUrl: string;
  code: string;
  identity: DeviceIdentity;
  post: FetchJson;
  restore?: VaultInfo;
}): Promise<{ mode: PhoneMode; phone: DeviceIdentity; vaultInfo: VaultInfo }> {
  const code = o.code.replace(/\s+/g, "");
  if (!/^\d{8}$/.test(code)) throw new Error(BAD_CODE_FORMAT);
  const url = base(o.baseUrl);

  const { sid, mode } = await phoneHello(url, o.post);
  if (mode === "restore" && o.restore === undefined) throw new Error(RESTORE_EXPECTED);

  const sidBytes = fromBase64(sid);
  const cpace = cpaceStart(utf8(code), PAIRING_CI, sidBytes, utf8(o.identity.deviceId));
  const started = await callP2pHost(
    o.post,
    `${url}/p2p/v1/pair/start`,
    { sid, message: toBase64(cpace.message) },
    { 404: NO_PAIRING },
  );
  const peerMessage = base64(started.message);
  let key: Uint8Array;
  try {
    key = pairingKey(cpaceFinish(cpace.state, peerMessage, "initiator"));
  } catch {
    throw new Error(MALFORMED);
  }

  const request: Record<string, string> = {
    sid,
    identity: await sealPairingMessage(key, "identity", "initiator", o.identity),
  };
  if (mode === "restore")
    request.vaultInfo = await sealPairingMessage(
      key,
      "vault-info",
      "initiator",
      o.restore as VaultInfo,
    );
  const finished = await callP2pHost(o.post, `${url}/p2p/v1/pair/finish`, request, {
    403: WRONG_CODE,
    404: NO_PAIRING,
  });

  let phone: DeviceIdentity;
  let vaultInfo: VaultInfo;
  try {
    phone = (await openPairingMessage(
      key,
      "identity",
      "responder",
      str(finished.identity),
    )) as DeviceIdentity;
    vaultInfo = (await openPairingMessage(
      key,
      "vault-info",
      "responder",
      str(finished.vaultInfo),
    )) as VaultInfo;
  } catch {
    throw new Error(MALFORMED);
  }
  return { mode, phone, vaultInfo };
}
