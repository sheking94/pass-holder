// Extension side of pairing with the phone over HTTP (ping, pair/hello, start, finish; paths in transport.ts).
// The extension is the CPace initiator; its `ad` is the UTF-8 of its own deviceId.
import { fromBase64, toBase64, utf8 } from "../encoding.ts";
import { PassHolderError } from "../errors.ts";
import { cpaceFinish, cpaceStart, PAIRING_CI } from "./cpace.ts";
import {
  openPairingMessage,
  pairingKey,
  sealPairingMessage,
  type DeviceIdentity,
  type VaultInfo,
} from "./pairing.ts";
import {
  callP2pHost,
  malformedResponse,
  P2P_PAIR_FINISH_PATH,
  P2P_PAIR_HELLO_PATH,
  P2P_PAIR_START_PATH,
  P2P_PING_PATH,
  responseString,
  type FetchJson,
} from "./transport.ts";

/** "pair": the phone has a vault; "restore": the phone waits for the extension's vault ("Odtwórz z wtyczki"). */
export type PhoneMode = "pair" | "restore";

const SID_LENGTH = 16;

const base = (baseUrl: string): string => baseUrl.replace(/\/+$/, "");

function base64(v: unknown, length?: number): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(responseString(v));
  } catch (error) {
    throw malformedResponse(error);
  }
  if (length !== undefined && bytes.length !== length) throw malformedResponse();
  return bytes;
}

/** Checks the phone is reachable and answers as a PassHolder host. */
export async function pingPhone(baseUrl: string, post: FetchJson): Promise<void> {
  const res = await callP2pHost(post, `${base(baseUrl)}${P2P_PING_PATH}`, {});
  if (res.ok !== true) throw malformedResponse();
}

/** The phone's current pairing offer; 404 (no offer, or it expired) throws code PAIRING_NOT_WAITING. */
export async function phoneHello(
  baseUrl: string,
  post: FetchJson,
): Promise<{ sid: string; mode: PhoneMode }> {
  const res = await callP2pHost(
    post,
    `${base(baseUrl)}${P2P_PAIR_HELLO_PATH}`,
    {},
    { 404: "PAIRING_NOT_WAITING" },
  );
  const sid = responseString(res.sid);
  base64(sid, SID_LENGTH);
  if (res.mode !== "pair" && res.mode !== "restore") throw malformedResponse();
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
  if (!/^\d{8}$/.test(code))
    throw new PassHolderError("PAIRING_BAD_CODE_FORMAT", "The pairing code is 8 digits");
  const url = base(o.baseUrl);

  const { sid, mode } = await phoneHello(url, o.post);
  if (mode === "restore" && o.restore === undefined)
    throw new PassHolderError("PAIRING_RESTORE_EXPECTED", "The phone waits for a vault to restore");

  const sidBytes = fromBase64(sid);
  const cpace = cpaceStart(utf8(code), PAIRING_CI, sidBytes, utf8(o.identity.deviceId));
  const started = await callP2pHost(
    o.post,
    `${url}${P2P_PAIR_START_PATH}`,
    { sid, message: toBase64(cpace.message) },
    { 404: "PAIRING_NOT_WAITING" },
  );
  const peerMessage = base64(started.message);
  let key: Uint8Array;
  try {
    key = pairingKey(cpaceFinish(cpace.state, peerMessage, "initiator"));
  } catch (error) {
    throw malformedResponse(error);
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
  const finished = await callP2pHost(o.post, `${url}${P2P_PAIR_FINISH_PATH}`, request, {
    403: "PAIRING_WRONG_CODE",
    404: "PAIRING_NOT_WAITING",
  });

  let phone: DeviceIdentity;
  let vaultInfo: VaultInfo;
  try {
    phone = (await openPairingMessage(
      key,
      "identity",
      "responder",
      responseString(finished.identity),
    )) as DeviceIdentity;
    vaultInfo = (await openPairingMessage(
      key,
      "vault-info",
      "responder",
      responseString(finished.vaultInfo),
    )) as VaultInfo;
  } catch (error) {
    throw malformedResponse(error);
  }
  return { mode, phone, vaultInfo };
}
