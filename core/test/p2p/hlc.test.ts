import { describe, expect, it } from "vitest";
import { compareHlc, HlcClock, parseHlc } from "../../src/p2p/hlc.ts";

describe("hlc", () => {
  it("orders by ms, then counter, then device id", () => {
    expect(compareHlc({ ms: 1, c: 9, d: "z" }, { ms: 2, c: 0, d: "a" })).toBe(-1);
    expect(compareHlc({ ms: 2, c: 1, d: "a" }, { ms: 2, c: 0, d: "z" })).toBe(1);
    expect(compareHlc({ ms: 2, c: 1, d: "a" }, { ms: 2, c: 1, d: "b" })).toBe(-1);
    expect(compareHlc({ ms: 2, c: 1, d: "a" }, { ms: 2, c: 1, d: "a" })).toBe(0);
  });
  it("keeps growing when the wall clock goes backwards", () => {
    let t = 1000;
    const clock = new HlcClock("A", () => t);
    const a = clock.tick();
    t = 500;
    const b = clock.tick();
    const c = clock.tick();
    expect(a).toEqual({ ms: 1000, c: 0, d: "A" });
    expect(b).toEqual({ ms: 1000, c: 1, d: "A" });
    expect(compareHlc(b, c)).toBe(-1);
  });
  it("ticks after an observed remote clock that runs ahead", () => {
    const clock = new HlcClock("B", () => 100);
    clock.observe({ ms: 99_999, c: 4, d: "A" });
    expect(clock.tick()).toEqual({ ms: 99_999, c: 5, d: "B" });
  });
  it("resets the counter when the wall clock moves forward", () => {
    let t = 10;
    const clock = new HlcClock("A", () => t);
    clock.tick();
    clock.tick();
    t = 11;
    expect(clock.tick()).toEqual({ ms: 11, c: 0, d: "A" });
  });
  it("rejects malformed values", () => {
    for (const bad of [
      null,
      {},
      { ms: -1, c: 0, d: "a" },
      { ms: 1.5, c: 0, d: "a" },
      { ms: 1, c: 0, d: "" },
      { ms: 1, c: 0, d: "x".repeat(65) },
    ])
      expect(() => parseHlc(bad)).toThrow("Invalid HLC");
    expect(parseHlc({ ms: 1, c: 2, d: "a", extra: 1 })).toEqual({ ms: 1, c: 2, d: "a" });
  });
});
