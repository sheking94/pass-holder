import { describe, expect, it } from "vitest";
import { concat, concatAll, sameBytes } from "../src/encoding.ts";
import { hasExactKeys, isRecord, requireString } from "../src/strict-json.ts";

describe("strict JSON helpers", () => {
  it("isRecord accepts only JSON objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    for (const v of [null, undefined, [], "x", 1, true]) expect(isRecord(v)).toBe(false);
  });

  it("hasExactKeys needs exactly the listed own keys, in any order", () => {
    expect(hasExactKeys({ b: 1, a: 2 }, ["a", "b"])).toBe(true);
    expect(hasExactKeys({}, [])).toBe(true);
    expect(hasExactKeys({ a: 1 }, ["a", "b"])).toBe(false);
    expect(hasExactKeys({ a: 1, b: 2, c: 3 }, ["a", "b"])).toBe(false);
    expect(hasExactKeys({ a: 1, c: 2 }, ["a", "b"])).toBe(false);
    expect(hasExactKeys(Object.create({ a: 1 }) as unknown, ["a"])).toBe(false);
    expect(hasExactKeys(["a"], ["0"])).toBe(false);
  });

  it("requireString returns a string or throws the given error", () => {
    expect(requireString("", () => new Error("no"))).toBe("");
    for (const v of [null, 1, {}, [], undefined])
      expect(() => requireString(v, () => new Error("no"))).toThrow("no");
  });
});

describe("byte helpers", () => {
  it("concat and concatAll join arrays in order", () => {
    const want = Uint8Array.of(1, 2, 3, 4);
    expect(concat(Uint8Array.of(1), Uint8Array.of(2, 3), Uint8Array.of(4))).toEqual(want);
    expect(concatAll([Uint8Array.of(1, 2), new Uint8Array(0), Uint8Array.of(3, 4)])).toEqual(want);
    expect(concatAll([])).toEqual(new Uint8Array(0));
  });

  it("sameBytes compares length and every byte", () => {
    expect(sameBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(sameBytes(new Uint8Array(0), new Uint8Array(0))).toBe(true);
    expect(sameBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(sameBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 0))).toBe(false);
  });
});
