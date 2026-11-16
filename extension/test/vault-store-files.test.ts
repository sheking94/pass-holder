import { describe, expect, it } from "vitest";
import { p2p } from "@passholder/core";
import * as files from "@passholder/core/files";
import { AUTO_LOCK_MS, STORAGE_KEYS } from "../src/vault-store.ts";
import {
  CODE,
  newBrowser,
  pairedBrowser,
  PASSWORD,
  PHONE_URL,
  type Network,
} from "./fake-phone.ts";

/** 600 000 bytes: three chunks of FILE_CHUNK_SIZE. */
const SIZE = 600_000;
const bytesOf = (seed: number) => new Uint8Array(SIZE).map((_, i) => (i * 31 + seed) % 251);

const encrypt = (seed = 1, name = "skan.pdf") =>
  files.encryptFile(bytesOf(seed), { name, mime: "application/pdf" });

function loginWith(name: string, attachments: files.Attachment[] = []): p2p.EntryContentV3 {
  const login = p2p.emptyLogin(name);
  return {
    ...login,
    fields: { ...login.fields, username: "u", password: "p" },
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

/** A second browser paired with the same phone. */
async function secondBrowser(network: Network) {
  const phone = network.get(PHONE_URL);
  if (!phone || phone === "hang") throw new Error("no phone");
  const b = newBrowser(network);
  phone.offerPairing();
  await b.store.pairStart(PHONE_URL, CODE, "Chrome B");
  await b.store.pairFinish(PASSWORD);
  return b;
}

const fileCalls = (calls: string[]) => calls.filter((c) => c === p2p.P2P_FILE_PATH).length;

describe("attachments in the vault store", () => {
  it("file added in browser A downloads in browser B", async () => {
    const a = await pairedBrowser();
    const b = await secondBrowser(a.network);
    const ef = await encrypt();
    expect(ef.attachment.chunks).toBe(3);

    await a.store.putEntry("e1", loginWith("bank.pl", [ef.attachment]), [ef]);
    expect(await a.store.fileStatus(ef.attachment)).toBe("ready");
    expect(await a.store.fileUploaded(ef.attachment)).toBe(false);

    const ra = await a.store.sync();
    expect(ra.files).toEqual({
      uploaded: 1,
      downloaded: 0,
      pending: 0,
      corrupted: [],
      corruptedIds: [],
    });
    expect(await a.store.fileUploaded(ef.attachment)).toBe(true);
    expect(a.phone.files.have(ef.attachment.id)).toEqual([0, 1, 2]);

    const progress: [number, number][] = [];
    const rb = await b.store.sync((done, total) => progress.push([done, total]));
    expect(rb.files.downloaded).toBe(1);
    expect(rb.files.error).toBeUndefined();
    expect(progress).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(await b.store.fileStatus(ef.attachment)).toBe("ready");
    expect(await b.store.fileUploaded(ef.attachment)).toBe(true);
    expect(await b.store.readFile(ef.attachment)).toEqual(bytesOf(1));
  });

  it("interrupted file phase resumes", async () => {
    const a = await pairedBrowser();
    const ef = await encrypt();
    await a.store.putEntry("e1", loginWith("bank.pl", [ef.attachment]), [ef]);
    // status, put #0, then put #1 fails.
    a.phone.failFileRequest = 3;

    const first = await a.store.sync();
    expect(first.files.error).toBeDefined();
    expect(await a.phone.entryNames()).toEqual(["bank.pl"]);
    expect(a.store.pendingCount()).toBe(0);
    expect(a.phone.files.have(ef.attachment.id)).toEqual([0]);
    expect(await a.store.fileUploaded(ef.attachment)).toBe(false);

    const before = fileCalls(a.phone.calls);
    const second = await a.store.sync();
    expect(second.files).toEqual({
      uploaded: 1,
      downloaded: 0,
      pending: 0,
      corrupted: [],
      corruptedIds: [],
    });
    // status plus the two chunks the phone lacked.
    expect(fileCalls(a.phone.calls) - before).toBe(3);
    expect(a.phone.files.have(ef.attachment.id)).toEqual([0, 1, 2]);
  });

  it("removing an uploaded attachment prunes it locally", async () => {
    const a = await pairedBrowser();
    const ef = await encrypt();
    await a.store.putEntry("e1", loginWith("bank.pl", [ef.attachment]), [ef]);
    await a.store.sync();
    expect(await a.files.ids()).toEqual([ef.attachment.id]);

    await a.store.putEntry("e1", loginWith("bank.pl"));
    expect(await a.store.fileStatus(ef.attachment)).not.toBe("ready");
    expect(await a.files.ids()).toEqual([]);
  });

  it("deleting the entry prunes its uploaded files locally", async () => {
    const a = await pairedBrowser();
    const ef = await encrypt();
    await a.store.putEntry("e1", loginWith("bank.pl", [ef.attachment]), [ef]);
    await a.store.sync();
    await a.store.delete("e1");
    expect(await a.files.ids()).toEqual([]);
  });

  it("pruning keeps an unused file that was added here and never uploaded (another tab may use it)", async () => {
    const a = await pairedBrowser();
    const fresh = await encrypt(1, "nowy.pdf");
    const old = await encrypt(2, "stary.pdf");
    // Saved by another page whose vault this page has not seen yet.
    await files.storeEncryptedFile(a.files, fresh);
    // Unused here and already on a phone: may go.
    await files.storeEncryptedFile(a.files, old);
    await a.files.markUploaded(old.attachment.id, "epoch");

    await a.store.putEntry("e1", loginWith("bank.pl"));
    expect(await a.files.ids()).toEqual([fresh.attachment.id]);
    await a.store.sync();
    await a.store.delete("e1");
    expect(await a.files.ids()).toEqual([fresh.attachment.id]);
  });

  it("an entry save that fails after the upsert keeps the new files", async () => {
    const a = await pairedBrowser();
    const ef = await encrypt();
    const set = a.local.set;
    a.local.set = async (key, value) => {
      if (key === STORAGE_KEYS.vault) throw new Error("disk full");
      return set(key, value);
    };
    await expect(
      a.store.putEntry("e1", loginWith("bank.pl", [ef.attachment]), [ef]),
    ).rejects.toThrow("disk full");
    // The entry in memory refers to the file.
    expect(a.store.getEntry("e1")!.data.attachments).toEqual([ef.attachment]);
    expect(await a.files.ids()).toEqual([ef.attachment.id]);
  });

  it("a failing prune does not fail putEntry or delete", async () => {
    const a = await pairedBrowser();
    const ef = await encrypt();
    await a.store.putEntry("e1", loginWith("bank.pl", [ef.attachment]), [ef]);
    await a.store.sync();
    a.files.delete = async () => {
      throw new Error("idb gone");
    };
    await a.store.putEntry("e1", loginWith("bank.pl"));
    await a.store.delete("e1");
    expect(a.store.getEntry("e1")).toBeUndefined();
  });

  it("a failing cleanup does not hide why the entry was not saved", async () => {
    const a = await pairedBrowser();
    const ef = await encrypt();
    a.files.delete = async () => {
      throw new Error("idb gone");
    };
    const huge = { ...loginWith("big"), note: "x".repeat(70_000), attachments: [ef.attachment] };
    await expect(a.store.putEntry("e2", huge, [ef])).rejects.toThrow("Wpis jest za duży");
  });

  it("old phone without file path", async () => {
    const a = await pairedBrowser();
    a.phone.fileSupport = false;
    const ef = await encrypt();
    await a.store.putEntry("e1", loginWith("bank.pl", [ef.attachment]), [ef]);

    const result = await a.store.sync();
    expect(result.files.error).toBe("Zaktualizuj aplikację na telefonie");
    expect(await a.phone.entryNames()).toEqual(["bank.pl"]);
    expect(a.store.pendingCount()).toBe(0);
    expect(await a.store.fileStatus(ef.attachment)).toBe("ready");
  });

  it("corrupted download is remembered", async () => {
    const a = await pairedBrowser();
    const ef = await encrypt(1);
    const other = await encrypt(2);
    // The phone holds chunks of another file under this id.
    other.blobs.forEach((blob, i) =>
      a.phone.files.put(ef.attachment.id, i, ef.attachment.chunks, blob, Date.now()),
    );
    await a.phone.addContent("e1", loginWith("bank.pl", [ef.attachment]));

    const first = await a.store.sync();
    expect(first.files.corrupted).toEqual(["skan.pdf"]);
    expect(first.files.error).toBeUndefined();
    expect(await a.store.fileStatus(ef.attachment)).toBe("corrupted");
    expect(await a.local.get(STORAGE_KEYS.corruptFiles)).toEqual([ef.attachment.id]);

    const before = fileCalls(a.phone.calls);
    const second = await a.store.sync();
    expect(second.files).toEqual({
      uploaded: 0,
      downloaded: 0,
      pending: 0,
      corrupted: [],
      corruptedIds: [],
    });
    expect(fileCalls(a.phone.calls)).toBe(before);
    expect(await a.store.fileStatus(ef.attachment)).toBe("corrupted");

    // Once no entry uses the file, the id is forgotten.
    await a.store.putEntry("e1", loginWith("bank.pl"));
    await a.store.sync();
    expect(await a.local.get(STORAGE_KEYS.corruptFiles)).toEqual([]);
  });

  it("readFile of a damaged local file says it is corrupted", async () => {
    const a = await pairedBrowser();
    const ef = await encrypt(1);
    const other = await encrypt(2);
    await a.store.putEntry("e1", loginWith("bank.pl", [ef.attachment]), [ef]);
    await a.files.putChunk(ef.attachment.id, 0, ef.attachment.chunks, other.blobs[0]!);
    await expect(a.store.readFile(ef.attachment)).rejects.toThrow("Plik jest uszkodzony");
  });

  it("upsert keeps attachments", async () => {
    const a = await pairedBrowser();
    const ef = await encrypt();
    await a.store.putEntry("e1", loginWith("bank.pl", [ef.attachment]), [ef]);

    await a.store.upsert("e1", { name: "bank.pl", username: "nowy", password: "inne" });
    expect(a.store.getEntry("e1")!.data.attachments).toEqual([ef.attachment]);
    expect(await a.store.fileStatus(ef.attachment)).toBe("ready");
  });

  it("putEntry after auto-lock stores no file", async () => {
    let clock = Date.now();
    const a = await pairedBrowser({ now: () => clock });
    const ef = await encrypt();
    clock += AUTO_LOCK_MS + 1;

    await expect(
      a.store.putEntry("e1", loginWith("bank.pl", [ef.attachment]), [ef]),
    ).rejects.toThrow("Sejf jest zablokowany");
    expect(await a.files.ids()).toEqual([]);
    await expect(a.store.readFile(ef.attachment)).rejects.toThrow("Sejf jest zablokowany");
  });

  it("a failed entry save removes the new files", async () => {
    const a = await pairedBrowser();
    const ef = await encrypt();
    // An id holding a login cannot take a note: refused after the type check, before anything is stored.
    await a.store.putEntry("e1", loginWith("bank.pl"));
    await expect(
      a.store.putEntry(
        "e1",
        {
          type: "note",
          name: "x",
          note: "",
          custom: [],
          fields: {},
          attachments: [ef.attachment],
        } as unknown as p2p.EntryContentV3,
        [ef],
      ),
    ).rejects.toThrow();
    expect(await a.files.ids()).toEqual([]);
    // Too large an entry fails in upsert, after the files were stored.
    const huge = { ...loginWith("big"), note: "x".repeat(70_000), attachments: [ef.attachment] };
    await expect(a.store.putEntry("e2", huge, [ef])).rejects.toThrow("Wpis jest za duży");
    expect(await a.files.ids()).toEqual([]);
  });

  it("the file phase stops when the vault auto-locks mid-transfer", async () => {
    let clock = Date.now();
    const a = await pairedBrowser({ now: () => clock });
    const ef = await encrypt();
    await a.store.putEntry("e1", loginWith("bank.pl", [ef.attachment]), [ef]);
    // After status and put #0 the 15 minutes pass.
    const handle = a.phone.handle.bind(a.phone);
    a.phone.handle = async (path, raw) => {
      const reply = await handle(path, raw);
      if (path === p2p.P2P_FILE_PATH && fileCalls(a.phone.calls) === 2) clock += AUTO_LOCK_MS + 1;
      return reply;
    };
    const used = await encrypt(2, "inny.pdf");
    await files.storeEncryptedFile(a.files, used);
    await a.files.markUploaded(used.attachment.id, "epoch");

    const result = await a.store.sync();
    expect(result.files.error).toBe("Sejf jest zablokowany");
    expect(fileCalls(a.phone.calls)).toBe(2);
    expect(a.phone.files.have(ef.attachment.id)).toEqual([0]);
    // No prune after a stopped phase.
    expect((await a.files.ids()).sort()).toEqual([ef.attachment.id, used.attachment.id].sort());
  });

  it("the file phase stops when the vault is locked mid-transfer", async () => {
    const a = await pairedBrowser();
    const ef = await encrypt();
    await a.store.putEntry("e1", loginWith("bank.pl", [ef.attachment]), [ef]);
    const handle = a.phone.handle.bind(a.phone);
    a.phone.handle = async (path, raw) => {
      const reply = await handle(path, raw);
      if (path === p2p.P2P_FILE_PATH && fileCalls(a.phone.calls) === 2) await a.store.lock();
      return reply;
    };
    const result = await a.store.sync();
    expect(result.files.error).toBe("Sejf jest zablokowany");
    expect(fileCalls(a.phone.calls)).toBe(2);
  });

  it("putEntry that locks while storing files does not save the entry and removes the files", async () => {
    let clock = Date.now();
    const a = await pairedBrowser({ now: () => clock });
    const ef = await encrypt();
    const markComplete = a.files.markComplete.bind(a.files);
    a.files.markComplete = async (id) => {
      await markComplete(id);
      clock += AUTO_LOCK_MS + 1;
    };
    await expect(
      a.store.putEntry("e1", loginWith("bank.pl", [ef.attachment]), [ef]),
    ).rejects.toThrow("Sejf jest zablokowany");
    expect(await a.files.ids()).toEqual([]);
    clock -= AUTO_LOCK_MS + 1;
    expect(a.store.getEntry("e1")).toBeUndefined();
  });

  it("disconnect still forgets everything when the file store fails", async () => {
    const a = await pairedBrowser();
    await a.local.set(STORAGE_KEYS.corruptFiles, ["x"]);
    a.files.ids = async () => {
      throw new Error("idb gone");
    };
    await a.store.disconnect({ force: true });
    expect(await a.local.get(STORAGE_KEYS.account)).toBeUndefined();
    expect(await a.local.get(STORAGE_KEYS.corruptFiles)).toBeUndefined();
  });

  it("disconnect clears files", async () => {
    const a = await pairedBrowser();
    const ef = await encrypt();
    await a.store.putEntry("e1", loginWith("bank.pl", [ef.attachment]), [ef]);
    await a.local.set(STORAGE_KEYS.corruptFiles, ["x"]);

    await a.store.disconnect({ force: true });
    expect(await a.files.ids()).toEqual([]);
    expect(await a.local.get(STORAGE_KEYS.corruptFiles)).toBeUndefined();
  });
});
