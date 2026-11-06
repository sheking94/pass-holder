import { readFileSync } from "node:fs";
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { fromHex, toHex } from "../../src/encoding.ts";

// Guards the hand-copied RFC 9496 Appendix A vectors that the Kotlin port is tested against.
const v = JSON.parse(
  readFileSync(new URL("../../test-vectors/ristretto255-rfc9496.json", import.meta.url), "utf8"),
) as {
  source: string;
  multiples: string[];
  invalid: string[];
  oneWayMap: { input: string; output: string }[];
};

const Point = ristretto255.Point;
const deriveToCurve = ristretto255_hasher.deriveToCurve;

describe("ristretto255 RFC 9496 vectors", () => {
  it("has the expected number of entries", () => {
    expect(v.multiples).toHaveLength(16);
    expect(v.invalid).toHaveLength(29);
    expect(v.oneWayMap).toHaveLength(11);
  });

  it("A.1: multiples of the generator", () => {
    v.multiples.forEach((hex, i) => {
      const p = i === 0 ? Point.ZERO : Point.BASE.multiply(BigInt(i));
      expect(toHex(p.toBytes())).toBe(hex);
      expect(toHex(Point.fromBytes(fromHex(hex)).toBytes())).toBe(hex);
    });
  });

  it("A.2: invalid encodings are rejected", () => {
    for (const hex of v.invalid) {
      expect(fromHex(hex)).toHaveLength(32);
      expect(() => Point.fromBytes(fromHex(hex))).toThrow();
    }
  });

  it("A.3: one-way map from 64 uniform bytes", () => {
    if (deriveToCurve === undefined) throw new Error("deriveToCurve unavailable");
    for (const { input, output } of v.oneWayMap) {
      expect(toHex(deriveToCurve(fromHex(input)).toBytes())).toBe(output);
    }
  });
});
