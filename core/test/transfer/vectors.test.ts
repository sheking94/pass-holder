import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { exportFile, type TransferFormat } from "../../src/transfer/index.ts";

const dir = new URL("../../test-vectors/transfer/", import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, dir), "utf8");
const entries = [...JSON.parse(read("passholder.expected.json")).entries, ...JSON.parse(read("bitwarden.expected.json")).entries];

describe("shared transfer vectors", () => {
  const files: [TransferFormat, string][] = [
    ["passholder", "export.passholder.json"],
    ["bitwarden", "export.bitwarden.json"],
    ["nordpass", "export.nordpass.csv"],
  ];
  for (const [format, file] of files) {
    it(`export ${format} matches ${file}`, () => {
      expect(exportFile(format, entries)).toBe(read(file));
    });
  }

  it("sort.json matches localeCompare(pl)", () => {
    const { names, sorted } = JSON.parse(read("sort.json"));
    expect([...names].sort((a: string, b: string) => a.localeCompare(b, "pl"))).toEqual(sorted);
  });
});
