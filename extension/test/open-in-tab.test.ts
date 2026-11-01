import { describe, expect, it } from "vitest";
import { isTabPage, openInTab, type TabApi } from "../src/open-in-tab.ts";

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

describe("isTabPage", () => {
  it("recognises the tab and setup pages, not the popup", () => {
    expect(isTabPage("?tab")).toBe(true);
    expect(isTabPage("?setup")).toBe(true);
    expect(isTabPage("")).toBe(false);
    expect(isTabPage("?other")).toBe(false);
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

  it("ignores other extension pages", async () => {
    const { api, calls } = fakeApi([{ tabId: 9, windowId: 1, url: "chrome-extension://abc/offscreen.html" }]);
    await openInTab(api, PAGE);
    expect(calls).toEqual([`create ${PAGE}?tab`]);
  });
});
