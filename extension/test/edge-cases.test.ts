import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "@passholder/server/src/app.ts";
import { Database } from "@passholder/server/src/db.ts";
import { ApiError, ServerClient } from "../src/api.ts";
import { memoryStore, NO_VAULT_ON_SERVER, VaultStore } from "../src/vault-store.ts";

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

const newBrowser = (now = () => Date.now()) => new VaultStore(memoryStore(), memoryStore(), undefined, now);
const names = (store: VaultStore) => store.entries().map((e) => e.data.name).sort();

describe("VaultStore edge cases", () => {
  it("logs in again when the server was restarted and forgot the session", async () => {
    const db = new Database(":memory:");
    const url = await listen(db, SETUP_TOKEN);
    const browser = newBrowser();
    await browser.createVault([url], SETUP_TOKEN, PASSWORD);
    await browser.sync(); // gets a session token

    // The Pi is switched off and on again: same database and address, sessions are gone.
    await servers.splice(0)[0]!.close();
    await listen(db, undefined, Number(new URL(url).port));

    await browser.upsert("1", { name: "bank.pl", username: "jan", password: "x" });
    await browser.sync();
    expect(browser.entry("1")!.dirty).toBe(false);
  }, 30_000);

  it("resolves a conflict between two browsers by the newer edit", async () => {
    const url = await listen(new Database(":memory:"), SETUP_TOKEN);
    // One shared clock, so the edit made in b is clearly the newer one.
    let clock = Date.now();
    const a = newBrowser(() => clock);
    await a.createVault([url], SETUP_TOKEN, PASSWORD);
    await a.upsert("1", { name: "a.pl", username: "u", password: "old" });
    await a.sync();
    const b = newBrowser(() => clock);
    await b.connectExisting([url], PASSWORD);

    clock += 100;
    await a.upsert("1", { name: "a.pl", username: "u", password: "from-a" });
    clock += 100;
    await b.upsert("1", { name: "a.pl", username: "u", password: "from-b" });
    await a.sync();
    await b.sync();
    await a.sync();
    expect(a.entry("1")!.data).toMatchObject({ password: "from-b" });
    expect(b.entry("1")!.data).toMatchObject({ password: "from-b" });
  }, 30_000);

  it("keeps unsynced changes on disk across a lock and unlock", async () => {
    const url = await listen(new Database(":memory:"), SETUP_TOKEN);
    const browser = newBrowser();
    await browser.createVault([url], SETUP_TOKEN, PASSWORD);
    await browser.upsert("1", { name: "offline.pl", username: "u", password: "p" });
    await browser.lock();
    await browser.unlock(PASSWORD);
    expect(browser.entry("1")).toMatchObject({ dirty: true });
    await browser.sync();
    expect(names(browser)).toEqual(["offline.pl"]);
  }, 30_000);

  it("refuses to use the vault while locked", async () => {
    const browser = newBrowser();
    expect(() => browser.entries()).toThrow("zablokowany");
    await expect(browser.upsert("1", { name: "a.pl", username: "u", password: "p" })).rejects.toThrow("zablokowany");
    await expect(browser.sync()).rejects.toThrow("zablokowany");
    await expect(browser.unlock(PASSWORD)).rejects.toThrow("nie jest połączona");
  });

  it("refuses a server that sends weak KDF parameters", async () => {
    const fakeServer = (url: string) =>
      new ServerClient(url, async () =>
        Response.json({ kdf: { alg: "argon2id", salt: "AAAAAAAAAAAAAAAAAAAAAA==", memoryKiB: 8, iterations: 1, parallelism: 1 } }),
      );
    const browser = new VaultStore(memoryStore(), memoryStore(), fakeServer);
    await expect(browser.connectExisting(["https://evil"], PASSWORD)).rejects.toThrow("KDF");
    expect(await browser.getAccount()).toBeUndefined();
  });

  it("does not save the account when setup is refused", async () => {
    const url = await listen(new Database(":memory:"), SETUP_TOKEN);
    const browser = newBrowser();
    await expect(browser.createVault([url], "wrong", PASSWORD)).rejects.toMatchObject({ status: 403 });
    expect(await browser.getAccount()).toBeUndefined();
  }, 30_000);

  it("says to create a vault when connecting to a server that has none yet", async () => {
    const url = await listen(new Database(":memory:"), SETUP_TOKEN);
    const browser = newBrowser();
    await expect(browser.connectExisting([url], PASSWORD)).rejects.toThrow(NO_VAULT_ON_SERVER);
    expect(await browser.getAccount()).toBeUndefined();
  });
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
