import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MAX_FILE_SIZE } from "../../src/files/attachment.ts";
import {
  ZIP_ENTRY_TOO_LARGE, ZIP_INVALID, ZipWriter, crc32, isZip, readZipEntry, readZipIndex,
} from "../../src/transfer/zip.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);

async function build(files: [string, Uint8Array][]): Promise<Uint8Array> {
  const w = new ZipWriter(new Date(Date.UTC(2026, 10, 13, 12, 30, 0)));
  for (const [path, bytes] of files) await w.add(path, bytes);
  return new Uint8Array(await new Blob(w.finish() as BlobPart[]).arrayBuffer());
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Offset of the first central directory header, read from the end of central directory record. */
function centralOffset(b: Uint8Array): number {
  return view(b).getUint32(b.length - 22 + 16, true);
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

/** One deflated entry written the way java.util.zip does: bit 3 set, zero sizes and CRC in the local header, then a data descriptor. */
function withDataDescriptor(name: string, content: Uint8Array): Uint8Array {
  const nameBytes = utf8(name);
  const data = new Uint8Array(deflateRawSync(content));
  const crc = crc32(content);
  const local = new Uint8Array(30 + nameBytes.length);
  const lv = view(local);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(6, 0x0808, true);
  lv.setUint16(8, 8, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  const desc = new Uint8Array(16);
  const dv = view(desc);
  dv.setUint32(0, 0x08074b50, true);
  dv.setUint32(4, crc, true);
  dv.setUint32(8, data.length, true);
  dv.setUint32(12, content.length, true);
  const central = new Uint8Array(46 + nameBytes.length);
  const cv = view(central);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint16(8, 0x0808, true);
  cv.setUint16(10, 8, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, content.length, true);
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint32(42, 0, true);
  central.set(nameBytes, 46);
  const cdOffset = local.length + data.length + desc.length;
  const eocd = new Uint8Array(22);
  const ev = view(eocd);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, cdOffset, true);
  const out = new Uint8Array(cdOffset + central.length + eocd.length);
  out.set(local, 0);
  out.set(data, local.length);
  out.set(desc, local.length + data.length);
  out.set(central, cdOffset);
  out.set(eocd, cdOffset + central.length);
  return out;
}

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(utf8("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("ZipWriter and reader", () => {
  it("round-trips an empty file, incompressible bytes (stored) and zeros (deflated)", async () => {
    const random = randomBytes(300 * 1024);
    const zeros = new Uint8Array(300 * 1024);
    const zip = await build([["empty.txt", new Uint8Array(0)], ["random.bin", random], ["zeros.bin", zeros]]);
    const index = readZipIndex(zip);
    expect(index.map((e) => [e.path, e.method, e.size])).toEqual([
      ["empty.txt", 0, 0], ["random.bin", 0, random.length], ["zeros.bin", 8, zeros.length],
    ]);
    expect(index[2]!.compressedSize).toBeLessThan(10000);
    expect(await readZipEntry(zip, index[0]!, MAX_FILE_SIZE)).toEqual(new Uint8Array(0));
    expect(await readZipEntry(zip, index[1]!, MAX_FILE_SIZE)).toEqual(random);
    expect(await readZipEntry(zip, index[2]!, MAX_FILE_SIZE)).toEqual(zeros);
  });

  it("keeps a UTF-8 name and marks it with flag bit 11", async () => {
    const zip = await build([["Zażółć ?.txt", utf8("treść")]]);
    const [entry] = readZipIndex(zip);
    expect(entry!.path).toBe("Zażółć ?.txt");
    expect(view(zip).getUint16(6, true) & 0x0800).toBe(0x0800);
    expect(new TextDecoder().decode(await readZipEntry(zip, entry!, MAX_FILE_SIZE))).toBe("treść");
  });

  it("writes sizes in the local header (no data descriptor) and the first entry first", async () => {
    const zip = await build([["a.txt", utf8("abc")], ["b.txt", utf8("de")]]);
    const v = view(zip);
    expect(v.getUint16(6, true) & 0x0008).toBe(0);
    expect(v.getUint32(18, true)).toBe(3);
    expect(v.getUint32(22, true)).toBe(3);
    expect(readZipIndex(zip).map((e) => e.offset)).toEqual([0, 30 + 5 + 3]);
  });

  it("reads an entry written with a data descriptor (sizes only in the central directory)", async () => {
    const content = utf8("x".repeat(5000));
    const zip = withDataDescriptor("passholder.json", content);
    const [entry] = readZipIndex(zip);
    expect(entry).toMatchObject({ path: "passholder.json", method: 8, size: 5000 });
    expect(await readZipEntry(zip, entry!, MAX_FILE_SIZE)).toEqual(content);
  });
});

describe("readZipIndex rejects", () => {
  const sample = () => build([["a.txt", utf8("hello hello hello hello")]]);

  it("ZIP64 sizes", async () => {
    const zip = await sample();
    view(zip).setUint32(centralOffset(zip) + 24, 0xffffffff, true);
    expect(() => readZipIndex(zip)).toThrow(ZIP_INVALID);
  });

  it("an encrypted entry", async () => {
    const zip = await sample();
    const at = centralOffset(zip) + 8;
    view(zip).setUint16(at, view(zip).getUint16(at, true) | 1, true);
    expect(() => readZipIndex(zip)).toThrow(ZIP_INVALID);
  });

  it("compression method 12", async () => {
    const zip = await sample();
    view(zip).setUint16(centralOffset(zip) + 10, 12, true);
    expect(() => readZipIndex(zip)).toThrow(ZIP_INVALID);
  });

  it("a repeated name", async () => {
    const zip = await build([["a.txt", utf8("1")], ["a.txt", utf8("2")]]);
    expect(() => readZipIndex(zip)).toThrow(ZIP_INVALID);
  });

  it("several disks", async () => {
    const zip = await sample();
    view(zip).setUint16(zip.length - 22 + 4, 1, true);
    expect(() => readZipIndex(zip)).toThrow(ZIP_INVALID);
  });

  it("bytes that are not a ZIP", () => {
    expect(() => readZipIndex(utf8("{\"format\":\"passholder\"}"))).toThrow(ZIP_INVALID);
    expect(() => readZipIndex(new Uint8Array(0))).toThrow(ZIP_INVALID);
  });
});

describe("readZipEntry", () => {
  it("rejects a bad CRC-32", async () => {
    const zip = await build([["a.txt", utf8("hello")]]);
    const at = centralOffset(zip) + 16;
    view(zip).setUint32(at, view(zip).getUint32(at, true) ^ 1, true);
    const [entry] = readZipIndex(zip);
    await expect(readZipEntry(zip, entry!, MAX_FILE_SIZE)).rejects.toThrow(ZIP_INVALID);
  });

  it("stops inflating a file that declares 1000 B and holds 11 MB of zeros", async () => {
    const zip = await build([["bomb.bin", new Uint8Array(11 * 1024 * 1024)]]);
    view(zip).setUint32(centralOffset(zip) + 24, 1000, true);
    const [entry] = readZipIndex(zip);
    expect(entry!.size).toBe(1000);
    await expect(readZipEntry(zip, entry!, MAX_FILE_SIZE)).rejects.toThrow(ZIP_ENTRY_TOO_LARGE);
  });

  it("refuses an entry whose declared size is over the limit", async () => {
    const zip = await build([["a.txt", utf8("hello")]]);
    const [entry] = readZipIndex(zip);
    await expect(readZipEntry(zip, entry!, 4)).rejects.toThrow(ZIP_ENTRY_TOO_LARGE);
  });
});

describe("isZip", () => {
  it("recognises the local header signature", () => {
    expect(isZip(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]))).toBe(true);
    expect(isZip(utf8("{}"))).toBe(false);
    expect(isZip(new Uint8Array([0x50, 0x4b]))).toBe(false);
  });
});
