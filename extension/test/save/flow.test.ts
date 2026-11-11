// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSaveWatch } from "../../src/save/watch.ts";
import type { ToWatchMessage } from "../../src/save/messages.ts";
import { extSender, scriptSender, setup } from "./save-fixture.ts";

// The page script and the service worker wired together through fakes: what one real SPA login does end to end.

const roots: ShadowRoot[] = [];
const origAttach = Element.prototype.attachShadow;
const frames = (): HTMLIFrameElement[] =>
  roots.filter((r) => r.host.isConnected).flatMap((r) => Array.from(r.querySelectorAll("iframe")));
const frameId = (f: HTMLIFrameElement | undefined) => (f ? new URL(f.src).searchParams.get("id") : null);

beforeEach(() => {
  roots.length = 0;
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init: ShadowRootInit) {
    const root = origAttach.call(this, init);
    roots.push(root);
    return root;
  });
  // happy-dom logs a stack trace for every extension iframe it cannot load.
  const error = console.error;
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    if (!String(a[0]).includes("Iframe page loading is disabled")) error(...a);
  });
});
// startSaveWatch cannot be stopped: the listeners of earlier tests stay on the document, so turn their wiring off.
let stop = (): void => undefined;
afterEach(() => { stop(); document.body.innerHTML = ""; vi.restoreAllMocks(); });

async function wired() {
  let toWatch: ((m: ToWatchMessage) => void) | undefined;
  let live = true;
  stop = () => { live = false; };
  const s = await setup({ onSend: (tabId, m) => { if (live && tabId === 7) toWatch?.(m); } });
  const work: Promise<unknown>[] = [];
  startSaveWatch(document, {
    send: (m) => {
      if (!live) return Promise.resolve(undefined);
      const p = m.type === "save-candidate" ? s.sc.onCandidate(m, scriptSender()) : s.sc.onPending(m, scriptSender());
      work.push(p);
      return p;
    },
    onMessage: (h) => { toWatch = h; },
    panelUrl: (id) => `chrome-extension://ext-id/save-prompt.html?id=${encodeURIComponent(id)}`,
  });
  const settle = async () => {
    for (let n = 0; n < work.length; n++) await work[n];
  };
  return { ...s, settle };
}

describe("save prompt, page script with the service worker", () => {
  it("one SPA login (click on submit, submit prevented) shows one panel with valid info", async () => {
    document.body.innerHTML = `<form id="f"><input name="username" value="anna"><input type="password" name="password" value="s3cret">
      <button type="submit" id="go">Go</button></form>`;
    document.getElementById("f")!.addEventListener("submit", (e) => e.preventDefault());
    const s = await wired();
    await s.settle();
    document.getElementById("go")!.click();
    await s.settle();

    expect(frames()).toHaveLength(1);
    const id = frameId(frames()[0]);
    expect(id).toBe((await s.stored())["7"]!.id);
    const info = await s.sc.info({ target: "background", type: "save-info", candidateId: id! }, extSender);
    expect(info).toMatchObject({ id, host: "shop.pl", username: "anna", decision: "create", locked: false });
  }, 30_000);

  it("a second, different login on the same page moves the panel to the new candidate", async () => {
    document.body.innerHTML = `<form id="f"><input name="username" value="anna"><input type="password" name="password" value="one">
      <button type="submit" id="go">Go</button></form>`;
    document.getElementById("f")!.addEventListener("submit", (e) => e.preventDefault());
    const s = await wired();
    document.getElementById("go")!.click();
    await s.settle();
    const first = frameId(frames()[0]);
    (document.querySelector("[type=password]") as HTMLInputElement).value = "two";
    document.getElementById("go")!.click();
    await s.settle();

    expect(frames()).toHaveLength(1);
    const id = frameId(frames()[0]);
    expect(id).not.toBe(first);
    expect(id).toBe((await s.stored())["7"]!.id);
  }, 30_000);
});
