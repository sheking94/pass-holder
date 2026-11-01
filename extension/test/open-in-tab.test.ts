import { describe, expect, it } from "vitest";
import { openInTab, type TabApi } from "../src/open-in-tab.ts";
import { isInTab, isMainTab, pageMode } from "../src/page-mode.ts";

const PAGE = "chrome-extension://abc/popup.html";

function fakeApi(tabs: { tabId: number; windowId: number; url: string }[]) {
  const calls: string[] = [];
  const api: TabApi = {
    openTabs: async () => tabs,
    focus: async (tabId, windowId) => void calls.push(`focus ${tabId} ${windowId}`),
    create: async (url) => void calls.push(`create ${url}`),
  };
  return { api, calls };
}

describe("pageMode", () => {
  it("tells the popup from each tab", () => {
    expect(pageMode("")).toBe("popup");
    expect(pageMode("?other")).toBe("popup");
    expect(pageMode("?tab")).toBe("tab");
    expect(pageMode("?setup")).toBe("setup");
    expect(pageMode("?addresses")).toBe("addresses");
    expect(pageMode("?transfer")).toBe("transfer");
  });

  it("counts every tab as a tab, also the CSV one, but only tab and setup as the main tab", () => {
    expect(isInTab("popup")).toBe(false);
    for (const mode of ["tab", "setup", "addresses", "transfer"] as const) expect(isInTab(mode)).toBe(true);
    expect(isMainTab("tab")).toBe(true);
    expect(isMainTab("setup")).toBe(true);
    expect(isMainTab("addresses")).toBe(false);
    expect(isMainTab("transfer")).toBe(false);
  });
});

describe("openInTab", () => {
  it("opens a new tab when none is open", async () => {
    const { api, calls } = fakeApi([]);
    await openInTab(api, PAGE);
    expect(calls).toEqual([`create ${PAGE}?tab`]);
  });

  it("switches to an already open PassHolder tab instead of opening another", async () => {
    const { api, calls } = fakeApi([{ tabId: 7, windowId: 2, url: `${PAGE}?tab` }]);
    await openInTab(api, PAGE);
    expect(calls).toEqual(["focus 7 2"]);
  });

  it("reuses the setup tab too", async () => {
    const { api, calls } = fakeApi([{ tabId: 3, windowId: 1, url: `${PAGE}?setup` }]);
    await openInTab(api, PAGE);
    expect(calls).toEqual(["focus 3 1"]);
  });

  it("does not reuse the CSV or address tab: they show only one form", async () => {
    const { api, calls } = fakeApi([
      { tabId: 4, windowId: 1, url: `${PAGE}?transfer` },
      { tabId: 5, windowId: 1, url: `${PAGE}?addresses` },
    ]);
    await openInTab(api, PAGE);
    expect(calls).toEqual([`create ${PAGE}?tab`]);
  });

  it("ignores other extension pages", async () => {
    const { api, calls } = fakeApi([{ tabId: 9, windowId: 1, url: "chrome-extension://abc/offscreen.html" }]);
    await openInTab(api, PAGE);
    expect(calls).toEqual([`create ${PAGE}?tab`]);
  });
});
