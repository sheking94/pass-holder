// Run by RealServerTest: the Chrome extension's own VaultStore (TypeScript) talks to the same server as
// the Kotlin client, reads what the phone wrote and adds an entry of its own.
// Usage: node --experimental-transform-types interop.ts <repo-root> <server-url> <master-password as UTF-8 Base64>
import { pathToFileURL } from "node:url";

const [root, url, passwordB64] = process.argv.slice(2) as [string, string, string];
const password = Buffer.from(passwordB64, "base64").toString("utf8");
const { VaultStore, memoryStore } = await import(pathToFileURL(`${root}/extension/src/vault-store.ts`).href);
const { upsertEntry, liveEntries } = await import(pathToFileURL(`${root}/core/src/index.ts`).href);

const store = new VaultStore(memoryStore(), memoryStore());
await store.connectExisting(url, password);
const seen = liveEntries({ lastSyncRevision: 0, entries: store.entries() }).map((e: { data: { name: string } }) => e.data.name);
upsertEntry(store.vaultForEdit(), crypto.randomUUID(), { name: "z-przegladarki.pl", username: "jan", password: "z TS" });
await store.save();
await store.sync();
console.log(JSON.stringify(seen));
