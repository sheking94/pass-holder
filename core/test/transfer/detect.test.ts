import { withCode } from "../error-code.ts";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { exportFile, parseImportFile } from "../../src/transfer/index.ts";

const read = (name: string) =>
  readFileSync(new URL(`../../test-vectors/transfer/${name}`, import.meta.url), "utf8");

describe("parseImportFile", () => {
  it.each([
    ["passholder.json", "passholder"],
    ["bitwarden.json", "bitwarden"],
    ["nordpass.csv", "nordpass"],
    ["nordpass-typed.csv", "nordpass"],
  ])("recognises %s as %s", (name, format) => {
    const r = parseImportFile(read(name));
    expect(r.format).toBe(format);
    expect(r.parsed.entries.length).toBeGreaterThan(0);
  });

  it("ignores a BOM and leading spaces", () => {
    expect(parseImportFile("﻿  \n" + read("passholder.json")).format).toBe("passholder");
  });

  it("reports an empty, broken or unknown file by its code", () => {
    expect(() => parseImportFile("")).toThrow(withCode("IMPORT_EMPTY_FILE"));
    expect(() => parseImportFile(" \n ")).toThrow(withCode("IMPORT_EMPTY_FILE"));
    expect(() => parseImportFile("{zły")).toThrow(withCode("IMPORT_BAD_JSON"));
    expect(() => parseImportFile('{"x":1}')).toThrow(withCode("IMPORT_UNKNOWN_FORMAT"));
  });

  it("lets a parser's own error through (encrypted Bitwarden)", () => {
    expect(() => parseImportFile(JSON.stringify({ encrypted: true, items: [] }))).toThrow(
      withCode("IMPORT_BITWARDEN_ENCRYPTED"),
    );
  });

  it("shows the encrypted message for a password-protected Bitwarden export (no items)", () => {
    const protectedFile = JSON.stringify({
      encrypted: true,
      passwordProtected: true,
      salt: "c2FsdA==",
      kdfType: 0,
      kdfIterations: 600000,
      encKeyValidation_DO_NOT_EDIT: "2.x",
      data: "2.y",
    });
    expect(() => parseImportFile(protectedFile)).toThrow(withCode("IMPORT_BITWARDEN_ENCRYPTED"));
  });
});

describe("exportFile", () => {
  const { parsed } = parseImportFile(read("passholder.json"));
  it("writes each format so that it is recognised again", () => {
    for (const f of ["passholder", "bitwarden", "nordpass"] as const) {
      expect(parseImportFile(exportFile(f, parsed.entries)).format).toBe(f);
    }
  });
});
