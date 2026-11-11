// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSaveWatch, type WatchRuntime } from "../../src/save/watch.ts";
import type { SaveCandidateMessage, SavePendingMessage, ToWatchMessage } from "../../src/save/messages.ts";

const LOGIN = `<form id="f"><input name="username" value="jan"><input type="password" name="password" value="s3cret">
  <button type="submit" id="go">Go</button></form>`;

function setup(pendingReply: unknown = {}) {
  const sent: Array<SaveCandidateMessage | SavePendingMessage> = [];
  let handler: ((m: ToWatchMessage) => void) | undefined;
  const runtime: WatchRuntime = {
    send: (m) => { sent.push(m); return Promise.resolve(m.type === "save-pending" ? pendingReply : undefined); },
    onMessage: (h) => { handler = h; },
    panelUrl: (id) => `chrome-extension://abc/save-prompt.html?id=${encodeURIComponent(id)}`,
  };
  const emit = (m: ToWatchMessage): void => handler?.(m);
  return { sent, runtime, emit, candidates: () => sent.filter((m) => m.type === "save-candidate") };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const roots: ShadowRoot[] = [];
const origAttach = Element.prototype.attachShadow;
const frames = (): HTMLIFrameElement[] =>
  roots.filter((r) => r.host.isConnected).flatMap((r) => Array.from(r.querySelectorAll("iframe")));

beforeEach(() => {
  roots.length = 0;
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init: ShadowRootInit) {
    expect(init.mode).toBe("closed");
    const root = origAttach.call(this, init);
    roots.push(root);
    return root;
  });
});
afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("startSaveWatch", () => {
  it("sends save-candidate on submit", () => {
    document.body.innerHTML = LOGIN;
    const t = setup();
    startSaveWatch(document, t.runtime);
    document.getElementById("f")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(t.candidates()).toEqual([{
      target: "background", type: "save-candidate", username: "jan", password: "s3cret", formSignature: "password,username",
    }]);
  });

  it("sends on Enter in the password field", () => {
    document.body.innerHTML = LOGIN;
    const t = setup();
    startSaveWatch(document, t.runtime);
    document.querySelector("[type=password]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(t.candidates()).toHaveLength(1);
  });

  it("does not send on other keys", () => {
    document.body.innerHTML = LOGIN;
    const t = setup();
    startSaveWatch(document, t.runtime);
    document.querySelector("[type=password]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(t.candidates()).toHaveLength(0);
  });

  it("sends on a button click in a div without a form", () => {
    document.body.innerHTML = `<div><input name="username" value="jan"><input type="password" value="pw"><button id="b"><span>Go</span></button></div>`;
    const t = setup();
    startSaveWatch(document, t.runtime);
    document.querySelector("#b span")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(t.candidates()).toMatchObject([{ username: "jan", password: "pw" }]);
  });

  it("does not send on a click of a button in another form", () => {
    document.body.innerHTML = LOGIN + `<form id="other"><input name="q" value="x"><button id="s">Search</button></form>`;
    const t = setup();
    startSaveWatch(document, t.runtime);
    document.getElementById("s")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(t.candidates()).toHaveLength(0);
  });

  it("sends the values from before the page handler clears the fields", () => {
    document.body.innerHTML = LOGIN;
    document.getElementById("f")!.addEventListener("submit", () => {
      for (const i of document.querySelectorAll("input")) i.value = "";
    });
    const t = setup();
    startSaveWatch(document, t.runtime);
    document.getElementById("f")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(t.candidates()).toMatchObject([{ username: "jan", password: "s3cret" }]);
  });

  it("sends save-pending with the empty login forms on start and shows the panel for the reply", async () => {
    document.body.innerHTML = `<form><input name="u"><input type="password" name="p"></form>`;
    const t = setup({ candidateId: "c1" });
    startSaveWatch(document, t.runtime);
    expect(t.sent[0]).toEqual({ target: "background", type: "save-pending", emptyLoginForms: ["p,u"] });
    await flush();
    expect(frames().map((f) => f.src)).toEqual(["chrome-extension://abc/save-prompt.html?id=c1"]);
  });

  it("save-show inserts one frame in a closed shadow root, save-hide removes it", () => {
    const t = setup();
    startSaveWatch(document, t.runtime);
    t.emit({ target: "save-watch", type: "save-show", candidateId: "c2" });
    t.emit({ target: "save-watch", type: "save-show", candidateId: "c2" });
    const host = document.querySelector("[data-passholder-save]") as HTMLElement;
    expect(document.querySelectorAll("[data-passholder-save]")).toHaveLength(1);
    expect(host.shadowRoot).toBeNull();
    expect(host.style.position).toBe("fixed");
    expect(host.style.zIndex).toBe("2147483647");
    expect(frames()).toHaveLength(1);
    expect(frames()[0]?.src).toBe("chrome-extension://abc/save-prompt.html?id=c2");
    t.emit({ target: "save-watch", type: "save-hide" });
    expect(document.querySelector("[data-passholder-save]")).toBeNull();
  });

  it("does nothing when the top frame is cross-origin", () => {
    document.body.innerHTML = LOGIN;
    vi.spyOn(window, "top", "get").mockReturnValue({
      get location(): never { throw new Error("cross-origin"); },
    } as unknown as Window);
    const t = setup();
    startSaveWatch(document, t.runtime);
    document.getElementById("f")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    t.emit({ target: "save-watch", type: "save-show", candidateId: "c3" });
    expect(t.sent).toEqual([]);
    expect(document.querySelector("[data-passholder-save]")).toBeNull();
  });

  it("a same-origin subframe sends candidates but not save-pending and hosts no panel", () => {
    document.body.innerHTML = LOGIN;
    vi.spyOn(window, "top", "get").mockReturnValue({ location: { origin: window.location.origin } } as unknown as Window);
    const t = setup({ candidateId: "x" });
    startSaveWatch(document, t.runtime);
    document.getElementById("f")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    t.emit({ target: "save-watch", type: "save-show", candidateId: "c4" });
    expect(t.sent.map((m) => m.type)).toEqual(["save-candidate"]);
    expect(document.querySelector("[data-passholder-save]")).toBeNull();
  });
});
