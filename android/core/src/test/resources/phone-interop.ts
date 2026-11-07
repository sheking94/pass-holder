// Run by PhoneInteropTest: the extension's own TypeScript code pairs with the real Kotlin phone host over HTTP
// (pairWithPhone) and then syncs with it (syncVaultV2 over noiseTransport).
// Usage: node phone-interop.ts <repo-root> <base-url> <config.json>
// config.json: { code, password, restore (boolean), count, prefix }
//   restore = false: unwraps the phone's vault key with the password, adds `count` entries and syncs.
//   restore = true: makes its own vault (weakest accepted KDF), sends it in the pairing, uploads `count` entries.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [root, baseUrl, configPath] = process.argv.slice(2) as [string, string, string];
// Read as UTF-8 from a file, because the JVM may pass non-ASCII arguments in the platform charset.
const config = JSON.parse(readFileSync(configPath, "utf8")) as {
  code: string;
  password: string;
  restore: boolean;
  count: number;
  prefix: string;
};
const core = await import(pathToFileURL(`${root}/core/src/index.ts`).href);
const { p2p } = core;

const post = async (url: string, body: unknown): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

const deviceId = `ext-${crypto.randomUUID()}`;
const staticKey = p2p.generateKeyPair();
const identity = { deviceId, name: "Chrome", staticPublicKey: core.toBase64(staticKey.publicKey) };

await p2p.pingPhone(baseUrl, post);

let vaultKey: Uint8Array;
let restore: unknown;
if (config.restore) {
  const kdf = { alg: "argon2id", salt: core.toBase64(core.randomBytes(16)), ...core.MIN_KDF };
  vaultKey = core.newVaultKey();
  const keys = await core.deriveKeys(config.password, kdf);
  // epoch and addresses of the old phone; the phone ignores them.
  restore = { epoch: core.toBase64(core.randomBytes(16)), kdf, wrappedVaultKey: await core.wrapVaultKey(keys.encKey, vaultKey), addresses: [] };
}
const paired = await p2p.pairWithPhone({ baseUrl, code: config.code, identity, post, restore });
if (!config.restore) {
  const keys = await core.deriveKeys(config.password, paired.vaultInfo.kdf);
  vaultKey = await core.unwrapVaultKey(keys.encKey, paired.vaultInfo.wrappedVaultKey);
}

const vault = p2p.emptyVaultV2();
if (config.restore) p2p.applyVaultInfo(vault, { epoch: (restore as { epoch: string }).epoch, addresses: [] });
const clock = p2p.clockForVault(vault, deviceId);
for (let i = 0; i < config.count; i++) {
  p2p.upsertEntryV2(vault, clock, crypto.randomUUID(), { name: `${config.prefix}-${i}`, username: "z TS", password: `${config.password}-${i}` });
}
// The phone's epoch: every local entry becomes dirty and is uploaded.
p2p.applyVaultInfo(vault, paired.vaultInfo);

const send = p2p.noiseTransport({
  baseUrl,
  deviceId,
  staticKey,
  peerPublicKey: core.fromBase64(paired.phone.staticPublicKey),
  post,
});
await p2p.syncVaultV2(vault, vaultKey!, clock, send);

const names = p2p.liveEntriesV2(vault).map((e: { data: { name: string } }) => e.data.name).sort();
console.log(
  JSON.stringify({
    deviceId,
    mode: paired.mode,
    phone: paired.phone,
    vaultInfo: paired.vaultInfo,
    sentKdf: config.restore ? (restore as { kdf: unknown }).kdf : null,
    sentWrappedVaultKey: config.restore ? (restore as { wrappedVaultKey: string }).wrappedVaultKey : null,
    names,
    epoch: vault.epoch,
  }),
);
