import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "../../src/transfer/csv.ts";

describe("parseCsv", () => {
  it("handles quotes, commas, doubled quotes, line breaks, CRLF, BOM and blank lines", () => {
    const text = '﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\nlast,,\n';
    expect(parseCsv(text)).toEqual([
      { line: 1, fields: ["a", "b", "c"] },
      { line: 2, fields: ["x, y", 'say "hi"', "line1\nline2"] },
      { line: 5, fields: ["last", "", ""] },
    ]);
  });

  it("reads a last row without a line break", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      { line: 1, fields: ["a", "b"] },
      { line: 2, fields: ["1", "2"] },
    ]);
  });

  it("rejects an unclosed quote", () => {
    expect(() => parseCsv('a\n"oops')).toThrow(/niezamknięty cudzysłów/);
  });
});

describe("toCsv", () => {
  it("quotes fields with commas, quotes, line breaks or outer spaces and ends rows with CRLF", () => {
    const csv = toCsv([["a", "b,c", 'q"q', " s "], ["x", "", "l\nl", "z"]]);
    expect(csv).toBe('a,"b,c","q""q"," s "\r\nx,,"l\nl",z\r\n');
    expect(parseCsv(csv).map((r) => r.fields)).toEqual([["a", "b,c", 'q"q', " s "], ["x", "", "l\nl", "z"]]);
  });
});
