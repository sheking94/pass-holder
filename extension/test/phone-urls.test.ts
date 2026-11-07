import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/phone-client.ts";
import { learnedPhoneUrls, normalizePhoneUrl, normalizePhoneUrls, orderForTrying, pickPhone, PROBE_TIMEOUT_MS } from "../src/phone-urls.ts";
import { pairedBrowser, PHONE_URL, SECOND_URL } from "./fake-phone.ts";

afterEach(() => {
  vi.useRealTimers();
});

/** A client whose status() answers, fails, or never settles. */
const probe = (behaviour: "ok" | "fail" | "hang", calls: string[], url: string) => ({
  url,
  status: (timeoutMs?: number) => {
    calls.push(`${url}@${timeoutMs}`);
    if (behaviour === "ok") return Promise.resolve();
    if (behaviour === "fail") return Promise.reject(new ApiError(0, "down"));
    return new Promise<void>((_, reject) => setTimeout(() => reject(new ApiError(0, "timeout")), timeoutMs));
  },
});

describe("phone addresses", () => {
  it("normalizes an IPv4 address (with or without http:// and port) to http://IPv4:port", () => {
    expect(normalizePhoneUrl(" 192.168.1.5 ")).toBe("http://192.168.1.5:8787");
    expect(normalizePhoneUrl("192.168.1.5:9000/")).toBe("http://192.168.1.5:9000");
    expect(normalizePhoneUrl("HTTP://10.0.0.1:8787//")).toBe("http://10.0.0.1:8787");
    expect(normalizePhoneUrl("http://LocalHost:8787")).toBe("http://localhost:8787");
    // A single 0 is fine; leading zeros are not (the WHATWG URL parser would read 010 as octal 8).
    expect(normalizePhoneUrl("10.0.0.1")).toBe("http://10.0.0.1:8787");
    for (const bad of ["", "https://192.168.1.5:8787", "http://phone.local:8787", "http://[::1]:8787", "1.2.3.256", "1.2.3", "http://1.2.3.4:0", "http://1.2.3.4:8787/p2p", "http://u@1.2.3.4", "010.0.0.1", "192.168.01.5", "http://1.2.3.00:8787"]) {
      expect(normalizePhoneUrl(bad)).toBeUndefined();
    }
  });

  it("normalizes a typed list, drops empty entries and duplicates, and names a wrong one", () => {
    expect(normalizePhoneUrls([" 192.168.1.5 ", "", "http://192.168.1.5:8787", "100.64.0.7"])).toEqual([PHONE_URL, SECOND_URL]);
    expect(() => normalizePhoneUrls(["192.168.1.5", "telefon.local"])).toThrow("Nieprawidłowy adres telefonu „telefon.local”");
  });

  it("keeps only usable addresses learned from the phone", () => {
    expect(learnedPhoneUrls(["http://192.168.1.5:8787", "http://[fd00::1]:8787", "telefon.local", "100.64.0.7:8787"])).toEqual([PHONE_URL, SECOND_URL]);
  });

  it("orders the address that worked last first", () => {
    expect(orderForTrying(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(orderForTrying(["a", "b"], "gone")).toEqual(["a", "b"]);
  });
});

describe("pickPhone", () => {
  it("uses a single address without checking it first", async () => {
    const calls: string[] = [];
    const { url } = await pickPhone(["http://only"], (u) => probe("ok", calls, u));
    expect(url).toBe("http://only");
    expect(calls).toEqual([]);
  });

  it("pings each address with the probe timeout and takes the first that answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const calls: string[] = [];
    const behaviours: Record<string, "ok" | "fail" | "hang"> = { a: "hang", b: "fail", c: "ok" };
    const picking = pickPhone(["a", "b", "c"], (u) => probe(behaviours[u]!, calls, u));
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    const { url, client } = await picking;
    expect(url).toBe("c");
    expect(client.url).toBe("c");
    expect(calls).toEqual([`a@${PROBE_TIMEOUT_MS}`, `b@${PROBE_TIMEOUT_MS}`, `c@${PROBE_TIMEOUT_MS}`]);
    expect(PROBE_TIMEOUT_MS).toBe(4000);
  });

  it("says which addresses it tried when none answers", async () => {
    const error = await pickPhone(["a", "b"], (u) => probe("fail", [], u)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).message).toContain("a, b");
    expect((error as ApiError).message).toContain("Synchronizacja");
  });
});

describe("VaultStore.setPhoneUrls", () => {
  it("normalizes the addresses, keeps lastPhoneUrl only if it is still listed, refuses an empty or wrong list", async () => {
    const { store } = await pairedBrowser();
    await store.setPhoneUrls([" 192.168.1.5 ", "100.64.0.7"]);
    expect(await store.getAccount()).toMatchObject({ phoneUrls: [PHONE_URL, SECOND_URL], lastPhoneUrl: PHONE_URL });
    await store.setPhoneUrls([SECOND_URL]);
    expect((await store.getAccount())!.lastPhoneUrl).toBeUndefined();

    await expect(store.setPhoneUrls([" ", ""])).rejects.toThrow("Podaj adres telefonu");
    await expect(store.setPhoneUrls(["https://192.168.1.5"])).rejects.toThrow("Nieprawidłowy adres telefonu");
    expect((await store.getAccount())!.phoneUrls).toEqual([SECOND_URL]);
  }, 30_000);
});
