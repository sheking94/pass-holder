// Run by P2pInteropTest: the extension's own P2P sync client (TypeScript, Noise over HTTP) against the Kotlin host.
// Usage: node p2p-interop.ts <repo-root> <base-url> <config.json>
// config.json: { deviceId, privateKey, phonePublicKey, vaultKey (hex), epoch, count, startPrefix, password, files? }
// With files: true the client also attaches a 3-chunk file to an entry and runs syncFiles (upload + download).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [root, baseUrl, configPath] = process.argv.slice(2) as [string, string, string];
// Read as UTF-8 from a file, because the JVM may pass non-ASCII arguments in the platform charset.
const config = JSON.parse(readFileSync(configPath, "utf8")) as {
  deviceId: string;
  privateKey: string;
  phonePublicKey: string;
  vaultKey: string;
  epoch: string;
  count: number;
  startPrefix: string;
  password: string;
  files?: boolean;
  phoneFileId?: string;
};
const { p2p } = await import(pathToFileURL(`${root}/core/src/index.ts`).href);

const vault = p2p.emptyVaultV2();
p2p.applyVaultInfo(vault, { epoch: config.epoch, addresses: [] });
const clock = p2p.clockForVault(vault, config.deviceId);
for (let i = 0; i < config.count; i++) {
  p2p.upsertEntryV2(vault, clock, crypto.randomUUID(), {
    ...p2p.emptyLogin(`${config.startPrefix}-${i}`),
    fields: { ...p2p.emptyLogin().fields, username: "z TS", password: i === 0 ? config.password : "p".repeat(100) },
  });
}

const hex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));
const vaultKey = hex(config.vaultKey);
const { files } = await import(pathToFileURL(`${root}/core/src/index.ts`).href);
const localFiles = new files.MemoryLocalFileStore();
if (config.files) {
  const bytes = Uint8Array.from({ length: 600000 }, (_, i) => (i * 7 + 3) & 0xff);
  const enc = await files.encryptFile(bytes, { name: "z-przegladarki.bin", mime: "application/octet-stream" });
  await files.storeEncryptedFile(localFiles, enc);
  p2p.upsertEntryV2(vault, clock, crypto.randomUUID(), { ...p2p.emptyLogin("z-plikiem"), attachments: [enc.attachment] });
}

const post = async (url: string, body: unknown): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const send = p2p.noiseTransport({
  baseUrl,
  deviceId: config.deviceId,
  staticKey: p2p.keyPairFromPrivateKey(hex(config.privateKey)),
  peerPublicKey: hex(config.phonePublicKey),
  post,
});
await p2p.syncVaultV2(vault, vaultKey, clock, send);

let fileOut: unknown;
if (config.files) {
  const sendFile = files.noiseFileTransport({
    baseUrl,
    deviceId: config.deviceId,
    staticKey: p2p.keyPairFromPrivateKey(hex(config.privateKey)),
    peerPublicKey: hex(config.phonePublicKey),
    post,
  });
  const result = await files.syncFiles(vault, localFiles, sendFile);
  // The file the phone added: decrypt what was downloaded and report its SHA-256.
  const fromPhone = files.usedAttachments(vault).get(config.phoneFileId!);
  const blobs: string[] = [];
  for (let i = 0; fromPhone && i < fromPhone.chunks; i++) blobs.push((await localFiles.getChunk(fromPhone.id, i))!);
  const bytes = fromPhone ? await files.decryptFile(fromPhone, blobs) : undefined;
  fileOut = { ...result, downloadedSha256: bytes && (await files.sha256Hex(bytes)) };
}

const names = p2p.liveEntriesV2(vault).map((e: { data: { name: string } }) => e.data.name).sort();
console.log(JSON.stringify({ names, epoch: vault.epoch, addresses: vault.addresses, files: fileOut }));
