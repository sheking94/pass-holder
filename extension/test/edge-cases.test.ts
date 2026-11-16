import { describe, expect, it, vi } from "vitest";
import { ApiError, PHONE_UNREACHABLE, PhoneClient, POST_TIMEOUT_MS } from "../src/phone-client.ts";
import { STORAGE_KEYS, VaultStore, memoryStore } from "../src/vault-store.ts";
import { CODE, FakePhone, names, newBrowser, pairedBrowser, PASSWORD, PHONE_URL } from "./fake-phone.ts";

describe("VaultStore edge cases", () => {
  it("resolves a conflict between the phone and the browser by the newer edit", async () => {
    for (const [offset, winner] of [[3_600_000, "from-browser"], [-3_600_000, "from-phone"]] as const) {
      // The browser's clock runs an hour ahead of (or behind) the phone's.
      let skew: number = offset;
      const { store, phone } = await pairedBrowser({ now: () => Date.now() + skew });
      await store.upsert("1", { name: "a.pl", username: "u", password: "old" });
      await store.sync();

      await phone.addEntry("1", "a.pl", "from-phone");
      // The phone's clock jumped to the browser's "old" edit; the browser's next edit is clearly later than that.
      skew += 10_000;
      await store.upsert("1", { name: "a.pl", username: "u", password: "from-browser" });
      await store.sync();
      expect(store.entry("1")!.data).toMatchObject({ password: winner });
      expect(await phone.passwords()).toEqual({ "1": winner });
    }
  }, 60_000);

  it("keeps unsynced changes on disk across a lock and unlock", async () => {
    const { store } = await pairedBrowser();
    await store.upsert("1", { name: "offline.pl", username: "u", password: "p" });
    await store.lock();
    await store.unlock(PASSWORD);
    expect(store.entry("1")).toMatchObject({ dirty: true });
    await store.sync();
    expect(store.entry("1")).toMatchObject({ dirty: false });
    expect(names(store)).toEqual(["offline.pl"]);
  }, 30_000);

  it("refuses to use the vault while locked", async () => {
    const browser = new VaultStore(memoryStore(), memoryStore());
    expect(() => browser.entries()).toThrow("zablokowany");
    await expect(browser.upsert("1", { name: "a.pl", username: "u", password: "p" })).rejects.toThrow("zablokowany");
    await expect(browser.sync()).rejects.toThrow("zablokowany");
    await expect(browser.unlock(PASSWORD)).rejects.toThrow("nie jest sparowana");
    await expect(browser.repair(PHONE_URL, CODE, PASSWORD)).rejects.toThrow("nie jest sparowana");
  });

  it("refuses a phone that sends weak KDF parameters", async () => {
    const phone = await FakePhone.withVault(PASSWORD, [PHONE_URL]);
    phone.kdf = { ...phone.kdf!, memoryKiB: 8, iterations: 1, parallelism: 1 };
    const { store, session } = newBrowser(new Map([[PHONE_URL, phone]]));
    phone.offerPairing();
    await expect(store.pairStart(PHONE_URL, CODE, "Chrome")).rejects.toThrow("Telefon odpowiedział niepoprawnie.");
    expect(await session.get(STORAGE_KEYS.pendingPairing)).toBeUndefined();
  });

  it("a wrong code fails and leaves nothing behind", async () => {
    const phone = await FakePhone.withVault(PASSWORD, [PHONE_URL]);
    const { store, session } = newBrowser(new Map([[PHONE_URL, phone]]));
    phone.offerPairing();
    await expect(store.pairStart(PHONE_URL, "87654321", "Chrome")).rejects.toThrow("Zły kod parowania");
    expect(await session.get(STORAGE_KEYS.pendingPairing)).toBeUndefined();
    expect(await store.getAccount()).toBeUndefined();
  }, 30_000);

  it("refuses an empty or too long device name", async () => {
    const { store } = newBrowser(new Map());
    await expect(store.pairStart(PHONE_URL, CODE, "  ")).rejects.toThrow("nazwę");
    await expect(store.pairStart(PHONE_URL, CODE, "x".repeat(65))).rejects.toThrow("nazwę");
  });

  it("refuses to pair a browser that is already paired as a new account", async () => {
    const { store, phone } = await pairedBrowser();
    phone.offerPairing();
    await expect(store.pairStart(PHONE_URL, CODE, "Chrome")).rejects.toThrow("już sparowana");
  }, 30_000);

  it("a phone that forgot this browser is reported by sync", async () => {
    const { store, phone } = await pairedBrowser();
    phone.devices.length = 0;
    await expect(store.sync()).rejects.toThrow("Telefon nie zna tej przeglądarki");
  }, 30_000);
});

