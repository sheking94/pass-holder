import { describe, expect, it } from "vitest";
import { PROMPT_BADGE, PROMPT_WIDTH, promptBounds, PromptWindows, type Bounds, type WindowApi } from "../../src/save/prompt-window.ts";
import type { KeyValueStore } from "../../src/storage.ts";

function memory(): KeyValueStore {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => m.get(k) as T | undefined,
    set: async (k, v) => { m.set(k, structuredClone(v)); },
    remove: async (k) => { m.delete(k); },
  };
}

function fake(o: { openFails?: boolean; navigateFails?: boolean } = {}) {
  const calls: string[] = [];
  const badges = new Map<number, string>();
  let next = 100;
  const api: WindowApi = {
    tabWindow: async () => ({ left: 10, top: 20, width: 1200, height: 800 }),
    open: async (url: string, b: Bounds) => {
      if (o.openFails) throw new Error("no window");
      calls.push(`open ${url} ${b.left},${b.top}`);
      return next++;
    },
    navigate: async (id, url) => {
      if (o.navigateFails) throw new Error("gone");
      calls.push(`navigate ${id} ${url}`);
    },
    close: async (id) => { calls.push(`close ${id}`); },
    badge: async (tabId, text) => { badges.set(tabId, text); },
  };
  const w = new PromptWindows(api, memory(), (id) => `prompt?id=${id}`);
  return { w, calls, badges };
}

describe("PromptWindows", () => {
  it("opens one window top right of the tab's window, with a badge", async () => {
    const f = fake();
    await f.w.show(7, "c1");
    await f.w.show(7, "c1");
    expect(f.calls).toEqual([`open prompt?id=c1 ${10 + 1200 - PROMPT_WIDTH - 16},100`]);
    expect(f.badges.get(7)).toBe(PROMPT_BADGE);
  });

  it("points the open window at a newer candidate, reopens when it is gone", async () => {
    const f = fake();
    await f.w.show(7, "c1");
    await f.w.show(7, "c2");
    expect(f.calls.at(-1)).toBe("navigate 100 prompt?id=c2");
    const g = fake({ navigateFails: true });
    await g.w.show(7, "c1");
    await g.w.show(7, "c2");
    expect(g.calls).toHaveLength(2);
    expect(g.calls[1]).toMatch(/^open prompt\?id=c2/);
  });

  it("hide closes the window and clears the badge; closing it is not the user's close", async () => {
    const f = fake();
    await f.w.show(7, "c1");
    await f.w.hide(7);
    expect(f.calls.at(-1)).toBe("close 100");
    expect(f.badges.get(7)).toBe("");
    expect(await f.w.closedByUser(100)).toBeUndefined();
  });

  it("closeWindow keeps the badge", async () => {
    const f = fake();
    await f.w.show(7, "c1");
    await f.w.closeWindow(7);
    expect(f.calls.at(-1)).toBe("close 100");
    expect(f.badges.get(7)).toBe(PROMPT_BADGE);
  });

  it("closedByUser names the tab of our window once", async () => {
    const f = fake();
    await f.w.show(7, "c1");
    expect(await f.w.closedByUser(5)).toBeUndefined();
    expect(await f.w.closedByUser(100)).toBe(7);
    expect(await f.w.closedByUser(100)).toBeUndefined();
    // Next show opens a new window.
    await f.w.show(7, "c1");
    expect(f.calls.filter((c) => c.startsWith("open"))).toHaveLength(2);
  });

  it("a window that fails to open leaves the badge", async () => {
    const f = fake({ openFails: true });
    await f.w.show(7, "c1");
    expect(f.badges.get(7)).toBe(PROMPT_BADGE);
    expect(await f.w.closedByUser(100)).toBeUndefined();
  });

  it("bounds fall back without the tab's window", () => {
    expect(promptBounds(undefined)).toMatchObject({ left: 0, top: 80, width: PROMPT_WIDTH });
  });
});
