import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "@passholder/server/src/app.ts";
import { Database } from "@passholder/server/src/db.ts";
import { exportNordPassCsv, NORDPASS_COLUMNS, parseCsv, parseNordPassCsv } from "../src/csv-transfer.ts";
import { memoryStore, VaultStore } from "../src/vault-store.ts";

const HEADER = NORDPASS_COLUMNS.join(",");

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

describe("NordPass CSV", () => {
  const entries = [
    { name: "zeta.pl", username: "ja", password: 'p,"a"\nss' },
    { name: "Bank", username: "jan@example.com", password: " spacja na końcu " },
  ];

  it("exports the NordPass header and logins sorted by name", () => {
    const csv = exportNordPassCsv(entries);
    const rows = parseCsv(csv);
    expect(rows[0]!.fields).toEqual([...NORDPASS_COLUMNS]);
    expect(rows.map((r) => r.fields[0])).toEqual(["name", "Bank", "zeta.pl"]);
    const type = NORDPASS_COLUMNS.indexOf("type");
    expect(rows[1]!.fields[type]).toBe("password");
    expect(rows[1]!.fields).toHaveLength(NORDPASS_COLUMNS.length);
  });

  it("imports what it exported, unchanged", () => {
    const parsed = parseNordPassCsv(exportNordPassCsv(entries));
    expect(parsed.skipped).toEqual([]);
    expect(parsed.entries).toEqual([entries[1], entries[0]]);
  });

  it("takes only logins, finds columns by name and names a row by its URL when the name is empty", () => {
    const csv = [
      "type,password,username,url,name,note",
      "password,s1,jan,https://www.example.com/login,,",
      "note,,,,Notatka,tekst",
      "credit_card,,,,Karta,",
      "password,,jan,,Bez hasła,",
      "password,s2,,,,",
      "password,s3,ola,,Poczta,",
    ].join("\n");
    const parsed = parseNordPassCsv(csv);
    expect(parsed.entries).toEqual([
      { name: "example.com", username: "jan", password: "s1" },
      { name: "Poczta", username: "ola", password: "s3" },
    ]);
    expect(parsed.skipped.map((s) => s.line)).toEqual([3, 4, 5, 6]);
  });

  it("rejects a file that is not a NordPass export", () => {
    expect(() => parseNordPassCsv("foo,bar\n1,2")).toThrow(/NordPass/);
    expect(() => parseNordPassCsv("")).toThrow(/pusty/);
  });

  it("accepts the header only", () => {
    expect(parseNordPassCsv(HEADER + "\n")).toEqual({ entries: [], skipped: [] });
  });
});

describe("VaultStore.importEntries", () => {
  const servers: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it("adds new entries as local changes and skips duplicates, also within the file", async () => {
    const app = buildApp({ db: new Database(":memory:"), setupToken: "token" });
    servers.push(app);
    const store = new VaultStore(memoryStore(), memoryStore());
    await store.createVault(await app.listen({ host: "127.0.0.1", port: 0 }), "token", "hasło główne do testu");
    await store.upsert("1", { name: "Bank", username: "jan", password: "x" });

    let n = 0;
    const result = await store.importEntries(
      [
        { name: "Bank", username: "jan", password: "x" },
        { name: "Bank", username: "jan", password: "nowe" },
        { name: "Poczta", username: "ola", password: "y" },
        { name: "Poczta", username: "ola", password: "y" },
      ],
      () => `new-${++n}`,
    );
    expect(result).toEqual({ added: 2, duplicates: 2 });
    expect(store.entries().map((e) => e.data.password).sort()).toEqual(["nowe", "x", "y"]);
    expect(store.pendingCount()).toBe(3);

    await store.sync();
    expect(store.pendingCount()).toBe(0);
  }, 30_000);
});
