import { describe, expect, it } from "vitest";
import { matchUrl } from "../src/autofill/match.ts";
import { saveUrl } from "../src/save/url.ts";
import { hostOf, normalizeHost, parseWebAddress } from "../src/web-address.ts";

describe("normalizeHost", () => {
  it("lowercases and drops a leading www. and one trailing dot", () => {
    expect(normalizeHost("WWW.Example.COM.")).toBe("example.com");
    expect(normalizeHost("wwwx.example.com")).toBe("wwwx.example.com");
    expect(normalizeHost("example.com..")).toBe("example.com.");
  });

  // Review V3 CS5: the order of the two steps matters only for "www.". The save vectors fix it to "" ("empty host
  // after www removal"); autofill matching, which used the other order ("www"), now follows them.
  it("removes www. before the trailing dot, so www. has no host", () => {
    expect(normalizeHost("www.")).toBe("");
    expect(saveUrl("https://www.")).toBeNull();
    expect(matchUrl("https://www./", "www")).toBeUndefined();
  });
});

describe("parseWebAddress", () => {
  it("reads text without a scheme as https only when asked", () => {
    expect(parseWebAddress("example.com", { assumeHttps: true })).toEqual({
      scheme: "https:",
      host: "example.com",
      port: "",
    });
    expect(parseWebAddress("example.com", { assumeHttps: false })).toBeUndefined();
  });

  it("keeps a non-default port and refuses other schemes", () => {
    expect(parseWebAddress(" http://www.a.pl:8080/x ", { assumeHttps: false })).toEqual({
      scheme: "http:",
      host: "a.pl",
      port: "8080",
    });
    expect(parseWebAddress("https://a.pl:443", { assumeHttps: false })?.port).toBe("");
    expect(parseWebAddress("ftp://a.pl", { assumeHttps: true })).toBeUndefined();
  });
});

describe("hostOf", () => {
  it("gives the normalized host of any scheme, or undefined", () => {
    expect(hostOf("https://www.Example.com/login")).toBe("example.com");
    expect(hostOf("example.org/x")).toBe("example.org");
    expect(hostOf("ftp://files.example.com")).toBe("files.example.com");
    expect(hostOf("http://[::1]:8080")).toBe("[::1]");
    expect(hostOf("nie adres")).toBeUndefined();
  });
});
