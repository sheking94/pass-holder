import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromHex, toHex, utf8 } from "../../src/encoding.ts";
import {
  CipherState,
  generateKeyPair,
  keyPairFromPrivateKey,
  NoiseKK,
  P2P_PROLOGUE,
  type KeyPair,
} from "../../src/p2p/noise.ts";

interface VectorMessage {
  payload: string;
  ciphertext: string;
}
const raw = JSON.parse(
  readFileSync(new URL("../../test-vectors/noise-kk.json", import.meta.url), "utf8"),
) as {
  protocol_name: string;
  init_prologue: string;
  init_static: string;
  init_ephemeral: string;
  init_remote_static: string;
  resp_prologue: string;
  resp_static: string;
  resp_ephemeral: string;
  resp_remote_static: string;
  handshake_hash: string;
  messages: VectorMessage[];
};

function pair(): { a: KeyPair; b: KeyPair } {
  return { a: generateKeyPair(), b: generateKeyPair() };
}

async function handshake(prologue = P2P_PROLOGUE) {
  const { a, b } = pair();
  const init = NoiseKK.initiator({ s: a, rs: b.publicKey, prologue });
  const resp = NoiseKK.responder({ s: b, rs: a.publicKey, prologue });
  const m1 = await init.writeMessage(utf8("hello"));
  expect(await resp.readMessage(m1)).toEqual(utf8("hello"));
  const m2 = await resp.writeMessage(utf8("world"));
  expect(await init.readMessage(m2)).toEqual(utf8("world"));
  return { init, resp };
}

describe("Noise_KK_25519_AESGCM_SHA256", () => {
  it("uses the passholder/v2 prologue", () => {
    expect(P2P_PROLOGUE).toEqual(utf8("passholder/v2/noise"));
  });

  it("reproduces the Cacophony KK vector", async () => {
    expect(raw.protocol_name).toBe("Noise_KK_25519_AESGCM_SHA256");
    const initS = keyPairFromPrivateKey(fromHex(raw.init_static));
    const respS = keyPairFromPrivateKey(fromHex(raw.resp_static));
    // Pre-message keys in the vector are the peers' static public keys.
    expect(toHex(respS.publicKey)).toBe(raw.init_remote_static);
    expect(toHex(initS.publicKey)).toBe(raw.resp_remote_static);

    const init = NoiseKK.initiator({
      s: initS,
      rs: fromHex(raw.init_remote_static),
      prologue: fromHex(raw.init_prologue),
      e: keyPairFromPrivateKey(fromHex(raw.init_ephemeral)),
    });
    const resp = NoiseKK.responder({
      s: respS,
      rs: fromHex(raw.resp_remote_static),
      prologue: fromHex(raw.resp_prologue),
      e: keyPairFromPrivateKey(fromHex(raw.resp_ephemeral)),
    });

    const [h1, h2, ...transport] = raw.messages as [
      VectorMessage,
      VectorMessage,
      ...VectorMessage[],
    ];
    const m1 = await init.writeMessage(fromHex(h1.payload));
    expect(toHex(m1)).toBe(h1.ciphertext);
    expect(toHex(await resp.readMessage(m1))).toBe(h1.payload);
    const m2 = await resp.writeMessage(fromHex(h2.payload));
    expect(toHex(m2)).toBe(h2.ciphertext);
    expect(toHex(await init.readMessage(m2))).toBe(h2.payload);

    expect(toHex(init.handshakeHash)).toBe(raw.handshake_hash);
    expect(toHex(resp.handshakeHash)).toBe(raw.handshake_hash);

    // Transport messages alternate direction, starting with initiator -> responder; AD is empty.
    const i = init.split();
    const r = resp.split();
    const empty = new Uint8Array(0);
    expect(transport.length).toBe(4);
    for (const [k, m] of transport.entries()) {
      const [sender, receiver] = k % 2 === 0 ? [i, r] : [r, i];
      const ct = await sender.send.encrypt(empty, fromHex(m.payload));
      expect(toHex(ct)).toBe(m.ciphertext);
      expect(toHex(await receiver.recv.decrypt(empty, ct))).toBe(m.payload);
    }
  });

  it("both sides derive matching transport keys", async () => {
    const { init, resp } = await handshake();
    expect(init.handshakeHash).toEqual(resp.handshakeHash);
    const i = init.split();
    const r = resp.split();
    const ad = utf8("passholder/v2/test");
    for (let n = 0; n < 3; n++) {
      const ping = await i.send.encrypt(ad, utf8(`ping ${n}`));
      expect(await r.recv.decrypt(ad, ping)).toEqual(utf8(`ping ${n}`));
      const pong = await r.send.encrypt(ad, utf8(`pong ${n}`));
      expect(await i.recv.decrypt(ad, pong)).toEqual(utf8(`pong ${n}`));
    }
    // Directions use different keys: a frame cannot be read back by its own sender's recv state.
    const own = await i.send.encrypt(ad, utf8("x"));
    await expect(i.recv.decrypt(ad, own)).rejects.toThrow();
  });

  it("rejects a tampered, truncated or replayed message", async () => {
    const { a, b } = pair();
    const mk = () => ({
      init: NoiseKK.initiator({ s: a, rs: b.publicKey, prologue: P2P_PROLOGUE }),
      resp: NoiseKK.responder({ s: b, rs: a.publicKey, prologue: P2P_PROLOGUE }),
    });

    // Tampered byte in message 1 (in the ephemeral key and in the encrypted payload).
    for (const index of [0, 40]) {
      const { init, resp } = mk();
      const m1 = await init.writeMessage(utf8("hello"));
      m1[index]! ^= 0x01;
      await expect(resp.readMessage(m1)).rejects.toThrow();
    }

    // Truncated message 1: shorter than e, and missing part of the tag.
    {
      const { init, resp } = mk();
      const m1 = await init.writeMessage(utf8("hello"));
      await expect(resp.readMessage(m1.subarray(0, 20))).rejects.toThrow();
    }
    {
      const { init, resp } = mk();
      const m1 = await init.writeMessage(utf8("hello"));
      await expect(resp.readMessage(m1.subarray(0, m1.length - 1))).rejects.toThrow();
    }

    // Replayed transport frame after split().
    const { init, resp } = await handshake();
    const i = init.split();
    const r = resp.split();
    const ad = new Uint8Array(0);
    const frame = await i.send.encrypt(ad, utf8("sync"));
    expect(await r.recv.decrypt(ad, frame)).toEqual(utf8("sync"));
    await expect(r.recv.decrypt(ad, frame)).rejects.toThrow();
  });

  it("fails when the responder expects a different initiator key", async () => {
    const { a, b } = pair();
    const stranger = generateKeyPair();
    const init = NoiseKK.initiator({ s: a, rs: b.publicKey, prologue: P2P_PROLOGUE });
    const resp = NoiseKK.responder({ s: b, rs: stranger.publicKey, prologue: P2P_PROLOGUE });
    await expect(resp.readMessage(await init.writeMessage(utf8("hi")))).rejects.toThrow();
  });

  it("fails when the prologues differ", async () => {
    const { a, b } = pair();
    const init = NoiseKK.initiator({ s: a, rs: b.publicKey, prologue: P2P_PROLOGUE });
    const resp = NoiseKK.responder({ s: b, rs: a.publicKey, prologue: utf8("other") });
    await expect(resp.readMessage(await init.writeMessage(utf8("hi")))).rejects.toThrow();
  });

  it("enforces message order, split() timing and the 65535-byte limit", async () => {
    const { a, b } = pair();
    const init = NoiseKK.initiator({ s: a, rs: b.publicKey, prologue: P2P_PROLOGUE });
    const resp = NoiseKK.responder({ s: b, rs: a.publicKey, prologue: P2P_PROLOGUE });
    expect(() => init.split()).toThrow();
    await expect(resp.writeMessage(utf8("x"))).rejects.toThrow();
    await expect(init.readMessage(new Uint8Array(48))).rejects.toThrow();
    // 32 (e) + payload + 16 (tag) must stay within 65535.
    await expect(init.writeMessage(new Uint8Array(65535 - 48 + 1))).rejects.toThrow(/65535/);
    await expect(resp.readMessage(new Uint8Array(65536))).rejects.toThrow(/65535/);
    const m1 = await init.writeMessage(new Uint8Array(65535 - 48));
    expect(m1.length).toBe(65535);
    await resp.readMessage(m1);
    expect(() => resp.split()).toThrow();
    await init.readMessage(await resp.writeMessage(new Uint8Array(0)));
    await expect(init.writeMessage(utf8("x"))).rejects.toThrow();
    const { send } = init.split();
    await expect(send.encrypt(new Uint8Array(0), new Uint8Array(65535 - 16 + 1))).rejects.toThrow(
      /65535/,
    );
  });
});

