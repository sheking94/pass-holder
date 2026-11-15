// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });

describe("save-watch.ts (the content script entry point)", () => {
  it("a synchronous throw of sendMessage (extension reloaded) does not reach the page", async () => {
    const sendMessage = vi.fn(() => { throw new Error("Extension context invalidated."); });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    document.body.innerHTML = `<form id="f"><input name="username" value="jan"><input type="password" name="password" value="pw"></form>`;
    await import("../../src/save-watch.ts"); // sends save-pending at once
    // A page-dispatched submit is untrusted: no candidate (review V3-S1).
    document.getElementById("f")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(sendMessage.mock.calls.map((c) => (c as unknown[])[0])).toMatchObject([{ type: "save-pending" }]);
  });
});
