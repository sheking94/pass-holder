import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { concat, fromHex, randomBytes, toHex, utf8 } from "../../src/encoding.ts";
import { _cpaceInternals, cpaceFinish, cpaceStart, lvCat, PAIRING_CI } from "../../src/p2p/cpace.ts";

const raw = JSON.parse(
  readFileSync(new URL("../../test-vectors/cpace-ristretto255.json", import.meta.url), "utf8"),
) as Record<
  | "PRS" | "CI" | "sid" | "ADa" | "ADb" | "ya" | "yb" | "g" | "Ya" | "Yb" | "K" | "ISK_IR"
  | "generator_string" | "generator_hash" | "invalid_Y1" | "invalid_Y2_identity",
  string
>;

const v = {
  PRS: fromHex(raw.PRS),
  CI: fromHex(raw.CI),
  sid: fromHex(raw.sid),
  ADa: fromHex(raw.ADa),
  ADb: fromHex(raw.ADb),
  ya: fromHex(raw.ya),
  yb: fromHex(raw.yb),
  Ya: fromHex(raw.Ya),
  Yb: fromHex(raw.Yb),
  ISK_IR: raw.ISK_IR,
  invalidY1: fromHex(raw.invalid_Y1),
  identity: fromHex(raw.invalid_Y2_identity),
};

function pair(codeA: string, codeB: string): { ia: Uint8Array; ib: Uint8Array } {
  const sid = randomBytes(16);
  const a = cpaceStart(utf8(codeA), PAIRING_CI, sid, utf8("A"));
  const b = cpaceStart(utf8(codeB), PAIRING_CI, sid, utf8("B"));
  return {
    ia: cpaceFinish(a.state, b.message, "initiator"),
    ib: cpaceFinish(b.state, a.message, "responder"),
  };
}

describe("cpace", () => {
  it("encodes lengths like the draft's prepend_len / lv_cat vectors", () => {
    expect(toHex(lvCat(new Uint8Array()))).toBe("00");
    expect(toHex(lvCat(utf8("1234"), utf8("5"), new Uint8Array(), utf8("678")))).toBe(
      "043132333401350003363738",
    );
    const r127 = Uint8Array.from({ length: 127 }, (_, i) => i);
    const r128 = Uint8Array.from({ length: 128 }, (_, i) => i);
    expect(toHex(lvCat(r127).subarray(0, 2))).toBe("7f00");
    expect(toHex(lvCat(r128).subarray(0, 3))).toBe("800100");
    expect(lvCat(r128).length).toBe(130);
  });

  it("reproduces the draft test vector", () => {
    const a = cpaceStart(v.PRS, v.CI, v.sid, v.ADa, v.ya);
    const b = cpaceStart(v.PRS, v.CI, v.sid, v.ADb, v.yb);
    expect(toHex(a.message)).toBe(toHex(lvCat(v.Ya, v.ADa)));
    expect(toHex(b.message)).toBe(toHex(lvCat(v.Yb, v.ADb)));
    expect(toHex(cpaceFinish(a.state, b.message, "initiator"))).toBe(v.ISK_IR);
    expect(toHex(cpaceFinish(b.state, a.message, "responder"))).toBe(v.ISK_IR);
  });

  it("reproduces the draft's intermediate values (generator_string, generator_hash, g, K)", () => {
    const { generatorString, generatorHash, calculateGenerator, sharedPoint } = _cpaceInternals;
    expect(toHex(generatorString(v.PRS, v.CI, v.sid))).toBe(raw.generator_string);
    expect(toHex(generatorHash(v.PRS, v.CI, v.sid))).toBe(raw.generator_hash);
    expect(toHex(calculateGenerator(v.PRS, v.CI, v.sid))).toBe(raw.g);
    expect(toHex(sharedPoint(v.ya, v.Yb))).toBe(raw.K);
    expect(toHex(sharedPoint(v.yb, v.Ya))).toBe(raw.K);
  });

  it("two parties with the same code agree on a 64-byte key", () => {
    const { ia, ib } = pair("12345678", "12345678");
    expect(ia.length).toBe(64);
    expect(toHex(ia)).toBe(toHex(ib));
  });

  it("a different code gives different keys", () => {
    const { ia, ib } = pair("12345678", "12345679");
    expect(toHex(ia)).not.toBe(toHex(ib));
  });

  it("binds the key to the roles (transcript order)", () => {
    const sid = randomBytes(16);
    const a = cpaceStart(utf8("12345678"), PAIRING_CI, sid, utf8("A"));
    const b = cpaceStart(utf8("12345678"), PAIRING_CI, sid, utf8("B"));
    const ia = cpaceFinish(a.state, b.message, "initiator");
    const ib = cpaceFinish(b.state, a.message, "initiator");
    expect(toHex(ia)).not.toBe(toHex(ib));
  });

  it("rejects the identity element and garbage from the peer", () => {
    const a = cpaceStart(utf8("12345678"), PAIRING_CI, randomBytes(16), new Uint8Array());
    const identityMessage = lvCat(new Uint8Array(32), new Uint8Array());
    const garbageMessage = lvCat(new Uint8Array(32).fill(0xff), new Uint8Array());
    expect(() => cpaceFinish(a.state, identityMessage, "initiator")).toThrow("CPace: invalid peer element");
    expect(() => cpaceFinish(a.state, garbageMessage, "initiator")).toThrow("CPace: invalid peer element");
    // Draft B.3.11: Y_i1 (non-canonical) and Y_i2 == G.I must abort.
    expect(() => cpaceFinish(a.state, lvCat(v.invalidY1, v.ADb), "responder")).toThrow(
      "CPace: invalid peer element",
    );
    expect(() => cpaceFinish(a.state, lvCat(v.identity, v.ADb), "responder")).toThrow(
      "CPace: invalid peer element",
    );
  });

  it("rejects malformed message framing", () => {
    const b = cpaceStart(v.PRS, v.CI, v.sid, v.ADb, v.yb);
    const a = cpaceStart(v.PRS, v.CI, v.sid, v.ADa, v.ya);
    const bad = [
      new Uint8Array(),
      v.Yb, // raw element without lv_cat framing
      b.message.subarray(0, b.message.length - 1), // truncated
      concat(b.message, new Uint8Array([0])), // trailing byte
      lvCat(v.Yb.subarray(0, 31), v.ADb), // short element
      lvCat(concat(v.Yb, new Uint8Array([0])), v.ADb), // long element
      concat(new Uint8Array([0x80]), v.Yb), // unterminated LEB128 length
    ];
    for (const m of bad) {
      expect(() => cpaceFinish(a.state, m, "initiator")).toThrow("CPace: invalid peer element");
    }
  });

  it("rejects an invalid supplied scalar", () => {
    expect(() => cpaceStart(v.PRS, v.CI, v.sid, v.ADa, new Uint8Array(31))).toThrow();
    expect(() => cpaceStart(v.PRS, v.CI, v.sid, v.ADa, new Uint8Array(32))).toThrow();
  });
});
