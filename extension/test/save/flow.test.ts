// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { startSaveWatch } from "../../src/save/watch.ts";
import { extSender, scriptSender, setup, type PromptCall } from "./save-fixture.ts";

// The page script and the service worker wired together through fakes: what one real SPA login does end to end.

// startSaveWatch cannot be stopped: the listeners of earlier tests stay on the document, so turn their wiring off.
let stop = (): void => undefined;
afterEach(() => {
  stop();
  document.body.innerHTML = "";
});

async function wired() {
  let live = true;
  stop = () => {
    live = false;
  };
  /** The fake question window of tab 7: the candidate it shows, or null when closed. */
  const windows: string[] = [];
  let open: string | null = null;
  const onSend = (tabId: number, m: PromptCall) => {
    if (!live || tabId !== 7) return;
    if (m.type === "save-show") {
      if (open === null) windows.push(m.candidateId);
      open = m.candidateId;
    } else if (m.type !== "badge") open = null;
  };
  const s = await setup({ onSend });
  const work: Promise<unknown>[] = [];
  startSaveWatch(document, {
    send: (m) => {
      if (!live) return Promise.resolve(undefined);
      const p =
        m.type === "save-candidate"
          ? s.sc.onCandidate(m, scriptSender())
          : s.sc.onPending(m, scriptSender());
      work.push(p);
      return p;
    },
    trusted: () => true,
  });
  const settle = async () => {
    for (let n = 0; n < work.length; n++) await work[n];
  };
  return { ...s, settle, windows, shown: () => open };
}

describe("save prompt, page script with the service worker", () => {
  it("one SPA login (click on submit, submit prevented) opens one window with valid info", async () => {
    document.body.innerHTML = `<form id="f"><input name="username" value="anna"><input type="password" name="password" value="s3cret">
      <button type="submit" id="go">Go</button></form>`;
    document.getElementById("f")!.addEventListener("submit", (e) => e.preventDefault());
    const s = await wired();
    await s.settle();
    document.getElementById("go")!.click();
    await s.settle();

    expect(s.windows).toHaveLength(1);
    const id = s.shown();
    expect(id).toBe((await s.stored())["7"]!.id);
    expect(document.querySelector("iframe")).toBeNull();
    const info = await s.sc.info(
      { target: "background", type: "save-info", candidateId: id! },
      extSender,
    );
    expect(info).toMatchObject({
      id,
      host: "shop.pl",
      username: "anna",
      decision: "create",
      locked: false,
    });
  }, 30_000);

  it("a second, different login on the same page points the same window at the new candidate", async () => {
    document.body.innerHTML = `<form id="f"><input name="username" value="anna"><input type="password" name="password" value="one">
      <button type="submit" id="go">Go</button></form>`;
    document.getElementById("f")!.addEventListener("submit", (e) => e.preventDefault());
    const s = await wired();
    document.getElementById("go")!.click();
    await s.settle();
    const first = s.shown();
    (document.querySelector("[type=password]") as HTMLInputElement).value = "two";
    document.getElementById("go")!.click();
    await s.settle();

    expect(s.windows).toHaveLength(1);
    const id = s.shown();
    expect(id).not.toBe(first);
    expect(id).toBe((await s.stored())["7"]!.id);
  }, 30_000);
});
