import { describe, expect, it } from "vitest";
import { toBase64 } from "../../src/encoding.ts";
import {
  canAddAttachment,
  chunkCount,
  parseAttachments,
  type Attachment,
} from "../../src/files/index.ts";
import {
  emptyLogin,
  emptyVaultV2,
  parseEntryData,
  serializeEntryData,
  upsertEntryV2,
  HlcClock,
  type EntryDataV3,
} from "../../src/p2p/index.ts";
import {
  countAttachments,
  exportPassHolderJson,
  parsePassHolderJson,
} from "../../src/transfer/index.ts";

const hlc = { ms: 5, c: 1, d: "dev" };
const KEY = toBase64(new Uint8Array(32).fill(7));
const SHA = "a".repeat(64);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const att = (n = 1, over: Partial<Attachment> = {}): Attachment => ({
  id: uuid(n),
  name: "a.txt",
  mime: "text/plain",
  size: 10,
  chunks: 1,
  sha256: SHA,
  key: KEY,
  ...over,
});
const entry = (attachments?: unknown): EntryDataV3 =>
  ({
    ...emptyLogin("n"),
    v: 3,
    hlc,
    ...(attachments === undefined ? {} : { attachments }),
  }) as EntryDataV3;
// Key order matters: attachments sits between custom and hlc.
const withAtt = (attachments: unknown) => {
  const { hlc: h, ...rest } = JSON.parse(serializeEntryData(entry()));
  return { ...rest, attachments, hlc: h };
};
const bad = (attachments: unknown) =>
  expect(() => parseEntryData(withAtt(attachments))).toThrow("Invalid entry payload");

describe("attachment serialization", () => {
  it("serializes in canonical order and round-trips", () => {
    const a = att();
    const text = serializeEntryData(entry([a]));
    expect(text).toBe(
      `{"v":3,"type":"login","name":"n","note":"","fields":{"username":"","password":"","totp":"","urls":[],"androidApps":[]},"custom":[],"attachments":[{"id":"${a.id}","name":"a.txt","mime":"text/plain","size":10,"chunks":1,"sha256":"${SHA}","key":"${KEY}"}],"hlc":{"ms":5,"c":1,"d":"dev"}}`,
    );
    expect(parseEntryData(JSON.parse(text))).toEqual(entry([a]));
  });
  it("omits the key when absent or undefined", () => {
    expect(serializeEntryData(entry())).not.toContain("attachments");
    expect(serializeEntryData(entry(undefined))).toBe(serializeEntryData(entry()));
  });
});

describe("attachment parsing", () => {
  it("rejects bad descriptors", () => {
    bad([]);
    bad([{ ...att(), extra: 1 }]);
    const { key: _k, ...noKey } = att();
    bad([noKey]);
    for (const size of [0, 10485761, 1.5]) bad([att(1, { size })]);
    bad([att(1, { size: 262145, chunks: 1 })]);
    for (const name of ["", "a".repeat(256), "a/b", "a\\b", "a\u0000", "a\u0085"])
      bad([att(1, { name })]);
    bad([att(1, { mime: "m".repeat(128) })]);
    bad([att(1, { sha256: "a".repeat(63) })]);
    bad([att(1, { sha256: "A".repeat(64) })]);
    bad([att(1, { key: toBase64(new Uint8Array(31)) })]);
    // Same 32 bytes, but the unused low bits of the last Base64 digit are set.
    bad([
      att(1, {
        key:
          KEY.slice(0, -2) +
          (KEY.slice(-2, -1) === "A"
            ? "B"
            : String.fromCharCode(KEY.charCodeAt(KEY.length - 2) + 1)) +
          "=",
      }),
    ]);
    bad([att(1, { id: "0000000A-0000-4000-8000-00000000000B" })]);
    bad([att(1, { id: "00000000-0000-1000-8000-000000000001" })]);
    bad([att(1), att(1)]);
    bad(Array.from({ length: 41 }, (_, i) => att(i + 1)));
  });
  it("accepts 40 descriptors", () => {
    const list = Array.from({ length: 40 }, (_, i) => att(i + 1));
    expect(parseAttachments(list)).toHaveLength(40);
    expect(parseEntryData(withAtt(list)).attachments).toHaveLength(40);
  });
  it("chunkCount and canAddAttachment", () => {
    expect(chunkCount(262145)).toBe(2);
    expect(canAddAttachment(19)).toBe(true);
    expect(canAddAttachment(20)).toBe(false);
  });
});

describe("upsertEntryV2 attachments", () => {
  const run = (attachments: Attachment[]) => {
    const vault = emptyVaultV2();
    const { type, name, note, fields, custom } = emptyLogin("n") as any;
    upsertEntryV2(vault, new HlcClock("dev"), "id1", {
      type,
      name,
      note,
      fields,
      custom,
      attachments,
    });
    return vault.entries.get("id1")!.data as object;
  };
  it("drops an empty list, keeps a non-empty one, rejects 41", () => {
    expect("attachments" in run([])).toBe(false);
    expect((run([att()]) as any).attachments).toHaveLength(1);
    expect(() => run(Array.from({ length: 41 }, (_, i) => att(i + 1)))).toThrow(
      "Invalid entry payload",
    );
  });
});

describe("export", () => {
  it("omits attachments and counts them", () => {
    const e = { ...emptyLogin("n"), attachments: [att()] };
    const text = exportPassHolderJson([e]);
    expect(text).not.toContain("attachments");
    expect(parsePassHolderJson(text).entries).toHaveLength(1);
    expect(
      countAttachments([{ ...emptyLogin("a"), attachments: [att(1), att(2)] }, emptyLogin("b")]),
    ).toBe(2);
  });
});
