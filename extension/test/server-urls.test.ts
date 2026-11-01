import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { buildApp } from "@passholder/server/src/app.ts";
import { Database } from "@passholder/server/src/db.ts";
import { ApiError, ServerClient } from "../src/api.ts";
import { normalizeServerUrls, orderForTrying, pickServer } from "../src/server-urls.ts";
import { memoryStore, STORAGE_KEYS, VaultStore } from "../src/vault-store.ts";

const SETUP_TOKEN = "token";
const PASSWORD = "Zażółć gęślą jaźń 2026";
const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function startServer(db = new Database(":memory:")) {
  const app = buildApp({ db, setupToken: SETUP_TOKEN });
  closers.push(() => app.close());
  return app.listen({ host: "127.0.0.1", port: 0 });
}

/** A port where nothing listens: what the Tailscale address looks like with the VPN off. */
async function deadUrl() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/** Accepts connections and never answers: an address that is routed somewhere but silent. */
async function silentUrl() {
  const sockets: Socket[] = [];
  const silent: Server = createServer((socket) => void sockets.push(socket));
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  closers.push(() => {
    sockets.forEach((s) => s.destroy());
    return new Promise((resolve) => silent.close(resolve));
  });
  return `http://127.0.0.1:${(silent.address() as { port: number }).port}`;
}

/** Records which addresses the store talked to. */
function recordingClients() {
  const used: string[] = [];
  const makeClient = (url: string) =>
    new ServerClient(url, (input, init) => {
      used.push(new URL(String(input)).origin);
      return fetch(input, init);
    });
  return { used, makeClient };
}

describe("server addresses", () => {
  it("normalizes and orders the addresses", () => {
    expect(normalizeServerUrls([" https://a:1/ ", "", "https://b:2", "https://a:1"])).toEqual(["https://a:1", "https://b:2"]);
    expect(orderForTrying(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(orderForTrying(["a", "b"], "gone")).toEqual(["a", "b"]);
  });

  it("uses a single address without checking it first", async () => {
    let calls = 0;
    const { url } = await pickServer(["http://only"], (u) => new ServerClient(u, async () => (calls++, Response.json({}))));
    expect(url).toBe("http://only");
    expect(calls).toBe(0);
  });

  it("skips an address that does not answer in time", async () => {
    const live = await startServer();
    const started = Date.now();
    const { url } = await pickServer([await silentUrl(), live], (u) => new ServerClient(u));
    expect(url).toBe(live);
    expect(Date.now() - started).toBeLessThan(8000);
  }, 15_000);

  it("says which addresses it tried when none answers", async () => {
    const a = await deadUrl();
    const b = await deadUrl();
    const error = await pickServer([a, b], (u) => new ServerClient(u)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).message).toContain(`${a}, ${b}`);
  });

  it("connects through whichever address works and syncs through the other one later", async () => {
    const db = new Database(":memory:");
    const home = await startServer(db);
    const tailscale = await startServer(db); // the same server (same database) at a second address
    const offline = await deadUrl();

    // Set up at home; the Tailscale address is not reachable yet (VPN off).
    const { used, makeClient } = recordingClients();
    const browser = new VaultStore(memoryStore(), memoryStore(), makeClient);
    await browser.createVault([home, offline], SETUP_TOKEN, PASSWORD);
    expect(await browser.getAccount()).toMatchObject({ serverUrls: [home, offline], lastServerUrl: home });

    // Away from home: the home address is gone, Tailscale works.
    await browser.setServerUrls([offline, tailscale]);
    await browser.upsert("1", { name: "bank.pl", username: "jan", password: "x" });
    await browser.sync();
    expect(browser.entry("1")!.dirty).toBe(false);
    expect((await browser.getAccount())!.lastServerUrl).toBe(tailscale);

    // The next sync tries the address that worked last time first.
    used.length = 0;
    await browser.sync();
    expect(used[0]).toBe(new URL(tailscale).origin);

    // A second browser connected only at home sees the entry.
    const other = new VaultStore(memoryStore(), memoryStore());
    await other.connectExisting(home, PASSWORD);
    expect(other.entries().map((e) => e.data.name)).toEqual(["bank.pl"]);
  }, 30_000);

  it("reads an account saved by version 1.0 with a single serverUrl", async () => {
    const url = await startServer();
    const first = new VaultStore(memoryStore(), memoryStore());
    await first.createVault(url, SETUP_TOKEN, PASSWORD);
    const { serverUrls, lastServerUrl, ...rest } = (await first.getAccount())!;

    const local = memoryStore();
    await local.set(STORAGE_KEYS.account, { serverUrl: url, ...rest });
    const upgraded = new VaultStore(local, memoryStore());
    expect(await upgraded.getAccount()).toMatchObject({ serverUrls: [url] });
    await upgraded.unlock(PASSWORD);
    await upgraded.sync();
    expect(serverUrls).toEqual([url]);
    expect(lastServerUrl).toBe(url);
  }, 30_000);

  it("refuses an empty list of addresses", async () => {
    const url = await startServer();
    const browser = new VaultStore(memoryStore(), memoryStore());
    await browser.createVault(url, SETUP_TOKEN, PASSWORD);
    await expect(browser.setServerUrls([" ", ""])).rejects.toThrow("Podaj adres serwera");
    expect((await browser.getAccount())!.serverUrls).toEqual([url]);
  }, 30_000);
});