describe("PhoneClient", () => {
  it("POSTs JSON to the full URL and returns status and body", async () => {
    const calls: [string, RequestInit][] = [];
    const client = new PhoneClient("http://192.168.1.5:8787/", async (url, init) => {
      calls.push([String(url), init!]);
      return Response.json({ error: "no pairing" }, { status: 404 });
    });
    expect(client.baseUrl).toBe("http://192.168.1.5:8787");
    expect(await client.post("http://192.168.1.5:8787/p2p/v1/pair/hello", {})).toEqual({ status: 404, body: { error: "no pairing" } });
    expect(calls[0]![1]).toMatchObject({ method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  });

  it("status() pings the phone", async () => {
    const paths: string[] = [];
    const ok = new PhoneClient("http://x", async (url) => (paths.push(new URL(String(url)).pathname), Response.json({ ok: true })));
    await ok.status();
    expect(paths).toEqual(["/p2p/v1/ping"]);
    const wrong = new PhoneClient("http://x", async () => Response.json({ ok: false }));
    await expect(wrong.status()).rejects.toThrow("malformed");
  });

  it("turns a network error and a non-JSON body into what callers expect", async () => {
    const down = new PhoneClient("http://x", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(down.status()).rejects.toEqual(new ApiError(0, "Telefon nie odpowiada. Czy tryb Synchronizacja jest włączony?"));
    const html = new PhoneClient("http://x", async () => new Response("<h1>Bad Gateway</h1>", { status: 502 }));
    expect(await html.post("http://x/p2p/v1/ping", {})).toEqual({ status: 502, body: {} });
  });

  it("gives up on a request after 30 s, also when the body never finishes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      expect(POST_TIMEOUT_MS).toBe(30_000);
      const silent = new PhoneClient("http://x", () => new Promise<Response>(() => {}));
      const slowBody = new PhoneClient("http://x", async () => ({ status: 200, json: () => new Promise(() => {}) }) as unknown as Response);
      for (const client of [silent, slowBody]) {
        let result: unknown;
        const call = client.post("http://x/p2p/v2/sync", {}).then((r) => r, (e: unknown) => e).then((r) => (result = r));
        await vi.advanceTimersByTimeAsync(POST_TIMEOUT_MS - 1);
        expect(result).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        await call;
        expect(result).toEqual(new ApiError(0, PHONE_UNREACHABLE));
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("phone that only speaks v1", () => {
  it("asks to update the phone app when the v2 handshake is 404", async () => {
    const { phone, local, session } = await pairedBrowser();
    const oldPhone: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const reply = path === "/p2p/v2/handshake" ? { status: 404, body: { error: "not found" } } : await phone.handle(path, JSON.parse(String(init?.body ?? "{}")));
      return Response.json(reply.body, { status: reply.status });
    }) as typeof fetch;
    const reopened = new VaultStore(local, session, (url) => new PhoneClient(url, oldPhone));
    await reopened.unlock(PASSWORD);
    await expect(reopened.sync()).rejects.toThrow("Zaktualizuj aplikację na telefonie");
  }, 30_000);
});
