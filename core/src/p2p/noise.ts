// Noise_KK_25519_AESGCM_SHA256, Noise Protocol Framework revision 34 (2018-07-11):
// https://noiseprotocol.org/noise.html
// Sections 5.1 (CipherState), 5.2 (SymmetricState), 5.3 (HandshakeState), 7.5 (KK),
// 12.1 (25519), 12.3 (AESGCM), 12.5 (SHA256).
// Test vector: Cacophony, see core/test-vectors/noise-kk.json.
//
//   KK:
//     -> s
//     <- s
//     ...
//     -> e, es, ss
//     <- e, ee, se
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, utf8 } from "../encoding.ts";
import { PassHolderError } from "../errors.ts";
import { GCM_NONCE_BYTES, GCM_TAG_BYTES, KEY_BYTES } from "../sizes.ts";

/** Prologue bound into every PassHolder device-to-device handshake. */
export const P2P_PROLOGUE = utf8("passholder/v2/noise");

const PROTOCOL_NAME = utf8("Noise_KK_25519_AESGCM_SHA256");
const DHLEN = KEY_BYTES;
const HASHLEN = 32;
const TAGLEN = GCM_TAG_BYTES;
/** Noise messages, handshake and transport, are at most 65535 bytes (section 3). */
export const MAX_MESSAGE = 65535;
/** n = 2^64-1 is reserved; reaching it means the CipherState is exhausted (section 5.1). */
const MAX_NONCE = 2n ** 64n - 1n;
const EMPTY = new Uint8Array(0);

/** Every Noise failure has code NOISE_FAILED and a message starting "Noise: ". */
function noiseError(what: string, cause?: unknown): PassHolderError {
  return new PassHolderError("NOISE_FAILED", `Noise: ${what}`, { cause });
}

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** Fresh X25519 key pair from the CSPRNG. */
export function generateKeyPair(): KeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return { publicKey, privateKey: secretKey };
}

/** X25519 key pair for an existing 32-byte private key (stored keys, test vectors). */
export function keyPairFromPrivateKey(privateKey: Uint8Array): KeyPair {
  if (privateKey.length !== DHLEN) throw noiseError("private key must be 32 bytes");
  return { publicKey: x25519.getPublicKey(privateKey), privateKey: privateKey.slice() };
}

function dh(keyPair: KeyPair, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(keyPair.privateKey, publicKey);
}

function hash(data: Uint8Array): Uint8Array {
  return sha256(data);
}

/** HKDF(chaining_key, input_key_material, 2) from section 4.3. */
function hkdf2(chainingKey: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const tempKey = hmac(sha256, chainingKey, ikm);
  const out1 = hmac(sha256, tempKey, Uint8Array.of(0x01));
  const out2 = hmac(sha256, tempKey, concat(out1, Uint8Array.of(0x02)));
  return [out1, out2];
}

/** AESGCM nonce: 32 bits of zeros followed by the 64-bit big-endian counter (section 12.3). */
function aesGcmNonce(n: bigint): Uint8Array {
  const nonce = new Uint8Array(GCM_NONCE_BYTES);
  new DataView(nonce.buffer).setBigUint64(4, n, false);
  return nonce;
}

/**
 * Noise CipherState: key k (or none) and 64-bit counter n.
 * Without a key, encrypt/decrypt return the input unchanged (section 5.1).
 * Calls must not overlap; a concurrent call throws.
 */
export class CipherState {
  #key: Promise<CryptoKey> | null;
  #n: bigint;
  #busy = false;

  /** `n` is only for tests; normal callers start at 0. */
  constructor(key: Uint8Array | null, n = 0n) {
    if (key !== null && key.length !== KEY_BYTES) throw noiseError("cipher key must be 32 bytes");
    if (n < 0n || n > MAX_NONCE) throw noiseError("nonce out of range");
    this.#key =
      key === null
        ? null
        : crypto.subtle.importKey("raw", key.slice() as BufferSource, "AES-GCM", false, [
            "encrypt",
            "decrypt",
          ]);
    this.#n = n;
  }

  hasKey(): boolean {
    return this.#key !== null;
  }

