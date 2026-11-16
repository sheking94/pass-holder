// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { startSaveWatch, type WatchRuntime } from "../../src/save/watch.ts";
import type { SaveCandidateMessage, SavePendingMessage } from "../../src/save/messages.ts";

const LOGIN = `<form id="f"><input name="username" value="jan"><input type="password" name="password" value="s3cret">
  <button type="submit" id="go">Go</button></form>`;

/** Events dispatched in tests are untrusted; `trusted` says which ones count as the user's. */
function setup(trusted: ((e: Event) => boolean) | "real" = () => true) {
  const sent: Array<SaveCandidateMessage | SavePendingMessage> = [];
  const runtime: WatchRuntime = {
    send: (m) => {
      sent.push(m);
      return Promise.resolve(undefined);
    },
    ...(trusted !== "real" && { trusted }),
  };
  return { sent, runtime, candidates: () => sent.filter((m) => m.type === "save-candidate") };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("startSaveWatch", () => {
  it("sends save-candidate on submit", () => {
    document.body.innerHTML = LOGIN;
    const t = setup();
    startSaveWatch(document, t.runtime);
    document
      .getElementById("f")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(t.candidates()).toEqual([
      {
        target: "background",
        type: "save-candidate",
        username: "jan",
        password: "s3cret",
        formSignature: "password,username",
      },
    ]);
  });

  it("sends on Enter in the password field", () => {
    document.body.innerHTML = LOGIN;
    const t = setup();
    startSaveWatch(document, t.runtime);
    document
      .querySelector("[type=password]")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(t.candidates()).toHaveLength(1);
  });

  it("does not send on other keys", () => {
    document.body.innerHTML = LOGIN;
    const t = setup();
    startSaveWatch(document, t.runtime);
    document
      .querySelector("[type=password]")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
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
    document.body.innerHTML =
      LOGIN + `<form id="other"><input name="q" value="x"><button id="s">Search</button></form>`;
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
    document
      .getElementById("f")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(t.candidates()).toMatchObject([{ username: "jan", password: "s3cret" }]);
  });

  it("sends save-pending with the empty login forms on start and puts nothing on the page", () => {
    document.body.innerHTML = `<form><input name="u"><input type="password" name="p"></form>`;
    const before = document.body.innerHTML;
    const t = setup();
    startSaveWatch(document, t.runtime);
    expect(t.sent[0]).toEqual({
      target: "background",
      type: "save-pending",
      emptyLoginForms: ["p,u"],
    });
    expect(document.body.innerHTML).toBe(before);
  });

  it("ignores submit, Enter and click the page dispatched itself (isTrusted false)", () => {
    document.body.innerHTML = LOGIN;
    const t = setup("real"); // the real check: event.isTrusted (happy-dom leaves it undefined, a browser sets false)
    startSaveWatch(document, t.runtime);
    document
      .getElementById("f")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    document
      .querySelector("[type=password]")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    document.getElementById("go")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(t.candidates()).toEqual([]);
  });

  it("only events the check accepts count", () => {
    document.body.innerHTML = LOGIN;
    const t = setup((e) => e.type === "click");
    startSaveWatch(document, t.runtime);
    document
      .getElementById("f")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    document.getElementById("go")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(t.candidates()).toHaveLength(1);
  });

  it("does nothing when the top frame is cross-origin", () => {
    document.body.innerHTML = LOGIN;
    vi.spyOn(window, "top", "get").mockReturnValue({
      get location(): never {
        throw new Error("cross-origin");
      },
    } as unknown as Window);
    const t = setup();
    startSaveWatch(document, t.runtime);
    document
      .getElementById("f")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(t.sent).toEqual([]);
  });

  it("a same-origin subframe sends candidates but not save-pending", () => {
    document.body.innerHTML = LOGIN;
    vi.spyOn(window, "top", "get").mockReturnValue({
      location: { origin: window.location.origin },
    } as unknown as Window);
    const t = setup();
    startSaveWatch(document, t.runtime);
    document
      .getElementById("f")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(t.sent.map((m) => m.type)).toEqual(["save-candidate"]);
  });
});