describe("CipherState", () => {
  it("passes plaintext through when it has no key", async () => {
    const cs = new CipherState(null);
    const pt = utf8("plain");
    expect(await cs.encrypt(new Uint8Array(0), pt)).toEqual(pt);
    expect(await cs.decrypt(new Uint8Array(0), pt)).toEqual(pt);
  });

  it("uses 4 zero bytes || 64-bit big-endian counter as the AES-GCM nonce", async () => {
    const key = new Uint8Array(32).fill(7);
    const n = 0x0102030405060708n;
    const cs = new CipherState(key, n);
    const ad = utf8("ad");
    const ct = await cs.encrypt(ad, utf8("msg"));
    const iv = fromHex("000000000102030405060708");
    const ref = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv as BufferSource, additionalData: ad as BufferSource },
        await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]),
        utf8("msg") as BufferSource,
      ),
    );
    expect(ct).toEqual(ref);
  });

  it("refuses to use nonce 2^64-1", async () => {
    const key = new Uint8Array(32).fill(1);
    const last = new CipherState(key, 2n ** 64n - 2n);
    const ct = await last.encrypt(new Uint8Array(0), utf8("a"));
    await expect(last.encrypt(new Uint8Array(0), utf8("b"))).rejects.toThrow(/exhausted/);
    const reader = new CipherState(key, 2n ** 64n - 2n);
    expect(await reader.decrypt(new Uint8Array(0), ct)).toEqual(utf8("a"));
    await expect(reader.decrypt(new Uint8Array(0), ct)).rejects.toThrow(/exhausted/);
  });

  it("does not advance the counter on a failed decrypt", async () => {
    const key = new Uint8Array(32).fill(2);
    const w = new CipherState(key);
    const r = new CipherState(key);
    const ct = await w.encrypt(new Uint8Array(0), utf8("ok"));
    const bad = ct.slice();
    bad[0]! ^= 1;
    await expect(r.decrypt(new Uint8Array(0), bad)).rejects.toThrow();
    expect(await r.decrypt(new Uint8Array(0), ct)).toEqual(utf8("ok"));
  });
});
