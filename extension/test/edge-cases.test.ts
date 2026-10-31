import { afterEach, describe, expect, it } from "vitest";
import { liveEntries, upsertEntry } from "@passholder/core";
import { buildApp } from "@passholder/server/src/app.ts";
import { Database } from "@passholder/server/src/db.ts";
import { ApiError, ServerClient } from "../src/api.ts";
import { memoryStore, VaultStore } from "../src/vault-store.ts";

const SETUP_TOKEN = "token";
const PASSWORD = "hasło główne";
const servers: { close(): Promise<unknown> }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function listen(db: Database, setupToken?: string, port = 0) {
  const app = buildApp({ db, setupToken });
  servers.push(app);
  return app.listen({ host: "127.0.0.1", port });
}

const newBrowser = () => new VaultStore(memoryStore(), memoryStore());
const names = (store: VaultStore) => liveEntries({ lastSyncRevision: 0, entries: store.entries() }).map((e) => e.data.name).sort();

describe("VaultStore edge cases", () => {
  it("logs in again when the server was restarted and forgot the session", async () => {
    const db = new Database(":memory:");
    const url = await listen(db, SETUP_TOKEN);
    const browser = newBrowser();
    await browser.createVault(url, SETUP_TOKEN, PASSWORD);
    await browser.sync(); // gets a session token

    // The Pi is switched off and on again: same database and address, sessions are gone.
    await servers.splice(0)[0]!.close();
    await listen(db, undefined, Number(new URL(url).port));

    upsertEntry(browser.vaultForEdit(), "1", { name: "bank.pl", username: "jan", password: "x" });
    await browser.save();
    await browser.sync();
    expect(browser.entries().get("1")!.dirty).toBe(false);
  }, 30_000);

  it("resolves a conflict between two browsers by the newer edit", async () => {
    const url = await listen(new Database(":memory:"), SETUP_TOKEN);
    const a = newBrowser();
    await a.createVault(url, SETUP_TOKEN, PASSWORD);
    upsertEntry(a.vaultForEdit(), "1", { name: "a.pl", username: "u", password: "old" }, 100);
    await a.sync();
    const b = newBrowser();
    await b.connectExisting(url, PASSWORD);

    upsertEntry(a.vaultForEdit(), "1", { name: "a.pl", username: "u", password: "from-a" }, 200);
    upsertEntry(b.vaultForEdit(), "1", { name: "a.pl", username: "u", password: "from-b" }, 300);
    await a.sync();
    await b.sync();
    await a.sync();
    expect(a.entries().get("1")!.data).toMatchObject({ password: "from-b" });
    expect(b.entries().get("1")!.data).toMatchObject({ password: "from-b" });
  }, 30_000);

  it("keeps unsynced changes on disk across a lock and unlock", async () => {
    const url = await listen(new Database(":memory:"), SETUP_TOKEN);
    const browser = newBrowser();
    await browser.createVault(url, SETUP_TOKEN, PASSWORD);
    upsertEntry(browser.vaultForEdit(), "1", { name: "offline.pl", username: "u", password: "p" });
    await browser.save();
    await browser.lock();
    await browser.unlock(PASSWORD);
    expect(browser.entries().get("1")).toMatchObject({ dirty: true });
    await browser.sync();
    expect(names(browser)).toEqual(["offline.pl"]);
  }, 30_000);

  it("refuses to use the vault while locked", async () => {
    const browser = newBrowser();
    expect(() => browser.entries()).toThrow("locked");
    await expect(browser.save()).rejects.toThrow("locked");
    await expect(browser.sync()).rejects.toThrow("locked");
    await expect(browser.unlock(PASSWORD)).rejects.toThrow("No account");
  });

  it("refuses a server that sends weak KDF parameters", async () => {
    const fakeServer = (url: string) =>
      new ServerClient(url, async () =>
        Response.json({ kdf: { alg: "argon2id", salt: "AAAAAAAAAAAAAAAAAAAAAA==", memoryKiB: 8, iterations: 1, parallelism: 1 } }),
      );
    const browser = new VaultStore(memoryStore(), memoryStore(), fakeServer);
    await expect(browser.connectExisting("https://evil", PASSWORD)).rejects.toThrow("KDF");
    expect(await browser.getAccount()).toBeUndefined();
  });

  it("does not save the account when setup is refused", async () => {
    const url = await listen(new Database(":memory:"), SETUP_TOKEN);
    const browser = newBrowser();
    await expect(browser.createVault(url, "wrong", PASSWORD)).rejects.toMatchObject({ status: 403 });
    expect(await browser.getAccount()).toBeUndefined();
  }, 30_000);
});

describe("ServerClient", () => {
  it("strips trailing slashes and sends the token", async () => {
    const calls: [string, RequestInit][] = [];
    const client = new ServerClient("https://pi.local:8443///", async (url, init) => {
      calls.push([String(url), init!]);
      return Response.json({ currentRevision: 0, accepted: [], conflicts: [], changes: [] });
    });
    await client.sync("tok", { sinceRevision: 0, changes: [] });
    expect(calls[0]![0]).toBe("https://pi.local:8443/api/v1/sync");
    expect(calls[0]![1].headers).toMatchObject({ authorization: "Bearer tok", "content-type": "application/json" });
  });

  it("turns errors into ApiError with the server's message, or a status for non-JSON bodies", async () => {
    const json = new ServerClient("http://x", async () => Response.json({ error: "Wrong master password" }, { status: 401 }));
    await expect(json.session("a")).rejects.toEqual(new ApiError(401, "Wrong master password"));
    const html = new ServerClient("http://x", async () => new Response("<h1>Bad Gateway</h1>", { status: 502 }));
    await expect(html.status()).rejects.toMatchObject({ status: 502, message: "HTTP 502" });
    const down = new ServerClient("http://x", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(down.status()).rejects.toMatchObject({ status: 0 });
  });
});