  async encrypt(ad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
    if (this.#key === null) return plaintext.slice();
    if (plaintext.length + TAGLEN > MAX_MESSAGE) throw noiseError("message exceeds 65535 bytes");
    return this.#run(async (key, nonce) => {
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce as BufferSource, additionalData: ad as BufferSource },
        key,
        plaintext as BufferSource,
      );
      return new Uint8Array(ct);
    });
  }

  async decrypt(ad: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
    if (this.#key === null) return ciphertext.slice();
    if (ciphertext.length > MAX_MESSAGE) throw noiseError("message exceeds 65535 bytes");
    if (ciphertext.length < TAGLEN) throw noiseError("ciphertext too short");
    return this.#run(async (key, nonce) => {
      let pt: ArrayBuffer;
      try {
        pt = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: nonce as BufferSource, additionalData: ad as BufferSource },
          key,
          ciphertext as BufferSource,
        );
      } catch (error) {
        throw noiseError("decryption failed", error);
      }
      return new Uint8Array(pt);
    });
  }

  /** Runs one AEAD operation with the current nonce; n advances only on success. */
  async #run(op: (key: CryptoKey, nonce: Uint8Array) => Promise<Uint8Array>): Promise<Uint8Array> {
    if (this.#n >= MAX_NONCE) throw noiseError("nonce exhausted");
    if (this.#busy) throw noiseError("concurrent CipherState use");
    this.#busy = true;
    try {
      const out = await op(await this.#key!, aesGcmNonce(this.#n));
      this.#n += 1n;
      return out;
    } finally {
      this.#busy = false;
    }
  }
}

/** Noise SymmetricState (section 5.2). */
class SymmetricState {
  ck: Uint8Array;
  h: Uint8Array;
  cipher = new CipherState(null);

  constructor(protocolName: Uint8Array) {
    if (protocolName.length <= HASHLEN) {
      this.h = new Uint8Array(HASHLEN);
      this.h.set(protocolName);
    } else {
      this.h = hash(protocolName);
    }
    this.ck = this.h.slice();
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, tempK] = hkdf2(this.ck, ikm);
    this.ck = ck;
    this.cipher = new CipherState(tempK.subarray(0, KEY_BYTES));
  }

  mixHash(data: Uint8Array): void {
    this.h = hash(concat(this.h, data));
  }

  async encryptAndHash(plaintext: Uint8Array): Promise<Uint8Array> {
    const ct = await this.cipher.encrypt(this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  async decryptAndHash(ciphertext: Uint8Array): Promise<Uint8Array> {
    const pt = await this.cipher.decrypt(this.h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf2(this.ck, EMPTY);
    return [new CipherState(k1.subarray(0, KEY_BYTES)), new CipherState(k2.subarray(0, KEY_BYTES))];
  }
}

export interface NoiseKKOptions {
  /** Local static key pair. */
  s: KeyPair;
  /** Remote party's static public key, known in advance (KK pre-message). */
  rs: Uint8Array;
  prologue: Uint8Array;
}

type Step = "write1" | "read1" | "write2" | "read2" | "done" | "split" | "failed";

/**
 * Noise_KK_25519_AESGCM_SHA256 handshake (section 5.3 HandshakeState with pattern KK).
 * Message 1 goes initiator -> responder, message 2 responder -> initiator; then split().
 * Any error leaves the handshake unusable.
 */
export class NoiseKK {
  readonly #initiator: boolean;
  readonly #s: KeyPair;
  readonly #rs: Uint8Array;
  #e: KeyPair | undefined;
  #re: Uint8Array | undefined;
  readonly #ss: SymmetricState;
  #step: Step;
  #busy = false;

  /** `e` is a fixed ephemeral key pair (test vectors only); without it writeMessage generates one. */
  private constructor(initiator: boolean, o: NoiseKKOptions, e?: KeyPair) {
    if (o.s.privateKey.length !== DHLEN || o.s.publicKey.length !== DHLEN)
      throw noiseError("static key pair must be 32-byte X25519 keys");
    if (o.rs.length !== DHLEN) throw noiseError("remote static key must be 32 bytes");
    this.#initiator = initiator;
    this.#s = o.s;
    this.#rs = o.rs.slice();
    this.#e = e;
    this.#ss = new SymmetricState(PROTOCOL_NAME);
    this.#ss.mixHash(o.prologue);
    // Pre-messages: "-> s" then "<- s", hashed in pattern order on both sides.
    const initiatorStatic = initiator ? this.#s.publicKey : this.#rs;
    const responderStatic = initiator ? this.#rs : this.#s.publicKey;
    this.#ss.mixHash(initiatorStatic);
    this.#ss.mixHash(responderStatic);
    this.#step = initiator ? "write1" : "read1";
  }

  static initiator(o: NoiseKKOptions): NoiseKK {
    return new NoiseKK(true, o);
  }

  static responder(o: NoiseKKOptions): NoiseKK {
    return new NoiseKK(false, o);
  }

  /** `initiator` with a fixed ephemeral key pair, ONLY for test vectors. */
  static initiatorWithEphemeral(o: NoiseKKOptions, e: KeyPair): NoiseKK {
    return new NoiseKK(true, o, e);
  }

  /** `responder` with a fixed ephemeral key pair, ONLY for test vectors. */
  static responderWithEphemeral(o: NoiseKKOptions, e: KeyPair): NoiseKK {
    return new NoiseKK(false, o, e);
  }

  async writeMessage(payload: Uint8Array): Promise<Uint8Array> {
    const expected = this.#initiator ? "write1" : "write2";
    if (DHLEN + payload.length + TAGLEN > MAX_MESSAGE)
      throw noiseError("message exceeds 65535 bytes");
    return this.#guard(expected, async () => {
      // Token "e".
      const e = this.#e ?? generateKeyPair();
      this.#e = e;
      this.#ss.mixHash(e.publicKey);
      const re = this.#re;
      if (this.#initiator) {
        // -> e, es, ss
        this.#ss.mixKey(dh(e, this.#rs)); // es: DH(e, rs)
        this.#ss.mixKey(dh(this.#s, this.#rs)); // ss
      } else {
        // <- e, ee, se
        this.#ss.mixKey(dh(e, re!)); // ee
        this.#ss.mixKey(dh(e, this.#rs)); // se: responder computes DH(e, rs)
      }
      const ct = await this.#ss.encryptAndHash(payload);
      return concat(e.publicKey, ct);
    });
  }

  async readMessage(message: Uint8Array): Promise<Uint8Array> {
    const expected = this.#initiator ? "read2" : "read1";
    if (message.length > MAX_MESSAGE) throw noiseError("message exceeds 65535 bytes");
    if (message.length < DHLEN + TAGLEN) throw noiseError("handshake message too short");
    return this.#guard(expected, async () => {
      // Token "e".
      const re = message.slice(0, DHLEN);
      this.#re = re;
      this.#ss.mixHash(re);
      if (this.#initiator) {
        // <- e, ee, se
        this.#ss.mixKey(dh(this.#e!, re)); // ee
        this.#ss.mixKey(dh(this.#s, re)); // se: initiator computes DH(s, re)
      } else {
        // -> e, es, ss
        this.#ss.mixKey(dh(this.#s, re)); // es: responder computes DH(s, re)
        this.#ss.mixKey(dh(this.#s, this.#rs)); // ss
      }
      return this.#ss.decryptAndHash(message.subarray(DHLEN));
    });
  }

  /** Transport ciphers after both handshake messages; callable once. */
  split(): { send: CipherState; recv: CipherState } {
    if (this.#busy || this.#step !== "done")
      throw noiseError("split() before the handshake finished");
    const [c1, c2] = this.#ss.split();
    this.#step = "split";
    // c1 encrypts initiator -> responder, c2 responder -> initiator.
    return this.#initiator ? { send: c1, recv: c2 } : { send: c2, recv: c1 };
  }

  /** Final handshake hash h, for channel binding; available once the handshake has finished. */
  get handshakeHash(): Uint8Array {
    if (this.#step !== "done" && this.#step !== "split") throw noiseError("handshake not finished");
    return this.#ss.h.slice();
  }

  /** Runs one handshake step; input-size errors above leave the state intact, any later error fails it. */
  async #guard(expected: Step, op: () => Promise<Uint8Array>): Promise<Uint8Array> {
    if (this.#busy) throw noiseError("concurrent handshake use");
    if (this.#step !== expected)
      throw noiseError(`unexpected handshake step (state ${this.#step})`);
    this.#busy = true;
    try {
      const out = await op();
      this.#step = advance(expected);
      return out;
    } catch (error) {
      this.#step = "failed";
      throw error;
    } finally {
      this.#busy = false;
    }
  }
}

function advance(step: Step): Step {
  switch (step) {
    case "write1":
      return "read2";
    case "read1":
      return "write2";
    case "write2":
    case "read2":
      return "done";
    default:
      throw noiseError("invalid handshake step");
  }
}
