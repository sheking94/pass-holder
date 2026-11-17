// CPace PAKE, cipher suite CPACE-RISTR255-SHA512, initiator-responder setting.
// Implements draft-irtf-cfrg-cpace-21 (23 April 2026):
// https://www.ietf.org/archive/id/draft-irtf-cfrg-cpace-21.txt
// Sections 6.3 (lv_cat, transcript_ir), 7.2 (protocol), 8.1 (generator_string)
// and 8.3 (G_Ristretto255); test vectors from Appendix B.3.
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { concat, randomBytes, utf8 } from "../encoding.ts";

/** Channel identifier for pairing a device with the phone. */
export const PAIRING_CI = utf8("passholder/v2/pair");

const Point = ristretto255.Point;
const Fn = Point.Fn;
/** RFC 9496 element derivation (one-way map from 64 uniform bytes). */
const deriveToCurve = ristretto255_hasher.deriveToCurve;
if (deriveToCurve === undefined)
  throw new Error("CPace: ristretto255 element derivation unavailable");
const elementDerivation: (uniformBytes: Uint8Array) => InstanceType<typeof Point> = deriveToCurve;

const DSI = utf8("CPaceRistretto255");
const DSI_ISK = utf8("CPaceRistretto255_ISK");
/** SHA-512 input block size (H.s_in_bytes). */
const S_IN_BYTES = 128;
const FIELD_SIZE_BYTES = 32;
const INVALID = "CPace: invalid peer element";

export interface CpaceState {
  readonly ya: bigint;
  readonly Ya: Uint8Array;
  readonly ad: Uint8Array;
  readonly sid: Uint8Array;
}

/** prepend_len (draft A.1.1): LEB128 length followed by the data. */
function prependLen(data: Uint8Array): Uint8Array {
  const len: number[] = [];
  let n = data.length;
  do {
    const low = n & 0x7f;
    n = Math.floor(n / 128);
    len.push(n > 0 ? low | 0x80 : low);
  } while (n > 0);
  return concat(Uint8Array.from(len), data);
}

/** lv_cat (draft A.1.3): concatenation of prepend_len of every argument. */
export function lvCat(...parts: Uint8Array[]): Uint8Array {
  return concat(...parts.map(prependLen));
}

/** Inverse of lvCat for exactly `count` fields; null on any framing error. */
function lvSplit(bytes: Uint8Array, count: number): Uint8Array[] | null {
  const out: Uint8Array[] = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    let len = 0;
    let shift = 1;
    for (;;) {
      if (pos >= bytes.length || shift > 2 ** 28) return null;
      const b = bytes[pos++] as number;
      len += (b & 0x7f) * shift;
      shift *= 128;
      if ((b & 0x80) === 0) break;
    }
    if (len > bytes.length - pos) return null;
    out.push(bytes.subarray(pos, pos + len));
    pos += len;
  }
  return pos === bytes.length ? out : null;
}

/** generator_string (draft A.2). */
function generatorString(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Uint8Array {
  const zpad = Math.max(0, S_IN_BYTES - 1 - prependLen(prs).length - prependLen(DSI).length);
  return lvCat(DSI, prs, new Uint8Array(zpad), ci, sid);
}

/** Hash of generator_string truncated to 2 * field size (draft 8.3); the input of the element derivation. */
function generatorHash(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Uint8Array {
  return sha512(generatorString(prs, ci, sid)).subarray(0, 2 * FIELD_SIZE_BYTES);
}

/** G_Ristretto255.calculate_generator (draft 8.3). */
function calculateGenerator(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array) {
  return elementDerivation(generatorHash(prs, ci, sid));
}

function bytesToScalarLE(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i] as number);
  return Fn.create(n);
}

/** G.sample_scalar (draft 8.3): 32 random bytes, bits above 252 cleared, little-endian. */
function sampleScalar(): bigint {
  for (;;) {
    const bytes = randomBytes(32);
    bytes[31] = (bytes[31] as number) & 0x0f;
    const y = bytesToScalarLE(bytes);
    if (y !== 0n) return y;
  }
}

/** scalar_mult_vfy (draft 8.3): decode failure or a neutral result means abort (K == G.I). */
function scalarMultVfy(y: bigint, Yp: Uint8Array): Uint8Array {
  let peer;
  try {
    peer = Point.fromBytes(Yp);
  } catch {
    throw new Error(INVALID);
  }
  if (peer.is0()) throw new Error(INVALID);
  const Kp = peer.multiply(y);
  if (Kp.is0()) throw new Error(INVALID);
  return Kp.toBytes();
}

/** Starts a CPace run with a random scalar. `message` is lv_cat(Y, ad) and is sent to the peer. */
export function cpaceStart(
  prs: Uint8Array,
  ci: Uint8Array,
  sid: Uint8Array,
  ad: Uint8Array,
): { state: CpaceState; message: Uint8Array } {
  return startWithScalar(prs, ci, sid, ad, sampleScalar());
}

function startWithScalar(
  prs: Uint8Array,
  ci: Uint8Array,
  sid: Uint8Array,
  ad: Uint8Array,
  y: bigint,
): { state: CpaceState; message: Uint8Array } {
  const Y = calculateGenerator(prs, ci, sid).multiply(y).toBytes();
  return {
    state: { ya: y, Ya: Y, ad: ad.slice(), sid: sid.slice() },
    message: lvCat(Y, ad),
  };
}

/** Finishes a CPace run and returns ISK (64 bytes); throws on an invalid peer message. */
export function cpaceFinish(
  state: CpaceState,
  peerMessage: Uint8Array,
  role: "initiator" | "responder",
): Uint8Array {
  const fields = lvSplit(peerMessage, 2);
  if (fields === null) throw new Error(INVALID);
  const [Yp, adp] = fields as [Uint8Array, Uint8Array];
  if (Yp.length !== FIELD_SIZE_BYTES) throw new Error(INVALID);

  const K = scalarMultVfy(state.ya, Yp);

  const transcript =
    role === "initiator"
      ? concat(lvCat(state.Ya, state.ad), lvCat(Yp, adp))
      : concat(lvCat(Yp, adp), lvCat(state.Ya, state.ad));
  return sha512(concat(lvCat(DSI_ISK, state.sid, K), transcript));
}

/** Test-only access to intermediate values of the draft vector. Not part of the protocol API. */
export const _cpaceInternals = {
  /** cpaceStart with a fixed scalar `ya` (32 bytes, little-endian), to reproduce the draft vector. */
  startWithScalar: (
    prs: Uint8Array,
    ci: Uint8Array,
    sid: Uint8Array,
    ad: Uint8Array,
    ya: Uint8Array,
  ): { state: CpaceState; message: Uint8Array } => {
    if (ya.length !== 32) throw new Error("CPace: scalar must be 32 bytes");
    const y = bytesToScalarLE(ya);
    if (y === 0n) throw new Error("CPace: zero scalar");
    return startWithScalar(prs, ci, sid, ad, y);
  },
  generatorString,
  generatorHash,
  calculateGenerator: (prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Uint8Array =>
    calculateGenerator(prs, ci, sid).toBytes(),
  /** K = scalar_mult_vfy(y, Y_peer), with y as 32 little-endian bytes. */
  sharedPoint: (y: Uint8Array, peer: Uint8Array): Uint8Array =>
    scalarMultVfy(bytesToScalarLE(y), peer),
};
