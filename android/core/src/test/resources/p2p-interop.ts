// Run by P2pInteropTest: the extension's own P2P sync client (TypeScript, Noise over HTTP) against the Kotlin host.
// Usage: node p2p-interop.ts <repo-root> <base-url> <config.json>
// config.json: { deviceId, privateKey, phonePublicKey, vaultKey (hex), epoch, count, startPrefix, password }
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
};
const { p2p } = await import(pathToFileURL(`${root}/core/src/index.ts`).href);

const hex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));
const vaultKey = hex(config.vaultKey);

const vault = p2p.emptyVaultV2();
p2p.applyVaultInfo(vault, { epoch: config.epoch, addresses: [] });
const clock = p2p.clockForVault(vault, config.deviceId);
for (let i = 0; i < config.count; i++) {
  p2p.upsertEntryV2(vault, clock, crypto.randomUUID(), {
    name: `${config.startPrefix}-${i}`,
    username: "z TS",
    password: i === 0 ? config.password : "p".repeat(100),
  });
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

const names = p2p.liveEntriesV2(vault).map((e: { data: { name: string } }) => e.data.name).sort();
console.log(JSON.stringify({ names, epoch: vault.epoch, addresses: vault.addresses }));
