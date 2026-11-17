import { describe, expect, it } from "vitest";
import { concat, p2p, transfer } from "@passholder/core";
import * as files from "@passholder/core/files";
import { AUTO_LOCK_MS } from "../src/vault-store.ts";
import { pairedBrowser, PASSWORD, newLogin } from "./fake-phone.ts";

/** 600 000 bytes: three chunks of FILE_CHUNK_SIZE. */
const SIZE = 600_000;
const bytesOf = (seed: number, size = SIZE) =>
  new Uint8Array(size).map((_, i) => (i * 31 + seed) % 251);

function loginWith(name: string, attachments: files.Attachment[] = []): p2p.EntryContent {
  const login = p2p.emptyLogin(name);
  return {
    ...login,
    fields: { ...login.fields, username: "u", password: "p" },
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

/**
 * A PassHolder ZIP made by the core exporter: "Bank" with two files (one name Windows refuses), "Poczta" without
 * files. `sources` maps each source descriptor id to its bytes.
 */
async function sampleArchive() {
  const plain = new Map<string, Uint8Array>();
  const describe = async (seed: number, name: string) => {
    const ef = await files.encryptFile(bytesOf(seed), { name, mime: "application/pdf" });
    plain.set(ef.attachment.id, bytesOf(seed));
    return ef.attachment;
  };
  const bank = loginWith("Bank", [
    await describe(1, "skan: umowa?.pdf"),
    await describe(2, "żółć.pdf"),
  ]);
  const poczta = loginWith("Poczta");
  const { parts } = await transfer.exportPassHolderZip([bank, poczta], async (a) =>
    plain.get(a.id),
  );
  return { bytes: concat(...parts), bank };
}

const withoutFiles = (c: p2p.EntryContent) => {
  const { attachments: _a, ...rest } = c;
  return rest;
};

describe("VaultStore.importArchive", () => {
  it("adds the entries with their files under new ids", async () => {
    const a = await pairedBrowser();
    const { bytes, bank } = await sampleArchive();
    const { result, filesAdded, fileSkips, parsed } = await a.store.importArchive(bytes);
    expect(result).toEqual({ added: 2, duplicates: 0, tooLarge: 0 });
    expect(filesAdded).toBe(2);
    expect(fileSkips).toEqual([]);
    expect(parsed.entries.map((e) => e.content.name)).toEqual(["Bank", "Poczta"]);

    const imported = a.store.allContents().find((c) => c.name === "Bank")!;
    expect(withoutFiles(imported)).toEqual(withoutFiles(bank));
    const atts = imported.attachments!;
    expect(atts.map((x) => x.name)).toEqual(["skan: umowa?.pdf", "żółć.pdf"]);
    expect(atts.map((x) => x.id)).not.toContain(bank.attachments![0]!.id);
    expect(atts.map((x) => x.id)).not.toContain(bank.attachments![1]!.id);
    expect(await a.store.readFile(atts[0]!)).toEqual(bytesOf(1));
    expect(await a.store.readFile(atts[1]!)).toEqual(bytesOf(2));
    expect((await a.files.ids()).sort()).toEqual(atts.map((x) => x.id).sort());
    expect(a.store.pendingCount()).toBe(2);
  }, 30_000);

  it("a second import of the same archive adds no entries and leaves no extra files", async () => {
    const a = await pairedBrowser();
    const { bytes } = await sampleArchive();
    await a.store.importArchive(bytes);
    const ids = (await a.files.ids()).sort();
    const again = await a.store.importArchive(bytes);
    expect(again.result).toEqual({ added: 0, duplicates: 2, tooLarge: 0 });
    expect(again.filesAdded).toBe(0);
    expect(again.fileSkips).toEqual([]);
    expect((await a.files.ids()).sort()).toEqual(ids);
    expect(a.store.allContents()).toHaveLength(2);
  }, 30_000);

  it("the same entry twice in one archive is added once, and only its first copy's files stay", async () => {
    const a = await pairedBrowser();
    const plain = new Map<string, Uint8Array>();
    const att = async (seed: number) => {
      const ef = await files.encryptFile(bytesOf(seed, 10), {
        name: `f${seed}.txt`,
        mime: "text/plain",
      });
      plain.set(ef.attachment.id, bytesOf(seed, 10));
      return ef.attachment;
    };
    const one = loginWith("Bank", [await att(1)]);
    const two = loginWith("Bank", [await att(2)]);
    const { parts } = await transfer.exportPassHolderZip([one, two], async (x) => plain.get(x.id));
    const { result, filesAdded } = await a.store.importArchive(concat(...parts));
    expect(result).toEqual({ added: 1, duplicates: 1, tooLarge: 0 });
    expect(filesAdded).toBe(1);
    const kept = a.store.allContents()[0]!.attachments!;
    expect(await a.files.ids()).toEqual([kept[0]!.id]);
  }, 30_000);

  it("one failed delete of an unused file does not stop removing the others", async () => {
    const a = await pairedBrowser();
    const plain = new Map<string, Uint8Array>();
    const att = async (seed: number) => {
      const ef = await files.encryptFile(bytesOf(seed, 10), {
        name: `f${seed}.txt`,
        mime: "text/plain",
      });
      plain.set(ef.attachment.id, bytesOf(seed, 10));
      return ef.attachment;
    };
    const one = loginWith("Bank", [await att(1)]);
    const two = loginWith("Bank", [await att(2), await att(3)]);
    const { parts } = await transfer.exportPassHolderZip([one, two], async (x) => plain.get(x.id));
    const del = a.files.delete.bind(a.files);
    let deletes = 0;
    a.files.delete = async (id) => {
      if (++deletes === 1) throw new Error("idb busy");
      await del(id);
    };
    const { result, filesAdded } = await a.store.importArchive(concat(...parts));
    expect(result.added).toBe(1);
    expect(filesAdded).toBe(1);
    expect(deletes).toBe(2);
    // The kept file and the one whose delete failed.
    expect(await a.files.ids()).toHaveLength(2);
  }, 30_000);

  it("a file missing from the archive is skipped, its entry still comes in", async () => {
    const a = await pairedBrowser();
    const index = JSON.stringify({
      format: "passholder",
      version: 3,
      entries: [
        {
          ...loginWith("Bank"),
          attachments: [{ name: "a.txt", mime: "text/plain", size: 10, path: "files/1-a.txt" }],
        },
      ],
    });
    const zip = new transfer.ZipWriter();
    await zip.add("passholder.json", new TextEncoder().encode(index));
    const { result, filesAdded, fileSkips } = await a.store.importArchive(concat(...zip.finish()));
    expect(result.added).toBe(1);
    expect(filesAdded).toBe(0);
    expect(fileSkips).toEqual([{ at: "wpis 1, a.txt", reason: "brak w archiwum" }]);
    expect(a.store.allContents()[0]!.attachments).toBeUndefined();
    expect(await a.files.ids()).toEqual([]);
  }, 30_000);

  it("auto-lock while storing files: an error, nothing imported, no files left", async () => {
    let clock = Date.now();
    const a = await pairedBrowser({ now: () => clock });
    await a.store.putEntry("old", newLogin({ name: "Stary", username: "u", password: "p" }));
    const before = a.store.allContents();
    const { bytes } = await sampleArchive();
    const markComplete = a.files.markComplete.bind(a.files);
    a.files.markComplete = async (id) => {
      await markComplete(id);
      clock += AUTO_LOCK_MS + 1;
    };
    await expect(a.store.importArchive(bytes)).rejects.toThrow("Sejf jest zablokowany");
    expect(await a.files.ids()).toEqual([]);
    clock -= AUTO_LOCK_MS + 1;
    expect(a.store.allContents()).toEqual(before);
  }, 30_000);

  it("locked while storing files: an error, nothing imported (also on disk), no files left", async () => {
    const a = await pairedBrowser();
    await a.store.putEntry("old", newLogin({ name: "Stary", username: "u", password: "p" }));
    const before = a.store.allContents();
    const { bytes } = await sampleArchive();
    const putChunk = a.files.putChunk.bind(a.files);
    a.files.putChunk = async (...args) => {
      await putChunk(...args);
      await a.store.lock();
    };
    await expect(a.store.importArchive(bytes)).rejects.toThrow("Sejf jest zablokowany");
    expect(await a.files.ids()).toEqual([]);
    a.files.putChunk = putChunk;
    await a.store.unlock(PASSWORD);
    expect(a.store.allContents()).toEqual(before);
  }, 30_000);

  it("a failing file store: an error, nothing imported, the files stored so far removed", async () => {
    const a = await pairedBrowser();
    const { bytes } = await sampleArchive();
    let calls = 0;
    const putChunk = a.files.putChunk.bind(a.files);
    a.files.putChunk = async (...args) => {
      if (++calls === 5) throw new Error("QuotaExceededError");
      await putChunk(...args);
    };
    await expect(a.store.importArchive(bytes)).rejects.toThrow("QuotaExceededError");
    expect(await a.files.ids()).toEqual([]);
    expect(a.store.allContents()).toEqual([]);
  }, 30_000);

  it("refuses a damaged archive and imports nothing", async () => {
    const a = await pairedBrowser();
    const { bytes } = await sampleArchive();
    await expect(a.store.importArchive(bytes.subarray(0, bytes.length - 30))).rejects.toThrow(
      transfer.ZIP_INVALID,
    );
    expect(a.store.allContents()).toEqual([]);
    expect(await a.files.ids()).toEqual([]);
  }, 30_000);
});

describe("VaultStore.exportArchive", () => {
  it("exports entries and ready files; a file waiting for sync is counted as missing", async () => {
    const a = await pairedBrowser();
    const ready = await files.encryptFile(bytesOf(1, 10), { name: "jest.txt", mime: "text/plain" });
    const waiting = await files.encryptFile(bytesOf(2, 10), {
      name: "czeka.txt",
      mime: "text/plain",
    });
    await a.store.putEntry("e1", loginWith("Bank", [ready.attachment, waiting.attachment]), [
      ready,
    ]);
    await a.store.putEntry("e2", newLogin({ name: "Poczta", username: "u", password: "p" }));

    const out = await a.store.exportArchive();
    expect({ entries: out.entries, files: out.files, missing: out.missing }).toEqual({
      entries: 2,
      files: 1,
      missing: 1,
    });

    const { parsed, readFile } = await transfer.openPassHolderZip(concat(...out.parts));
    const bank = parsed.entries.find((e) => e.content.name === "Bank")!;
    expect(bank.files.map((f) => f.name)).toEqual(["jest.txt"]);
    expect(await readFile(bank.files[0]!)).toEqual(bytesOf(1, 10));
  }, 30_000);

  it("round trip into another browser keeps the files", async () => {
    const a = await pairedBrowser();
    const ef = await files.encryptFile(bytesOf(3), { name: "skan.pdf", mime: "application/pdf" });
    await a.store.putEntry("e1", loginWith("Bank", [ef.attachment]), [ef]);
    const out = await a.store.exportArchive();

    const b = await pairedBrowser();
    const { filesAdded } = await b.store.importArchive(concat(...out.parts));
    expect(filesAdded).toBe(1);
    const att = b.store.allContents()[0]!.attachments![0]!;
    expect(await b.store.readFile(att)).toEqual(bytesOf(3));
  }, 30_000);

  it("refuses while locked", async () => {
    const a = await pairedBrowser();
    await a.store.lock();
    await expect(a.store.exportArchive()).rejects.toThrow("Sejf jest zablokowany");
  });
});
